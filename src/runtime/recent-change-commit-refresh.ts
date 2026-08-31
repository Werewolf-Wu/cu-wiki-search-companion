// SPDX-License-Identifier: MPL-2.0
import type { StorageInvalidationRequest } from './runtime-lifecycle-coordinator';

export interface CommittedRecentChange {
  throughLocalSeq: number;
  filesChanged: boolean;
  dataCodesInvalidated: boolean;
}

export interface RecentChangeCommitBroadcast extends CommittedRecentChange {
  type: 'committed';
}

export interface CommittedRecentChangeRefreshOptions {
  refresh(invalidation: StorageInvalidationRequest): Promise<void>;
  broadcast(message: RecentChangeCommitBroadcast): void;
}

/** Applies one durable recent-change result after its writer lock is released. */
export class CommittedRecentChangeRefresh {
  constructor(private readonly options: CommittedRecentChangeRefreshOptions) {}

  async apply(
    committed: CommittedRecentChange,
  ): Promise<{ dataCodesInvalidated: boolean }> {
    await this.options.refresh({ pages: true, files: committed.filesChanged });
    this.options.broadcast({ type: 'committed', ...committed });
    return { dataCodesInvalidated: committed.dataCodesInvalidated };
  }
}
