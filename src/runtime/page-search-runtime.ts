// SPDX-License-Identifier: MPL-2.0
import type { Analyzer } from '../analyzer/analyzer';
import type { AnalyzerLoadResult } from '../analyzer/load-jieba';
import type {
  SearchIndexRebuildResult,
  SearchIndexRebuildWarning,
} from '../maintenance/local-data-maintenance';
import type { ContentSearchResult } from '../search/content-index';
import type { LuaModuleSearchResult } from '../search/lua-module-index';
import {
  type SearchIndexHandle,
  type SnapshotInspection,
  type SnapshotPublishResult,
  VersionedSearchIndexCache,
} from '../search/versioned-search-index-cache';
import {
  CombinedTitleIndex,
  LinearTitleIndex,
  type TitleSearchBackend,
  type TitleSearchResult,
} from '../search/title-index';
import {
  readActivePageHeaders,
  type WikiSearchDatabase,
} from '../storage/database';
import { readLocalSequence } from '../storage/sync-state';
import type { ContentSyncProgress, NamespaceInfo, PageRecord } from '../types';
import { AnalyzerPreparationCoordinator } from './analyzer-preparation';
import { ContentSyncSession } from './content-sync-session';
import { StagedPreparationCoordinator } from './staged-preparation';

export type PageSearchKind = 'title' | 'content' | 'lua';
export type PageSearchReadiness = 'not-started' | 'local' | 'ready';
type PageSearchHandle =
  | SearchIndexHandle<'title'>
  | SearchIndexHandle<'content'>
  | SearchIndexHandle<'lua'>;

export interface PageSearchRuntimeState {
  initialized: boolean;
  engine: AnalyzerLoadResult['engine'];
  analyzerWarning?: string;
  readiness: Readonly<Record<PageSearchKind, PageSearchReadiness>>;
  indexedPages: number;
  indexedContentPages: number;
  indexedLuaModules: number;
  namespaces: readonly NamespaceInfo[];
  throughLocalSeq: number;
  snapshots: readonly SnapshotInspection[];
  jiebaReadyMs?: number;
  contentIndexReadyMs?: number;
  luaIndexReadyMs?: number;
  contentReadyMs?: number;
}

export interface PageSearchRuntimeStatus {
  message: string;
  tone?: 'normal' | 'success' | 'error';
}

export interface PageSearchRuntimeOptions {
  database: WikiSearchDatabase;
  indexCache: VersionedSearchIndexCache;
  bootstrapAnalyzer: Analyzer;
  loadAnalyzer(): Promise<AnalyzerLoadResult>;
  waitUntilVisible(): Promise<void>;
  synchronizeTitles(
    force: boolean,
    analyzer: Analyzer,
    onBatch: (pages: PageRecord[]) => void,
  ): Promise<void>;
  synchronizeContent(force: boolean): Promise<ContentSyncProgress>;
  rebuildIndexes(analyzer: Analyzer): Promise<SearchIndexRebuildResult>;
  onStateChange?(state: PageSearchRuntimeState): void;
  onStatus?(status: PageSearchRuntimeStatus): void;
  clock?(): number;
  startedAt?: number;
}

export class PageSearchRuntime {
  private readonly database: WikiSearchDatabase;
  private readonly indexCache: VersionedSearchIndexCache;
  private readonly bootstrapAnalyzer: Analyzer;
  private readonly clock: () => number;
  private readonly startedAt: number;
  private readonly analyzerPreparation: AnalyzerPreparationCoordinator<AnalyzerLoadResult>;
  private readonly titlePreparation: StagedPreparationCoordinator;
  private readonly contentPreparation: StagedPreparationCoordinator;
  private readonly luaPreparation: StagedPreparationCoordinator;
  private readonly contentSyncSession: ContentSyncSession;
  private initializePromise: Promise<void> | undefined;
  private titleSyncPromise: Promise<string | undefined> | undefined;
  private rebuildPromise: Promise<SearchIndexRebuildWarning[]> | undefined;
  private installGeneration = 0;
  private analyzerResult: AnalyzerLoadResult | undefined;
  private searchBackend: TitleSearchBackend | undefined;
  private bootstrapIndex: LinearTitleIndex | undefined;
  private titleHandle: SearchIndexHandle<'title'> | undefined;
  private contentHandle: SearchIndexHandle<'content'> | undefined;
  private luaHandle: SearchIndexHandle<'lua'> | undefined;
  private mutableState: PageSearchRuntimeState = {
    initialized: false,
    engine: 'bootstrap',
    readiness: { title: 'not-started', content: 'not-started', lua: 'not-started' },
    indexedPages: 0,
    indexedContentPages: 0,
    indexedLuaModules: 0,
    namespaces: [],
    throughLocalSeq: 0,
    snapshots: (['title', 'content', 'lua'] as const).map((kind) => ({
      kind,
      status: 'not-started',
    })),
  };

