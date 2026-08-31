// SPDX-License-Identifier: MPL-2.0
import type { Analyzer } from '../analyzer/analyzer';
import {
  type SearchIndexHandle,
  type SnapshotPublishSkipReason,
  type SnapshotPublishResult,
  type SnapshotInspection,
  VersionedSearchIndexCache,
} from '../search/versioned-search-index-cache';
import type { WikiSearchDatabase } from '../storage/database';
import {
  dataRulesPreference,
  type DataRulesPreferenceStore,
} from '../storage/data-rules-preference';
import {
  CACHE_VERSION_CONTRACT_KEY,
  type CacheVersionContract,
} from '../storage/version-contract';
import { prepareContentJobs } from '../sync/content-sync';
import type { RecentChangeSyncState, ReconciliationSyncState } from '../types';

const CONTENT_JOB_TYPE = 'wikitext-content';

interface MaintenanceStorage {
  estimate?(): Promise<StorageEstimate>;
  persisted?(): Promise<boolean>;
  persist?(): Promise<boolean>;
}

interface BroadcastAdapter {
  postMessage(message: unknown): void;
}

export interface LocalDataMaintenanceOptions {
  storage?: MaintenanceStorage;
  preference?: Pick<DataRulesPreferenceStore, 'remove'>;
  broadcast?: BroadcastAdapter;
  reload?: () => void;
}

export interface LocalDataDiagnostics {
  counts: {
    pages: number;
    files: number;
    dataCodes: number;
    contentSources: number;
    luaSources: number;
  };
  jobs: { done: number; pending: number; running: number; failed: number };
  recentChanges?: RecentChangeSyncState;
  reconciliation?: ReconciliationSyncState;
  versionContract?: CacheVersionContract;
  snapshots: SnapshotInspection[];
  storage: { usage?: number; quota?: number; persisted?: boolean };
}

export type PersistenceRequestResult =
  | { status: 'granted' }
  | { status: 'denied' }
  | { status: 'unsupported' }
  | { status: 'error'; message: string };

export interface SearchIndexRebuildResult {
  title: SearchIndexHandle<'title'>;
  content: SearchIndexHandle<'content'>;
  lua: SearchIndexHandle<'lua'>;
  publishResults: {
    title: SnapshotPublishResult;
    content: SnapshotPublishResult;
    lua: SnapshotPublishResult;
  };
  warnings: SearchIndexRebuildWarning[];
}

export interface SearchIndexRebuildWarning {
  kind: 'title' | 'content' | 'lua';
  reason: SnapshotPublishSkipReason;
  message: string;
}

export class LocalDataMaintenance {
  private readonly storage: MaintenanceStorage | undefined;
  private readonly preference: Pick<DataRulesPreferenceStore, 'remove'>;
  private readonly broadcast: BroadcastAdapter | undefined;
  private readonly reload: () => void;

  constructor(
    private readonly database: WikiSearchDatabase,
    private readonly indexCache: VersionedSearchIndexCache,
    options: LocalDataMaintenanceOptions = {},
  ) {
    this.storage = options.storage ?? globalThis.navigator?.storage;
    this.preference = options.preference ?? dataRulesPreference;
    this.broadcast = options.broadcast;
    this.reload = options.reload ?? (() => globalThis.location?.reload());
  }

  async inspect(): Promise<LocalDataDiagnostics> {
    const [pages, files, dataCodes, jobs, recentRecord, reconciliationRecord, versionRecord, snapshots] =
      await Promise.all([
        this.database.pages.toArray(),
        this.database.fileResources.toArray(),
        this.database.dataCodes.count(),
        this.database.jobs.filter((job) => job.type === CONTENT_JOB_TYPE).toArray(),
        this.database.syncState.get('recent-changes-sync'),
        this.database.syncState.get('reconciliation-sync'),
        this.database.syncState.get(CACHE_VERSION_CONTRACT_KEY),
        this.indexCache.inspect(),
      ]);
    const activePages = pages.filter((page) => !page.deleted);
    const contentSources = activePages.filter((page) => {
      const model = page.contentModel?.toLocaleLowerCase();
      return (
        !page.isRedirect &&
        typeof page.content === 'string' &&
        (model === 'wikitext' || model === 'bson')
      );
    }).length;
    const luaSources = activePages.filter(
      (page) =>
        !page.isRedirect &&
        typeof page.content === 'string' &&
        page.contentModel?.toLocaleLowerCase() === 'scribunto',
    ).length;
    const storage = await this.inspectStorage();
    return {
      counts: {
        pages: activePages.length,
        files: files.filter((file) => !file.deleted).length,
        dataCodes,
        contentSources,
        luaSources,
      },
      jobs: {
        done: jobs.filter((job) => job.status === 'done').length,
        pending: jobs.filter((job) => job.status === 'pending').length,
        running: jobs.filter((job) => job.status === 'running').length,
        failed: jobs.filter((job) => job.status === 'failed').length,
      },
      recentChanges: recentRecord?.value as RecentChangeSyncState | undefined,
      reconciliation: reconciliationRecord?.value as
        | ReconciliationSyncState
        | undefined,
      versionContract: versionRecord?.value as CacheVersionContract | undefined,
      snapshots,
      storage,
    };
  }

