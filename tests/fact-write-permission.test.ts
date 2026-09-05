// SPDX-License-Identifier: MPL-2.0
import 'fake-indexeddb/auto';

import { WikiSearchDatabase } from '../src/storage/database';
import {
  CACHE_VERSION_CONTRACT_KEY,
  CURRENT_VERSION_CONTRACT,
  FactWriteCompatibilityError,
  initializeVersionContract,
  inspectVersionContract,
} from '../src/storage/version-contract';
import { IncrementalSyncCoordinator } from '../src/sync/incremental-sync-coordinator';

describe('fact writer compatibility across live tabs', () => {
  it.each(['explicit', 'scheduled'] as const)('rejects an already-running tab after a format upgrade (%s)', async (mode) => {
    const name = `test-${crypto.randomUUID()}`;
    const oldTab = new WikiSearchDatabase(name);
    const newTab = new WikiSearchDatabase(name);
    await Promise.all([oldTab.open(), newTab.open()]);
    try {
      await initializeVersionContract(oldTab);
      const lockManager = new QueuedLocks();
      const oldWriter = new IncrementalSyncCoordinator(oldTab, { lockManager });
      const newWriter = new IncrementalSyncCoordinator(newTab, { lockManager });
      await oldWriter.runExclusive(async () => undefined);
      await newWriter.runExclusive(async () => {
        await newTab.syncState.put({
          key: CACHE_VERSION_CONTRACT_KEY,
          value: { ...CURRENT_VERSION_CONTRACT, pageFacts: 2 },
        });
      });
      const before = await oldTab.syncState.toArray();
      const task = vi.fn(async () => undefined);

      const attempt = mode === 'explicit' ? oldWriter.runExclusive(task) : oldWriter.runIfDue(task);
      await expect(attempt).rejects.toBeInstanceOf(FactWriteCompatibilityError);
      expect(task).not.toHaveBeenCalled();
      expect(await oldTab.syncState.toArray()).toEqual(before);
    } finally {
      oldTab.close();
      newTab.close();
      await oldTab.delete();
    }
  });

  it('checks the durable format after a queued writer obtains its lock', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    let release!: () => void;
    let started!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { started = resolve; });
    const lockManager = new QueuedLocks();
    const writer = new IncrementalSyncCoordinator(database, { lockManager });
    try {
      await initializeVersionContract(database);
      const upgrading = writer.runExclusive(async () => {
        started();
        await held;
        await database.syncState.put({ key: CACHE_VERSION_CONTRACT_KEY,
          value: { ...CURRENT_VERSION_CONTRACT, contentJobFormat: 2 } });
      });
      await ready;
      const task = vi.fn(async () => undefined);
      const queued = writer.runExclusive(task);
      const rejected = expect(queued).rejects.toBeInstanceOf(FactWriteCompatibilityError);
      release();
      await Promise.all([upgrading, rejected]);
      expect(task).not.toHaveBeenCalled();
    } finally {
      release();
      database.close();
      await database.delete();
    }
  });

  it('allows derived format differences without repeatedly rewriting the contract', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    try {
      const stored = { ...CURRENT_VERSION_CONTRACT, analyzerPipeline: 99,
        extractors: { wikitext: 99, bson: 99, lua: 99 } };
      await database.syncState.put({ key: CACHE_VERSION_CONTRACT_KEY, value: stored });
      const writer = new IncrementalSyncCoordinator(database, { lockManager: new QueuedLocks() });
      const task = vi.fn(async () => undefined);
      await writer.runExclusive(task);
      await writer.runIfDue(task);
      expect(task).toHaveBeenCalledTimes(2);
      expect((await database.syncState.get(CACHE_VERSION_CONTRACT_KEY))?.value).toEqual(stored);
    } finally {
      database.close();
      await database.delete();
    }
  });

  it('inspects legacy data without writes and registers it only inside the first granted write', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    try {
      await database.syncState.put({ key: 'local-sequence', value: 7 });
      await database.jobs.put({ type: 'wikitext-content', pageId: 1, status: 'pending' });
      const before = await database.syncState.toArray();
      expect(await inspectVersionContract(database)).toMatchObject({ status: 'compatible', registeredLegacy: false });
      expect(await database.syncState.toArray()).toEqual(before);
      const task = vi.fn(async () => {
        expect((await database.syncState.get(CACHE_VERSION_CONTRACT_KEY))?.value).toEqual(CURRENT_VERSION_CONTRACT);
      });
      const unavailable = new IncrementalSyncCoordinator(database, { lockManager: null });
      expect(await unavailable.runExclusive(task)).toBe('lock-unavailable');
      expect(await database.syncState.toArray()).toEqual(before);
      expect(task).not.toHaveBeenCalled();
      const writer = new IncrementalSyncCoordinator(database, { lockManager: new QueuedLocks() });
      expect(await writer.runExclusive(task)).toBe('ran');
      expect((await database.syncState.get('local-sequence'))?.value).toBe(7);
      expect(await database.jobs.count()).toBe(1);
    } finally {
      database.close();
      await database.delete();
    }
  });

  it.each([
    ['malformed', { pageFacts: 1 }],
    ['old facts', { ...CURRENT_VERSION_CONTRACT, pageFacts: 0 }],
    ['future schema', { ...CURRENT_VERSION_CONTRACT, databaseSchema: 4 }],
  ])('refuses %s without changing durable state', async (_label, contract) => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    try {
      await database.syncState.put({ key: CACHE_VERSION_CONTRACT_KEY, value: contract });
      const before = await database.syncState.toArray();
      const task = vi.fn(async () => undefined);
      const writer = new IncrementalSyncCoordinator(database, { lockManager: new QueuedLocks() });
      await expect(writer.runIfDue(task)).rejects.toBeInstanceOf(FactWriteCompatibilityError);
      expect(task).not.toHaveBeenCalled();
      expect(await database.syncState.toArray()).toEqual(before);
    } finally {
      database.close();
      await database.delete();
    }
  });
});

class QueuedLocks {
  private busy = false;
  private readonly waiters: Array<() => void> = [];

  async request<T>(
    _name: string,
    options: LockOptions,
    callback: LockGrantedCallback<T>,
  ): Promise<T> {
    if (this.busy && options.ifAvailable) return callback(null);
    if (this.busy) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.busy = true;
    try {
      return await callback({ name: 'test-lock', mode: 'exclusive' });
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.busy = false;
    }
  }
}
