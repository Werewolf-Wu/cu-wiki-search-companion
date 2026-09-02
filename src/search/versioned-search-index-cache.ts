// SPDX-License-Identifier: MPL-2.0
import type { Analyzer } from '../analyzer/analyzer';
import {
  readActivePageHeaders,
  readPageHeadersAfter,
  type WikiSearchDatabase,
} from '../storage/database';
import {
  createCompatibilityKey,
  type SearchIndexKind,
} from '../storage/version-contract';
import {
  isNonNegativeSafeInteger,
  readLocalSequence,
} from '../storage/sync-state';
import type { IndexSnapshotRecord, PageRecord, SyncStateRecord } from '../types';
import { ContentIndex } from './content-index';
import { LuaModuleIndex } from './lua-module-index';
import { TitleIndex } from './title-index';

const SNAPSHOT_GENERATION_KEY = 'search-index-generation';
const SNAPSHOT_FORMAT_VERSION = 2;
const MAX_PAYLOAD_BYTES = 64 * 1024 * 1024;
const DEFAULT_PUBLISH_DELAY_MS = 5_000;

type SearchIndexFor<K extends SearchIndexKind> = K extends 'title'
  ? TitleIndex
  : K extends 'content'
    ? ContentIndex
    : LuaModuleIndex;

type SerializableSearchIndex = TitleIndex | ContentIndex | LuaModuleIndex;

export interface SearchIndexHandle<K extends SearchIndexKind = SearchIndexKind> {
  kind: K;
  index: SearchIndexFor<K>;
  throughLocalSeq: number;
  source: 'snapshot' | 'rebuild';
  replayedPages: number;
  restoreMs: number;
  compatibilityKey: string;
  snapshotGeneration: number;
}

export type SnapshotPublishSkipReason =
  | 'cleared-this-session'
  | 'too-large'
  | 'quota'
  | 'sequence-changed'
  | 'not-newer';

export type SnapshotPublishResult =
  | { status: 'published'; record: IndexSnapshotRecord }
  | {
      status: 'skipped';
      reason: SnapshotPublishSkipReason;
    };

export type SnapshotInspectionStatus =
  | 'not-started'
  | 'missing'
  | 'available'
  | 'replay-required'
  | 'outdated'
  | 'corrupt';

export interface SnapshotInspection {
  kind: SearchIndexKind;
  status: SnapshotInspectionStatus;
  throughLocalSeq?: number;
  documentCount?: number;
  payloadBytes?: number;
  createdAt?: number;
  restoreMs?: number;
  serializationMs?: number;
  message?: string;
}

interface StorageEstimateAdapter {
  estimate(): Promise<StorageEstimate>;
}

export interface VersionedSearchIndexCacheOptions {
  storage?: StorageEstimateAdapter;
  now?: () => number;
  clock?: () => number;
  publishDelayMs?: number;
}

interface ReadBundle {
  snapshot?: IndexSnapshotRecord;
  currentSequence: number;
  snapshotGeneration: number;
  pages: PageRecord[];
  pagesAreDelta: boolean;
}

interface PublishState {
  snapshot?: IndexSnapshotRecord;
  currentSequence: number;
  snapshotGeneration: number;
}

interface RuntimeState {
  compatibilityKey?: string;
  status: SnapshotInspectionStatus;
  restoreMs?: number;
  message?: string;
  validatedSnapshot?: IndexSnapshotRecord;
}

export class VersionedSearchIndexCache {
  private readonly storage: StorageEstimateAdapter | undefined;
  private readonly now: () => number;
  private readonly clock: () => number;
  private readonly publishDelayMs: number;
  private readonly pendingPublishes = new Map<
    SearchIndexKind,
    ReturnType<typeof setTimeout>
  >();
  private readonly runtime = new Map<SearchIndexKind, RuntimeState>();
  private readonly refreshQueues = new WeakMap<object, Promise<void>>();
  private publishQueue: Promise<void> = Promise.resolve();
  private publishingSuppressed = false;

  constructor(
    private readonly database: WikiSearchDatabase,
    options: VersionedSearchIndexCacheOptions = {},
  ) {
    this.storage = options.storage ?? globalThis.navigator?.storage;
    this.now = options.now ?? Date.now;
    this.clock = options.clock ?? (() => performance.now());
    this.publishDelayMs = options.publishDelayMs ?? DEFAULT_PUBLISH_DELAY_MS;
  }