  async rebuildSearchIndexes(analyzer: Analyzer): Promise<SearchIndexRebuildResult> {
    await this.indexCache.clear();
    this.indexCache.allowPublishing();
    const title = await this.indexCache.restoreOrRebuild('title', analyzer);
    const content = await this.indexCache.restoreOrRebuild('content', analyzer);
    const lua = await this.indexCache.restoreOrRebuild('lua', analyzer);
    const publishResults = {
      title: await this.publishRebuiltHandle(title),
      content: await this.publishRebuiltHandle(content),
      lua: await this.publishRebuiltHandle(lua),
    };
    const warnings = (Object.entries(publishResults) as Array<
      ['title' | 'content' | 'lua', SnapshotPublishResult]
    >).flatMap(([kind, result]) => publicationWarning(kind, result));
    return { title, content, lua, publishResults, warnings };
  }

  async rebuildContentQueue(): Promise<void> {
    await prepareContentJobs(this.database, false);
  }

  async clearSnapshots(): Promise<void> {
    await this.indexCache.clear();
  }

  async requestPersistence(): Promise<PersistenceRequestResult> {
    if (!this.storage?.persist) return { status: 'unsupported' };
    try {
      // Invoked before the first await so callers can call this method directly
      // from the user's click activation handler.
      const request = this.storage.persist();
      return (await request) ? { status: 'granted' } : { status: 'denied' };
    } catch (error) {
      return {
        status: 'error',
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  async resetLocalMirror(options: { resetDataRules: boolean }): Promise<void> {
    if (options.resetDataRules) await this.preference.remove();
    this.broadcast?.postMessage({ type: 'reset' });
    this.database.close();
    await this.database.delete();
    this.reload();
  }

  private async publishRebuiltHandle<K extends 'title' | 'content' | 'lua'>(
    handle: SearchIndexHandle<K>,
  ): Promise<SnapshotPublishResult> {
    const initial = await this.indexCache.publish(handle);
    if (initial.status !== 'skipped' || initial.reason !== 'sequence-changed') {
      return initial;
    }
    await this.indexCache.refresh(handle);
    return this.indexCache.publish(handle);
  }

  private async inspectStorage(): Promise<{
    usage?: number;
    quota?: number;
    persisted?: boolean;
  }> {
    const result: { usage?: number; quota?: number; persisted?: boolean } = {};
    if (this.storage?.estimate) {
      try {
        const estimate = await this.storage.estimate();
        result.usage = estimate.usage;
        result.quota = estimate.quota;
      } catch {
        // Diagnostics remain available when the storage API is restricted.
      }
    }
    if (this.storage?.persisted) {
      try {
        result.persisted = await this.storage.persisted();
      } catch {
        // Same graceful-degradation rule as estimate().
      }
    }
    return result;
  }
}

function publicationWarning(
  kind: 'title' | 'content' | 'lua',
  result: SnapshotPublishResult,
): SearchIndexRebuildWarning[] {
  if (result.status === 'published' || result.reason === 'not-newer') return [];
  const label = kind === 'title' ? '标题' : kind === 'content' ? '正文' : 'Lua';
  const detail =
    result.reason === 'quota'
      ? '浏览器剩余配额不足'
      : result.reason === 'too-large'
        ? '快照超过 64 MiB'
        : result.reason === 'sequence-changed'
          ? '页面事实序列持续变化'
          : '重建期间快照 generation 已变化';
  return [{ kind, reason: result.reason, message: `${label}快照未保存：${detail}` }];
}
