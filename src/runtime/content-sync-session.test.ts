// SPDX-License-Identifier: MPL-2.0
import { ContentSyncSession } from './content-sync-session';
import { StagedPreparationCoordinator } from './staged-preparation';

describe('ContentSyncSession', () => {
  it('reports and preserves a failed settlement while keeping local preparation', async () => {
    const originalError = new Error('第二批正文请求失败');
    const synchronize = vi
      .fn<(force: boolean) => Promise<void>>()
      .mockRejectedValueOnce(originalError)
      .mockResolvedValue(undefined);
    const failures: unknown[] = [];
    const session = new ContentSyncSession({
      synchronize,
      reportFailure: (error) => {
        failures.push(error);
      },
    });
    const prepareLocal = vi.fn(async () => undefined);
    const preparation = new StagedPreparationCoordinator({
      prepareLocal,
      settle: () => session.run(false),
    });

    await expect(preparation.prepare()).rejects.toBe(originalError);
    await expect(preparation.prepare()).resolves.toBeUndefined();

    expect(prepareLocal).toHaveBeenCalledOnce();
    expect(synchronize).toHaveBeenCalledTimes(2);
    expect(failures).toEqual([originalError]);
  });
});
