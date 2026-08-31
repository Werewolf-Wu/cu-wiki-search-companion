// SPDX-License-Identifier: MPL-2.0
import type { ReconciliationSyncState } from '../types';
import { CommittedReconciliationRefresh } from './reconciliation-commit-refresh';

describe('CommittedReconciliationRefresh', () => {
  it('exposes a committed Data invalidation for post-lock cache refresh', async () => {
    const refresh = new CommittedReconciliationRefresh({
      readState: async () =>
        reconciliationState({ throughLocalSeq: 13, dataCodesInvalidated: true }),
      lastAppliedSequence: () => 10,
      refresh: async () => undefined,
      broadcast: vi.fn(),
    });

    await expect(refresh.apply()).resolves.toEqual({
      throughLocalSeq: 13,
      dataCodesInvalidated: true,
    });
  });

  it('broadcasts a committed Data invalidation to other tabs', async () => {
    const broadcast = vi.fn();
    const refresh = new CommittedReconciliationRefresh({
      readState: async () =>
        reconciliationState({ throughLocalSeq: 13, dataCodesInvalidated: true }),
      lastAppliedSequence: () => 10,
      refresh: async () => undefined,
      broadcast,
    });

    await refresh.apply();

    expect(broadcast).toHaveBeenCalledWith({
      type: 'reconciled',
      throughLocalSeq: 13,
      filesChanged: false,
      dataCodesInvalidated: true,
    });
  });

  it('re-exposes Data invalidation without a new local sequence so a failed refresh can retry', async () => {
    let lastApplied = 10;
    const refreshStorage = vi.fn(async () => {
      lastApplied = 13;
    });
    const broadcast = vi.fn();
    const refresh = new CommittedReconciliationRefresh({
      readState: async () =>
        reconciliationState({
          status: 'failed',
          throughLocalSeq: 13,
          dataCodesInvalidated: true,
        }),
      lastAppliedSequence: () => lastApplied,
      refresh: refreshStorage,
      broadcast,
    });

    await expect(refresh.apply()).resolves.toMatchObject({ dataCodesInvalidated: true });
    await expect(refresh.apply()).resolves.toEqual({
      throughLocalSeq: 13,
      dataCodesInvalidated: true,
    });
    expect(refreshStorage).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledOnce();
  });

  it('refreshes and broadcasts a failed reconciliation batch that advanced local facts', async () => {
    const order: string[] = [];
    const refresh = new CommittedReconciliationRefresh({
      readState: async () =>
        reconciliationState({
          status: 'failed',
          throughLocalSeq: 12,
          pagesChanged: 1,
        }),
      lastAppliedSequence: () => 10,
      refresh: async (invalidation) => {
        order.push(`refresh:${String(invalidation.pages)}:${String(invalidation.files)}`);
      },
      broadcast: (message) => {
        order.push(
          `broadcast:${message.throughLocalSeq}:${String(message.filesChanged)}`,
        );
      },
    });

    await expect(refresh.apply()).resolves.toEqual({
      throughLocalSeq: 12,
      dataCodesInvalidated: false,
    });
    expect(order).toEqual(['refresh:true:false', 'broadcast:12:false']);
  });

  it('does nothing when reconciliation has not committed a newer searchable fact', async () => {
    const refreshStorage = vi.fn(async () => undefined);
    const broadcast = vi.fn();
    const refresh = new CommittedReconciliationRefresh({
      readState: async () => reconciliationState({ status: 'running' }),
      lastAppliedSequence: () => 10,
      refresh: refreshStorage,
      broadcast,
    });

    await expect(refresh.apply()).resolves.toBeUndefined();
    expect(refreshStorage).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('does not broadcast historical completed state already applied by this tab', async () => {
    const refreshStorage = vi.fn(async () => undefined);
    const broadcast = vi.fn();
    const refresh = new CommittedReconciliationRefresh({
      readState: async () =>
        reconciliationState({
          status: 'complete',
          throughLocalSeq: 12,
          pagesChanged: 1,
          completedAt: 2,
        }),
      lastAppliedSequence: () => 12,
      refresh: refreshStorage,
      broadcast,
    });

    await expect(refresh.apply()).resolves.toBeUndefined();
    expect(refreshStorage).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('retries a failed broadcast without repeating an already successful refresh', async () => {
    const broadcastError = new Error('BroadcastChannel 暂时不可用');
    let committedSequence = 12;
    let lastApplied = 12;
    const refreshStorage = vi.fn(async () => {
      lastApplied = committedSequence;
    });
    const broadcast = vi
      .fn<(message: unknown) => void>()
      .mockImplementationOnce(() => {
        throw broadcastError;
      })
      .mockImplementation(() => undefined);
    const refresh = new CommittedReconciliationRefresh({
      readState: async () =>
        reconciliationState({
          status: 'complete',
          throughLocalSeq: committedSequence,
          pagesChanged: 1,
          completedAt: 2,
        }),
      lastAppliedSequence: () => lastApplied,
      refresh: refreshStorage,
      broadcast,
    });

    await expect(refresh.apply()).resolves.toBeUndefined();
    expect(refreshStorage).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();

    committedSequence = 13;
    await expect(refresh.apply()).rejects.toBe(broadcastError);
    await expect(refresh.apply()).resolves.toEqual({
      throughLocalSeq: 13,
      dataCodesInvalidated: false,
    });
    expect(refreshStorage).toHaveBeenCalledOnce();
    expect(broadcast).toHaveBeenCalledTimes(2);
  });

  it('still broadcasts durable facts when this tab cannot refresh its derived index', async () => {
    const refreshError = new Error('本标签索引刷新失败');
    const broadcast = vi.fn();
    const refresh = new CommittedReconciliationRefresh({
      readState: async () =>
        reconciliationState({ throughLocalSeq: 11, filesChanged: true }),
      lastAppliedSequence: () => 10,
      refresh: async () => {
        throw refreshError;
      },
      broadcast,
    });

    await expect(refresh.apply()).resolves.toEqual({
      throughLocalSeq: 11,
      dataCodesInvalidated: false,
      refreshError,
    });
    expect(broadcast).toHaveBeenCalledWith({
      type: 'reconciled',
      throughLocalSeq: 11,
      filesChanged: true,
      dataCodesInvalidated: false,
    });
  });

  it.each([
    ['missing', undefined],
    ['NaN', Number.NaN],
    ['negative', -1],
    ['non-number', '12'],
  ])('normalizes %s legacy throughLocalSeq before returning Data invalidation', async (_label, rawThrough) => {
    const refreshStorage = vi.fn(async () => undefined);
    const broadcast = vi.fn();
    const persisted = {
      ...reconciliationState({ dataCodesInvalidated: true }),
      throughLocalSeq: rawThrough,
    } as unknown as ReconciliationSyncState;
    const refresh = new CommittedReconciliationRefresh({
      readState: async () => persisted,
      lastAppliedSequence: () => 10,
      refresh: refreshStorage,
      broadcast,
    });

    await expect(refresh.apply()).resolves.toEqual({
      throughLocalSeq: 10,
      dataCodesInvalidated: true,
    });
    expect(refreshStorage).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });
});

function reconciliationState(
  overrides: Partial<ReconciliationSyncState>,
): ReconciliationSyncState {
  return {
    status: 'running',
    scanProtocol: 2,
    reason: 'scheduled',
    namespaceIds: [0],
    namespaceNames: { 0: '' },
    namespaceIndex: 1,
    generation: 1,
    startLocalSeq: 10,
    throughLocalSeq: 10,
    serverStartedAt: '2026-09-01T00:00:00Z',
    pagesFetched: 1,
    pagesChanged: 0,
    filesChanged: false,
    dataCodesInvalidated: false,
    startedAt: 1,
    ...overrides,
  };
}
