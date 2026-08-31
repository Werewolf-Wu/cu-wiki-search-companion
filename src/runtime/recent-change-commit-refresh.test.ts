// SPDX-License-Identifier: MPL-2.0
import { CommittedRecentChangeRefresh } from './recent-change-commit-refresh';

describe('CommittedRecentChangeRefresh', () => {
  it('applies and broadcasts the durable RC sequence for every caller', async () => {
    const refreshed: unknown[] = [];
    const broadcasts: unknown[] = [];
    const refresh = new CommittedRecentChangeRefresh({
      refresh: async (invalidation) => {
        refreshed.push(invalidation);
      },
      broadcast: (message) => {
        broadcasts.push(message);
      },
    });

    await expect(
      refresh.apply({
        throughLocalSeq: 13,
        filesChanged: true,
        dataCodesInvalidated: true,
      }),
    ).resolves.toEqual({ dataCodesInvalidated: true });
    expect(refreshed).toEqual([{ pages: true, files: true }]);
    expect(broadcasts).toEqual([
      {
        type: 'committed',
        throughLocalSeq: 13,
        filesChanged: true,
        dataCodesInvalidated: true,
      },
    ]);
  });
});
