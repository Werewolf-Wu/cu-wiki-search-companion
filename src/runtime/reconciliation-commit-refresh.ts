// SPDX-License-Identifier: MPL-2.0
import type { ReconciliationSyncState } from '../types';
import type { StorageInvalidationRequest } from './runtime-lifecycle-coordinator';

export interface ReconciliationCommitBroadcast {
  type: 'reconciled';
  throughLocalSeq: number;
  filesChanged: boolean;
}

export interface CommittedReconciliationRefreshOptions {
  readState(): Promise<ReconciliationSyncState | undefined>;
  readLocalSequence(): Promise<number>;
  lastAppliedSequence(): number;
  refresh(invalidation: StorageInvalidationRequest): Promise<void>;
  broadcast(message: ReconciliationCommitBroadcast): void;
}

export interface CommittedReconciliationRefreshResult {
  throughLocalSeq: number;
  dataCodesInvalidated: boolean;
  refreshError?: unknown;
}

/** Applies durable reconciliation batches after their cross-tab writer lock is gone. */
export class CommittedReconciliationRefresh {
  private lastBroadcastSequence = 0;

  constructor(private readonly options: CommittedReconciliationRefreshOptions) {}

  async apply(): Promise<CommittedReconciliationRefreshResult | undefined> {
    const [state, localSequence] = await Promise.all([
      this.options.readState(),
      this.options.readLocalSequence(),
    ]);
    if (!state || localSequence <= state.startLocalSeq) return undefined;

    const shouldRefresh = localSequence > this.options.lastAppliedSequence();
    const shouldBroadcast = localSequence > this.lastBroadcastSequence;
    if (!shouldRefresh && !shouldBroadcast) return undefined;

    let refreshError: unknown;
    try {
      if (shouldRefresh) {
        await this.options.refresh({ pages: true, files: state.filesChanged });
      }
    } catch (error) {
      refreshError = error;
    }
    if (shouldBroadcast) {
      try {
        this.options.broadcast({
          type: 'reconciled',
          throughLocalSeq: localSequence,
          filesChanged: state.filesChanged,
        });
        this.lastBroadcastSequence = localSequence;
      } catch (error) {
        if (!refreshError) throw error;
      }
    }
    return {
      throughLocalSeq: localSequence,
      dataCodesInvalidated: state.dataCodesInvalidated,
      ...(refreshError ? { refreshError } : {}),
    };
  }
}