  constructor(private readonly options: PageSearchRuntimeOptions) {
    this.database = options.database;
    this.indexCache = options.indexCache;
    this.bootstrapAnalyzer = options.bootstrapAnalyzer;
    this.clock = options.clock ?? (() => performance.now());
    this.startedAt = options.startedAt ?? this.clock();
    this.analyzerPreparation = new AnalyzerPreparationCoordinator(async () => {
      await this.initialize();
      await options.waitUntilVisible();
      const result = await options.loadAnalyzer();
      this.analyzerResult = result;
      this.patchState({
        engine: result.engine,
        analyzerWarning: result.warning,
        jiebaReadyMs: this.elapsedMs(),
      });
      return result;
    });
    this.titlePreparation = new StagedPreparationCoordinator({
      prepareLocal: () => this.prepareLocalTitle(),
      settle: () => this.settleTitle(),
    });
    this.contentPreparation = new StagedPreparationCoordinator({
      prepareLocal: () => this.prepareLocalDerived('content'),
      settle: () => this.settleDerived('content'),
    });
    this.luaPreparation = new StagedPreparationCoordinator({
      prepareLocal: () => this.prepareLocalDerived('lua'),
      settle: () => this.settleDerived('lua'),
    });
    this.contentSyncSession = new ContentSyncSession({
      synchronize: (force) => this.performContentSynchronization(force),
      reportFailure: (error) => {
        this.status(`正文同步暂停，本地已有正文仍可搜索：${errorMessage(error)}`, 'error');
      },
    });
  }

  get state(): PageSearchRuntimeState {
    return {
      ...this.mutableState,
      readiness: { ...this.mutableState.readiness },
      namespaces: this.mutableState.namespaces.map((namespace) => ({ ...namespace })),
      snapshots: this.mutableState.snapshots.map((snapshot) => ({ ...snapshot })),
    };
  }

  initialize(): Promise<void> {
    if (this.initializePromise) return this.initializePromise;
    const attempt = (async () => {
      const pages = await readActivePageHeaders(this.database);
      this.bootstrapIndex = new LinearTitleIndex(this.bootstrapAnalyzer, pages);
      this.searchBackend = this.bootstrapIndex;
      this.patchState({
        initialized: true,
        indexedPages: this.searchBackend.size,
        namespaces: namespaceOptions(pages),
        throughLocalSeq: pages.reduce(
          (maximum, page) => Math.max(maximum, page.localSeq),
          0,
        ),
      });
    })();
    const tracked = attempt.catch((error: unknown) => {
      if (this.initializePromise === tracked) this.initializePromise = undefined;
      throw error;
    });
    this.initializePromise = tracked;
    return tracked;
  }

  prepare(kind: PageSearchKind): Promise<void> {
    const rebuild = this.rebuildPromise;
    if (rebuild) {
      return settle(rebuild).then(() => this.prepare(kind));
    }
    if (kind === 'title') return this.titlePreparation.prepare();
    return kind === 'content'
      ? this.contentPreparation.prepare()
      : this.luaPreparation.prepare();
  }

  async synchronizeTitles(force = false): Promise<void> {
    const rebuild = this.rebuildPromise;
    if (rebuild) await settle(rebuild);
    await this.titlePreparation.prepareLocal();
    try {
      await this.synchronizePreparedTitles(force);
    } catch (error) {
      this.titlePreparation.invalidateSettlement();
      throw error;
    }
  }

  async synchronizeContent(force = false): Promise<void> {
    await this.initialize();
    return this.contentSyncSession.run(force);
  }

