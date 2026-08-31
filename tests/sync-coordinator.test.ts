// SPDX-License-Identifier: MPL-2.0
import 'fake-indexeddb/auto';

import { WikiSearchDatabase } from '../src/storage/database';
import { IncrementalSyncCoordinator } from '../src/sync/incremental-sync-coordinator';

describe('incremental sync coordinator', () => {
  it('allows only one tab to run a due sync task', async () => {
    const databaseName = `test-${crypto.randomUUID()}`;
    const firstDatabase = new WikiSearchDatabase(databaseName);
    const secondDatabase = new WikiSearchDatabase(databaseName);
    await Promise.all([firstDatabase.open(), secondDatabase.open()]);
    const lockManager = new ContendedLockManager();
    const firstCoordinator = new IncrementalSyncCoordinator(firstDatabase, { lockManager });
    const secondCoordinator = new IncrementalSyncCoordinator(secondDatabase, { lockManager });
    let releaseTask!: () => void;
    let reportStarted!: () => void;
    const taskStarted = new Promise<void>((resolve) => {
      reportStarted = resolve;
    });
    const holdTask = new Promise<void>((resolve) => {
      releaseTask = resolve;
    });
    let tasksRun = 0;

    const firstRun = firstCoordinator.runIfDue(async () => {
      tasksRun += 1;
      reportStarted();
      await holdTask;
    });
    await taskStarted;
    const secondRun = await secondCoordinator.runIfDue(async () => {
      tasksRun += 1;
    });
    releaseTask();

    expect(await firstRun).toBe('ran');
    expect(secondRun).toBe('lock-unavailable');
    expect(tasksRun).toBe(1);

    firstDatabase.close();
    secondDatabase.close();
    await firstDatabase.delete();
  });

  it('shares the next due time across tabs and runs again only after it expires', async () => {
    const databaseName = `test-${crypto.randomUUID()}`;
    const firstDatabase = new WikiSearchDatabase(databaseName);
    const secondDatabase = new WikiSearchDatabase(databaseName);
    await Promise.all([firstDatabase.open(), secondDatabase.open()]);
    const lockManager = new ContendedLockManager();
    let now = 1_000;
    const firstCoordinator = new IncrementalSyncCoordinator(firstDatabase, {
      intervalMs: 1_000,
      jitterMs: 0,
      lockManager,
      now: () => now,
    });
    const secondCoordinator = new IncrementalSyncCoordinator(secondDatabase, {
      intervalMs: 1_000,
      jitterMs: 0,
      lockManager,
      now: () => now,
    });
    const tasksRun: string[] = [];

    const firstRun = await firstCoordinator.runIfDue(async () => {
      tasksRun.push('first');
    });
    const immediateSecondRun = await secondCoordinator.runIfDue(async () => {
      tasksRun.push('too-early');
    });
    now = 2_000;
    const laterSecondRun = await secondCoordinator.runIfDue(async () => {
      tasksRun.push('later');
    });

    expect(firstRun).toBe('ran');
    expect(immediateSecondRun).toBe('not-due');
    expect(laterSecondRun).toBe('ran');
    expect(tasksRun).toEqual(['first', 'later']);

    firstDatabase.close();
    secondDatabase.close();
    await firstDatabase.delete();
  });

  it('does not postpone the next attempt when the sync task fails', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    const coordinator = new IncrementalSyncCoordinator(database, {
      intervalMs: 1_000,
      jitterMs: 0,
      lockManager: new ContendedLockManager(),
      now: () => 1_000,
    });
    const tasksRun: string[] = [];

    await expect(
      coordinator.runIfDue(async () => {
        tasksRun.push('failed');
        throw new Error('模拟增量同步失败');
      }),
    ).rejects.toThrow('模拟增量同步失败');
    const retry = await coordinator.runIfDue(async () => {
      tasksRun.push('retry');
    });

    expect(retry).toBe('ran');
    expect(tasksRun).toEqual(['failed', 'retry']);

    database.close();
    await database.delete();
  });

  it('does not postpone the next attempt when the sync task reports a deferred outcome', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    const coordinator = new IncrementalSyncCoordinator(database, {
      intervalMs: 1_000,
      jitterMs: 0,
      lockManager: new ContendedLockManager(),
      now: () => 1_000,
    });
    const tasksRun: string[] = [];

    const deferred = await coordinator.runIfDue(async () => {
      tasksRun.push('login-required');
      return false;
    });
    const retry = await coordinator.runIfDue(async () => {
      tasksRun.push('retry');
      return true;
    });

    expect(deferred).toBe('ran');
    expect(retry).toBe('ran');
    expect(tasksRun).toEqual(['login-required', 'retry']);

    database.close();
    await database.delete();
  });

  it('does not run an exclusive writer when Web Locks are unavailable', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    const coordinator = new IncrementalSyncCoordinator(database, { lockManager: null });
    const task = vi.fn(async () => undefined);

    expect(await coordinator.runExclusive(task)).toBe('lock-unavailable');
    expect(task).not.toHaveBeenCalled();

    database.close();
    await database.delete();
  });

  it('queues an explicit full reconciliation behind the same writer lock', async () => {
    const databaseName = `test-${crypto.randomUUID()}`;
    const firstDatabase = new WikiSearchDatabase(databaseName);
    const secondDatabase = new WikiSearchDatabase(databaseName);
    await Promise.all([firstDatabase.open(), secondDatabase.open()]);
    const lockManager = new ContendedLockManager();
    const firstCoordinator = new IncrementalSyncCoordinator(firstDatabase, { lockManager });
    const secondCoordinator = new IncrementalSyncCoordinator(secondDatabase, { lockManager });
    let releaseIncremental!: () => void;
    let incrementalStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      incrementalStarted = resolve;
    });
    const held = new Promise<void>((resolve) => {
      releaseIncremental = resolve;
    });
    const order: string[] = [];

    const incremental = firstCoordinator.runIfDue(async () => {
      order.push('incremental-start');
      incrementalStarted();
      await held;
      order.push('incremental-end');
    });
    await started;
    const reconciliation = secondCoordinator.runExclusive(async () => {
      order.push('reconciliation');
    });
    await Promise.resolve();
    expect(order).toEqual(['incremental-start']);
    releaseIncremental();

    expect(await incremental).toBe('ran');
    expect(await reconciliation).toBe('ran');
    expect(order).toEqual(['incremental-start', 'incremental-end', 'reconciliation']);

    firstDatabase.close();
    secondDatabase.close();
    await firstDatabase.delete();
  });
});

class ContendedLockManager {
  private locked = false;
  private waiters: Array<() => void> = [];

  async request<T>(
    _name: string,
    _options: LockOptions,
    callback: LockGrantedCallback<T>,
  ): Promise<T> {
    if (this.locked && _options.ifAvailable) return callback(null);
    if (this.locked) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }

    this.locked = true;
    try {
      return await callback({ name: 'test-lock', mode: 'exclusive' });
    } finally {
      this.locked = false;
      this.waiters.shift()?.();
    }
  }
}
