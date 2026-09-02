// SPDX-License-Identifier: MPL-2.0
import type {
  RecentChangeSyncResult,
  ReconciliationSyncResult,
  ReconciliationSyncState,
} from '../types';

export type SyncAttemptResult =
  | { status: 'complete' }
  | { status: 'error'; error: unknown };

export interface MirrorSyncCoordinator {
  runIfDue(task: () => Promise<boolean | void>): Promise<
    'ran' | 'not-due' | 'lock-unavailable'
  >;
  runExclusive(task: () => Promise<void>): Promise<'ran' | 'lock-unavailable'>;
}

export interface MirrorSyncFacts {
  reconcile(
    force: boolean,
    onProgress: (state: ReconciliationSyncState) => void,
  ): Promise<ReconciliationSyncResult>;
  catchUp(): Promise<RecentChangeSyncResult>;
}

export interface CommittedReconciliationResult {
  dataCodesInvalidated: boolean;
  refreshError?: unknown;
}

export interface MirrorSyncCommittedRefresh {
  refreshReconciliation(): Promise<CommittedReconciliationResult | undefined>;
  refreshRecentChanges(
    result: Extract<RecentChangeSyncResult, { status: 'complete' }>,
  ): Promise<{ dataCodesInvalidated: boolean }>;
}

export interface MirrorSyncDerivedRefresh {
  refreshData(): Promise<SyncAttemptResult>;
  hasLoadedContentIndex(): boolean;
  refreshContent(): Promise<void>;
}

export type MirrorSyncEvent =
  | { type: 'started'; request: MirrorSyncRequest }
  | { type: 'reconciliation-started'; request: MirrorSyncRequest }
  | { type: 'reconciliation-progress'; state: ReconciliationSyncState };

export type MirrorSyncRequest = 'scheduled' | 'manual';

export interface MirrorSyncOutcome {
  request: MirrorSyncRequest;
  status:
    | 'complete'
    | 'not-due'
    | 'no-baseline'
    | 'login-required'
    | 'lock-unavailable'
    | 'catch-up-error'
    | 'data-error'
    | 'content-error'
    | 'error';
  coordination: 'ran' | 'not-due' | 'lock-unavailable';
  reconciliation?: ReconciliationSyncResult;
  recentChanges?: RecentChangeSyncResult;
  committedReconciliation?: CommittedReconciliationResult;
  dataRefresh?: SyncAttemptResult;
  contentRefresh?: 'complete' | 'not-loaded';
  errors?: {
    synchronization?: unknown;
    catchUp?: unknown;
    committedRefresh?: unknown;
    data?: unknown;
    content?: unknown;
  };
}

export interface MirrorSyncOrchestratorOptions {
  coordinator: MirrorSyncCoordinator;
  facts: MirrorSyncFacts;
  committed: MirrorSyncCommittedRefresh;
  derived: MirrorSyncDerivedRefresh;
  onEvent?(event: MirrorSyncEvent): void;
}

/** Owns mirror synchronization ordering, in-flight requests, and post-lock work. */
export class MirrorSyncOrchestrator {
  private scheduledRequest: Promise<MirrorSyncOutcome> | undefined;
  private manualRequest: Promise<MirrorSyncOutcome> | undefined;

  constructor(private readonly options: MirrorSyncOrchestratorOptions) {}

  runScheduled(): Promise<MirrorSyncOutcome> {
    if (this.scheduledRequest) return this.scheduledRequest;
    const request = this.run('scheduled');
    const tracked = request.finally(() => {
      if (this.scheduledRequest === tracked) this.scheduledRequest = undefined;
    });
    this.scheduledRequest = tracked;
    return tracked;
  }

  reconcileNow(): Promise<MirrorSyncOutcome> {
    if (this.manualRequest) return this.manualRequest;
    const request = this.run('manual');
    const tracked = request.finally(() => {
      if (this.manualRequest === tracked) this.manualRequest = undefined;
    });
    this.manualRequest = tracked;
    return tracked;
  }