  async refresh(): Promise<void> {
    await this.initialize();
    const sequence = await readLocalSequence(this.database);
    const handles = this.handles();
    const sequenceAdvanced = sequence > this.mutableState.throughLocalSeq;
    const handleBehind = handles.some(
      (handle) => sequence > handle.throughLocalSeq,
    );
    if (!sequenceAdvanced && !handleBehind) return;

    for (const handle of handles) await this.indexCache.refresh(handle);
    if (sequenceAdvanced) {
      const pages = await readActivePageHeaders(this.database);
      this.bootstrapIndex = new LinearTitleIndex(this.bootstrapAnalyzer, pages);
      this.searchBackend = this.titleHandle
        ? new CombinedTitleIndex(this.titleHandle.index, this.bootstrapIndex)
        : this.bootstrapIndex;
      this.mutableState.namespaces = namespaceOptions(pages);
    }
    this.mutableState.throughLocalSeq = Math.max(
      this.mutableState.throughLocalSeq,
      sequence,
    );
    this.updateCounts();
    for (const handle of handles) this.indexCache.schedulePublish(handle);
    await this.refreshSnapshotStatus();
  }

  rebuildIndexes(): Promise<SearchIndexRebuildWarning[]> {
    if (this.rebuildPromise) return this.rebuildPromise;
    const activeLocalPreparations = Promise.all([
      this.titlePreparation.waitForActiveLocal(),
      this.contentPreparation.waitForActiveLocal(),
      this.luaPreparation.waitForActiveLocal(),
    ]);
    this.installGeneration += 1;
    const attempt = (async () => {
      await this.initialize();
      await activeLocalPreparations;
      const loadedAnalyzer = await this.analyzerPreparation.prepare();
      const rebuilt = await this.options.rebuildIndexes(loadedAnalyzer.analyzer);
      const pages = await readActivePageHeaders(this.database);
      const bootstrap = new LinearTitleIndex(this.bootstrapAnalyzer, pages);

      this.installGeneration += 1;
      this.titleHandle = rebuilt.title;
      this.contentHandle = rebuilt.content;
      this.luaHandle = rebuilt.lua;
      this.bootstrapIndex = bootstrap;
      this.searchBackend = new CombinedTitleIndex(rebuilt.title.index, bootstrap);
      this.mutableState.readiness = {
        title: retainReady(this.mutableState.readiness.title),
        content: retainReady(this.mutableState.readiness.content),
        lua: retainReady(this.mutableState.readiness.lua),
      };
      this.mutableState.namespaces = namespaceOptions(pages);
      this.mutableState.throughLocalSeq = Math.max(
        rebuilt.title.throughLocalSeq,
        rebuilt.content.throughLocalSeq,
        rebuilt.lua.throughLocalSeq,
      );
      this.updateCounts();
      await this.refreshSnapshotStatus();
      return rebuilt.warnings;
    })();
    const tracked = attempt.finally(() => {
      if (this.rebuildPromise === tracked) this.rebuildPromise = undefined;
    });
    this.rebuildPromise = tracked;
    return tracked;
  }

  async refreshSnapshotStatus(): Promise<void> {
    this.patchState({ snapshots: await this.indexCache.inspect() });
  }

  searchTitles(query: string, namespace?: number): TitleSearchResult[] {
    return this.searchBackend?.search(query, namespace) ?? [];
  }

  searchContent(query: string, namespace?: number): ContentSearchResult[] {
    return this.contentHandle?.index.search(query, namespace) ?? [];
  }

  searchLua(query: string): LuaModuleSearchResult[] {
    return this.luaHandle?.index.search(query) ?? [];
  }

  hasLoadedContentIndex(): boolean {
    return Boolean(this.contentHandle || this.luaHandle);
  }

  private async prepareLocalTitle(): Promise<void> {
    await this.initialize();
    const installGeneration = this.installGeneration;
    if (!this.titleHandle) {
      this.status('正在按需加载分词引擎与标题索引…');
      const loadedAnalyzer = await this.analyzerPreparation.prepare();
      const restored = await this.indexCache.restoreOrRebuild(
        'title',
        loadedAnalyzer.analyzer,
      );
      if (installGeneration === this.installGeneration || !this.titleHandle) {
        this.titleHandle = restored;
        this.searchBackend = new CombinedTitleIndex(
          restored.index,
          this.bootstrapIndex!,
        );
      }
    }
    this.setReadiness('title', 'local');
    this.updateCounts();
    await this.refreshSnapshotStatus();
  }

