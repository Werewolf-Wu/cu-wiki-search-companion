// SPDX-License-Identifier: MPL-2.0
import { Analyzer, createBootstrapSegmenter } from './analyzer/analyzer';
import { loadAnalyzer, type AnalyzerLoadResult } from './analyzer/load-jieba';
import {
  DEFAULT_DATA_CODE_RULES,
  parseDataFieldRules,
} from './data/data-field-rules';
import { insertAtEditorSelection, wikiLink } from './editor';
import { LocalDataMaintenance } from './maintenance/local-data-maintenance';
import { AnalyzerPreparationCoordinator } from './runtime/analyzer-preparation';
import { changeBroadcastEffect } from './runtime/change-broadcast';
import { browserTaskScheduler } from './runtime/cooperative-task-scheduler';
import { DataCodeSyncSession } from './runtime/data-code-sync-session';
import { ContentSyncSession } from './runtime/content-sync-session';
import { InitialBackgroundRefreshCoordinator } from './runtime/initial-background-refresh';
import {
  MirrorSyncOrchestrator,
  type MirrorSyncEvent,
  type MirrorSyncOutcome,
  type SyncAttemptResult,
} from './runtime/mirror-sync-orchestrator';
import { CommittedRecentChangeRefresh } from './runtime/recent-change-commit-refresh';
import { CommittedReconciliationRefresh } from './runtime/reconciliation-commit-refresh';
import {
  RuntimeLifecycleCoordinator,
  type StorageInvalidation,
  type StorageInvalidationRequest,
} from './runtime/runtime-lifecycle-coordinator';
import { StagedPreparationCoordinator } from './runtime/staged-preparation';
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
import { readActivePageHeaders, WikiSearchDatabase } from './storage/database';
import { dataRulesPreference } from './storage/data-rules-preference';
import { readLocalSequence } from './storage/sync-state';
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
import { SearchPanel, type MaintenanceActionFeedback } from './ui/search-panel';

declare const __CU_WIKI_BUILD_ID__: string;

interface MediaWikiWindow extends Window {
  mw?: {
    config?: { get(key: string): unknown };
    util?: { getUrl(title: string): string };
  };
  __CU_WIKI_SEARCH__?: DebugApi;
}

