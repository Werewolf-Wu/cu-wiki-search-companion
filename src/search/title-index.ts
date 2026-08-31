// SPDX-License-Identifier: MPL-2.0
import MiniSearch, { type Options, type SearchResult } from 'minisearch';

import type { Analyzer } from '../analyzer/analyzer';
import type { PageRecord } from '../types';

interface IndexedTitle {
  id: number;
  title: string;
  normalizedTitle: string;
  namespace: number;
  namespaceName: string;
  tokens: string;
}

export interface TitleSearchResult {
  id: number;
  title: string;
  namespace: number;
  namespaceName: string;
  score: number;
}

export interface TitleSearchBackend {
  search(query: string, namespace?: number, limit?: number): TitleSearchResult[];
  readonly size: number;
}

interface LinearTitle {
  page: PageRecord;
  compactTitle: string;
}

interface PendingTitleRebuild {
  updates: PageRecord[][];
}

/**
 * Small synchronous fallback used while the richer MiniSearch/jieba index is
 * built during an idle period. The title corpus is only a few thousand rows,
 * so a linear substring scan is both faster to initialise and still cheap per
 * keystroke.
 */
export class LinearTitleIndex implements TitleSearchBackend {
  private readonly titles: LinearTitle[];

  constructor(
    private readonly analyzer: Analyzer,
    pages: PageRecord[],
  ) {
    this.titles = pages
      .filter((page) => !page.deleted)
      .map((page) => ({
        page,
        compactTitle: analyzer.compactNormalized(page.normalizedTitle),
      }));
  }

  search(query: string, namespace?: number, limit = 20): TitleSearchResult[] {
    const normalizedQuery = this.analyzer.normalize(query);
    if (!normalizedQuery) return [];
    const compactQuery = this.analyzer.compactNormalized(normalizedQuery);
    if (!compactQuery) return [];

    const matches: TitleSearchResult[] = [];
    for (const { page, compactTitle } of this.titles) {
      if (namespace !== undefined && page.namespace !== namespace) continue;
      const position = compactTitle.indexOf(compactQuery);
      if (position < 0) continue;

      let score = 10_000 - position * 10 - compactTitle.length;
      if (compactTitle === compactQuery) score += 1_000_000;
      else if (position === 0) score += 100_000;
      matches.push({
        id: page.id,
        title: page.title,
        namespace: page.namespace,
        namespaceName: page.namespaceName,
        score,
      });
    }
    return matches
      .sort((left, right) => right.score - left.score || left.id - right.id)
      .slice(0, limit);
  }

  get size(): number {
    return this.titles.length;
  }
}

export class CombinedTitleIndex implements TitleSearchBackend {
  constructor(
    private readonly primary: TitleSearchBackend,
    private readonly fallback: TitleSearchBackend,
  ) {}

  search(query: string, namespace?: number, limit = 20): TitleSearchResult[] {
    const merged = new Map<number, TitleSearchResult>();
    for (const result of [
      ...this.primary.search(query, namespace, limit),
      ...this.fallback.search(query, namespace, limit),
    ]) {
      const previous = merged.get(result.id);
      if (!previous || result.score > previous.score) merged.set(result.id, result);
    }
    return [...merged.values()]
      .sort((left, right) => right.score - left.score || left.id - right.id)
      .slice(0, limit);
  }

  get size(): number {
    return this.primary.size;
  }
}

export class TitleIndex implements TitleSearchBackend {
  private index = this.createIndex();
  private rebuildGeneration = 0;
  private readonly pendingRebuilds = new Set<PendingTitleRebuild>();

  constructor(private readonly analyzer: Analyzer) {}

  rebuild(pages: PageRecord[]): void {
    this.rebuildGeneration += 1;
    const nextIndex = this.createIndex();
    this.applyPages(nextIndex, pages);
    this.index = nextIndex;
  }

