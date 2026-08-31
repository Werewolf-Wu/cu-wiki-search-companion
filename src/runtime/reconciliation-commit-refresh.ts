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
  private broadcastBaselineInitialized = false;
  private lastBroadcastSequence = 0;

  constructor(private readonly options: CommittedReconciliationRefreshOptions) {}

  async apply(): Promise<CommittedReconciliationRefreshResult | undefined> {
    const state = await this.options.readState();
    if (!state) return undefined;
    const startSequence = normalizeSequence(state.startLocalSeq, 0);
    const committedSequence = Math.max(
      startSequence,
      normalizeSequence(state.throughLocalSeq as unknown, startSequence),
    );
    const hasCommittedFacts = committedSequence > startSequence;
    if (!hasCommittedFacts && !state.dataCodesInvalidated) return undefined;

    const lastAppliedBefore = this.options.lastAppliedSequence();
    if (hasCommittedFacts && !this.broadcastBaselineInitialized) {
      this.broadcastBaselineInitialized = true;
      if (committedSequence <= lastAppliedBefore) {
        this.lastBroadcastSequence = committedSequence;
      }
    }
    const shouldRefresh = hasCommittedFacts && committedSequence > lastAppliedBefore;
    const shouldBroadcast =
      hasCommittedFacts && committedSequence > this.lastBroadcastSequence;
    if (!shouldRefresh && !shouldBroadcast && !state.dataCodesInvalidated) {
      return undefined;
    }

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
          throughLocalSeq: committedSequence,
          filesChanged: state.filesChanged,
        });
        this.lastBroadcastSequence = committedSequence;
      } catch (error) {
        if (!refreshError) throw error;
      }
    }
    return {
      throughLocalSeq: committedSequence,
      dataCodesInvalidated: state.dataCodesInvalidated,
      ...(refreshError ? { refreshError } : {}),
    };
  }
}

function normalizeSequence(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;
}