interface DebugApi {
  ready: boolean;
  scriptVersion: string;
  buildId: string;
  engine?: AnalyzerLoadResult['engine'];
  indexedPages: number;
  indexedFiles: number;
  indexedDataCodes: number;
  indexedContentPages: number;
  indexedLuaModules: number;
  startupMs?: number;
  jiebaReadyMs?: number;
  contentIndexReadyMs?: number;
  luaIndexReadyMs?: number;
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

interface DataCodeCommit {
  origin: 'refresh' | 'save';
  rulesSource: string;
  result: Awaited<ReturnType<typeof syncDataCodes>>;
}

const pageWindow = unsafeWindow as unknown as MediaWikiWindow;
const bootStartedAt = performance.now();
const LEGACY_DATA_EXTRACTION_RULES_KEY = 'data-extraction-rules';
let startupPanel: SearchPanel | undefined;

if (shouldActivate()) {
  void start().catch((error: unknown) => {
    startupPanel?.setStartupFailure(errorMessage(error), () => pageWindow.location.reload());
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
  let incrementalCoordinator: IncrementalSyncCoordinator | undefined;
  let runtimeLifecycle: RuntimeLifecycleCoordinator | undefined;
  let dataCodeSyncSession: DataCodeSyncSession<DataCodeCommit> | undefined;
  let mirrorSyncOrchestrator: MirrorSyncOrchestrator | undefined;
  let writesCompatible = true;
  let lastAppliedLocalSeq = 0;
  let lastAppliedFileChangeSeq = 0;
  let analyzerResult: AnalyzerLoadResult | undefined;
  let dataCodeRulesSource = DEFAULT_DATA_CODE_RULES;
  let fileReady: Promise<void> | undefined;
  let fileReadySettled = false;
  let resolveInitialCacheReady!: () => void;
  const initialCacheReady = new Promise<void>((resolve) => {
    resolveInitialCacheReady = resolve;
  });
  const namespaces = new Map<number, string>();
  const contentModel = pageWindow.mw?.config?.get('wgPageContentModel');
  const canInsertWikiText = typeof contentModel !== 'string' || contentModel === 'wikitext';
  const initialBackgroundRefresh = new InitialBackgroundRefreshCoordinator({
    canRun: () => writesCompatible,
    isVisible: () => document.visibilityState === 'visible',
    syncIncremental: () => requestIncrementalSync(),
    syncData: async () => (await requestDataCodeSync(false)).status === 'complete',
  });

  const panel = new SearchPanel({
    prepareSearch: (kind) => {
      const preparation =
        kind === 'title'
          ? ensureEnhancedTitleStarted()
          : ensureDerivedSearchStarted(kind);
      observeRuntimeTask(
        preparation,
        'enhanced search startup',
        `${searchKindLabel(kind)}加载失败，已有本地搜索仍可用`,
      );
    },
    prepareFiles: () => {
      observeRuntimeTask(
        ensureFileSearchStarted(false),
        'file resource startup',
        '文件资源加载失败，本地缓存仍可用',
      );
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
      const link = wikiLink(
        result.title,
        'kind' in result ? result.title : query,
        result.namespace,
      );
      const editor = insertAtEditorSelection(link);
      panel.setStatus(`已插入 ${link} · ${editor === 'codemirror' ? 'CodeMirror' : '文本框'}`, 'success');
    },
    copy: (result, query) => {
      const link = wikiLink(
        result.title,
        'kind' in result ? result.title : query,
        result.namespace,
      );
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
      observeRuntimeTask(
        lifecycle.refreshMirror({
          syncTitles: () => requestSync(false),
          reconcile: () => requestManualReconciliation(),
          syncData: () => requestManualDataCodeSync(),
          syncContent: () => requestContentSync(false),
        }),
        'manual mirror refresh',
        '重新同步本地数据暂停',
      );
    },
    refreshFiles: () => {
      observeRuntimeTask(
        ensureFileSearchStarted(true),
        'manual file refresh',
        '文件资源同步暂停，本地缓存仍可搜索',
      );
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
  const contentSyncSession = new ContentSyncSession({
    synchronize: (force) => performContentSync(force),
    reportFailure: (error) => {
      const message = error instanceof Error ? error.message : String(error);
      panel.setStatus(`正文同步暂停，本地已有正文仍可搜索：${message}`, 'error');
      console.error('[CU Wiki Search] content sync failed', error);
    },
  });
  const analyzerPreparation = new AnalyzerPreparationCoordinator(async () => {
    await initialCacheReady;
    await browserTaskScheduler.waitUntilVisible();
    const loadedAnalyzer = await loadAnalyzer();
    analyzerResult = loadedAnalyzer;
    debugApi.engine = loadedAnalyzer.engine;
    debugApi.jiebaReadyMs = Math.round(performance.now() - bootStartedAt);
    return loadedAnalyzer;
  });
  const titlePreparation = new StagedPreparationCoordinator({
    prepareLocal: () => prepareEnhancedTitleIndex(),
    settle: () => settleEnhancedTitleIndex(),
  });
  const contentPreparation = new StagedPreparationCoordinator({
    prepareLocal: () => prepareDerivedSearchIndex('content'),
    settle: () => settleDerivedSearchIndex('content'),
  });
  const luaPreparation = new StagedPreparationCoordinator({
    prepareLocal: () => prepareDerivedSearchIndex('lua'),
    settle: () => settleDerivedSearchIndex('lua'),
  });
  startupPanel = panel;
  panel.setInsertMode(canInsertWikiText);
  panel.setStatus('正在加载本地索引与分词引擎…');

  const debugApi: DebugApi = {
    ready: false,
    scriptVersion: GM_info.script.version,
    buildId: __CU_WIKI_BUILD_ID__,
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
    readActivePageHeaders(database),
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
  const committedReconciliationRefresh = new CommittedReconciliationRefresh({
    readState: () => readReconciliationSyncState(database),
    lastAppliedSequence: () => lastAppliedLocalSeq,
    refresh: (invalidation) => refreshIndexesFromStorage(invalidation),
    broadcast: (message) => incrementalChannel?.postMessage(message),
  });
  const committedRecentChangeRefresh = new CommittedRecentChangeRefresh({
    refresh: (invalidation) => refreshIndexesFromStorage(invalidation),
    broadcast: (message) => incrementalChannel?.postMessage(message),
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
  dataCodeSyncSession = new DataCodeSyncSession<DataCodeCommit>({
    refresh: (force) => performDataCodeRefresh(force),
    save: (source) => performDataCodeSave(source),
    apply: (commit) => applyDataCodeCommit(commit),
  });
  if (incrementalCoordinator) {
    mirrorSyncOrchestrator = new MirrorSyncOrchestrator({
      coordinator: incrementalCoordinator,
      facts: {
        reconcile: (force, onProgress) =>
          reconcileWikiMirror(database, api, fallbackAnalyzer, {
            force,
            onProgress,
          }),
        catchUp: () => syncRecentChanges(database, api, fallbackAnalyzer),
      },
      committed: {
        refreshReconciliation: () => committedReconciliationRefresh.apply(),
        refreshRecentChanges: (result) => committedRecentChangeRefresh.apply(result),
      },
      derived: {
        refreshData: () => requestDataCodeSync(false),
        hasLoadedContentIndex: () => Boolean(contentIndex || luaModuleIndex),
        refreshContent: () => runContentSync(false),
      },
      onEvent: (event) => handleMirrorSyncEvent(event),
    });
  }
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
      ? `已恢复 ${searchBackend.size} 个标题 · ${dataCodeIndex.size} 个 Data 代码 · 各模式按需加载`
      : `本地数据版本不兼容，已停止后台写入；可搜索现有数据或执行完整重置`,
    writesCompatible ? 'success' : 'error',
  );
  resolveInitialCacheReady();

  if (typeof BroadcastChannel === 'function') {
    incrementalChannel = new BroadcastChannel('cu-wiki-local-search:changes:v1');
    incrementalChannel.addEventListener('message', (event) => {
      const effect = changeBroadcastEffect(event.data);
      if (effect.type === 'reset') {
        database.close();
        location.reload();
        return;
      }
      if (effect.dataRefresh === 'pending') initialBackgroundRefresh.markPending();
      else if (effect.dataRefresh === 'complete') initialBackgroundRefresh.markComplete();
      if (document.visibilityState !== 'visible') {
        runtimeLifecycle?.deferStorageRefresh(effect.invalidation);
        return;
      }
      observeRuntimeTask(
        refreshIndexesFromStorage(effect.invalidation),
        'broadcast storage refresh',
        '本地索引刷新暂停，稍后将自动重试',
      );
      if (effect.dataRefresh === 'pending') {
        observeRuntimeTask(
          initialBackgroundRefresh.request(),
          'broadcast Data refresh',
        );
      }
    });
  }

  const requestVisibleIncrementalSync = (): void => {
    if (document.visibilityState !== 'visible') return;
    if (runtimeLifecycle) {
      observeRuntimeTask(
        runtimeLifecycle.resumeStorageRefresh(),
        'visible storage refresh',
        '本地索引刷新暂停，稍后将自动重试',
      );
    }
    observeRuntimeTask(initialBackgroundRefresh.request(), 'visible Data refresh');
    observeRuntimeTask(requestIncrementalSync(), 'visible incremental sync');
  };
  window.addEventListener('focus', requestVisibleIncrementalSync);
  document.addEventListener('visibilitychange', requestVisibleIncrementalSync);
  window.setInterval(requestVisibleIncrementalSync, 30_000);

  if (writesCompatible) {
    observeRuntimeTask(
      (async () => {
        await whenPageIdle();
        await initialBackgroundRefresh.request();
      })(),
      'initial background refresh',
      '后台首次刷新暂停，稍后将自动重试',
    );
  }

  function ensureEnhancedTitleStarted(): Promise<void> {
    return titlePreparation.prepare();
  }

  async function prepareEnhancedTitleIndex(): Promise<void> {
    panel.setStatus('正在按需加载分词引擎与标题索引…');
    const loadedAnalyzer = await analyzerPreparation.prepare();
    const restoredTitle = await indexCache.restoreOrRebuild(
      'title',
      loadedAnalyzer.analyzer,
    );
    const upgradedIndex = restoredTitle.index;
    if (!bootstrapIndex) throw new Error('本地标题缓存尚未就绪');
    titleHandle = restoredTitle;
    titleIndex = upgradedIndex;
    searchBackend = new CombinedTitleIndex(upgradedIndex, bootstrapIndex);
    debugApi.indexedPages = upgradedIndex.size;
    await updateSnapshotDebug();
    panel.refreshResults();
  }

  async function settleEnhancedTitleIndex(): Promise<void> {
    panel.setStatus('正在同步标题…');
    const syncResult = await runSync(false);
    if (syncResult.status === 'error') throw syncResult.error;
    if (!analyzerResult || !titleIndex) throw new Error('增强标题索引尚未就绪');
    if (analyzerResult.warning) {
      panel.setStatus(
        `jieba 加载失败，已用 Intl.Segmenter · ${titleIndex.size} 标题`,
        'error',
      );
    } else {
      panel.setStatus(
        `标题索引已就绪 · ${titleIndex.size} 标题 · 正文与 Lua 按模式加载`,
        'success',
      );
    }
  }

  function ensureDerivedSearchStarted(kind: 'content' | 'lua'): Promise<void> {
    return kind === 'content' ? contentPreparation.prepare() : luaPreparation.prepare();
  }

  async function prepareDerivedSearchIndex(kind: 'content' | 'lua'): Promise<void> {
    panel.setStatus(
      kind === 'content' ? '正在按需恢复正文索引…' : '正在按需恢复 Lua 索引…',
    );
    await titlePreparation.prepareLocal();
    await browserTaskScheduler.waitUntilVisible();
    if (!analyzerResult || analyzerResult.engine === 'bootstrap') {
      throw new Error('增强分词引擎尚未就绪');
    }
    if (kind === 'content') {
      const restored = await indexCache.restoreOrRebuild(
        'content',
        analyzerResult.analyzer,
      );
      contentHandle = restored;
      contentIndex = restored.index;
      debugApi.indexedContentPages = restored.index.size;
    } else {
      const restored = await indexCache.restoreOrRebuild(
        'lua',
        analyzerResult.analyzer,
      );
      luaHandle = restored;
      luaModuleIndex = restored.index;
      debugApi.indexedLuaModules = restored.index.size;
    }
    panel.refreshResults();
  }

  async function settleDerivedSearchIndex(kind: 'content' | 'lua'): Promise<void> {
    const handle = kind === 'content' ? contentHandle : luaHandle;
    if (!handle) throw new Error(`${searchKindLabel(kind)}尚未就绪`);
    await ensureEnhancedTitleStarted();
    await settleRestoredDerivedHandle(handle);
    const readyMs = Math.round(performance.now() - bootStartedAt);
    if (kind === 'content') debugApi.contentIndexReadyMs = readyMs;
    else debugApi.luaIndexReadyMs = readyMs;
    debugApi.contentReadyMs = Math.max(
      debugApi.contentIndexReadyMs ?? 0,
      debugApi.luaIndexReadyMs ?? 0,
    );
    await updateSnapshotDebug();
    panel.refreshResults();
  }

  async function settleRestoredDerivedHandle<K extends 'content' | 'lua'>(
    handle: SearchIndexHandle<K>,
  ): Promise<void> {
    await runContentSync(false);
    await indexCache.refresh(handle);
    const warning = snapshotPublishWarning(await indexCache.publish(handle));
    if (warning) panel.setStatus(warning, 'error');
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
    const task = (async () => {
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
      const coordinated = incrementalCoordinator
        ? await incrementalCoordinator.runExclusive(run)
        : (await run(), 'ran' as const);
      if (coordinated === 'lock-unavailable') {
        throw new Error('无法取得跨标签写入锁，请确认浏览器支持 Web Locks 后重试');
      }
      if (!finalState) throw new Error('文件资源同步未返回结果');
      await rebuildFileIndex();
      await refreshIndexesFromStorage({ files: true });
      incrementalChannel?.postMessage({ type: 'files-committed' });
      panel.setStatus(
        `文件资源同步完成 · ${finalState.pagesFetched} 项可独立搜索`,
        'success',
      );
    })();
    fileSyncPromise = task;
    try {
      await task;
    } finally {
      if (fileSyncPromise === task) fileSyncPromise = undefined;
    }
  }

  async function requestSync(force: boolean): Promise<void> {
    await titlePreparation.prepareLocal();
    const result = await runSync(force);
    if (result.status === 'error') {
      titlePreparation.invalidateSettlement();
      throw result.error;
    }
  }

  async function saveDataCodeRules(source: string): Promise<void> {
    assertWritesAllowed();
    parseDataFieldRules(source);
    const session = dataCodeSyncSession;
    if (!session) throw new Error('Data 代码同步尚未就绪');
    const outcome = await session.save(source);
    if (outcome.status === 'error') throw outcome.error;
  }

  async function requestDataCodeSync(force: boolean): Promise<SyncAttemptResult> {
    if (!ensureWritesAllowed()) {
      initialBackgroundRefresh.markPending();
      return { status: 'error', error: new Error('本地数据版本不兼容') };
    }
    const session = dataCodeSyncSession;
    if (!session) {
      return { status: 'error', error: new Error('Data 代码同步尚未就绪') };
    }
    const outcome = await session.refresh(force);
    if (outcome.status === 'complete') return { status: 'complete' };
    initialBackgroundRefresh.markPending();
    const message = errorMessage(outcome.error);
    panel.setStatus(
      `Data 代码更新失败，${dataCodeIndex?.size ? '继续使用本地缓存' : '标题搜索仍可用'}：${message}`,
      'error',
    );
    console.error('[CU Wiki Search] Data code sync failed', outcome.error);
    return outcome;
  }

  async function performDataCodeRefresh(force: boolean): Promise<DataCodeCommit> {
    let result: Awaited<ReturnType<typeof syncDataCodes>> | undefined;
    let canonicalRules = dataCodeRulesSource;
    await runCoordinatedWriter('data-refresh', async () => {
      canonicalRules = await readCanonicalDataRules();
      result = await syncDataCodes(database, fallbackAnalyzer, {
        force,
        rulesSource: canonicalRules,
      });
    });
    if (!result) throw new Error('Data 代码同步未返回结果');
    return { origin: 'refresh', rulesSource: canonicalRules, result };
  }

  async function performDataCodeSave(source: string): Promise<DataCodeCommit> {
    let result: Awaited<ReturnType<typeof syncDataCodes>> | undefined;
    await runCoordinatedWriter('data-save', async () => {
      result = await syncDataCodes(database, fallbackAnalyzer, {
        force: true,
        rulesSource: source,
      });
      // Keep the preference and matching cache commit under the same writer lock.
      await dataRulesPreference.set(source);
    });
    if (!result) throw new Error('Data 代码规则保存未返回结果');
    return { origin: 'save', rulesSource: source, result };
  }

  function applyDataCodeCommit(commit: DataCodeCommit): void {
    dataCodeIndex = new DataCodeIndex(fallbackAnalyzer, commit.result.records);
    dataCodeRulesSource = commit.rulesSource;
    debugApi.indexedDataCodes = dataCodeIndex.size;
    panel.setDataCodeRules(dataCodeRulesSource, DEFAULT_DATA_CODE_RULES);
    panel.refreshResults();
    initialBackgroundRefresh.markComplete();
    if (commit.result.refreshed || commit.origin === 'save') {
      incrementalChannel?.postMessage({ type: 'data-committed' });
    }
    if (commit.origin === 'save') {
      panel.setStatus(`Data 代码检索字段已保存 · ${dataCodeIndex.size} 条`, 'success');
    } else if (commit.result.refreshed) {
      panel.setStatus(`Data 代码更新完成 · ${dataCodeIndex.size} 条`, 'success');
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
    await ensureEnhancedTitleStarted();
    return runContentSync(force);
  }

  async function requestIncrementalSync(): Promise<void> {
    if (!ensureWritesAllowed()) return;
    const orchestrator = mirrorSyncOrchestrator;
    if (!orchestrator) return;
    const outcome = await orchestrator.runScheduled();
    if (outcome.status === 'lock-unavailable' || outcome.status === 'not-due') {
      await refreshIndexesFromStorage();
    }
    await applyMirrorSyncOutcome(outcome);
  }

  async function requestManualReconciliation(): Promise<void> {
    if (!ensureWritesAllowed()) throw new Error('本地数据版本不兼容');
    const orchestrator = mirrorSyncOrchestrator;
    if (!orchestrator) throw new Error('全量对账协调器尚未就绪');
    const outcome = await orchestrator.reconcileNow();
    await applyMirrorSyncOutcome(outcome);
    if (outcome.status !== 'complete') throw mirrorSyncOutcomeError(outcome);
  }

  function handleMirrorSyncEvent(event: MirrorSyncEvent): void {
    if (event.type === 'started') {
      if (event.request === 'scheduled') debugApi.incrementalStatus = 'running';
      else debugApi.reconciliationStatus = 'running';
      return;
    }
    debugApi.reconciliationStatus = 'running';
    if (event.type === 'reconciliation-started') return;
    panel.setStatus(
      `全量对账 ${event.state.pagesFetched} 页 · ${Math.min(event.state.namespaceIndex + 1, event.state.namespaceIds.length)}/${event.state.namespaceIds.length}`,
    );
  }

  async function applyMirrorSyncOutcome(outcome: MirrorSyncOutcome): Promise<void> {
    const reconciliation = outcome.reconciliation;
    if (reconciliation) {
      debugApi.reconciliationStatus =
        reconciliation.status === 'complete'
          ? 'complete'
          : reconciliation.status;
      if (reconciliation.status === 'complete') {
        debugApi.reconciliationCompletedAt = (
          await readReconciliationSyncState(database)
        )?.completedAt;
      }
    }
    const recentChanges = outcome.recentChanges;
    if (recentChanges?.status === 'complete') {
      debugApi.incrementalStatus = 'complete';
      debugApi.incrementalThrough = recentChanges.through;
    } else if (recentChanges) {
      debugApi.incrementalStatus = recentChanges.status;
    } else if (outcome.request === 'scheduled') {
      debugApi.incrementalStatus =
        outcome.status === 'not-due'
          ? 'idle'
          : outcome.status === 'catch-up-error' ||
              outcome.status === 'data-error' ||
              outcome.status === 'content-error'
            ? 'error'
            : outcome.status;
    } else if (outcome.status === 'catch-up-error') {
      debugApi.incrementalStatus = 'error';
    }
    if (!reconciliation && outcome.request === 'manual') {
      debugApi.reconciliationStatus =
        outcome.status === 'data-error' ||
        outcome.status === 'content-error' ||
        outcome.status === 'catch-up-error'
          ? 'error'
          : outcome.status;
    } else if (
      !reconciliation &&
      outcome.errors?.synchronization &&
      debugApi.reconciliationStatus === 'running'
    ) {
      debugApi.reconciliationStatus = 'error';
    }

    for (const [phase, error] of Object.entries(outcome.errors ?? {})) {
      console.error(`[CU Wiki Search] mirror sync ${phase} failed`, error);
    }
    if (outcome.status === 'complete') {
      if (outcome.request === 'manual' && reconciliation?.status === 'complete') {
        panel.setStatus(
          `全量对账完成 · ${reconciliation.pagesFetched} 页 · ${reconciliation.pagesChanged} 个页面变化` +
            (reconciliation.filesChanged ? ' · 文件资源已更新' : ''),
          'success',
        );
      } else if (
        recentChanges?.status === 'complete' &&
        (recentChanges.changedPages.length || recentChanges.filesChanged)
      ) {
        panel.setStatus(
          `增量同步完成 · ${recentChanges.changedPages.length} 个页面` +
            (recentChanges.filesChanged ? ' · 文件资源已更新' : ''),
          'success',
        );
      }
      return;
    }
    if (outcome.status === 'not-due') return;
    const message = mirrorSyncOutcomeError(outcome).message;
    const prefix = outcome.request === 'manual' ? '全量对账' : '增量同步';
    panel.setStatus(`${prefix}暂停，本地已有内容仍可搜索：${message}`, 'error');
  }

  function mirrorSyncOutcomeError(outcome: MirrorSyncOutcome): Error {
    const cause =
      outcome.errors?.synchronization ??
      outcome.errors?.catchUp ??
      outcome.errors?.data ??
      outcome.errors?.content ??
      outcome.errors?.committedRefresh;
    if (cause instanceof Error) return cause;
    if (cause !== undefined) return new Error(String(cause));
    if (outcome.status === 'login-required') return new Error('请先登录灰机账号');
    if (outcome.status === 'lock-unavailable') {
      return new Error('无法取得跨标签写入锁，请确认浏览器支持 Web Locks 后重试');
    }
    if (outcome.status === 'no-baseline') {
      return new Error('尚无完整标题基线，请先重试标题同步');
    }
    if (outcome.status === 'not-due') return new Error('全量对账尚未到期');
    return new Error('同步未完成，请稍后重试');
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
    const [sequence, incrementalState, dataState] = await Promise.all([
      invalidation.pages ? readLocalSequence(database) : 0,
      invalidation.pages || invalidation.files
        ? readRecentChangeSyncState(database)
        : undefined,
      invalidation.data ? readDataCodeSyncState(database) : undefined,
    ]);
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
      if (contentHandle) await indexCache.refresh(contentHandle);
      if (luaHandle) await indexCache.refresh(luaHandle);
      if (sequenceAdvanced) {
        const allPages = await readActivePageHeaders(database);
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

  function runContentSync(force: boolean): Promise<void> {
    if (!ensureWritesAllowed()) return Promise.resolve();
    return contentSyncSession.run(force);
  }

  async function performContentSync(force: boolean): Promise<void> {
    let finalProgress: Awaited<ReturnType<typeof syncContent>> | undefined;
    const writeContentFacts = async (): Promise<void> => {
      finalProgress = await syncContent(database, api, {
        force,
        onBatch: () => {
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
    const refreshDerivedIndexes = async (): Promise<void> => {
      await refreshIndexesFromStorage();
      debugApi.indexedContentPages = contentIndex?.size ?? 0;
      debugApi.indexedLuaModules = luaModuleIndex?.size ?? 0;
      panel.refreshResults();
    };
    let coordinated: 'ran' | 'lock-unavailable';
    if (runtimeLifecycle) {
      coordinated = await runtimeLifecycle.runContentWriter(
        writeContentFacts,
        refreshDerivedIndexes,
      );
    } else {
      await writeContentFacts();
      await refreshDerivedIndexes();
      coordinated = 'ran';
    }
    if (coordinated === 'lock-unavailable') {
      throw new Error('另一个标签页正在写入本地镜像，请稍后重试');
    }
    if (!finalProgress) throw new Error('正文同步未返回进度');
    if (force && (contentIndex || luaModuleIndex)) {
      const allPages = await database.pages.filter((page) => !page.deleted).toArray();
      await contentIndex?.rebuildAsync(allPages);
      await luaModuleIndex?.rebuildAsync(allPages);
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
    debugApi.indexedContentPages = contentIndex?.size ?? 0;
    debugApi.indexedLuaModules = luaModuleIndex?.size ?? 0;
    panel.refreshResults();
    const loadedIndexes =
      contentIndex || luaModuleIndex
        ? ` · ${contentIndex?.size ?? 0} 正文 / ${luaModuleIndex?.size ?? 0} Lua`
        : ' · 正文与 Lua 索引将在切换模式时按需恢复';
    panel.setStatus(
      snapshotWarning ??
        `正文同步完成 · ${finalProgress.done}/${finalProgress.total} 页${loadedIndexes}`,
      finalProgress.failed || snapshotWarning ? 'error' : 'success',
    );
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
          const allPages = await readActivePageHeaders(database);
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

  async function rebuildSearchIndexes(): Promise<MaintenanceActionFeedback | undefined> {
    assertWritesAllowed();
    await Promise.all([
      titlePreparation.waitForActiveLocal(),
      contentPreparation.waitForActiveLocal(),
      luaPreparation.waitForActiveLocal(),
    ]);
    const rebuilt = await analyzerPreparation.runLocal((loadedAnalyzer) =>
      maintenance.rebuildSearchIndexes(loadedAnalyzer.analyzer),
    );
    titleHandle = rebuilt.title;
    contentHandle = rebuilt.content;
    luaHandle = rebuilt.lua;
    titleIndex = rebuilt.title.index;
    contentIndex = rebuilt.content.index;
    luaModuleIndex = rebuilt.lua.index;
    const pages = await readActivePageHeaders(database);
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
    if (rebuilt.warnings.length) {
      return {
        message: `索引已重建，某些快照未保存：${rebuilt.warnings.map(({ message }) => message).join('；')}；当前搜索可用`,
        tone: 'normal',
      };
    }
    return undefined;
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

  function observeRuntimeTask(
    task: Promise<unknown>,
    context: string,
    userMessage?: string,
  ): void {
    void task.catch((error: unknown) => {
      if (userMessage) panel.setStatus(`${userMessage}：${errorMessage(error)}`, 'error');
      console.error(`[CU Wiki Search] ${context} failed`, error);
    });
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

function progressMessage(progress: TitleSyncProgress): string {
  if (progress.status === 'failed') return `标题同步失败：${progress.error ?? '未知错误'}`;
  if (progress.status === 'complete') return `标题同步完成 · ${progress.pagesFetched} 页`;
  return `同步标题 ${progress.pagesFetched} 页 · ${progress.namespaceName ?? '命名空间'} (${Math.min(progress.namespaceIndex + 1, progress.namespaceCount)}/${progress.namespaceCount})`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function searchKindLabel(kind: 'title' | 'content' | 'lua'): string {
  if (kind === 'content') return '正文索引';
  if (kind === 'lua') return 'Lua 索引';
  return '标题索引';
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