  async rebuildAsync(pages: PageRecord[], batchSize = 5): Promise<void> {
    const generation = ++this.rebuildGeneration;
    const nextIndex = this.createIndex();
    const pending: PendingTitleRebuild = { updates: [] };
    this.pendingRebuilds.add(pending);
    const activePages = pages.filter((page) => !page.deleted);
    try {
      for (let offset = 0; offset < activePages.length; offset += batchSize) {
        this.applyPages(nextIndex, activePages.slice(offset, offset + batchSize));
        await yieldToEventLoop();
      }
      for (const update of pending.updates) this.applyPages(nextIndex, update);
      if (generation === this.rebuildGeneration) this.index = nextIndex;
    } finally {
      this.pendingRebuilds.delete(pending);
    }
  }

  update(pages: PageRecord[]): void {
    for (const pending of this.pendingRebuilds) {
      pending.updates.push(pages.map((page) => ({ ...page })));
    }
    this.applyPages(this.index, pages);
  }

  private applyPages(index: MiniSearch<IndexedTitle>, pages: PageRecord[]): void {
    for (const page of pages) {
      if (page.deleted) {
        if (index.has(page.id)) index.discard(page.id);
        continue;
      }
      const document = this.toDocument(page);
      if (index.has(page.id)) index.replace(document);
      else index.add(document);
    }
  }

  async updateAsync(pages: PageRecord[], batchSize = 5): Promise<void> {
    for (let offset = 0; offset < pages.length; offset += batchSize) {
      this.update(pages.slice(offset, offset + batchSize));
      await yieldToEventLoop();
    }
  }

  exportSnapshot(): unknown {
    return { miniSearch: this.index.toJSON() };
  }

  async importSnapshot(payload: unknown): Promise<void> {
    if (!payload || typeof payload !== 'object' || !('miniSearch' in payload)) {
      throw new Error('标题快照 payload 结构无效');
    }
    const generation = ++this.rebuildGeneration;
    const pending: PendingTitleRebuild = { updates: [] };
    this.pendingRebuilds.add(pending);
    try {
      const restored = await MiniSearch.loadJSONAsync<IndexedTitle>(
        JSON.stringify(payload.miniSearch),
        this.indexOptions(),
      );
      for (const update of pending.updates) this.applyPages(restored, update);
      if (generation === this.rebuildGeneration) this.index = restored;
    } finally {
      this.pendingRebuilds.delete(pending);
    }
  }

  search(query: string, namespace?: number, limit = 20): TitleSearchResult[] {
    const normalizedQuery = this.analyzer.normalize(query);
    if (!normalizedQuery) return [];
    const terms = this.analyzer.queryTokens(normalizedQuery);
    if (!terms.length) return [];

    const options = {
      prefix: true,
      fuzzy: (term: string): number =>
        this.analyzer.cjkOf(term) ? (term.length >= 2 ? 1 : 0) : term.length >= 4 ? 1 : 0,
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

    const compactQuery = this.analyzer.compact(normalizedQuery);
    return results
      .map((result) => {
        const title = String(result.title);
        const compactTitle = this.analyzer.compact(title);
        let boost = 1;
        if (compactTitle === compactQuery) boost = 100;
        else if (compactTitle.startsWith(compactQuery)) boost = 10;
        else if (compactTitle.includes(compactQuery)) boost = 3;
        return {
          id: Number(result.id),
          title,
          namespace: Number(result.namespace),
          namespaceName: String(result.namespaceName),
          score: result.score * boost,
        };
      })
      .sort((left, right) => right.score - left.score || left.id - right.id)
      .slice(0, limit);
  }

  get size(): number {
    return this.index.documentCount;
  }

  private createIndex(): MiniSearch<IndexedTitle> {
    return new MiniSearch<IndexedTitle>(this.indexOptions());
  }

  private indexOptions(): Options<IndexedTitle> {
    return {
      idField: 'id',
      fields: ['tokens'],
      storeFields: ['title', 'normalizedTitle', 'namespace', 'namespaceName'],
      tokenize: (value) => value.split(/\s+/),
      processTerm: (term) => term,
    };
  }

  private toDocument(page: PageRecord): IndexedTitle {
    return {
      id: page.id,
      title: page.title,
      normalizedTitle: page.normalizedTitle,
      namespace: page.namespace,
      namespaceName: page.namespaceName,
      // Re-normalising the source title is deliberate. Besides accepting old
      // database rows, this is the browser-tested path for the WASM segmenter.
      tokens: this.analyzer.documentTokens(page.title).join(' '),
    };
  }
}

function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, 0));
}