  async restoreOrRebuild<K extends SearchIndexKind>(
    kind: K,
    analyzer: Analyzer,
  ): Promise<SearchIndexHandle<K>> {
    const startedAt = this.clock();
    const compatibilityKey = createCompatibilityKey(
      kind,
      analyzer.compatibilityEngine,
    );
    const bundle = await this.readBundle(kind, compatibilityKey);
    const index = createIndex(kind, analyzer);
    let source: SearchIndexHandle<K>['source'] = 'rebuild';
    let replayedPages = 0;
    let runtimeStatus: SnapshotInspectionStatus = bundle.snapshot
      ? 'corrupt'
      : 'missing';
    let runtimeMessage: string | undefined;
    let validatedSnapshot: IndexSnapshotRecord | undefined;

    if (bundle.snapshot) {
      if (bundle.snapshot.compatibilityKey !== compatibilityKey) {
        runtimeStatus = 'outdated';
        runtimeMessage = '兼容键已变化';
      } else {
        try {
          const payload = await validateSnapshot(
            bundle.snapshot,
            kind,
            bundle.currentSequence,
          );
          await index.importSnapshot(payload);
          if (index.size !== bundle.snapshot.documentCount) {
            throw new Error('快照文档数量不一致');
          }
          validatedSnapshot = bundle.snapshot;
          const changedPages = bundle.pages
            .filter((page) => page.localSeq > bundle.snapshot!.throughLocalSeq)
            .sort((left, right) => left.localSeq - right.localSeq);
          if (changedPages.length) await index.updateAsync(changedPages);
          replayedPages = changedPages.length;
          source = 'snapshot';
          runtimeStatus = changedPages.length ? 'replay-required' : 'available';
        } catch (error) {
          runtimeStatus = 'corrupt';
          runtimeMessage = error instanceof Error ? error.message : String(error);
          await this.deleteSnapshotIfUnchanged(
            bundle.snapshot,
            bundle.snapshotGeneration,
          );
        }
      }
    }

    if (source === 'rebuild') {
      const rebuildPages = bundle.pagesAreDelta
        ? kind === 'title'
          ? await readActivePageHeaders(this.database)
          : await this.database.pages.toArray()
        : bundle.pages;
      await index.rebuildAsync(rebuildPages);
    }
    const restoreMs = Math.max(0, this.clock() - startedAt);
    this.runtime.set(kind, {
      compatibilityKey,
      status: runtimeStatus,
      restoreMs,
      message: runtimeMessage,
      validatedSnapshot,
    });
    return {
      kind,
      index,
      throughLocalSeq: bundle.currentSequence,
      source,
      replayedPages,
      restoreMs,
      compatibilityKey,
      snapshotGeneration: bundle.snapshotGeneration,
    };
  }

  async refresh<K extends SearchIndexKind>(
    handle: SearchIndexHandle<K>,
  ): Promise<number> {
    const previous = this.refreshQueues.get(handle) ?? Promise.resolve();
    const refreshing = previous.then(
      () => this.refreshOnce(handle),
      () => this.refreshOnce(handle),
    );
    const queued = refreshing.then(
      () => undefined,
      () => undefined,
    );
    this.refreshQueues.set(handle, queued);
    try {
      return await refreshing;
    } finally {
      if (this.refreshQueues.get(handle) === queued) {
        this.refreshQueues.delete(handle);
      }
    }
  }

  private async refreshOnce<K extends SearchIndexKind>(
    handle: SearchIndexHandle<K>,
  ): Promise<number> {
    const { currentSequence, pages } = await this.database.transaction(
      'r',
      this.database.pages,
      this.database.syncState,
      this.database.fileResources,
      async () => {
        const currentSequence = await readLocalSequence(this.database);
        const pages =
          currentSequence > handle.throughLocalSeq
            ? await this.database.pages
                .where('localSeq')
                .above(handle.throughLocalSeq)
                .toArray()
            : [];
        return { currentSequence, pages };
      },
    );
    if (pages.length) {
      pages.sort((left, right) => left.localSeq - right.localSeq);
      await handle.index.updateAsync(pages);
    }
    handle.throughLocalSeq = Math.max(handle.throughLocalSeq, currentSequence);
    return pages.length;
  }

