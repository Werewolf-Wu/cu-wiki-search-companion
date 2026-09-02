// SPDX-License-Identifier: MPL-2.0
import MiniSearch, { type Options, type SearchResult } from 'minisearch';

import type { Analyzer } from '../analyzer/analyzer';
import { extractContent } from '../content/extract-content';
import {
  browserTaskScheduler,
  type CooperativeTaskScheduler,
} from '../runtime/cooperative-task-scheduler';
import type { PageRecord } from '../types';

interface IndexedContent {
  id: number;
  title: string;
  normalizedTitle: string;
  namespace: number;
  namespaceName: string;
  tokens: string;
}

export interface ContentSearchResult {
  kind: 'content';
  id: number;
  title: string;
  namespace: number;
  namespaceName: string;
  snippet: string;
  score: number;
}

interface PendingContentRebuild {
  updates: PageRecord[][];
}

export class ContentIndex {
  private index = this.createIndex();
  private extractedById = new Map<number, string>();
  private rebuildGeneration = 0;
  private readonly pendingRebuilds = new Set<PendingContentRebuild>();

  constructor(
    private readonly analyzer: Analyzer,
    private readonly taskScheduler: Pick<CooperativeTaskScheduler, 'yield'> =
      browserTaskScheduler,
  ) {}

  rebuild(pages: PageRecord[]): void {
    this.rebuildGeneration += 1;
    const nextIndex = this.createIndex();
    const nextExtractedById = new Map<number, string>();
    this.applyPages(nextIndex, nextExtractedById, pages);
    this.index = nextIndex;
    this.extractedById = nextExtractedById;
  }

  async rebuildAsync(pages: PageRecord[], batchSize = 2): Promise<void> {
    const generation = ++this.rebuildGeneration;
    const nextIndex = this.createIndex();
    const nextExtractedById = new Map<number, string>();
    const pending: PendingContentRebuild = { updates: [] };
    this.pendingRebuilds.add(pending);
    try {
      for (let offset = 0; offset < pages.length; offset += batchSize) {
        this.applyPages(
          nextIndex,
          nextExtractedById,
          pages.slice(offset, offset + batchSize),
        );
        await this.taskScheduler.yield();
      }
      for (const update of pending.updates) {
        this.applyPages(nextIndex, nextExtractedById, update);
      }
      if (generation === this.rebuildGeneration) {
        this.index = nextIndex;
        this.extractedById = nextExtractedById;
      }
    } finally {
      this.pendingRebuilds.delete(pending);
    }
  }

  update(pages: PageRecord[]): void {
    for (const pending of this.pendingRebuilds) {
      pending.updates.push(pages.map((page) => ({ ...page })));
    }
    this.applyPages(this.index, this.extractedById, pages);
  }

  private applyPages(
    index: MiniSearch<IndexedContent>,
    extractedById: Map<number, string>,
    pages: PageRecord[],
  ): void {
    for (const page of pages) {
      const document = this.toDocument(page, extractedById);
      if (!document) {
        if (index.has(page.id)) index.discard(page.id);
        extractedById.delete(page.id);
      } else if (index.has(page.id)) {
        index.replace(document);
      } else {
        index.add(document);
      }
    }
  }

  async updateAsync(pages: PageRecord[], batchSize = 2): Promise<void> {
    for (let offset = 0; offset < pages.length; offset += batchSize) {
      this.update(pages.slice(offset, offset + batchSize));
      await this.taskScheduler.yield();
    }
  }

  exportSnapshot(): unknown {
    return {
      miniSearch: this.index.toJSON(),
      extractedById: [...this.extractedById],
    };
  }

  async importSnapshot(payload: unknown): Promise<void> {
    if (
      !payload ||
      typeof payload !== 'object' ||
      !('miniSearch' in payload) ||
      !('extractedById' in payload) ||
      !isStringMapEntries(payload.extractedById)
    ) {
      throw new Error('正文快照 payload 结构无效');
    }
    const generation = ++this.rebuildGeneration;
    const pending: PendingContentRebuild = { updates: [] };
    this.pendingRebuilds.add(pending);
    const restoredExtractedById = new Map<number, string>();
    for (const [id, extracted] of payload.extractedById) {
      restoredExtractedById.set(id, extracted);
    }
    try {
      const restored = await MiniSearch.loadJSONAsync<IndexedContent>(
        JSON.stringify(payload.miniSearch),
        this.indexOptions(),
      );
      if (restoredExtractedById.size !== restored.documentCount) {
        throw new Error('正文快照摘要数量不一致');
      }
      for (const update of pending.updates) {
        this.applyPages(restored, restoredExtractedById, update);
      }
      if (generation === this.rebuildGeneration) {
        this.index = restored;
        this.extractedById = restoredExtractedById;
      }
    } finally {
      this.pendingRebuilds.delete(pending);
    }
  }

