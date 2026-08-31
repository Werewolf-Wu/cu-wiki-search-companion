// SPDX-License-Identifier: MPL-2.0
import type { ReconciliationSyncState } from '../types';
import { CommittedReconciliationRefresh } from './reconciliation-commit-refresh';

describe('CommittedReconciliationRefresh', () => {
  it('exposes a committed Data invalidation for post-lock cache refresh', async () => {
    const refresh = new CommittedReconciliationRefresh({
      readState: async () => reconciliationState({ dataCodesInvalidated: true }),
      readLocalSequence: async () => 13,
      lastAppliedSequence: () => 10,
      refresh: async () => undefined,
      broadcast: vi.fn(),
    });

    await expect(refresh.apply()).resolves.toEqual({
      throughLocalSeq: 13,
      dataCodesInvalidated: true,
    });
  });

  it('refreshes and broadcasts a failed reconciliation batch that advanced local facts', async () => {
    const order: string[] = [];
    const refresh = new CommittedReconciliationRefresh({
      readState: async () => reconciliationState({ status: 'failed', pagesChanged: 1 }),
      readLocalSequence: async () => 12,
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
      readLocalSequence: async () => 10,
      lastAppliedSequence: () => 10,
      refresh: refreshStorage,
      broadcast,
    });

    await expect(refresh.apply()).resolves.toBeUndefined();
    expect(refreshStorage).not.toHaveBeenCalled();
    expect(broadcast).not.toHaveBeenCalled();
  });

  it('broadcasts a committed batch even when this tab already applied the same sequence', async () => {
    const refreshStorage = vi.fn(async () => undefined);
    const broadcast = vi.fn();
    const refresh = new CommittedReconciliationRefresh({
      readState: async () => reconciliationState({ pagesChanged: 1 }),
      readLocalSequence: async () => 12,
      lastAppliedSequence: () => 12,
      refresh: refreshStorage,
      broadcast,
    });

    await expect(refresh.apply()).resolves.toEqual({
      throughLocalSeq: 12,
      dataCodesInvalidated: false,
    });
    expect(refreshStorage).not.toHaveBeenCalled();
    expect(broadcast).toHaveBeenCalledWith({
      type: 'reconciled',
      throughLocalSeq: 12,
      filesChanged: false,
    });
  });

  it('still broadcasts durable facts when this tab cannot refresh its derived index', async () => {
    const refreshError = new Error('本标签索引刷新失败');
    const broadcast = vi.fn();
    const refresh = new CommittedReconciliationRefresh({
      readState: async () => reconciliationState({ filesChanged: true }),
      readLocalSequence: async () => 11,
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
    });
  });
});

function reconciliationState(
  overrides: Partial<ReconciliationSyncState>,
): ReconciliationSyncState {
  return {
    status: 'running',
    reason: 'scheduled',
    namespaceIds: [0],
    namespaceNames: { 0: '' },
    namespaceIndex: 1,
    generation: 1,
    startLocalSeq: 10,
    serverStartedAt: '2026-09-01T00:00:00Z',
    pagesFetched: 1,
    pagesChanged: 0,
    filesChanged: false,
    dataCodesInvalidated: false,
    startedAt: 1,
    ...overrides,
  };
}
