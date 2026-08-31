// SPDX-License-Identifier: MPL-2.0
import { Analyzer, createBootstrapSegmenter } from './analyzer/analyzer';
import { loadAnalyzer, type AnalyzerLoadResult } from './analyzer/load-jieba';
import {
  DEFAULT_DATA_CODE_RULES,
  parseDataFieldRules,
} from './data/data-field-rules';
import { insertAtEditorSelection, wikiLink } from './editor';
import { LocalDataMaintenance } from './maintenance/local-data-maintenance';
import {
  RuntimeLifecycleCoordinator,
  type StorageInvalidation,
  type StorageInvalidationRequest,
} from './runtime/runtime-lifecycle-coordinator';
import { ContentIndex, type ContentSearchResult } from './search/content-index';
import { DataCodeIndex, type DataCodeSearchResult } from './search/data-code-index';
import { LuaModuleIndex, type LuaModuleSearchResult } from './search/lua-module-index';
import {
  type SearchIndexHandle,
  type SnapshotInspection,
  type SnapshotPublishResult,
  VersionedSearchIndexCache,
} from './search/versioned-search-index-cache';
import {
  CombinedTitleIndex,
  LinearTitleIndex,
  TitleIndex,
  type TitleSearchBackend,
  type TitleSearchResult,
} from './search/title-index';
import { WikiSearchDatabase } from './storage/database';
import { dataRulesPreference } from './storage/data-rules-preference';
import { initializeVersionContract } from './storage/version-contract';
import { syncContent } from './sync/content-sync';
import { readDataCodeSyncState, syncDataCodes } from './sync/data-code-sync';
import { syncFileResources } from './sync/file-resource-sync';
import { IncrementalSyncCoordinator } from './sync/incremental-sync-coordinator';
import {
  readRecentChangeSyncState,
  syncRecentChanges,
} from './sync/recent-change-sync';
import {
  readReconciliationSyncState,
  reconcileWikiMirror,
} from './sync/reconciliation-sync';
import { syncTitles } from './sync/title-sync';
import { WikiApi } from './sync/wiki-api';
import type { NamespaceInfo, PageRecord, TitleSyncProgress } from './types';
import { SearchPanel } from './ui/search-panel';

interface MediaWikiWindow extends Window {
  mw?: {
    config?: { get(key: string): unknown };
    util?: { getUrl(title: string): string };
  };
  __CU_WIKI_SEARCH__?: DebugApi;
}

interface DebugApi {
  ready: boolean;
  engine?: AnalyzerLoadResult['engine'];
  indexedPages: number;
  indexedFiles: number;
  indexedDataCodes: number;
  indexedContentPages: number;
  indexedLuaModules: number;
  startupMs?: number;
  jiebaReadyMs?: number;
  contentReadyMs?: number;
  contentModel?: string;
  incrementalStatus: IncrementalRuntimeStatus;
  incrementalThrough?: string;
  reconciliationStatus: ReconciliationRuntimeStatus;
  reconciliationCompletedAt?: number;
  snapshots: SnapshotInspection[];
  search(query: string, namespace?: number): TitleSearchResult[];
  searchFiles(query: string): TitleSearchResult[];
  searchCodes(query: string): DataCodeSearchResult[];
  searchContent(query: string, namespace?: number): ContentSearchResult[];
  searchLua(query: string): LuaModuleSearchResult[];
  forceSync(): Promise<void>;
  forceFileSync(): Promise<void>;
  forceDataCodeSync(): Promise<void>;
  forceContentSync(): Promise<void>;
  requestIncrementalSync(): Promise<void>;
}

type IncrementalRuntimeStatus =
  | 'idle'
  | 'running'
  | 'complete'
  | 'no-baseline'
  | 'login-required'
  | 'lock-unavailable'
  | 'error';

type ReconciliationRuntimeStatus =
  | 'idle'
  | 'running'
  | 'complete'
  | 'not-due'
  | 'no-baseline'
  | 'login-required'
  | 'lock-unavailable'
  | 'error';

type SyncAttemptResult =
  | { status: 'complete' }
  | { status: 'error'; error: unknown };

type ReconciliationRequestResult =
  | { status: 'complete' | 'not-due' }
  | {
      status:
        | 'no-baseline'
        | 'login-required'
        | 'lock-unavailable'
        | 'catch-up-error'
        | 'error';
      error?: unknown;
    };

const pageWindow = unsafeWindow as unknown as MediaWikiWindow;
const bootStartedAt = performance.now();
const LEGACY_DATA_EXTRACTION_RULES_KEY = 'data-extraction-rules';
let startupPanel: SearchPanel | undefined;

if (shouldActivate()) {
  void start().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    startupPanel?.setStartupFailure(message, () => pageWindow.location.reload());
    console.error('[CU Wiki Search] startup failed', error);
  });
}

function shouldActivate(): boolean {
  const configuredAction = pageWindow.mw?.config?.get('wgAction');
  const urlAction = new URL(location.href).searchParams.get('action');
  return configuredAction === 'edit' || configuredAction === 'submit' || urlAction === 'edit' || urlAction === 'submit';
}

