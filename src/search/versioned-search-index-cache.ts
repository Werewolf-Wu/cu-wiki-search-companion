// SPDX-License-Identifier: MPL-2.0
import type { Analyzer } from '../analyzer/analyzer';
import type { WikiSearchDatabase } from '../storage/database';
import {
  createCompatibilityKey,
  type SearchIndexKind,
} from '../storage/version-contract';
import type { IndexSnapshotRecord, PageRecord, SyncStateRecord } from '../types';
import { ContentIndex } from './content-index';
import { LuaModuleIndex } from './lua-module-index';
import { TitleIndex } from './title-index';

const LOCAL_SEQUENCE_KEY = 'local-sequence';
const SNAPSHOT_FORMAT_VERSION = 1;
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
}

export type SnapshotPublishResult =
  | { status: 'published'; record: IndexSnapshotRecord }
  | {
      status: 'skipped';
      reason:
        | 'cleared-this-session'
        | 'too-large'
        | 'quota'
        | 'sequence-changed'
        | 'not-newer';
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
  pages: PageRecord[];
  pagesAreDelta: boolean;
}

interface RuntimeState {
  compatibilityKey?: string;
  status: SnapshotInspectionStatus;
  restoreMs?: number;
  message?: string;
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
          await this.database.indexSnapshots.delete(snapshotKey(kind));
        }
      }
    }

    if (source === 'rebuild') {
      const rebuildPages = bundle.pagesAreDelta
        ? await this.database.pages.toArray()
        : bundle.pages;
      await index.rebuildAsync(rebuildPages);
    }
    const restoreMs = Math.max(0, this.clock() - startedAt);
    this.runtime.set(kind, {
      compatibilityKey,
      status: runtimeStatus,
      restoreMs,
      message: runtimeMessage,
    });
    return {
      kind,
      index,
      throughLocalSeq: bundle.currentSequence,
      source,
      replayedPages,
      restoreMs,
      compatibilityKey,
    };
  }

  async refresh<K extends SearchIndexKind>(
    handle: SearchIndexHandle<K>,
  ): Promise<number> {
    const { currentSequence, pages } = await this.database.transaction(
      'r',
      this.database.pages,
      this.database.syncState,
      async () => {
        const sequenceRecord = (await this.database.syncState.get(
          LOCAL_SEQUENCE_KEY,
        )) as SyncStateRecord<number> | undefined;
        const currentSequence = sequenceRecord?.value ?? handle.throughLocalSeq;
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
    handle.throughLocalSeq = currentSequence;
    return pages.length;
  }

  async publish<K extends SearchIndexKind>(
    handle: SearchIndexHandle<K>,
  ): Promise<SnapshotPublishResult> {
    if (this.publishingSuppressed) {
      return { status: 'skipped', reason: 'cleared-this-session' };
    }
    const serializationStartedAt = this.clock();
    const candidateThroughLocalSeq = handle.throughLocalSeq;
    const json = JSON.stringify(handle.index.exportSnapshot());
    const candidateDocumentCount = handle.index.size;
    const serializationMs = Math.max(0, this.clock() - serializationStartedAt);
    const payloadBytes = new TextEncoder().encode(json).byteLength;
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
      sha256: await sha256(json),
      json,
      serializationMs,
    };
    let result: SnapshotPublishResult = { status: 'skipped', reason: 'sequence-changed' };
    await this.database.transaction(
      'rw',
      this.database.indexSnapshots,
      this.database.syncState,
      async () => {
        const sequenceRecord = (await this.database.syncState.get(
          LOCAL_SEQUENCE_KEY,
        )) as SyncStateRecord<number> | undefined;
        const currentSequence = sequenceRecord?.value ?? 0;
        if (currentSequence !== record.throughLocalSeq) return;
        const existing = await this.database.indexSnapshots.get(record.key);
        if (
          existing?.compatibilityKey === record.compatibilityKey &&
          existing.throughLocalSeq >= record.throughLocalSeq
        ) {
          result = { status: 'skipped', reason: 'not-newer' };
          return;
        }
        await this.database.indexSnapshots.put(record);
        result = { status: 'published', record };
      },
    );
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
            await this.refresh(handle);
            this.schedulePublish(handle);
          }
        })
        .catch((error: unknown) => {
          console.warn('[CU Wiki Search] index snapshot publish failed', error);
        });
    }, this.publishDelayMs);
    this.pendingPublishes.set(handle.kind, timer);
  }

  async inspect(): Promise<SnapshotInspection[]> {
    const [records, sequenceRecord] = await Promise.all([
      this.database.indexSnapshots.toArray(),
      this.database.syncState.get(LOCAL_SEQUENCE_KEY) as Promise<
        SyncStateRecord<number> | undefined
      >,
    ]);
    const currentSequence = sequenceRecord?.value ?? 0;
    return Promise.all((['title', 'content', 'lua'] as const).map(async (kind) => {
      const record = records.find((candidate) => candidate.key === snapshotKey(kind));
      const runtime = this.runtime.get(kind);
      if (!record) {
        return {
          kind,
          status: runtime?.compatibilityKey ? runtime.status : 'not-started',
          restoreMs: runtime?.restoreMs,
          message: runtime?.message,
        };
      }
      let status: SnapshotInspectionStatus;
      const structurallyCorrupt =
        record.key !== snapshotKey(kind) ||
        record.kind !== kind ||
        record.throughLocalSeq > currentSequence ||
        new TextEncoder().encode(record.json).byteLength !== record.payloadBytes ||
        (await sha256(record.json)) !== record.sha256 ||
        !isJsonObject(record.json) ||
        !Number.isSafeInteger(record.documentCount) ||
        record.documentCount < 0;
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
    await this.database.indexSnapshots.bulkDelete(
      (['title', 'content', 'lua'] as const).map(snapshotKey),
    );
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
      async () => {
        const [snapshot, sequenceRecord] = await Promise.all([
          this.database.indexSnapshots.get(snapshotKey(kind)),
          this.database.syncState.get(LOCAL_SEQUENCE_KEY) as Promise<
            SyncStateRecord<number> | undefined
          >,
        ]);
        const currentSequence =
          sequenceRecord?.value ??
          (await this.database.pages.orderBy('localSeq').last())?.localSeq ??
          0;
        const pagesAreDelta = Boolean(
          snapshot &&
            snapshot.compatibilityKey === compatibilityKey &&
            snapshot.throughLocalSeq <= currentSequence,
        );
        const pages = pagesAreDelta
          ? await this.database.pages
              .where('localSeq')
              .above(snapshot!.throughLocalSeq)
              .toArray()
          : await this.database.pages.toArray();
        return { snapshot, currentSequence, pages, pagesAreDelta };
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
  if (new TextEncoder().encode(record.json).byteLength !== record.payloadBytes) {
    throw new Error('快照长度校验失败');
  }
  if ((await sha256(record.json)) !== record.sha256) {
    throw new Error('快照 SHA-256 校验失败');
  }
  const payload: unknown = JSON.parse(record.json);
  if (!payload || typeof payload !== 'object') throw new Error('快照 JSON 结构无效');
  if (!Number.isSafeInteger(record.documentCount) || record.documentCount < 0) {
    throw new Error('快照文档数量无效');
  }
  return payload;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
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
