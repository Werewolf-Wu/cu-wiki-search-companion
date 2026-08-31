// SPDX-License-Identifier: MPL-2.0
import { StagedPreparationCoordinator } from './staged-preparation';

describe('StagedPreparationCoordinator', () => {
  it('makes the local stage usable before settlement finishes', async () => {
    let releaseSettlement!: () => void;
    const settlement = new Promise<void>((resolve) => {
      releaseSettlement = resolve;
    });
    let localUsable = false;
    let settled = false;
    const coordinator = new StagedPreparationCoordinator({
      prepareLocal: async () => {
        localUsable = true;
      },
      settle: async () => {
        await settlement;
        settled = true;
      },
    });

    const preparing = coordinator.prepare();
    await vi.waitFor(() => expect(localUsable).toBe(true));

    expect(settled).toBe(false);
    releaseSettlement();
    await preparing;
    expect(settled).toBe(true);
  });

  it('keeps a successful local stage while retrying a failed settlement', async () => {
    const originalError = new Error('标题同步失败');
    const prepareLocal = vi.fn(async () => undefined);
    const settle = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(originalError)
      .mockResolvedValue(undefined);
    const coordinator = new StagedPreparationCoordinator({ prepareLocal, settle });

    await expect(coordinator.prepare()).rejects.toBe(originalError);
    await coordinator.prepare();

    expect(prepareLocal).toHaveBeenCalledOnce();
    expect(settle).toHaveBeenCalledTimes(2);
  });

  it('waits only for an already active local assignment before maintenance replaces it', async () => {
    let releaseLocal!: () => void;
    const localBlocked = new Promise<void>((resolve) => {
      releaseLocal = resolve;
    });
    let releaseSettlement!: () => void;
    const settlementBlocked = new Promise<void>((resolve) => {
      releaseSettlement = resolve;
    });
    const order: string[] = [];
    const coordinator = new StagedPreparationCoordinator({
      prepareLocal: async () => {
        await localBlocked;
        order.push('old-local-assignment');
      },
      settle: async () => settlementBlocked,
    });
    const preparing = coordinator.prepare();
    const maintenance = coordinator.waitForActiveLocal().then(() => {
      order.push('maintenance-rebuild');
    });

    await Promise.resolve();
    expect(order).toEqual([]);
    releaseLocal();
    await maintenance;

    expect(order).toEqual(['old-local-assignment', 'maintenance-rebuild']);

    const unusedLocal = vi.fn(async () => undefined);
    const unused = new StagedPreparationCoordinator({
      prepareLocal: unusedLocal,
      settle: vi.fn(async () => undefined),
    });
    await unused.waitForActiveLocal();
    expect(unusedLocal).not.toHaveBeenCalled();

    releaseSettlement();
    await preparing;
  });
});