  async publish<K extends SearchIndexKind>(
    handle: SearchIndexHandle<K>,
  ): Promise<SnapshotPublishResult> {
    if (this.publishingSuppressed) {
      return { status: 'skipped', reason: 'cleared-this-session' };
    }
    const initialState = await this.readPublishState(handle.kind);
    if (initialState.snapshotGeneration !== handle.snapshotGeneration) {
      return { status: 'skipped', reason: 'cleared-this-session' };
    }
    if (initialState.currentSequence !== handle.throughLocalSeq) {
      return { status: 'skipped', reason: 'sequence-changed' };
    }
    if (
      initialState.snapshot?.compatibilityKey === handle.compatibilityKey &&
      initialState.snapshot.throughLocalSeq >= handle.throughLocalSeq
    ) {
      return { status: 'skipped', reason: 'not-newer' };
    }
    const candidateGeneration = handle.snapshotGeneration;
    const serializationStartedAt = this.clock();
    const candidateThroughLocalSeq = handle.throughLocalSeq;
    const json = JSON.stringify(handle.index.exportSnapshot());
    const candidateDocumentCount = handle.index.size;
    const serializationMs = Math.max(0, this.clock() - serializationStartedAt);
    const encodedPayload = new TextEncoder().encode(json);
    const payloadBytes = encodedPayload.byteLength;
    if (payloadBytes > MAX_PAYLOAD_BYTES) {
      return { status: 'skipped', reason: 'too-large' };
    }
    if (!(await this.hasQuota(payloadBytes))) {
      return { status: 'skipped', reason: 'quota' };
    }
    const record: IndexSnapshotRecord = {
      key: snapshotKey(handle.kind),
      kind: handle.kind,
      snapshotFormatVersion: SNAPSHOT_FORMAT_VERSION,
      compatibilityKey: handle.compatibilityKey,
      throughLocalSeq: candidateThroughLocalSeq,
      createdAt: this.now(),
      documentCount: candidateDocumentCount,
      payloadBytes,
      sha256: await sha256(encodedPayload),
      json,
      serializationMs,
    };
    const result = await this.database.transaction(
      'rw',
      this.database.indexSnapshots,
      this.database.syncState,
      this.database.pages,
      this.database.fileResources,
      async (): Promise<SnapshotPublishResult> => {
        if (this.publishingSuppressed) {
          return { status: 'skipped', reason: 'cleared-this-session' };
        }
        const [currentSequence, generationRecord] = await Promise.all([
          readLocalSequence(this.database),
          this.database.syncState.get(SNAPSHOT_GENERATION_KEY) as Promise<
            SyncStateRecord<number> | undefined
          >,
        ]);
        if (snapshotGenerationOf(generationRecord) !== candidateGeneration) {
          return { status: 'skipped', reason: 'cleared-this-session' };
        }
        if (currentSequence !== record.throughLocalSeq) {
          return { status: 'skipped', reason: 'sequence-changed' };
        }
        const existing = await this.database.indexSnapshots.get(record.key);
        if (
          existing?.compatibilityKey === record.compatibilityKey &&
          existing.throughLocalSeq >= record.throughLocalSeq
        ) {
          return { status: 'skipped', reason: 'not-newer' };
        }
        await this.database.indexSnapshots.put(record);
        return { status: 'published', record };
      },
    );
    if (result.status === 'published') {
      this.runtime.set(handle.kind, {
        ...this.runtime.get(handle.kind),
        compatibilityKey: handle.compatibilityKey,
        status: 'available',
        message: undefined,
        validatedSnapshot: record,
      });
    }
    return result;
  }

  schedulePublish<K extends SearchIndexKind>(handle: SearchIndexHandle<K>): void {
    const pending = this.pendingPublishes.get(handle.kind);
    if (pending) clearTimeout(pending);
    const timer = setTimeout(() => {
      this.pendingPublishes.delete(handle.kind);
      this.publishQueue = this.publishQueue
        .then(async () => {
          const result = await this.publish(handle);
          if (result.status === 'skipped' && result.reason === 'sequence-changed') {
            const previousSequence = handle.throughLocalSeq;
            await this.refresh(handle);
            if (handle.throughLocalSeq > previousSequence) this.schedulePublish(handle);
          }
        })
        .catch((error: unknown) => {
          console.warn('[CU Wiki Search] index snapshot publish failed', error);
        });
    }, this.publishDelayMs);
    this.pendingPublishes.set(handle.kind, timer);
  }