async function start(): Promise<void> {
  const database = new WikiSearchDatabase();
  const api = new WikiApi();
  const indexCache = new VersionedSearchIndexCache(database);
  let incrementalChannel: BroadcastChannel | undefined;
  const maintenance = new LocalDataMaintenance(database, indexCache, {
    broadcast: { postMessage: (message) => incrementalChannel?.postMessage(message) },
  });
  let searchBackend: TitleSearchBackend | undefined;
  let bootstrapIndex: LinearTitleIndex | undefined;
  let titleIndex: TitleIndex | undefined;
  let fileSearchBackend: TitleSearchBackend | undefined;
  let dataCodeIndex: DataCodeIndex | undefined;
  let contentIndex: ContentIndex | undefined;
  let luaModuleIndex: LuaModuleIndex | undefined;
  let titleHandle: SearchIndexHandle<'title'> | undefined;
  let contentHandle: SearchIndexHandle<'content'> | undefined;
  let luaHandle: SearchIndexHandle<'lua'> | undefined;
  let syncPromise: Promise<SyncAttemptResult> | undefined;
  let fileSyncPromise: Promise<void> | undefined;
  let dataCodeSyncPromise: Promise<SyncAttemptResult | void> | undefined;
  let contentSyncPromise: Promise<void> | undefined;
  let incrementalSyncPromise: Promise<void> | undefined;
  let reconciliationSyncPromise: Promise<ReconciliationRequestResult> | undefined;
  let incrementalCoordinator: IncrementalSyncCoordinator | undefined;
  let runtimeLifecycle: RuntimeLifecycleCoordinator | undefined;
  let writesCompatible = true;
  let lastAppliedLocalSeq = 0;
  let lastAppliedFileChangeSeq = 0;
  let analyzerResult: AnalyzerLoadResult | undefined;
  let dataCodeRulesSource = DEFAULT_DATA_CODE_RULES;
  let engineReady: Promise<void> | undefined;
  let contentReady: Promise<void> | undefined;
  let fileReady: Promise<void> | undefined;
  let fileReadySettled = false;
  let resolveInitialCacheReady!: () => void;
  const initialCacheReady = new Promise<void>((resolve) => {
    resolveInitialCacheReady = resolve;
  });
  const namespaces = new Map<number, string>();
  const contentModel = pageWindow.mw?.config?.get('wgPageContentModel');
  const canInsertWikiText = typeof contentModel !== 'string' || contentModel === 'wikitext';

  const panel = new SearchPanel({
    prepareSearch: () => {
      void ensureEnhancedSearchStarted().catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        panel.setStatus(`增强搜索加载失败，标题缓存仍可用：${message}`, 'error');
        console.error('[CU Wiki Search] enhanced search startup failed', error);
      });
    },
    prepareFiles: () => {
      void ensureFileSearchStarted(false).catch((error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        panel.setStatus(`文件资源加载失败，本地缓存仍可用：${message}`, 'error');
        console.error('[CU Wiki Search] file resource startup failed', error);
      });
    },
    search: (query, namespace) => searchBackend?.search(query, namespace) ?? [],
    searchFiles: (query) => fileSearchBackend?.search(query) ?? [],
    searchLua: (query) => luaModuleIndex?.search(query) ?? [],
    searchContent: (query, namespace) => contentIndex?.search(query, namespace) ?? [],
    searchCodes: (query) => dataCodeIndex?.search(query) ?? [],
    insert: (result, query) => {
      if (!canInsertWikiText) {
        GM_setClipboard(result.title, 'text');
        panel.setStatus(`当前为 ${contentModel}，已复制标题：${result.title}`, 'success');
        return;
      }
      const link = wikiLink(result.title, 'kind' in result ? result.title : query);
      const editor = insertAtEditorSelection(link);
      panel.setStatus(`已插入 ${link} · ${editor === 'codemirror' ? 'CodeMirror' : '文本框'}`, 'success');
    },
    copy: (result, query) => {
      const link = wikiLink(result.title, 'kind' in result ? result.title : query);
      GM_setClipboard(link, 'text');
      panel.setStatus(`已复制 ${link}`, 'success');
    },
    open: (result) => {
      GM_openInTab(pageUrl(result.title), { active: true });
    },
    selectCode: (result) => {
      GM_setClipboard(result.code, 'text');
      panel.setStatus(`已复制代码名：${result.code}`, 'success');
    },
    copyCode: (result) => {
      GM_setClipboard(result.code, 'text');
      panel.setStatus(`已复制代码名：${result.code}`, 'success');
    },
    openCode: (result) => {
      GM_openInTab(pageUrl(result.source), { active: true });
    },
    refresh: () => {
      const lifecycle = runtimeLifecycle;
      if (!lifecycle) return;
      void lifecycle
        .refreshMirror({
          syncTitles: () => requestSync(false),
          reconcile: () => requestManualReconciliation(),
          syncData: () => requestManualDataCodeSync(),
          syncContent: () => requestContentSync(false),
        })
        .catch((error: unknown) => {
          const message = error instanceof Error ? error.message : String(error);
          panel.setStatus(`重新同步本地数据暂停：${message}`, 'error');
        });
    },
    refreshFiles: () => {
      void ensureFileSearchStarted(true);
    },
    saveDataCodeRules: (source) => saveDataCodeRules(source),
    loadMaintenance: () => maintenance.inspect(),
    rebuildSearchIndexes: () => rebuildSearchIndexes(),
    rebuildContentQueue: async () => {
      assertWritesAllowed();
      await runCoordinatedWriter('maintenance-queue', () =>
        maintenance.rebuildContentQueue(),
      );
    },
    reconcileNow: () => requestManualReconciliation(),
    clearSnapshots: async () => {
      await maintenance.clearSnapshots();
      await updateSnapshotDebug();
    },
    requestPersistence: () => maintenance.requestPersistence(),
    resetLocalMirror: (resetDataRules) =>
      maintenance.resetLocalMirror({ resetDataRules }),
  });
  startupPanel = panel;
  panel.setInsertMode(canInsertWikiText);
  panel.setStatus('正在加载本地索引与分词引擎…');

  const debugApi: DebugApi = {
    ready: false,
    indexedPages: 0,
    indexedFiles: 0,
    indexedDataCodes: 0,
    indexedContentPages: 0,
    indexedLuaModules: 0,
    contentModel: typeof contentModel === 'string' ? contentModel : undefined,
    incrementalStatus: 'idle',
    reconciliationStatus: 'idle',
    snapshots: [],
    search: (query, namespace) => searchBackend?.search(query, namespace) ?? [],
    searchFiles: (query) => fileSearchBackend?.search(query) ?? [],
    searchCodes: (query) => dataCodeIndex?.search(query) ?? [],
    searchContent: (query, namespace) => contentIndex?.search(query, namespace) ?? [],
    searchLua: (query) => luaModuleIndex?.search(query) ?? [],
    forceSync: () => requestManualReconciliation(),
    forceFileSync: () => ensureFileSearchStarted(true),
    forceDataCodeSync: () => requestManualDataCodeSync(),
    forceContentSync: () => requestContentSync(true),
    requestIncrementalSync: () => requestIncrementalSync(),
  };
  pageWindow.__CU_WIKI_SEARCH__ = debugApi;

  await database.open();
  const versionState = await initializeVersionContract(database);
  writesCompatible = versionState.status === 'compatible';
  const fallbackAnalyzer = new Analyzer(createBootstrapSegmenter(), 'bootstrap');
  const [
    pages,
    dataCodes,
    dataCodeSyncState,
    recentChangeState,
    reconciliationState,
  ] = await Promise.all([
    database.pages.filter((page) => !page.deleted).toArray(),
    database.dataCodes.toArray(),
    readDataCodeSyncState(database),
    readRecentChangeSyncState(database),
    readReconciliationSyncState(database),
  ]);
  const preferenceRules = await dataRulesPreference.get();
  for (const [source, origin] of [
    [preferenceRules, 'GM preference'],
    [dataCodeSyncState?.rulesSource, 'data-code-sync'],
  ] as const) {
    if (typeof source !== 'string') continue;
    try {
      parseDataFieldRules(source);
      dataCodeRulesSource = source;
      if (origin === 'data-code-sync' && preferenceRules === undefined) {
        await dataRulesPreference.set(source);
      }
      break;
    } catch (error) {
      console.warn(`[CU Wiki Search] ignored invalid ${origin} Data code rules`, error);
    }
  }
  await database.syncState.delete(LEGACY_DATA_EXTRACTION_RULES_KEY);
  panel.setDataCodeRules(dataCodeRulesSource, DEFAULT_DATA_CODE_RULES);
  analyzerResult = { analyzer: fallbackAnalyzer, engine: 'bootstrap' };
  if (writesCompatible) incrementalCoordinator = new IncrementalSyncCoordinator(database);
  runtimeLifecycle = new RuntimeLifecycleCoordinator({
    applyStorageInvalidation: applyStorageInvalidation,
    writer: incrementalCoordinator,
  });
  lastAppliedLocalSeq = pages.reduce(
    (maximum, page) => Math.max(maximum, page.localSeq),
    0,
  );
  lastAppliedFileChangeSeq = recentChangeState?.fileChangeSeq ?? 0;
  debugApi.incrementalThrough = recentChangeState?.through;
  debugApi.reconciliationStatus =
    reconciliationState?.status === 'complete'
      ? 'complete'
      : reconciliationState?.status === 'running'
        ? 'running'
        : reconciliationState?.status === 'failed'
          ? 'error'
          : 'idle';
  debugApi.reconciliationCompletedAt = reconciliationState?.completedAt;
  bootstrapIndex = new LinearTitleIndex(fallbackAnalyzer, pages);
  searchBackend = bootstrapIndex;
  dataCodeIndex = new DataCodeIndex(fallbackAnalyzer, dataCodes);
  collectNamespaces(pages, namespaces);
  panel.setNamespaces(namespaceOptions(namespaces));
  debugApi.ready = true;
  debugApi.engine = 'bootstrap';
  debugApi.indexedPages = searchBackend.size;
  debugApi.indexedDataCodes = dataCodeIndex.size;
  debugApi.snapshots = (['title', 'content', 'lua'] as const).map((kind) => ({
    kind,
    status: 'not-started',
  }));
  debugApi.startupMs = Math.round(performance.now() - bootStartedAt);
  panel.setStatus(
    writesCompatible
      ? `已恢复 ${searchBackend.size} 个标题 · ${dataCodeIndex.size} 个 Data 代码 · 点开后加载正文`
      : `本地数据版本不兼容，已停止后台写入；可搜索现有数据或执行完整重置`,
    writesCompatible ? 'success' : 'error',
  );
  resolveInitialCacheReady();

  if (typeof BroadcastChannel === 'function') {
    incrementalChannel = new BroadcastChannel('cu-wiki-local-search:changes:v1');
    incrementalChannel.addEventListener('message', (event) => {
      if (event.data?.type === 'reset') {
        database.close();
        location.reload();
        return;
      }
      const invalidation = broadcastInvalidation(event.data);
      if (document.visibilityState !== 'visible') {
        runtimeLifecycle?.deferStorageRefresh(invalidation);
        return;
      }
      void refreshIndexesFromStorage(invalidation);
    });
  }

  const requestVisibleIncrementalSync = (): void => {
    if (document.visibilityState !== 'visible') return;
    void runtimeLifecycle?.resumeStorageRefresh();
    void requestIncrementalSync();
  };
  window.addEventListener('focus', requestVisibleIncrementalSync);
  document.addEventListener('visibilitychange', requestVisibleIncrementalSync);
  window.setInterval(requestVisibleIncrementalSync, 30_000);

  if (writesCompatible) {
    void (async () => {
      await whenPageIdle();
      await requestIncrementalSync();
      await requestDataCodeSync(false);
    })();
  }

  function ensureEnhancedSearchStarted(): Promise<void> {
    if (!engineReady) {
      panel.setStatus('正在按需加载分词引擎与正文索引…');
      engineReady = (async () => {
        await initialCacheReady;
        const loadedAnalyzer = await loadAnalyzer();
        const restoredTitle = await indexCache.restoreOrRebuild(
          'title',
          loadedAnalyzer.analyzer,
        );
        const upgradedIndex = restoredTitle.index;
        if (!bootstrapIndex) throw new Error('本地标题缓存尚未就绪');
        analyzerResult = loadedAnalyzer;
        titleHandle = restoredTitle;
        titleIndex = upgradedIndex;
        searchBackend = new CombinedTitleIndex(upgradedIndex, bootstrapIndex);
        debugApi.engine = loadedAnalyzer.engine;
        debugApi.indexedPages = upgradedIndex.size;
        debugApi.jiebaReadyMs = Math.round(performance.now() - bootStartedAt);
        await updateSnapshotDebug();
        if (loadedAnalyzer.warning) {
          panel.setStatus(
            `jieba 加载失败，已用 Intl.Segmenter · ${upgradedIndex.size} 标题`,
            'error',
          );
        } else {
          panel.setStatus(
            `已恢复 ${upgradedIndex.size} 标题 · ${dataCodeIndex?.size ?? 0} 代码 · 正文恢复中`,
            'success',
          );
        }
      })();
      contentReady = (async () => {
        await engineReady;
        await runSync(false);
        if (!analyzerResult) return;
        const [restoredContent, restoredLua] = await Promise.all([
          indexCache.restoreOrRebuild('content', analyzerResult.analyzer),
          indexCache.restoreOrRebuild('lua', analyzerResult.analyzer),
        ]);
        contentHandle = restoredContent;
        luaHandle = restoredLua;
        contentIndex = restoredContent.index;
        luaModuleIndex = restoredLua.index;
        debugApi.indexedContentPages = restoredContent.index.size;
        debugApi.indexedLuaModules = restoredLua.index.size;
        debugApi.contentReadyMs = Math.round(performance.now() - bootStartedAt);
        await updateSnapshotDebug();
        panel.refreshResults();
        await runContentSync(false);
      })();
    }
    return contentReady ?? engineReady!;
  }

  function ensureFileSearchStarted(force: boolean): Promise<void> {
    if (!fileReady) {
      fileReadySettled = false;
      const loading = (async () => {
        await initialCacheReady;
        const cachedFiles = await database.fileResources
          .filter((file) => !file.deleted)
          .toArray();
        fileSearchBackend = new LinearTitleIndex(fallbackAnalyzer, cachedFiles);
        debugApi.indexedFiles = fileSearchBackend.size;
        panel.refreshResults();
        if (cachedFiles.length) {
          panel.setStatus(`已恢复 ${cachedFiles.length} 个文件资源`, 'success');
        } else {
          panel.setStatus('正在首次同步文件资源…');
        }
        await runFileSync(force);
      })();
      fileReady = loading.then(() => {
        fileReadySettled = true;
      }).catch((error: unknown) => {
        fileReady = undefined;
        fileReadySettled = false;
        throw error;
      });
      return fileReady;
    }
    return force && fileReadySettled ? runFileSync(true) : fileReady;
  }

  async function runFileSync(force: boolean): Promise<void> {
    if (!ensureWritesAllowed()) return;
    if (fileSyncPromise) return fileSyncPromise;
    fileSyncPromise = (async () => {
      try {
        const rebuildFileIndex = async (): Promise<void> => {
          const files = await database.fileResources
            .filter((file) => !file.deleted)
            .toArray();
          fileSearchBackend = new LinearTitleIndex(fallbackAnalyzer, files);
          debugApi.indexedFiles = fileSearchBackend.size;
          panel.refreshResults();
        };
        let finalState: Awaited<ReturnType<typeof syncFileResources>> | undefined;
        const run = async (): Promise<void> => {
          finalState = await syncFileResources(database, api, fallbackAnalyzer, {
            force,
            onBatch: rebuildFileIndex,
            onProgress: (progress) => {
              if (progress.status === 'running') {
                panel.setStatus(`同步文件资源 ${progress.pagesFetched} 页…`);
              }
            },
          });
        };
        if (incrementalCoordinator) await incrementalCoordinator.runExclusive(run);
        else await run();
        if (!finalState) throw new Error('文件资源同步未完成');
        await rebuildFileIndex();
        await refreshIndexesFromStorage({ files: true });
        incrementalChannel?.postMessage({ type: 'files-committed' });
        panel.setStatus(
          `文件资源同步完成 · ${finalState.pagesFetched} 项可独立搜索`,
          'success',
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        panel.setStatus(`文件资源同步暂停，本地缓存仍可搜索：${message}`, 'error');
        console.error('[CU Wiki Search] file resource sync failed', error);
      } finally {
        fileSyncPromise = undefined;
      }
    })();
    return fileSyncPromise;
  }

  async function requestSync(force: boolean): Promise<void> {
    void ensureEnhancedSearchStarted();
    await engineReady;
    const result = await runSync(force);
    if (result.status === 'error') throw result.error;
  }

  async function saveDataCodeRules(source: string): Promise<void> {
    assertWritesAllowed();
    parseDataFieldRules(source);
    if (dataCodeSyncPromise) await dataCodeSyncPromise;

    const task = (async () => {
      let result: Awaited<ReturnType<typeof syncDataCodes>> | undefined;
      await runCoordinatedWriter('data', async () => {
        result = await syncDataCodes(database, fallbackAnalyzer, {
          force: true,
          rulesSource: source,
        });
        // Keep the durable preference and its matching cache commit inside the
        // same cross-tab writer window so a stale tab cannot win afterwards.
        await dataRulesPreference.set(source);
      });
      if (!result) throw new Error('Data 代码规则保存未返回结果');
      dataCodeIndex = new DataCodeIndex(fallbackAnalyzer, result.records);
      dataCodeRulesSource = source;
      debugApi.indexedDataCodes = dataCodeIndex.size;
      panel.setDataCodeRules(dataCodeRulesSource, DEFAULT_DATA_CODE_RULES);
      panel.refreshResults();
      incrementalChannel?.postMessage({ type: 'data-committed' });
      panel.setStatus(`Data 代码检索字段已保存 · ${dataCodeIndex.size} 条`, 'success');
    })();
    dataCodeSyncPromise = task;
    try {
      await task;
    } finally {
      if (dataCodeSyncPromise === task) dataCodeSyncPromise = undefined;
    }
  }

  async function requestDataCodeSync(force: boolean): Promise<SyncAttemptResult> {
    if (!ensureWritesAllowed()) {
      return { status: 'error', error: new Error('本地数据版本不兼容') };
    }
    if (dataCodeSyncPromise) {
      return (await dataCodeSyncPromise) ?? { status: 'complete' };
    }
    const task = (async (): Promise<SyncAttemptResult> => {
      try {
        let result: Awaited<ReturnType<typeof syncDataCodes>> | undefined;
        let canonicalRules = dataCodeRulesSource;
        await runCoordinatedWriter('data', async () => {
          canonicalRules = await readCanonicalDataRules();
          result = await syncDataCodes(database, fallbackAnalyzer, {
            force,
            rulesSource: canonicalRules,
          });
        });
        if (!result) throw new Error('Data 代码同步未返回结果');
        dataCodeIndex = new DataCodeIndex(fallbackAnalyzer, result.records);
        dataCodeRulesSource = canonicalRules;
        debugApi.indexedDataCodes = dataCodeIndex.size;
        panel.setDataCodeRules(dataCodeRulesSource, DEFAULT_DATA_CODE_RULES);
        panel.refreshResults();
        if (result.refreshed) {
          incrementalChannel?.postMessage({ type: 'data-committed' });
          panel.setStatus(`Data 代码更新完成 · ${dataCodeIndex.size} 条`, 'success');
        }
        return { status: 'complete' } as const;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        panel.setStatus(
          `Data 代码更新失败，${dataCodeIndex?.size ? '继续使用本地缓存' : '标题搜索仍可用'}：${message}`,
          'error',
        );
        console.error('[CU Wiki Search] Data code sync failed', error);
        return { status: 'error', error } as const;
      }
    })();
    dataCodeSyncPromise = task;
    try {
      return await task;
    } finally {
      if (dataCodeSyncPromise === task) dataCodeSyncPromise = undefined;
    }
  }

  async function readCanonicalDataRules(): Promise<string> {
    const preference = await dataRulesPreference.get();
    const stored = await readDataCodeSyncState(database);
    for (const source of [preference, stored?.rulesSource, dataCodeRulesSource]) {
      if (typeof source !== 'string') continue;
      try {
        parseDataFieldRules(source);
        return source;
      } catch {
        // Continue to the next durable/local source.
      }
    }
    return DEFAULT_DATA_CODE_RULES;
  }

  async function requestManualDataCodeSync(): Promise<void> {
    const result = await requestDataCodeSync(true);
    if (result.status === 'error') throw result.error;
  }

  async function requestContentSync(force: boolean): Promise<void> {
    void ensureEnhancedSearchStarted();
    await contentReady;
    return runContentSync(force);
  }

  async function requestIncrementalSync(): Promise<void> {
    if (!ensureWritesAllowed()) return;
    if (incrementalSyncPromise) return incrementalSyncPromise;
    if (!incrementalCoordinator) return;
    const coordinator = incrementalCoordinator;
    const task = (async () => {
      let syncResult: Awaited<ReturnType<typeof syncRecentChanges>> | undefined;
      let reconciliationResult:
        | Awaited<ReturnType<typeof reconcileWikiMirror>>
        | undefined;
      try {
        debugApi.incrementalStatus = 'running';
        const coordinated = await coordinator.runIfDue(async () => {
          debugApi.reconciliationStatus = 'running';
          reconciliationResult = await reconcileWikiMirror(
            database,
            api,
            fallbackAnalyzer,
            {
              onProgress: (state) => {
                debugApi.reconciliationStatus = 'running';
                panel.setStatus(
                  `全量对账 ${state.pagesFetched} 页 · ${Math.min(state.namespaceIndex + 1, state.namespaceIds.length)}/${state.namespaceIds.length}`,
                );
              },
            },
          );
          if (reconciliationResult.status === 'login-required') return false;
          syncResult = await syncRecentChanges(database, api, fallbackAnalyzer);
          return syncResult.status === 'complete';
        });
        if (coordinated === 'lock-unavailable') {
          debugApi.incrementalStatus = 'lock-unavailable';
          await refreshIndexesFromStorage();
          return;
        }
        if (coordinated === 'not-due') {
          debugApi.incrementalStatus = 'idle';
          await refreshIndexesFromStorage();
          return;
        }
        if (reconciliationResult) {
          debugApi.reconciliationStatus = reconciliationResult.status;
          if (reconciliationResult.status === 'complete') {
            debugApi.reconciliationCompletedAt = (
              await readReconciliationSyncState(database)
            )?.completedAt;
            await refreshIndexesFromStorage();
            incrementalChannel?.postMessage({
              type: 'reconciled',
              throughLocalSeq: reconciliationResult.throughLocalSeq,
              filesChanged: reconciliationResult.filesChanged,
            });
            if (reconciliationResult.dataCodesInvalidated) {
              await requestDataCodeSync(false);
            }
            if (contentIndex && luaModuleIndex) {
              await runContentSync(false);
            }
          } else if (reconciliationResult.status === 'login-required') {
            debugApi.incrementalStatus = 'login-required';
            panel.setStatus(
              '全量对账与增量同步暂停：请登录灰机账号，本地已有内容仍可搜索',
              'error',
            );
            return;
          }
        }
        if (!syncResult) return;
        if (syncResult.status !== 'complete') {
          debugApi.incrementalStatus = syncResult.status;
          if (syncResult.status === 'login-required') {
            panel.setStatus('增量同步暂停：请登录灰机账号，本地已有内容仍可搜索', 'error');
          }
          return;
        }

        debugApi.incrementalStatus = 'complete';
        debugApi.incrementalThrough = syncResult.through;
        await refreshIndexesFromStorage();
        incrementalChannel?.postMessage({
          type: 'committed',
          throughLocalSeq: syncResult.throughLocalSeq,
          filesChanged: syncResult.filesChanged,
        });
        if (syncResult.dataCodesInvalidated) await requestDataCodeSync(false);
        if (syncResult.changedPages.length || syncResult.filesChanged) {
          panel.setStatus(
            `增量同步完成 · ${syncResult.changedPages.length} 个页面` +
              (syncResult.filesChanged ? ' · 文件资源已更新' : ''),
            'success',
          );
        }
      } catch (error) {
        const committedReconciliation = await readReconciliationSyncState(database);
        if (
          reconciliationResult?.status === 'complete' &&
          committedReconciliation?.status === 'complete'
        ) {
          debugApi.reconciliationStatus = 'complete';
          debugApi.reconciliationCompletedAt = committedReconciliation.completedAt;
          await refreshIndexesFromStorage();
          incrementalChannel?.postMessage({
            type: 'reconciled',
            filesChanged: committedReconciliation.filesChanged,
          });
          if (committedReconciliation.dataCodesInvalidated) {
            await requestDataCodeSync(false);
          }
          if (contentIndex && luaModuleIndex) {
            await runContentSync(false);
          }
        } else if (debugApi.reconciliationStatus === 'running') {
          debugApi.reconciliationStatus = 'error';
        }
        debugApi.incrementalStatus = 'error';
        const message = error instanceof Error ? error.message : String(error);
        panel.setStatus(`增量同步暂停，本地已有内容仍可搜索：${message}`, 'error');
        console.error('[CU Wiki Search] incremental sync failed', error);
      }
    })();
    incrementalSyncPromise = task;
    try {
      await task;
    } finally {
      if (incrementalSyncPromise === task) incrementalSyncPromise = undefined;
    }
  }

  async function requestReconciliationSync(
    force: boolean,
  ): Promise<ReconciliationRequestResult> {
    if (!ensureWritesAllowed()) {
      return { status: 'error', error: new Error('本地数据版本不兼容') };
    }
    if (reconciliationSyncPromise) return reconciliationSyncPromise;
    if (!incrementalCoordinator) return { status: 'lock-unavailable' };
    const coordinator = incrementalCoordinator;
    const task = (async () => {
      try {
        debugApi.reconciliationStatus = 'running';
        let result: Awaited<ReturnType<typeof reconcileWikiMirror>> | undefined;
        let catchUpResult: Awaited<ReturnType<typeof syncRecentChanges>> | undefined;
        let catchUpError: unknown;
        const coordinated = await coordinator.runExclusive(async () => {
          result = await reconcileWikiMirror(database, api, fallbackAnalyzer, {
            force,
            onProgress: (state) => {
              panel.setStatus(
                `全量对账 ${state.pagesFetched} 页 · ${Math.min(state.namespaceIndex + 1, state.namespaceIds.length)}/${state.namespaceIds.length}`,
              );
            },
          });
          if (result.status === 'complete') {
            try {
              catchUpResult = await syncRecentChanges(database, api, fallbackAnalyzer);
            } catch (error) {
              catchUpError = error;
            }
          }
        });
        if (coordinated === 'lock-unavailable') {
          debugApi.reconciliationStatus = 'lock-unavailable';
          return { status: 'lock-unavailable' } as const;
        }
        if (!result) {
          return {
            status: 'error',
            error: new Error('全量对账未返回结果'),
          } as const;
        }
        debugApi.reconciliationStatus = result.status;
        if (result.status === 'login-required') {
          panel.setStatus(
            '全量对账暂停：请登录灰机账号，本地已有内容仍可搜索',
            'error',
          );
          return { status: 'login-required' } as const;
        }
        if (result.status !== 'complete') return { status: result.status };
        if (catchUpResult?.status === 'login-required') {
          debugApi.incrementalStatus = 'login-required';
          panel.setStatus(
            '全量对账已提交，收尾增量同步暂停：请登录灰机账号',
            'error',
          );
        } else if (catchUpResult?.status === 'complete') {
          debugApi.incrementalStatus = 'complete';
          debugApi.incrementalThrough = catchUpResult.through;
        }
        debugApi.reconciliationCompletedAt = (
          await readReconciliationSyncState(database)
        )?.completedAt;
        await refreshIndexesFromStorage();
        incrementalChannel?.postMessage({
          type: 'reconciled',
          throughLocalSeq: result.throughLocalSeq,
          filesChanged: result.filesChanged,
        });
        if (
          result.dataCodesInvalidated ||
          (catchUpResult?.status === 'complete' && catchUpResult.dataCodesInvalidated)
        ) {
          const dataResult = await requestDataCodeSync(false);
          if (dataResult.status === 'error') return dataResult;
        }
        if (catchUpError) {
          debugApi.incrementalStatus = 'error';
          const message =
            catchUpError instanceof Error ? catchUpError.message : String(catchUpError);
          panel.setStatus(
            `全量对账已完成，收尾增量同步稍后重试：${message}`,
            'error',
          );
          console.error('[CU Wiki Search] reconciliation catch-up failed', catchUpError);
          return { status: 'catch-up-error', error: catchUpError } as const;
        } else if (catchUpResult?.status === 'login-required') {
          return { status: 'login-required' } as const;
        } else {
          panel.setStatus(
            `全量对账完成 · ${result.pagesFetched} 页 · ${result.pagesChanged} 个页面变化` +
              (result.filesChanged ? ' · 文件资源已更新' : ''),
            'success',
          );
        }
        return { status: 'complete' } as const;
      } catch (error) {
        debugApi.reconciliationStatus = 'error';
        const message = error instanceof Error ? error.message : String(error);
        panel.setStatus(`全量对账暂停，本地已有内容仍可搜索：${message}`, 'error');
        console.error('[CU Wiki Search] reconciliation failed', error);
        return { status: 'error', error } as const;
      }
    })();
    reconciliationSyncPromise = task;
    try {
      return await task;
    } finally {
      if (reconciliationSyncPromise === task) reconciliationSyncPromise = undefined;
    }
  }

  async function requestManualReconciliation(): Promise<void> {
    const result = await requestReconciliationSync(true);
    if (result.status === 'complete') {
      if (contentIndex && luaModuleIndex) await runContentSync(false);
      return;
    }
    if ('error' in result && result.error) throw result.error;
    const message =
      result.status === 'login-required'
        ? '请先登录灰机账号'
        : result.status === 'lock-unavailable'
          ? '另一个标签页正在写入本地镜像，请稍后重试'
          : result.status === 'no-baseline'
            ? '尚无完整标题基线，请先重试标题同步'
            : result.status === 'catch-up-error'
              ? '收尾增量同步失败，请稍后重试'
              : '全量对账尚未执行';
    throw new Error(message);
  }

  async function refreshIndexesFromStorage(
    invalidation: StorageInvalidationRequest = { pages: true },
  ): Promise<void> {
    if (runtimeLifecycle) return runtimeLifecycle.refreshStorage(invalidation);
    return applyStorageInvalidation({
      pages: invalidation.pages === true,
      files: invalidation.files === true,
      data: invalidation.data === true,
    });
  }

  async function applyStorageInvalidation(
    invalidation: StorageInvalidation,
  ): Promise<void> {
    const [sequenceRecord, incrementalState, dataState] = await Promise.all([
      invalidation.pages ? database.syncState.get('local-sequence') : undefined,
      invalidation.pages || invalidation.files
        ? readRecentChangeSyncState(database)
        : undefined,
      invalidation.data ? readDataCodeSyncState(database) : undefined,
    ]);
    const sequence = typeof sequenceRecord?.value === 'number' ? sequenceRecord.value : 0;
    let indexChanged = false;
    const sequenceAdvanced = invalidation.pages && sequence > lastAppliedLocalSeq;
    const handleBehind = [titleHandle, contentHandle, luaHandle].some(
      (handle) =>
        invalidation.pages && handle !== undefined && sequence > handle.throughLocalSeq,
    );
    if (sequenceAdvanced || handleBehind) {
      indexChanged = true;
      const changedPages = sequenceAdvanced
        ? await database.pages
            .where('localSeq')
            .above(lastAppliedLocalSeq)
            .toArray()
        : [];
      if (titleHandle) await indexCache.refresh(titleHandle);
      else if (sequenceAdvanced) titleIndex?.update(changedPages);
      if (contentHandle) await indexCache.refresh(contentHandle);
      else if (sequenceAdvanced && contentIndex) await contentIndex.updateAsync(changedPages);
      if (luaHandle) await indexCache.refresh(luaHandle);
      else if (sequenceAdvanced && luaModuleIndex) {
        await luaModuleIndex.updateAsync(changedPages);
      }
      if (sequenceAdvanced) {
        const allPages = await database.pages.filter((page) => !page.deleted).toArray();
        bootstrapIndex = new LinearTitleIndex(fallbackAnalyzer, allPages);
        searchBackend = titleIndex
          ? new CombinedTitleIndex(titleIndex, bootstrapIndex)
          : bootstrapIndex;
        collectNamespaces(changedPages, namespaces);
        panel.setNamespaces(namespaceOptions(namespaces));
      }
      debugApi.indexedPages = searchBackend?.size ?? titleIndex?.size ?? 0;
      debugApi.indexedContentPages = contentIndex?.size ?? 0;
      debugApi.indexedLuaModules = luaModuleIndex?.size ?? 0;
      lastAppliedLocalSeq = Math.max(lastAppliedLocalSeq, sequence);
      if (titleHandle) indexCache.schedulePublish(titleHandle);
      if (contentHandle) indexCache.schedulePublish(contentHandle);
      if (luaHandle) indexCache.schedulePublish(luaHandle);
    }

    const fileChangeSeq = incrementalState?.fileChangeSeq ?? 0;
    if (invalidation.files || fileChangeSeq > lastAppliedFileChangeSeq) {
      if (fileSearchBackend) {
        const files = await database.fileResources
          .filter((file) => !file.deleted)
          .toArray();
        fileSearchBackend = new LinearTitleIndex(fallbackAnalyzer, files);
        debugApi.indexedFiles = fileSearchBackend.size;
      }
      lastAppliedFileChangeSeq = fileChangeSeq;
    }
    if (incrementalState) debugApi.incrementalThrough = incrementalState.through;
    if (invalidation.data && dataCodeIndex) {
      const records = await database.dataCodes.toArray();
      dataCodeIndex = new DataCodeIndex(fallbackAnalyzer, records);
      debugApi.indexedDataCodes = dataCodeIndex.size;
      if (typeof dataState?.rulesSource === 'string') {
        try {
          parseDataFieldRules(dataState.rulesSource);
          dataCodeRulesSource = dataState.rulesSource;
          panel.setDataCodeRules(dataCodeRulesSource, DEFAULT_DATA_CODE_RULES);
        } catch (error) {
          console.warn('[CU Wiki Search] ignored invalid broadcast Data code rules', error);
        }
      }
    }
    if (indexChanged) await updateSnapshotDebug();
    panel.refreshResults();
  }

  async function runContentSync(force: boolean): Promise<void> {
    if (!ensureWritesAllowed()) return;
    if (contentSyncPromise) return contentSyncPromise;
    if (!contentIndex || !luaModuleIndex) return;
    const activeIndex = contentIndex;
    const activeLuaIndex = luaModuleIndex;
    contentSyncPromise = (async () => {
      try {
        let finalProgress: Awaited<ReturnType<typeof syncContent>> | undefined;
        const writeContentFacts = async (): Promise<void> => {
          finalProgress = await syncContent(database, api, {
            force,
            onBatch: async (batch) => {
              if (contentHandle && luaHandle) await refreshIndexesFromStorage();
              else {
                await activeIndex.updateAsync(batch);
                await activeLuaIndex.updateAsync(batch);
              }
              debugApi.indexedContentPages = activeIndex.size;
              debugApi.indexedLuaModules = activeLuaIndex.size;
              panel.refreshResults();
              incrementalChannel?.postMessage({ type: 'content-committed' });
            },
            onProgress: (progress) => {
              panel.setStatus(
                `同步页面正文 ${progress.done}/${progress.total}` +
                  (progress.failed ? ` · ${progress.failed} 失败` : ''),
              );
            },
          });
        };
        const coordinated = runtimeLifecycle
          ? await runtimeLifecycle.runContentWriter(writeContentFacts)
          : (await writeContentFacts(), 'ran' as const);
        if (coordinated === 'lock-unavailable') {
          panel.setStatus(
            '正文同步暂停：另一个标签页正在写入本地镜像，请稍后重试',
            'error',
          );
          return;
        }
        if (!finalProgress) throw new Error('正文同步未返回进度');
        if (force) {
          const allPages = await database.pages.filter((page) => !page.deleted).toArray();
          await activeIndex.rebuildAsync(allPages);
          await activeLuaIndex.rebuildAsync(allPages);
        }
        let snapshotWarning: string | undefined;
        if (contentHandle) {
          await indexCache.refresh(contentHandle);
          snapshotWarning = snapshotPublishWarning(await indexCache.publish(contentHandle));
        }
        if (luaHandle) {
          await indexCache.refresh(luaHandle);
          snapshotWarning ??= snapshotPublishWarning(await indexCache.publish(luaHandle));
        }
        await updateSnapshotDebug();
        debugApi.indexedContentPages = activeIndex.size;
        debugApi.indexedLuaModules = activeLuaIndex.size;
        panel.refreshResults();
        panel.setStatus(
          snapshotWarning ??
            `正文同步完成 · ${finalProgress.done}/${finalProgress.total} 页 · ${activeIndex.size} 正文 / ${activeLuaIndex.size} Lua`,
          finalProgress.failed || snapshotWarning ? 'error' : 'success',
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        panel.setStatus(`正文同步暂停，本地已有正文仍可搜索：${message}`, 'error');
        console.error('[CU Wiki Search] content sync failed', error);
      } finally {
        contentSyncPromise = undefined;
      }
    })();
    return contentSyncPromise;
  }

  async function runSync(force: boolean): Promise<SyncAttemptResult> {
    if (!ensureWritesAllowed()) {
      return { status: 'error', error: new Error('本地数据版本不兼容') };
    }
    if (syncPromise) return syncPromise;
    if (!analyzerResult || !titleIndex) {
      return { status: 'error', error: new Error('增强标题索引尚未就绪') };
    }
    const activeIndex = titleIndex;
    const activeAnalyzer = analyzerResult.analyzer;
    syncPromise = (async () => {
      try {
        let receivedBatch = false;
        const run = async (): Promise<void> => {
          await syncTitles(database, api, activeAnalyzer, {
            force,
            onBatch: (batch) => {
              receivedBatch = true;
              activeIndex.update(batch);
              collectNamespaces(batch, namespaces);
              panel.setNamespaces(namespaceOptions(namespaces));
              debugApi.indexedPages = activeIndex.size;
              panel.refreshResults();
            },
            onProgress: (progress) => panel.setStatus(progressMessage(progress)),
          });
        };
        const coordinated = incrementalCoordinator
          ? await incrementalCoordinator.runExclusive(run)
          : (await run(), 'ran' as const);
        if (coordinated === 'lock-unavailable') {
          throw new Error('另一个标签页正在写入本地镜像，请稍后重试');
        }
        if (receivedBatch) {
          const allPages = await database.pages.filter((page) => !page.deleted).toArray();
          await activeIndex.rebuildAsync(allPages);
          bootstrapIndex = new LinearTitleIndex(activeAnalyzer, allPages);
          searchBackend = new CombinedTitleIndex(activeIndex, bootstrapIndex);
          panel.refreshResults();
        }
        await refreshIndexesFromStorage();
        const snapshotWarning = titleHandle
          ? snapshotPublishWarning(await indexCache.publish(titleHandle))
          : undefined;
        await updateSnapshotDebug();
        debugApi.indexedPages = activeIndex.size;
        panel.setStatus(
          snapshotWarning ??
            `标题同步完成 · ${activeIndex.size} 页 · ${dataCodeIndex?.size ?? 0} 个 Data 代码 · ${analyzerResult?.engine}`,
          snapshotWarning ? 'error' : 'success',
        );
        return { status: 'complete' } as const;
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        panel.setStatus(`同步失败，本地搜索仍可用：${message}`, 'error');
        console.error('[CU Wiki Search] title sync failed', error);
        return { status: 'error', error } as const;
      } finally {
        syncPromise = undefined;
      }
    })();
    return syncPromise;
  }

  async function rebuildSearchIndexes(): Promise<void> {
    assertWritesAllowed();
    await ensureEnhancedSearchStarted();
    if (!analyzerResult || analyzerResult.engine === 'bootstrap') {
      throw new Error('增强分词引擎尚未就绪');
    }
    let rebuilt: Awaited<ReturnType<typeof maintenance.rebuildSearchIndexes>> | undefined;
    await runCoordinatedWriter('maintenance-index', async () => {
      rebuilt = await maintenance.rebuildSearchIndexes(analyzerResult!.analyzer);
    });
    if (!rebuilt) throw new Error('本地搜索索引重建未返回结果');
    titleHandle = rebuilt.title;
    contentHandle = rebuilt.content;
    luaHandle = rebuilt.lua;
    titleIndex = rebuilt.title.index;
    contentIndex = rebuilt.content.index;
    luaModuleIndex = rebuilt.lua.index;
    const pages = await database.pages.filter((page) => !page.deleted).toArray();
    bootstrapIndex = new LinearTitleIndex(fallbackAnalyzer, pages);
    searchBackend = new CombinedTitleIndex(titleIndex, bootstrapIndex);
    lastAppliedLocalSeq = Math.max(
      rebuilt.title.throughLocalSeq,
      rebuilt.content.throughLocalSeq,
      rebuilt.lua.throughLocalSeq,
    );
    debugApi.indexedPages = titleIndex.size;
    debugApi.indexedContentPages = contentIndex.size;
    debugApi.indexedLuaModules = luaModuleIndex.size;
    await updateSnapshotDebug();
    panel.refreshResults();
  }

  async function updateSnapshotDebug(): Promise<void> {
    debugApi.snapshots = await indexCache.inspect();
  }

  function ensureWritesAllowed(): boolean {
    if (writesCompatible) return true;
    panel.setStatus(
      '本地数据版本高于当前脚本，后台写入已停止；请使用完整重置恢复兼容状态',
      'error',
    );
    return false;
  }

  function assertWritesAllowed(): void {
    if (!ensureWritesAllowed()) throw new Error('本地数据版本不兼容，后台写入已停止');
  }

  async function runCoordinatedWriter(
    key: string,
    task: () => Promise<void>,
  ): Promise<void> {
    await initialCacheReady;
    const coordinated = runtimeLifecycle
      ? await runtimeLifecycle.runWriter(key, task)
      : 'lock-unavailable';
    if (coordinated === 'lock-unavailable') {
      throw new Error('无法取得跨标签写入锁，请确认浏览器支持 Web Locks 后重试');
    }
  }

  function snapshotPublishWarning(result: SnapshotPublishResult): string | undefined {
    if (result.status === 'published') return undefined;
    if (result.reason === 'too-large') {
      return '索引快照超过 64 MiB，已跳过保存；当前搜索仍可正常使用';
    }
    if (result.reason === 'quota') {
      return 'IndexedDB 剩余配额不足，已跳过快照；当前搜索仍可正常使用';
    }
    return undefined;
  }
}

function collectNamespaces(pages: PageRecord[], namespaces: Map<number, string>): void {
  for (const page of pages) {
    if (!page.deleted) namespaces.set(page.namespace, page.namespaceName);
  }
}

function namespaceOptions(namespaces: Map<number, string>): NamespaceInfo[] {
  return [...namespaces].map(([id, name]) => ({ id, name: name || '（主）' }));
}

function broadcastInvalidation(message: unknown): StorageInvalidationRequest {
  if (!message || typeof message !== 'object') return { pages: true };
  const record = message as { type?: unknown; filesChanged?: unknown };
  if (record.type === 'files-committed') return { files: true };
  if (record.type === 'data-committed') return { data: true };
  return {
    pages: true,
    files: record.filesChanged === true,
  };
}

function progressMessage(progress: TitleSyncProgress): string {
  if (progress.status === 'failed') return `标题同步失败：${progress.error ?? '未知错误'}`;
  if (progress.status === 'complete') return `标题同步完成 · ${progress.pagesFetched} 页`;
  return `同步标题 ${progress.pagesFetched} 页 · ${progress.namespaceName ?? '命名空间'} (${Math.min(progress.namespaceIndex + 1, progress.namespaceCount)}/${progress.namespaceCount})`;
}

function pageUrl(title: string): string {
  const path =
    pageWindow.mw?.util?.getUrl(title) ??
    `/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;
  return new URL(path, pageWindow.location.origin).href;
}

function whenPageIdle(): Promise<void> {
  return new Promise((resolve) => {
    if (typeof window.requestIdleCallback === 'function') {
      window.requestIdleCallback(() => resolve(), { timeout: 2_000 });
    } else {
      window.setTimeout(resolve, 0);
    }
  });
}