  private async run(request: MirrorSyncRequest): Promise<MirrorSyncOutcome> {
    this.options.onEvent?.({ type: 'started', request });
    let reconciliation: ReconciliationSyncResult | undefined;
    let reconciliationStarted = false;
    let recentChanges: RecentChangeSyncResult | undefined;
    let synchronizationError: unknown;
    let catchUpError: unknown;
    const writerTask = async (): Promise<boolean> => {
      reconciliationStarted = true;
      this.options.onEvent?.({ type: 'reconciliation-started', request });
      try {
        reconciliation = await this.options.facts.reconcile(
          request === 'manual',
          (state) =>
            this.options.onEvent?.({ type: 'reconciliation-progress', state }),
        );
      } catch (error) {
        synchronizationError = error;
        return false;
      }
      if (reconciliation.status === 'login-required') return false;
      if (request === 'manual' && reconciliation.status !== 'complete') return false;
      try {
        recentChanges = await this.options.facts.catchUp();
      } catch (error) {
        catchUpError = error;
        return false;
      }
      return recentChanges.status === 'complete';
    };

    let coordination: MirrorSyncOutcome['coordination'] = 'ran';
    try {
      coordination =
        request === 'scheduled'
          ? await this.options.coordinator.runIfDue(writerTask)
          : await this.options.coordinator.runExclusive(async () => {
              await writerTask();
            });
    } catch (error) {
      synchronizationError ??= error;
    }
    if (coordination !== 'ran') return { request, status: coordination, coordination };

    let committedReconciliation: CommittedReconciliationResult | undefined;
    let committedRefreshError: unknown;
    if (reconciliationStarted) {
      try {
        committedReconciliation =
          await this.options.committed.refreshReconciliation();
        committedRefreshError = committedReconciliation?.refreshError;
      } catch (error) {
        committedRefreshError = error;
      }
    }

    let dataInvalidated = committedReconciliation?.dataCodesInvalidated === true;
    if (recentChanges?.status === 'complete') {
      try {
        const committedRecentChanges =
          await this.options.committed.refreshRecentChanges(recentChanges);
        dataInvalidated ||= committedRecentChanges.dataCodesInvalidated;
      } catch (error) {
        committedRefreshError ??= error;
      }
    }

    let dataRefresh: SyncAttemptResult | undefined;
    let dataError: unknown;
    if (dataInvalidated) {
      try {
        dataRefresh = await this.options.derived.refreshData();
        if (dataRefresh.status === 'error') dataError = dataRefresh.error;
      } catch (error) {
        dataError = error;
        dataRefresh = { status: 'error', error };
      }
    }

    const contentNeeded =
      reconciliation?.status === 'complete' ||
      (recentChanges?.status === 'complete' &&
        recentChanges.deferredContentPageIds.length > 0);
    let contentRefresh: MirrorSyncOutcome['contentRefresh'];
    let contentError: unknown;
    if (contentNeeded) {
      if (this.options.derived.hasLoadedContentIndex()) {
        try {
          await this.options.derived.refreshContent();
          contentRefresh = 'complete';
        } catch (error) {
          contentError = error;
        }
      } else {
        contentRefresh = 'not-loaded';
      }
    }

    const errors = {
      ...(synchronizationError ? { synchronization: synchronizationError } : {}),
      ...(catchUpError ? { catchUp: catchUpError } : {}),
      ...(committedRefreshError ? { committedRefresh: committedRefreshError } : {}),
      ...(dataError ? { data: dataError } : {}),
      ...(contentError ? { content: contentError } : {}),
    };
    const status = outcomeStatus({
      reconciliation,
      recentChanges,
      synchronizationError,
      catchUpError,
      committedRefreshError,
      dataError,
      contentError,
    });
    return {
      request,
      status,
      coordination,
      ...(reconciliation ? { reconciliation } : {}),
      ...(recentChanges ? { recentChanges } : {}),
      ...(committedReconciliation ? { committedReconciliation } : {}),
      ...(dataRefresh ? { dataRefresh } : {}),
      ...(contentRefresh ? { contentRefresh } : {}),
      ...(Object.keys(errors).length ? { errors } : {}),
    };
  }
}

interface OutcomeStatusInput {
  reconciliation?: ReconciliationSyncResult;
  recentChanges?: RecentChangeSyncResult;
  synchronizationError?: unknown;
  catchUpError?: unknown;
  committedRefreshError?: unknown;
  dataError?: unknown;
  contentError?: unknown;
}

function outcomeStatus(input: OutcomeStatusInput): MirrorSyncOutcome['status'] {
  if (input.synchronizationError) return 'error';
  if (input.reconciliation?.status === 'login-required') return 'login-required';
  if (input.catchUpError) return 'catch-up-error';
  if (input.recentChanges?.status === 'login-required') return 'login-required';
  if (
    input.reconciliation?.status === 'no-baseline' &&
    (!input.recentChanges || input.recentChanges.status === 'no-baseline')
  ) {
    return 'no-baseline';
  }
  if (input.reconciliation?.status === 'not-due' && !input.recentChanges) {
    return 'not-due';
  }
  if (input.dataError) return 'data-error';
  if (input.contentError) return 'content-error';
  if (input.committedRefreshError) return 'error';
  return 'complete';
}