  private async prepareLocalDerived(kind: 'content' | 'lua'): Promise<void> {
    await this.titlePreparation.prepareLocal();
    const installGeneration = this.installGeneration;
    await this.options.waitUntilVisible();
    const analyzer = this.analyzerResult?.analyzer;
    if (!analyzer || this.analyzerResult?.engine === 'bootstrap') {
      throw new Error('增强分词引擎尚未就绪');
    }
    if (kind === 'content' && !this.contentHandle) {
      this.status('正在按需恢复正文索引…');
      const restored = await this.indexCache.restoreOrRebuild('content', analyzer);
      if (installGeneration === this.installGeneration || !this.contentHandle) {
        this.contentHandle = restored;
      }
    }
    if (kind === 'lua' && !this.luaHandle) {
      this.status('正在按需恢复 Lua 索引…');
      const restored = await this.indexCache.restoreOrRebuild('lua', analyzer);
      if (installGeneration === this.installGeneration || !this.luaHandle) {
        this.luaHandle = restored;
      }
    }
    this.setReadiness(kind, 'local');
    this.updateCounts();
    this.emitState();
  }

  private async settleTitle(): Promise<void> {
    this.status('正在同步标题…');
    const snapshotWarning = await this.synchronizePreparedTitles(false);
    this.setReadiness('title', 'ready');
    if (snapshotWarning) return;
    const count = this.mutableState.indexedPages;
    if (this.analyzerResult?.warning) {
      this.status(`jieba 加载失败，已用 Intl.Segmenter · ${count} 标题`, 'error');
    } else {
      this.status(`标题索引已就绪 · ${count} 标题 · 正文与 Lua 按模式加载`, 'success');
    }
  }

  private async settleDerived(kind: 'content' | 'lua'): Promise<void> {
    await this.titlePreparation.prepare();
    await this.synchronizeContent(false);
    this.setReadiness(kind, 'ready');
    const readyMs = this.elapsedMs();
    if (kind === 'content') this.mutableState.contentIndexReadyMs = readyMs;
    else this.mutableState.luaIndexReadyMs = readyMs;
    this.mutableState.contentReadyMs = Math.max(
      this.mutableState.contentIndexReadyMs ?? 0,
      this.mutableState.luaIndexReadyMs ?? 0,
    );
    await this.refreshSnapshotStatus();
  }

  private synchronizePreparedTitles(force: boolean): Promise<string | undefined> {
    if (this.titleSyncPromise) return this.titleSyncPromise;
    const handle = this.titleHandle;
    const analyzer = this.analyzerResult?.analyzer;
    if (!handle || !analyzer) return Promise.reject(new Error('增强标题索引尚未就绪'));

    const attempt = (async () => {
      let synchronizationError: unknown;
      try {
        await this.options.synchronizeTitles(force, analyzer, (pages) => {
          handle.index.update(pages);
          if (handle === this.titleHandle) {
            this.mutableState.namespaces = mergeNamespaces(
              this.mutableState.namespaces,
              pages,
            );
            this.updateCounts();
          }
        });
      } catch (error) {
        synchronizationError = error;
      }
      try {
        await this.refresh();
      } catch (refreshError) {
        if (synchronizationError === undefined) throw refreshError;
      }
      if (synchronizationError !== undefined) throw synchronizationError;

      const current = this.titleHandle;
      let warning: string | undefined;
      if (current) {
        warning = snapshotPublishWarning(await this.indexCache.publish(current));
        if (warning) this.status(warning, 'error');
        else this.status(`标题同步完成 · ${this.mutableState.indexedPages} 页`, 'success');
      }
      await this.refreshSnapshotStatus();
      return warning;
    })();
    const tracked = attempt.finally(() => {
      if (this.titleSyncPromise === tracked) this.titleSyncPromise = undefined;
    });
    this.titleSyncPromise = tracked;
    return tracked;
  }

