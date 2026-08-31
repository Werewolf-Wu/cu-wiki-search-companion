// SPDX-License-Identifier: MPL-2.0
import 'fake-indexeddb/auto';

import { cut, cut_for_search } from 'jieba-wasm/node';

import { Analyzer } from '../src/analyzer/analyzer';
import { LocalDataMaintenance } from '../src/maintenance/local-data-maintenance';
import { VersionedSearchIndexCache } from '../src/search/versioned-search-index-cache';
import { WikiSearchDatabase } from '../src/storage/database';
import { initializeVersionContract } from '../src/storage/version-contract';
import type { PageRecord } from '../src/types';

const analyzer = new Analyzer(
  { cut, cutForSearch: cut_for_search },
  'jieba-wasm',
);

describe('LocalDataMaintenance', () => {
  it('reports local facts, jobs, cursors, snapshots, quota, and persistence', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await initializeVersionContract(database);
    await database.pages.bulkPut([
      page(1, '普通正文', '可搜索正文', 'wikitext'),
      page(2, 'Data:Item/test.json', '{"name":"测试"}', 'BSON'),
      page(3, '模块:Test', 'return { key = true }', 'Scribunto'),
      { ...page(4, '已删除', '', 'wikitext'), deleted: true },
    ]);
    await database.fileResources.put(page(6, '文件:Test.png', '', undefined));
    await database.dataCodes.put({
      source: 'Data:Item/test.json',
      code: 'test',
      chineseName: '测试',
      normalizedName: '测试',
      dataType: 'Item',
      syncedAt: 1,
    });
    await database.jobs.bulkPut([
      { type: 'wikitext-content', pageId: 1, status: 'done' },
      { type: 'wikitext-content', pageId: 2, status: 'pending' },
      { type: 'wikitext-content', pageId: 3, status: 'running' },
      { type: 'wikitext-content', pageId: 9, status: 'failed' },
    ]);
    await database.syncState.bulkPut([
      { key: 'local-sequence', value: 4 },
      { key: 'recent-changes-sync', value: { through: 'cursor', completedAt: 10 } },
      { key: 'reconciliation-sync', value: { status: 'complete', completedAt: 20 } },
    ]);
    const cache = new VersionedSearchIndexCache(database, {
      storage: { estimate: async () => ({ usage: 2_000, quota: 10_000 }) },
    });
    await cache.publish(await cache.restoreOrRebuild('title', analyzer));
    const maintenance = new LocalDataMaintenance(database, cache, {
      storage: {
        estimate: async () => ({ usage: 2_000, quota: 10_000 }),
        persisted: async () => true,
      },
    });

    const diagnostics = await maintenance.inspect();

    expect(diagnostics.counts).toEqual({
      pages: 3,
      files: 1,
      dataCodes: 1,
      contentSources: 2,
      luaSources: 1,
    });
    expect(diagnostics.jobs).toEqual({ done: 1, pending: 1, running: 1, failed: 1 });
    expect(diagnostics.recentChanges).toMatchObject({ through: 'cursor', completedAt: 10 });
    expect(diagnostics.reconciliation).toMatchObject({ status: 'complete', completedAt: 20 });
    expect(diagnostics.snapshots.find(({ kind }) => kind === 'title')).toMatchObject({
      status: 'available',
    });
    expect(diagnostics.storage).toEqual({ usage: 2_000, quota: 10_000, persisted: true });

    database.close();
    await database.delete();
  });

  it('repairs only the content queue without fetching content', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.bulkPut([
      page(1, '缺正文', undefined, 'wikitext'),
      page(2, '不合格 CSS', undefined, 'css'),
    ]);
    const cache = new VersionedSearchIndexCache(database);
    const maintenance = new LocalDataMaintenance(database, cache);

    await maintenance.rebuildContentQueue();

    expect(await database.jobs.toArray()).toEqual([
      expect.objectContaining({ pageId: 1, status: 'pending' }),
    ]);

    database.close();
    await database.delete();
  });

  it('refreshes rebuilt handles and reports their final publication results', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '重建前标题', '重建前正文', 'wikitext'));
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    let advanced = false;
    const cache = new VersionedSearchIndexCache(database, {
      storage: {
        estimate: async () => {
          if (!advanced) {
            advanced = true;
            await database.transaction('rw', database.pages, database.syncState, async () => {
              await database.pages.put({
                ...page(1, '重建后标题', '重建后正文', 'wikitext'),
                localSeq: 2,
                revisionId: 20,
                contentRevisionId: 20,
              });
              await database.syncState.put({ key: 'local-sequence', value: 2 });
            });
          }
          return { usage: 1_000, quota: 1024 * 1024 * 1024 };
        },
      },
    });
    const maintenance = new LocalDataMaintenance(database, cache);

    const rebuilt = await maintenance.rebuildSearchIndexes(analyzer);

    expect(rebuilt.publishResults).toMatchObject({
      title: { status: 'published' },
      content: { status: 'published' },
      lua: { status: 'published' },
    });
    expect(rebuilt.title.throughLocalSeq).toBe(2);
    expect(rebuilt.content.throughLocalSeq).toBe(2);
    expect(rebuilt.lua.throughLocalSeq).toBe(2);
    expect(rebuilt.title.index.search('重建后')[0]?.title).toBe('重建后标题');
    expect(await database.indexSnapshots.count()).toBe(3);

    database.close();
    await database.delete();
  });

  it('keeps rebuilt handles usable and exposes warnings when snapshots cannot be saved', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '配额受限页面', '仍可搜索的正文', 'wikitext'));
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    const cache = new VersionedSearchIndexCache(database, {
      storage: { estimate: async () => ({ usage: 1_000, quota: 1_000 }) },
    });
    const maintenance = new LocalDataMaintenance(database, cache);

    const rebuilt = await maintenance.rebuildSearchIndexes(analyzer);

    expect(rebuilt.publishResults).toEqual({
      title: { status: 'skipped', reason: 'quota' },
      content: { status: 'skipped', reason: 'quota' },
      lua: { status: 'skipped', reason: 'quota' },
    });
    expect(rebuilt.warnings).toEqual([
      expect.objectContaining({ kind: 'title', reason: 'quota' }),
      expect.objectContaining({ kind: 'content', reason: 'quota' }),
      expect.objectContaining({ kind: 'lua', reason: 'quota' }),
    ]);
    expect(rebuilt.warnings.every(({ message }) => message.includes('配额'))).toBe(true);
    expect(rebuilt.title.index.search('配额受限')[0]?.title).toBe('配额受限页面');
    expect(rebuilt.content.index.search('仍可搜索')[0]?.title).toBe('配额受限页面');
    expect(await database.indexSnapshots.count()).toBe(0);

    database.close();
    await database.delete();
  });

  it.each([
    ['denied', { persist: async () => false }, { status: 'denied' }],
    ['error', { persist: async () => { throw new Error('blocked'); } }, { status: 'error', message: 'blocked' }],
    ['unsupported', {}, { status: 'unsupported' }],
  ])('keeps maintenance usable when persistence is %s', async (_label, storage, expected) => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    const maintenance = new LocalDataMaintenance(
      database,
      new VersionedSearchIndexCache(database),
      { storage },
    );

    await expect(maintenance.requestPersistence()).resolves.toMatchObject(expected);
    expect(await database.pages.count()).toBe(0);

    database.close();
    await database.delete();
  });

  it.each([
    [false, 0],
    [true, 1],
  ])('deletes the mirror and resets rules only when requested (%s)', async (resetRules, deletes) => {
    const name = `test-${crypto.randomUUID()}`;
    const database = new WikiSearchDatabase(name);
    await database.open();
    await database.pages.put(page(1, '将删除', '正文', 'wikitext'));
    const preference = { remove: vi.fn(async () => undefined) };
    const broadcast = { postMessage: vi.fn() };
    const reload = vi.fn();
    const maintenance = new LocalDataMaintenance(
      database,
      new VersionedSearchIndexCache(database),
      { preference, broadcast, reload },
    );

    await maintenance.resetLocalMirror({ resetDataRules: resetRules });

    expect(preference.remove).toHaveBeenCalledTimes(deletes);
    expect(broadcast.postMessage).toHaveBeenCalledWith({ type: 'reset' });
    expect(reload).toHaveBeenCalledOnce();
    const reopened = new WikiSearchDatabase(name);
    await reopened.open();
    expect(await reopened.pages.count()).toBe(0);
    reopened.close();
    await reopened.delete();
  });
});

function page(
  id: number,
  title: string,
  content: string | undefined,
  contentModel: string | undefined,
): PageRecord {
  return {
    id,
    title,
    normalizedTitle: analyzer.normalize(title),
    namespace: contentModel === 'Scribunto' ? 828 : 0,
    namespaceName: contentModel === 'Scribunto' ? '模块' : '（主）',
    isRedirect: false,
    localSeq: id,
    seenInTitleSync: 1,
    revisionId: id * 10,
    contentRevisionId: content === undefined ? undefined : id * 10,
    contentModel,
    content,
  };
}