  async inspect(): Promise<SnapshotInspection[]> {
    const { records, currentSequence } = await this.database.transaction(
      'r',
      this.database.indexSnapshots,
      this.database.syncState,
      this.database.pages,
      this.database.fileResources,
      async () => ({
        records: await this.database.indexSnapshots.toArray(),
        currentSequence: await readLocalSequence(this.database),
      }),
    );
    return Promise.all((['title', 'content', 'lua'] as const).map(async (kind) => {
      const record = records.find((candidate) => candidate.key === snapshotKey(kind));
      const runtime = this.runtime.get(kind);
      if (!record) {
        return {
          kind,
          status: runtime ? runtime.status : 'not-started',
          restoreMs: runtime?.restoreMs,
          message: runtime?.message,
        };
      }
      let status: SnapshotInspectionStatus;
      const matchesValidatedSnapshot = Boolean(
        runtime?.validatedSnapshot &&
          isSameSnapshot(record, runtime.validatedSnapshot),
      );
      const structurallyCorrupt =
        record.key !== snapshotKey(kind) ||
        record.kind !== kind ||
        !isNonNegativeSafeInteger(record.throughLocalSeq) ||
        record.throughLocalSeq > currentSequence ||
        !isNonNegativeSafeInteger(record.documentCount) ||
        (!matchesValidatedSnapshot && !(await hasValidPayload(record)));
      if (structurallyCorrupt) status = 'corrupt';
      else if (record.snapshotFormatVersion !== SNAPSHOT_FORMAT_VERSION) status = 'outdated';
      else if (!runtime?.compatibilityKey) status = 'not-started';
      else if (record.compatibilityKey !== runtime.compatibilityKey) status = 'outdated';
      else if (record.throughLocalSeq > currentSequence) status = 'corrupt';
      else if (record.throughLocalSeq < currentSequence) status = 'replay-required';
      else status = 'available';
      return {
        kind,
        status,
        throughLocalSeq: record.throughLocalSeq,
        documentCount: record.documentCount,
        payloadBytes: record.payloadBytes,
        createdAt: record.createdAt,
        restoreMs: runtime?.restoreMs,
        serializationMs: record.serializationMs,
        message: runtime?.message,
      };
    }));
  }

  async clear(): Promise<void> {
    for (const timer of this.pendingPublishes.values()) clearTimeout(timer);
    this.pendingPublishes.clear();
    this.publishingSuppressed = true;
    await this.database.transaction(
      'rw',
      this.database.indexSnapshots,
      this.database.syncState,
      async () => {
        const generationRecord = (await this.database.syncState.get(
          SNAPSHOT_GENERATION_KEY,
        )) as SyncStateRecord<number> | undefined;
        const currentGeneration = snapshotGenerationOf(generationRecord);
        if (currentGeneration >= Number.MAX_SAFE_INTEGER) {
          throw new Error('索引快照 generation 已达到安全整数上限');
        }
        await this.database.syncState.put({
          key: SNAPSHOT_GENERATION_KEY,
          value: currentGeneration + 1,
        });
        await this.database.indexSnapshots.bulkDelete(
          (['title', 'content', 'lua'] as const).map(snapshotKey),
        );
      },
    );
    for (const kind of ['title', 'content', 'lua'] as const) {
      this.runtime.set(kind, {
        ...this.runtime.get(kind),
        status: 'missing',
        message: undefined,
      });
    }
  }

  allowPublishing(): void {
    this.publishingSuppressed = false;
  }

  private async readBundle(
    kind: SearchIndexKind,
    compatibilityKey: string,
  ): Promise<ReadBundle> {
    return this.database.transaction(
      'r',
      this.database.indexSnapshots,
      this.database.syncState,
      this.database.pages,
      this.database.fileResources,
      async () => {
        const [snapshot, currentSequence, generationRecord] = await Promise.all([
          this.database.indexSnapshots.get(snapshotKey(kind)),
          readLocalSequence(this.database),
          this.database.syncState.get(SNAPSHOT_GENERATION_KEY) as Promise<
            SyncStateRecord<number> | undefined
          >,
        ]);
        const pagesAreDelta = Boolean(
          snapshot &&
            snapshot.compatibilityKey === compatibilityKey &&
            snapshot.throughLocalSeq <= currentSequence,
        );
        const pages = pagesAreDelta
          ? kind === 'title'
            ? await readPageHeadersAfter(this.database, snapshot!.throughLocalSeq)
            : await this.database.pages
                .where('localSeq')
                .above(snapshot!.throughLocalSeq)
                .toArray()
          : kind === 'title'
            ? await readActivePageHeaders(this.database)
            : await this.database.pages.toArray();
        return {
          snapshot,
          currentSequence,
          snapshotGeneration: snapshotGenerationOf(generationRecord),
          pages,
          pagesAreDelta,
        };
      },
    );
  }

  private async readPublishState(kind: SearchIndexKind): Promise<PublishState> {
    return this.database.transaction(
      'r',
      this.database.indexSnapshots,
      this.database.syncState,
      this.database.pages,
      this.database.fileResources,
      async () => {
        const [snapshot, currentSequence, generationRecord] = await Promise.all([
          this.database.indexSnapshots.get(snapshotKey(kind)),
          readLocalSequence(this.database),
          this.database.syncState.get(SNAPSHOT_GENERATION_KEY) as Promise<
            SyncStateRecord<number> | undefined
          >,
        ]);
        return {
          snapshot,
          currentSequence,
          snapshotGeneration: snapshotGenerationOf(generationRecord),
        };
      },
    );
  }