  private async performContentSynchronization(force: boolean): Promise<void> {
    let progress: ContentSyncProgress | undefined;
    let synchronizationError: unknown;
    try {
      progress = await this.options.synchronizeContent(force);
    } catch (error) {
      synchronizationError = error;
    }

    try {
      if (synchronizationError === undefined && force && this.hasLoadedContentIndex()) {
        const pages = await this.database.pages.toArray();
        await this.contentHandle?.index.rebuildAsync(pages);
        await this.luaHandle?.index.rebuildAsync(pages);
      }
      await this.refresh();
    } catch (refreshError) {
      if (synchronizationError === undefined) throw refreshError;
    }
    if (synchronizationError !== undefined) throw synchronizationError;

    let warning: string | undefined;
    for (const handle of [this.contentHandle, this.luaHandle]) {
      if (!handle) continue;
      await this.indexCache.refresh(handle);
      warning ??= snapshotPublishWarning(await this.indexCache.publish(handle));
    }
    this.updateCounts();
    await this.refreshSnapshotStatus();
    const loaded = this.hasLoadedContentIndex()
      ? ` · ${this.mutableState.indexedContentPages} 正文 / ${this.mutableState.indexedLuaModules} Lua`
      : ' · 正文与 Lua 索引将在切换模式时按需恢复';
    this.status(
      warning ?? `正文同步完成 · ${progress!.done}/${progress!.total} 页${loaded}`,
      progress!.failed || warning ? 'error' : 'success',
    );
  }

  private handles(): PageSearchHandle[] {
    return [this.titleHandle, this.contentHandle, this.luaHandle].filter(
      (handle): handle is PageSearchHandle => handle !== undefined,
    );
  }

  private updateCounts(): void {
    this.mutableState.indexedPages = this.searchBackend?.size ?? 0;
    this.mutableState.indexedContentPages = this.contentHandle?.index.size ?? 0;
    this.mutableState.indexedLuaModules = this.luaHandle?.index.size ?? 0;
    this.emitState();
  }

  private setReadiness(kind: PageSearchKind, readiness: PageSearchReadiness): void {
    this.mutableState.readiness = { ...this.mutableState.readiness, [kind]: readiness };
    this.emitState();
  }

  private patchState(patch: Partial<PageSearchRuntimeState>): void {
    this.mutableState = { ...this.mutableState, ...patch };
    this.emitState();
  }

  private emitState(): void {
    this.options.onStateChange?.(this.state);
  }

  private status(
    message: string,
    tone?: PageSearchRuntimeStatus['tone'],
  ): void {
    this.options.onStatus?.({ message, tone });
  }

  private elapsedMs(): number {
    return Math.max(0, Math.round(this.clock() - this.startedAt));
  }
}

function namespaceOptions(pages: PageRecord[]): NamespaceInfo[] {
  const namespaces = new Map<number, string>();
  for (const page of pages) {
    if (!page.deleted) namespaces.set(page.namespace, page.namespaceName);
  }
  return [...namespaces].map(([id, name]) => ({ id, name: name || '（主）' }));
}

function mergeNamespaces(
  existing: readonly NamespaceInfo[],
  pages: PageRecord[],
): NamespaceInfo[] {
  const namespaces = new Map(existing.map(({ id, name }) => [id, name]));
  for (const page of pages) {
    if (!page.deleted) namespaces.set(page.namespace, page.namespaceName || '（主）');
  }
  return [...namespaces].map(([id, name]) => ({ id, name }));
}

function retainReady(readiness: PageSearchReadiness): PageSearchReadiness {
  return readiness === 'ready' ? 'ready' : 'local';
}

function snapshotPublishWarning(result: SnapshotPublishResult): string | undefined {
  if (result.status === 'published' || result.reason === 'not-newer') return undefined;
  if (result.reason === 'too-large') {
    return '索引快照超过 64 MiB，已跳过保存；当前搜索仍可正常使用';
  }
  if (result.reason === 'quota') {
    return '浏览器存储配额不足，索引快照未保存；当前搜索仍可正常使用';
  }
  if (result.reason === 'sequence-changed') {
    return '页面数据仍在更新，本次快照稍后重试；当前搜索仍可正常使用';
  }
  return '索引快照已被清理，本次不再保存；当前搜索仍可正常使用';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function settle(promise: Promise<unknown>): Promise<void> {
  return promise.then(
    () => undefined,
    () => undefined,
  );
}
