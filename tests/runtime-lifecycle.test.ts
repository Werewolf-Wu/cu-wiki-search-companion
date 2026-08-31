// SPDX-License-Identifier: MPL-2.0
import {
  RuntimeLifecycleCoordinator,
  type ExclusiveWriter,
} from '../src/runtime/runtime-lifecycle-coordinator';

describe('runtime lifecycle coordinator', () => {
  it('deduplicates one tab content writer and queues another tab behind the shared lock', async () => {
    const writer = new QueuedWriter();
    const first = new RuntimeLifecycleCoordinator({
      applyStorageInvalidation: vi.fn(async () => undefined),
      writer,
    });
    const second = new RuntimeLifecycleCoordinator({
      applyStorageInvalidation: vi.fn(async () => undefined),
      writer,
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let firstRuns = 0;
    let secondRuns = 0;

    const firstRun = first.runContentWriter(async () => {
      firstRuns += 1;
      await held;
    });
    const duplicate = first.runContentWriter(async () => {
      firstRuns += 1;
    });
    const secondRun = second.runContentWriter(async () => {
      secondRuns += 1;
    });
    await vi.waitFor(() => expect(firstRuns).toBe(1));

    expect(secondRuns).toBe(0);
    release();
    expect(await firstRun).toBe('ran');
    expect(await duplicate).toBe('ran');
    expect(await secondRun).toBe('ran');
    expect(firstRuns).toBe(1);
    expect(secondRuns).toBe(1);
  });

  it('deduplicates named writers locally while sharing the cross-tab lock', async () => {
    const writer = new QueuedWriter();
    const first = new RuntimeLifecycleCoordinator({
      applyStorageInvalidation: vi.fn(async () => undefined),
      writer,
    });
    const second = new RuntimeLifecycleCoordinator({
      applyStorageInvalidation: vi.fn(async () => undefined),
      writer,
    });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const order: string[] = [];

    const dataWrite = first.runWriter('data', async () => {
      order.push('data-start');
      await held;
      order.push('data-end');
    });
    const duplicate = first.runWriter('data', async () => {
      order.push('duplicate');
    });
    const maintenance = second.runWriter('maintenance-index', async () => {
      order.push('maintenance');
    });
    await vi.waitFor(() => expect(order).toEqual(['data-start']));

    release();
    await Promise.all([dataWrite, duplicate, maintenance]);

    expect(order).toEqual(['data-start', 'data-end', 'maintenance']);
  });

  it('serializes refreshes and coalesces invalidations that arrive during a refresh', async () => {
    let finishFirst!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const applied: Array<{ pages: boolean; files: boolean; data: boolean }> = [];
    const coordinator = new RuntimeLifecycleCoordinator({
      applyStorageInvalidation: vi.fn(async (invalidation) => {
        applied.push(invalidation);
        if (applied.length === 1) await firstHeld;
      }),
    });

    const first = coordinator.refreshStorage({ pages: true });
    await vi.waitFor(() => expect(applied).toHaveLength(1));
    const files = coordinator.refreshStorage({ files: true });
    const data = coordinator.refreshStorage({ data: true });

    expect(applied).toEqual([{ pages: true, files: false, data: false }]);
    finishFirst();
    await Promise.all([first, files, data]);
    expect(applied).toEqual([
      { pages: true, files: false, data: false },
      { pages: false, files: true, data: true },
    ]);
  });

  it('retains every hidden-tab invalidation kind until visibility resumes', async () => {
    const apply = vi.fn(async () => undefined);
    const coordinator = new RuntimeLifecycleCoordinator({
      applyStorageInvalidation: apply,
    });

    coordinator.deferStorageRefresh({ pages: true });
    coordinator.deferStorageRefresh({ files: true });
    coordinator.deferStorageRefresh({ data: true });
    expect(apply).not.toHaveBeenCalled();

    await coordinator.resumeStorageRefresh();

    expect(apply).toHaveBeenCalledOnce();
    expect(apply).toHaveBeenCalledWith({ pages: true, files: true, data: true });
  });

  it('retains a failed refresh batch so a later visibility resume can retry it', async () => {
    const apply = vi
      .fn<(invalidation: { pages: boolean; files: boolean; data: boolean }) => Promise<void>>()
      .mockRejectedValueOnce(new Error('IndexedDB 暂时不可读'))
      .mockResolvedValue(undefined);
    const coordinator = new RuntimeLifecycleCoordinator({
      applyStorageInvalidation: apply,
    });

    await expect(
      coordinator.refreshStorage({ pages: true, files: true }),
    ).rejects.toThrow('IndexedDB 暂时不可读');
    await coordinator.resumeStorageRefresh();

    expect(apply).toHaveBeenCalledTimes(2);
    expect(apply).toHaveBeenLastCalledWith({ pages: true, files: true, data: false });
  });

  it('retries the title baseline before reconciliation and dependent refreshes', async () => {
    const order: string[] = [];
    const coordinator = new RuntimeLifecycleCoordinator({
      applyStorageInvalidation: vi.fn(async () => undefined),
    });

    await coordinator.refreshMirror({
      syncTitles: async () => {
        order.push('titles');
      },
      reconcile: async () => {
        order.push('reconcile');
      },
      syncData: async () => {
        order.push('data');
      },
      syncContent: async () => {
        order.push('content');
      },
    });

    expect(order).toEqual(['titles', 'reconcile', 'data', 'content']);
  });

  it('does not overwrite a failed title retry with later completion', async () => {
    const reconcile = vi.fn(async () => undefined);
    const syncData = vi.fn(async () => undefined);
    const syncContent = vi.fn(async () => undefined);
    const coordinator = new RuntimeLifecycleCoordinator({
      applyStorageInvalidation: vi.fn(async () => undefined),
    });

    await expect(
      coordinator.refreshMirror({
        syncTitles: async () => {
          throw new Error('网络仍不可用');
        },
        reconcile,
        syncData,
        syncContent,
      }),
    ).rejects.toThrow('网络仍不可用');
    expect(reconcile).not.toHaveBeenCalled();
    expect(syncData).not.toHaveBeenCalled();
    expect(syncContent).not.toHaveBeenCalled();
  });
});

class QueuedWriter implements ExclusiveWriter {
  private active = false;
  private waiters: Array<() => void> = [];

  async runExclusive(task: () => Promise<void>): Promise<'ran' | 'lock-unavailable'> {
    if (this.active) await new Promise<void>((resolve) => this.waiters.push(resolve));
    this.active = true;
    try {
      await task();
      return 'ran';
    } finally {
      this.active = false;
      this.waiters.shift()?.();
    }
  }
}