  private async hasQuota(payloadBytes: number): Promise<boolean> {
    if (!this.storage) return true;
    try {
      const estimate = await this.storage.estimate();
      if (estimate.quota === undefined || estimate.usage === undefined) return true;
      return estimate.quota - estimate.usage >= payloadBytes * 1.2;
    } catch {
      return true;
    }
  }

  private async deleteSnapshotIfUnchanged(
    snapshot: IndexSnapshotRecord,
    snapshotGeneration: number,
  ): Promise<void> {
    await this.database.transaction(
      'rw',
      this.database.indexSnapshots,
      this.database.syncState,
      async () => {
        const [current, generationRecord] = await Promise.all([
          this.database.indexSnapshots.get(snapshot.key),
          this.database.syncState.get(SNAPSHOT_GENERATION_KEY) as Promise<
            SyncStateRecord<number> | undefined
          >,
        ]);
        if (
          snapshotGenerationOf(generationRecord) === snapshotGeneration &&
          current &&
          isSameSnapshot(current, snapshot)
        ) {
          await this.database.indexSnapshots.delete(snapshot.key);
        }
      },
    );
  }
}

export function snapshotKey(kind: SearchIndexKind): string {
  return `search-index:${kind}`;
}

function createIndex<K extends SearchIndexKind>(
  kind: K,
  analyzer: Analyzer,
): SearchIndexFor<K> {
  const index: SerializableSearchIndex =
    kind === 'title'
      ? new TitleIndex(analyzer)
      : kind === 'content'
        ? new ContentIndex(analyzer)
        : new LuaModuleIndex(analyzer);
  return index as SearchIndexFor<K>;
}

async function validateSnapshot(
  record: IndexSnapshotRecord,
  kind: SearchIndexKind,
  currentSequence: number,
): Promise<unknown> {
  if (record.key !== snapshotKey(kind) || record.kind !== kind) {
    throw new Error('快照 key 或类型无效');
  }
  if (record.snapshotFormatVersion !== SNAPSHOT_FORMAT_VERSION) {
    throw new Error('快照格式版本无效');
  }
  if (
    !Number.isSafeInteger(record.throughLocalSeq) ||
    record.throughLocalSeq < 0 ||
    record.throughLocalSeq > currentSequence
  ) {
    throw new Error('快照序列范围无效');
  }
  const encodedPayload = new TextEncoder().encode(record.json);
  if (encodedPayload.byteLength !== record.payloadBytes) {
    throw new Error('快照长度校验失败');
  }
  if ((await sha256(encodedPayload)) !== record.sha256) {
    throw new Error('快照 SHA-256 校验失败');
  }
  const payload: unknown = JSON.parse(record.json);
  if (!payload || typeof payload !== 'object') throw new Error('快照 JSON 结构无效');
  if (!Number.isSafeInteger(record.documentCount) || record.documentCount < 0) {
    throw new Error('快照文档数量无效');
  }
  return payload;
}

async function hasValidPayload(record: IndexSnapshotRecord): Promise<boolean> {
  const encodedPayload = new TextEncoder().encode(record.json);
  return (
    encodedPayload.byteLength === record.payloadBytes &&
    (await sha256(encodedPayload)) === record.sha256 &&
    isJsonObject(record.json)
  );
}

async function sha256(value: BufferSource): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', value);
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function isJsonObject(value: string): boolean {
  try {
    const parsed: unknown = JSON.parse(value);
    return Boolean(parsed && typeof parsed === 'object');
  } catch {
    return false;
  }
}

function isSameSnapshot(
  left: IndexSnapshotRecord,
  right: IndexSnapshotRecord,
): boolean {
  return (
    left.key === right.key &&
    left.kind === right.kind &&
    left.snapshotFormatVersion === right.snapshotFormatVersion &&
    left.compatibilityKey === right.compatibilityKey &&
    left.throughLocalSeq === right.throughLocalSeq &&
    left.createdAt === right.createdAt &&
    left.documentCount === right.documentCount &&
    left.payloadBytes === right.payloadBytes &&
    left.sha256 === right.sha256 &&
    left.json === right.json &&
    left.serializationMs === right.serializationMs
  );
}

function snapshotGenerationOf(
  record: SyncStateRecord<number> | undefined,
): number {
  const value = record?.value;
  return isNonNegativeSafeInteger(value) ? value : 0;
}
