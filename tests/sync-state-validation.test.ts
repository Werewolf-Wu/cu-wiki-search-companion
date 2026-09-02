// SPDX-License-Identifier: MPL-2.0
import 'fake-indexeddb/auto';

import { cut, cut_for_search } from 'jieba-wasm/node';

import { Analyzer } from '../src/analyzer/analyzer';
import { WikiSearchDatabase } from '../src/storage/database';
import { readDataCodeSyncState, syncDataCodes } from '../src/sync/data-code-sync';
import { readFileResourceSyncState } from '../src/sync/file-resource-sync';
import { IncrementalSyncCoordinator } from '../src/sync/incremental-sync-coordinator';
import { readRecentChangeSyncState } from '../src/sync/recent-change-sync';
import { readReconciliationSyncState } from '../src/sync/reconciliation-sync';
import { readTitleSyncState } from '../src/sync/title-sync';

const analyzer = new Analyzer({ cut, cutForSearch: cut_for_search });

describe('sync-state validation', () => {
  it.each([
    ['title-sync', readTitleSyncState, { status: 'running', namespaceIndex: '0' }],
    [
      'file-resource-sync',
      readFileResourceSyncState,
      { status: 'running', namespaceIds: [6], apcontinue: 123 },
    ],
    [
      'recent-changes-sync',
      readRecentChangeSyncState,
      { through: 123, completedAt: 1, recentChanges: [] },
    ],
    [
      'reconciliation-sync',
      readReconciliationSyncState,
      { status: 'running', namespaceIds: [0], namespaceIndex: -1 },
    ],
  ])('rejects a malformed critical %s object with its storage key', async (key, read, value) => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.syncState.put({ key, value });

    await expect(read(database)).rejects.toThrow(`同步状态 "${key}" 已损坏`);

    database.close();
    await database.delete();
  });

  it('normalizes a legacy title continuation and ignores additional fields', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.syncState.put({
      key: 'title-sync',
      value: {
        status: 'failed',
        namespaceIds: [0],
        namespaceNames: { 0: '（主）' },
        namespaceIndex: 0,
        apcontinue: '旧版续扫位置',
        generation: 10,
        pagesFetched: 5,
        startedAt: 10,
        error: '断网',
        futureField: { preserved: true },
      },
    });

    const state = await readTitleSyncState(database);

    expect(state).toMatchObject({
      gapcontinue: '旧版续扫位置',
      futureField: { preserved: true },
    });
    expect(state).not.toHaveProperty('apcontinue');

    database.close();
    await database.delete();
  });

  it('treats malformed Data freshness as stale and overwrites it after a refresh', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.syncState.put({
      key: 'data-code-sync',
      value: { syncedAt: 'never', count: -1, futureField: true },
    });
    const fetcher = vi.fn(async () =>
      json({
        _returned: 1,
        _embedded: [
          {
            _id: 'Data:Item/validated.json',
            id: 'validated',
            locales: { 'zh-CN': { name: '已刷新' } },
          },
        ],
      }),
    );

    await expect(readDataCodeSyncState(database)).resolves.toBeUndefined();
    await syncDataCodes(database, analyzer, {
      fetcher: fetcher as typeof fetch,
      retries: 0,
    });

    expect(fetcher).toHaveBeenCalledOnce();
    await expect(readDataCodeSyncState(database)).resolves.toMatchObject({
      syncedAt: expect.any(Number),
      count: 1,
      indexVersion: 2,
    });

    database.close();
    await database.delete();
  });

  it('treats a malformed incremental schedule as due and overwrites it on success', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.syncState.put({
      key: 'incremental-sync-schedule',
      value: { lastSuccessAt: 100, nextDueAt: 'later' },
    });
    const task = vi.fn(async () => undefined);
    const coordinator = new IncrementalSyncCoordinator(database, {
      intervalMs: 1_000,
      jitterMs: 0,
      lockManager: new ImmediateLockManager(),
      now: () => 2_000,
    });

    await expect(coordinator.runIfDue(task)).resolves.toBe('ran');

    expect(task).toHaveBeenCalledOnce();
    expect((await database.syncState.get('incremental-sync-schedule'))?.value).toEqual({
      lastSuccessAt: 2_000,
      nextDueAt: 3_000,
    });

    database.close();
    await database.delete();
  });
});

class ImmediateLockManager {
  async request<T>(
    _name: string,
    _options: LockOptions,
    callback: LockGrantedCallback<T>,
  ): Promise<T> {
    return await callback({ name: 'test-lock', mode: 'exclusive' });
  }
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
