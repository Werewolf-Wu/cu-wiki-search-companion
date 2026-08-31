// SPDX-License-Identifier: MPL-2.0
import { changeBroadcastEffect } from './change-broadcast';

describe('changeBroadcastEffect', () => {
  it('rearms Data refresh for committed fact invalidations', () => {
    expect(
      changeBroadcastEffect({
        type: 'committed',
        throughLocalSeq: 13,
        filesChanged: true,
        dataCodesInvalidated: true,
      }),
    ).toEqual({
      type: 'refresh',
      invalidation: { pages: true, files: true },
      dataRefresh: 'pending',
    });
  });

  it('clears pending work when another tab commits refreshed Data records', () => {
    expect(changeBroadcastEffect({ type: 'data-committed' })).toEqual({
      type: 'refresh',
      invalidation: { data: true },
      dataRefresh: 'complete',
    });
  });

  it('keeps reset separate from cache invalidation', () => {
    expect(changeBroadcastEffect({ type: 'reset' })).toEqual({ type: 'reset' });
  });
});
