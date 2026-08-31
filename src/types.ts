// SPDX-License-Identifier: MPL-2.0
export interface PageRecord {
  id: number;
  title: string;
  normalizedTitle: string;
  namespace: number;
  namespaceName: string;
  isRedirect: boolean;
  localSeq: number;
  /** Comparable global sequence for file-row writes; legacy file localSeq held revisions. */
  writerSeq?: number;
  seenInTitleSync: number;
  seenInReconciliation?: number;
  deleted?: boolean;
  revisionId?: number;
  contentModel?: string;
  content?: string;
  contentRevisionId?: number;
}

export interface JobRecord {
  id?: number;
  type: string;
  pageId: number;
  status: 'pending' | 'running' | 'done' | 'failed';
  targetRevisionId?: number;
  error?: string;
  updatedAt?: number;
}

export interface SyncStateRecord<T = unknown> {
  key: string;
  value: T;
}

export interface IndexSnapshotRecord {
  key: string;
  kind: 'title' | 'content' | 'lua';
  snapshotFormatVersion: number;
  compatibilityKey: string;
  throughLocalSeq: number;
  createdAt: number;
  documentCount: number;
  payloadBytes: number;
  sha256: string;
  json: string;
  serializationMs?: number;
}

export interface DataCodeRecord {
  source: string;
  code: string;
  chineseName: string;
  normalizedName: string;
  searchText?: string;
  normalizedSearchText?: string;
  normalizedSearchValues?: string[];
  dataType: string;
  syncedAt: number;
}

export interface DataCodeSyncState {
  syncedAt: number;
  count: number;
  rulesSource?: string;
  indexVersion?: number;
}

export interface NamespaceInfo {
  id: number;
  name: string;
}

export interface TitleSyncState {
  status: 'running' | 'complete' | 'failed';
  namespaceIds: number[];
  namespaceNames: Record<number, string>;
  namespaceIndex: number;
  apcontinue?: string;
  generation: number;
  pagesFetched: number;
  startedAt: number;
  completedAt?: number;
  error?: string;
}

export interface TitleSyncProgress {
  status: TitleSyncState['status'];
  pagesFetched: number;
  namespaceIndex: number;
  namespaceCount: number;
  namespaceName?: string;
  error?: string;
}

export interface ContentSyncProgress {
  total: number;
  done: number;
  pending: number;
  failed: number;
}

export interface RecentChangeMarker {
  rcid: number;
  timestamp: string;
}

export interface RecentChangeSyncState {
  through: string;
  completedAt: number;
  recentChanges: RecentChangeMarker[];
  fileChangeSeq?: number;
}

export type ReconciliationReason = 'scheduled' | 'rc-gap' | 'manual';

export interface ReconciliationSyncState {
  status: 'running' | 'complete' | 'failed';
  scanProtocol: number;
  reason: ReconciliationReason;
  namespaceIds: number[];
  namespaceNames: Record<number, string>;
  namespaceIndex: number;
  gapcontinue?: string;
  generation: number;
  startLocalSeq: number;
  throughLocalSeq: number;
  serverStartedAt: string;
  pagesFetched: number;
  pagesChanged: number;
  filesChanged: boolean;
  dataCodesInvalidated: boolean;
  startedAt: number;
  completedAt?: number;
  error?: string;
}

export type ReconciliationSyncResult =
  | {
      status: 'complete';
      reason: ReconciliationReason;
      serverStartedAt: string;
      pagesFetched: number;
      pagesChanged: number;
      filesChanged: boolean;
      dataCodesInvalidated: boolean;
      throughLocalSeq: number;
    }
  | {
      status: 'not-due' | 'no-baseline';
      pagesFetched: 0;
      pagesChanged: 0;
      filesChanged: false;
      dataCodesInvalidated: false;
      throughLocalSeq: number;
    }
  | {
      status: 'login-required';
      pagesFetched: number;
      pagesChanged: number;
      filesChanged: boolean;
      dataCodesInvalidated: boolean;
      throughLocalSeq: number;
    };

export type RecentChangeSyncResult =
  | {
      status: 'complete';
      startedAt: string;
      through: string;
      eventsSeen: number;
      candidates: number;
      changedPages: PageRecord[];
      filesChanged: boolean;
      dataCodesInvalidated: boolean;
      throughLocalSeq: number;
    }
  | {
      status: 'no-baseline' | 'login-required';
      eventsSeen: 0;
      candidates: 0;
      changedPages: [];
      filesChanged: false;
      dataCodesInvalidated: false;
      throughLocalSeq: number;
    };
