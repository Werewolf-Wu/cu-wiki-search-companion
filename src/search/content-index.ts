// SPDX-License-Identifier: MPL-2.0
import MiniSearch, { type Options, type SearchResult } from 'minisearch';

import type { Analyzer } from '../analyzer/analyzer';
import { extractContent } from '../content/extract-content';
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

export class ContentIndex {
  private index = this.createIndex();
  private readonly extractedById = new Map<number, string>();

  constructor(private readonly analyzer: Analyzer) {}

  rebuild(pages: PageRecord[]): void {
    this.index = this.createIndex();
    this.extractedById.clear();
    const documents = pages.flatMap((page) => {
      const document = this.toDocument(page);
      return document ? [document] : [];
    });
    this.index.addAll(documents);
  }

  async rebuildAsync(pages: PageRecord[], batchSize = 2): Promise<void> {
    this.index = this.createIndex();
    this.extractedById.clear();
    await this.updateAsync(pages, batchSize);
  }

  update(pages: PageRecord[]): void {
    for (const page of pages) {
      const document = this.toDocument(page);
      if (!document) {
        if (this.index.has(page.id)) this.index.discard(page.id);
        this.extractedById.delete(page.id);
      } else if (this.index.has(page.id)) {
        this.index.replace(document);
      } else {
        this.index.add(document);
      }
    }
  }

  async updateAsync(pages: PageRecord[], batchSize = 2): Promise<void> {
    for (let offset = 0; offset < pages.length; offset += batchSize) {
      this.update(pages.slice(offset, offset + batchSize));
      await yieldToEventLoop();
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
    const restored = await MiniSearch.loadJSONAsync<IndexedContent>(
      JSON.stringify(payload.miniSearch),
      this.indexOptions(),
    );
    this.index = restored;
    this.extractedById.clear();
    for (const [id, extracted] of payload.extractedById) {
      this.extractedById.set(id, extracted);
    }
    if (this.extractedById.size !== this.index.documentCount) {
      throw new Error('正文快照摘要数量不一致');
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
        const compactTitle = this.analyzer.compact(title);
        const titleBoost = compactTitle.includes(compactQuery) ? 3 : 1;
        return {
          kind: 'content' as const,
          id: Number(result.id),
          title,
          namespace: Number(result.namespace),
          namespaceName: String(result.namespaceName),
          snippet: makeSnippet(
            this.extractedById.get(Number(result.id)) ?? '',
            normalizedQuery,
            this.analyzer,
          ),
          score: result.score * titleBoost,
        };
      })
      .sort((left, right) => right.score - left.score || left.id - right.id)
      .slice(0, limit);
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

  private toDocument(page: PageRecord): IndexedContent | undefined {
    if (
      page.deleted ||
      page.isRedirect ||
      typeof page.content !== 'string'
    ) {
      return undefined;
    }
    const extracted = extractContent(page.contentModel, page.content);
    if (!extracted) return undefined;
    this.extractedById.set(page.id, extracted);
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

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}

function makeSnippet(text: string, normalizedQuery: string, analyzer: Analyzer): string {
  const compactText = text.replace(/\s+/g, ' ').trim();
  if (!compactText) return '';
  const position = analyzer.normalize(compactText).indexOf(normalizedQuery);
  const start = Math.max(0, (position >= 0 ? position : 0) - 36);
  const end = Math.min(
    compactText.length,
    (position >= 0 ? position + normalizedQuery.length : 0) + 64,
  );
  return `${start > 0 ? '…' : ''}${compactText.slice(start, end)}${end < compactText.length ? '…' : ''}`;
}