  search(query: string, namespace?: number, limit = 20): ContentSearchResult[] {
    const normalizedQuery = this.analyzer.normalize(query);
    if (!normalizedQuery) return [];
    const terms = this.analyzer.queryTokens(normalizedQuery);
    if (!terms.length) return [];
    const options = {
      prefix: true,
      combineWith: 'AND' as const,
      tokenize: (value: string): string[] => this.analyzer.queryTokens(value),
      processTerm: (term: string): string => term,
      filter: (result: SearchResult): boolean =>
        namespace === undefined || result.namespace === namespace,
    };
    let results = this.index.search(normalizedQuery, options);
    if (!results.length && terms.length > 1) {
      results = this.index.search(normalizedQuery, { ...options, combineWith: 'OR' });
    }

    const compactQuery = this.analyzer.compactNormalized(normalizedQuery);
    return results
      .map((result) => {
        const title = String(result.title);
        const compactTitle = this.analyzer.compactNormalized(
          String(result.normalizedTitle),
        );
        const titleBoost = compactTitle.includes(compactQuery) ? 3 : 1;
        return {
          kind: 'content' as const,
          id: Number(result.id),
          title,
          namespace: Number(result.namespace),
          namespaceName: String(result.namespaceName),
          score: result.score * titleBoost,
        };
      })
      .sort((left, right) => right.score - left.score || left.id - right.id)
      .slice(0, limit)
      .map((result) => ({
        ...result,
        snippet: makeSnippet(
          this.extractedById.get(result.id) ?? '',
          normalizedQuery,
          this.analyzer,
        ),
      }));
  }

  get size(): number {
    return this.index.documentCount;
  }

  private createIndex(): MiniSearch<IndexedContent> {
    return new MiniSearch<IndexedContent>(this.indexOptions());
  }

  private indexOptions(): Options<IndexedContent> {
    return {
      idField: 'id',
      fields: ['tokens'],
      storeFields: ['title', 'normalizedTitle', 'namespace', 'namespaceName'],
      tokenize: (value) => value.split(/\s+/),
      processTerm: (term) => term,
    };
  }

  private toDocument(
    page: PageRecord,
    extractedById: Map<number, string>,
  ): IndexedContent | undefined {
    if (
      page.deleted ||
      page.isRedirect ||
      typeof page.content !== 'string'
    ) {
      return undefined;
    }
    const extracted = extractContent(page.contentModel, page.content);
    if (!extracted) return undefined;
    extractedById.set(page.id, extracted);
    return {
      id: page.id,
      title: page.title,
      normalizedTitle: page.normalizedTitle,
      namespace: page.namespace,
      namespaceName: page.namespaceName,
      tokens: this.analyzer.documentTokens(extracted).join(' '),
    };
  }
}

function isStringMapEntries(value: unknown): value is Array<[number, string]> {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === 'number' &&
        typeof entry[1] === 'string',
    )
  );
}

function makeSnippet(text: string, normalizedQuery: string, analyzer: Analyzer): string {
  const compactText = text.replace(/\s+/g, ' ').trim();
  if (!compactText) return '';
  const directPosition = compactText.indexOf(normalizedQuery);
  const insensitiveMatch =
    directPosition < 0
      ? new RegExp(escapeRegExp(normalizedQuery), 'iu').exec(compactText)
      : undefined;
  const originalPosition =
    directPosition >= 0 ? directPosition : (insensitiveMatch?.index ?? -1);
  if (originalPosition >= 0) {
    const matchLength =
      directPosition >= 0 ? normalizedQuery.length : insensitiveMatch![0].length;
    const start = Math.max(0, originalPosition - 36);
    const end = Math.min(compactText.length, originalPosition + matchLength + 64);
    return `${start > 0 ? '…' : ''}${compactText.slice(start, end)}${end < compactText.length ? '…' : ''}`;
  }
  const normalizedText = analyzer.normalize(compactText);
  const displayText = normalizedText || compactText;
  const position = normalizedText.indexOf(normalizedQuery);
  const start = Math.max(0, (position >= 0 ? position : 0) - 36);
  const end = Math.min(
    displayText.length,
    (position >= 0 ? position + normalizedQuery.length : 0) + 64,
  );
  return `${start > 0 ? '…' : ''}${displayText.slice(start, end)}${end < displayText.length ? '…' : ''}`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
