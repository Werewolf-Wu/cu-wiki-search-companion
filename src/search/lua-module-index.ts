// SPDX-License-Identifier: MPL-2.0
import MiniSearch, { type AsPlainObject, type Options } from 'minisearch';

import type { Analyzer } from '../analyzer/analyzer';
import { extractLua, type LuaExtraction } from '../content/extract-lua';
import {
  browserTaskScheduler,
  type CooperativeTaskScheduler,
} from '../runtime/cooperative-task-scheduler';
import type { PageRecord } from '../types';

interface IndexedLuaModule {
  id: number;
  title: string;
  normalizedTitle: string;
  namespace: number;
  namespaceName: string;
  tokens: string;
}

export type LuaSymbolKind = 'function' | 'return-key' | 'string' | 'dependency';

export interface LuaSymbolMatch {
  kind: LuaSymbolKind;
  value: string;
}

export interface LuaModuleSearchResult {
  kind: 'lua';
  id: number;
  title: string;
  namespace: number;
  namespaceName: string;
  matches: LuaSymbolMatch[];
  score: number;
}

interface PreparedLuaSymbol extends LuaSymbolMatch {
  priority: number;
  normalized: string;
  compact: string;
  terms: Set<string>;
}

interface SerializedPreparedLuaSymbol extends LuaSymbolMatch {
  priority: number;
  normalized: string;
  compact: string;
  terms: string[];
}

interface PendingLuaRebuild {
  updates: PageRecord[][];
}

export class LuaModuleIndex {
  private index = this.createIndex();
  private symbolsById = new Map<number, PreparedLuaSymbol[]>();
  private rebuildGeneration = 0;
  private readonly pendingRebuilds = new Set<PendingLuaRebuild>();

  constructor(
    private readonly analyzer: Analyzer,
    private readonly taskScheduler: Pick<CooperativeTaskScheduler, 'yield'> =
      browserTaskScheduler,
  ) {}

  rebuild(pages: PageRecord[]): void {
    this.rebuildGeneration += 1;
    const nextIndex = this.createIndex();
    const nextSymbolsById = new Map<number, PreparedLuaSymbol[]>();
    this.applyPages(nextIndex, nextSymbolsById, pages);
    this.index = nextIndex;
    this.symbolsById = nextSymbolsById;
  }

  async rebuildAsync(pages: PageRecord[], batchSize = 2): Promise<void> {
    const generation = ++this.rebuildGeneration;
    const nextIndex = this.createIndex();
    const nextSymbolsById = new Map<number, PreparedLuaSymbol[]>();
    const pending: PendingLuaRebuild = { updates: [] };
    this.pendingRebuilds.add(pending);
    try {
      for (let offset = 0; offset < pages.length; offset += batchSize) {
        this.applyPages(
          nextIndex,
          nextSymbolsById,
          pages.slice(offset, offset + batchSize),
        );
        await this.taskScheduler.yield();
      }
      for (const update of pending.updates) {
        this.applyPages(nextIndex, nextSymbolsById, update);
      }
      if (generation === this.rebuildGeneration) {
        this.index = nextIndex;
        this.symbolsById = nextSymbolsById;
      }
    } finally {
      this.pendingRebuilds.delete(pending);
    }
  }

  update(pages: PageRecord[]): void {
    for (const pending of this.pendingRebuilds) {
      pending.updates.push(pages.map((page) => ({ ...page })));
    }
    this.applyPages(this.index, this.symbolsById, pages);
  }

  private applyPages(
    index: MiniSearch<IndexedLuaModule>,
    symbolsById: Map<number, PreparedLuaSymbol[]>,
    pages: PageRecord[],
  ): void {
    for (const page of pages) {
      const document = this.toDocument(page, symbolsById);
      if (!document) {
        if (index.has(page.id)) index.discard(page.id);
        symbolsById.delete(page.id);
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
      symbolsById: [...this.symbolsById].map(([id, symbols]) => [
        id,
        symbols.map((symbol) => ({ ...symbol, terms: [...symbol.terms] })),
      ]),
    };
  }

  async importSnapshot(payload: unknown): Promise<void> {
    if (
      !payload ||
      typeof payload !== 'object' ||
      !('miniSearch' in payload) ||
      !('symbolsById' in payload) ||
      !isPreparedSymbolEntries(payload.symbolsById)
    ) {
      throw new Error('Lua 快照 payload 结构无效');
    }
    const generation = ++this.rebuildGeneration;
    const pending: PendingLuaRebuild = { updates: [] };
    this.pendingRebuilds.add(pending);
    const restoredSymbolsById = new Map<number, PreparedLuaSymbol[]>();
    for (const [id, symbols] of payload.symbolsById) {
      restoredSymbolsById.set(
        id,
        symbols.map((symbol) => ({ ...symbol, terms: new Set(symbol.terms) })),
      );
    }
    try {
      const restored = await MiniSearch.loadJSAsync<IndexedLuaModule>(
        payload.miniSearch as AsPlainObject,
        this.indexOptions(),
      );
      if (restoredSymbolsById.size !== restored.documentCount) {
        throw new Error('Lua 快照符号数量不一致');
      }
      for (const update of pending.updates) {
        this.applyPages(restored, restoredSymbolsById, update);
      }
      if (generation === this.rebuildGeneration) {
        this.index = restored;
        this.symbolsById = restoredSymbolsById;
      }
    } finally {
      this.pendingRebuilds.delete(pending);
    }
  }

  search(query: string, limit = 20): LuaModuleSearchResult[] {
    const normalizedQuery = this.analyzer.normalize(query);
    if (!normalizedQuery) return [];
    const terms = this.analyzer.queryTokens(normalizedQuery);
    if (!terms.length) return [];
    const options = {
      prefix: true,
      combineWith: 'AND' as const,
      tokenize: (value: string): string[] => this.analyzer.queryTokens(value),
      processTerm: (term: string): string => term,
    };
    let results = this.index.search(normalizedQuery, options);
    if (!results.length && terms.length > 1) {
      results = this.index.search(normalizedQuery, { ...options, combineWith: 'OR' });
    }

    const compactQuery = this.analyzer.compactNormalized(normalizedQuery);
    return results
      .map((result) => {
        const title = String(result.title);
        const matches = this.findMatches(
          this.symbolsById.get(Number(result.id)),
          normalizedQuery,
          compactQuery,
          terms,
        );
        const titleBoost = this.analyzer.compact(title).includes(compactQuery) ? 3 : 1;
        return {
          kind: 'lua' as const,
          id: Number(result.id),
          title,
          namespace: Number(result.namespace),
          namespaceName: String(result.namespaceName),
          matches: matches.map(({ kind, value }) => ({ kind, value })),
          score: result.score * titleBoost * (1 + (matches[0]?.rank ?? 0) / 100),
          matchRank: matches[0]?.rank ?? 0,
        };
      })
      .sort(
        (left, right) =>
          right.matchRank - left.matchRank ||
          right.score - left.score ||
          left.id - right.id,
      )
      .slice(0, limit)
      .map(({ matchRank: _matchRank, ...result }) => result);
  }

  get size(): number {
    return this.index.documentCount;
  }

  private createIndex(): MiniSearch<IndexedLuaModule> {
    return new MiniSearch<IndexedLuaModule>(this.indexOptions());
  }

  private indexOptions(): Options<IndexedLuaModule> {
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
    symbolsById: Map<number, PreparedLuaSymbol[]>,
  ): IndexedLuaModule | undefined {
    if (
      page.deleted ||
      page.isRedirect ||
      page.contentModel?.toLocaleLowerCase() !== 'scribunto' ||
      typeof page.content !== 'string'
    ) {
      return undefined;
    }
    const extracted = extractLua(page.content);
    if (!extracted.searchableText) return undefined;
    symbolsById.set(page.id, this.prepareSymbols(extracted));
    return {
      id: page.id,
      title: page.title,
      normalizedTitle: page.normalizedTitle,
      namespace: page.namespace,
      namespaceName: page.namespaceName,
      tokens: this.analyzer.documentTokens(extracted.searchableText).join(' '),
    };
  }

  private findMatches(
    values: PreparedLuaSymbol[] | undefined,
    normalizedQuery: string,
    compactQuery: string,
    queryTerms: string[],
  ): Array<LuaSymbolMatch & { rank: number }> {
    if (!values) return [];
    return values
      .map((candidate) => {
        let relevance = 0;
        if (candidate.normalized === normalizedQuery || candidate.compact === compactQuery) {
          relevance = 100;
        } else if (
          candidate.normalized.startsWith(normalizedQuery) ||
          candidate.compact.startsWith(compactQuery)
        ) {
          relevance = 60;
        } else if (
          candidate.normalized.includes(normalizedQuery) ||
          candidate.compact.includes(compactQuery)
        ) {
          relevance = 40;
        } else {
          const overlap = queryTerms.filter((term) => candidate.terms.has(term)).length;
          relevance = overlap ? (overlap / queryTerms.length) * 20 : 0;
        }
        return { ...candidate, rank: relevance + candidate.priority };
      })
      .filter(({ rank, priority }) => rank > priority)
      .sort((left, right) => right.rank - left.rank || left.value.length - right.value.length)
      .slice(0, 3);
  }

  private prepareSymbols(extracted: LuaExtraction): PreparedLuaSymbol[] {
    const values: Array<LuaSymbolMatch & { priority: number }> = [
      ...extracted.functions.map((value) => ({ kind: 'function' as const, value, priority: 4 })),
      ...extracted.returnKeys.map((value) => ({
        kind: 'return-key' as const,
        value,
        priority: 3,
      })),
      ...extracted.dependencies.map((value) => ({
        kind: 'dependency' as const,
        value,
        priority: 2,
      })),
      ...extracted.strings.map((value) => ({ kind: 'string' as const, value, priority: 1 })),
    ];
    return values.map((candidate) => {
      const normalized = this.analyzer.normalize(candidate.value);
      return {
        ...candidate,
        normalized,
        compact: this.analyzer.compactNormalized(normalized),
        terms: new Set(this.analyzer.documentTokens(candidate.value)),
      };
    });
  }
}

function isPreparedSymbolEntries(
  value: unknown,
): value is Array<[number, SerializedPreparedLuaSymbol[]]> {
  return (
    Array.isArray(value) &&
    value.every(
      (entry) =>
        Array.isArray(entry) &&
        entry.length === 2 &&
        typeof entry[0] === 'number' &&
        Array.isArray(entry[1]) &&
        entry[1].every(
          (symbol) =>
            symbol &&
            typeof symbol === 'object' &&
            ['function', 'return-key', 'string', 'dependency'].includes(symbol.kind) &&
            typeof symbol.value === 'string' &&
            typeof symbol.priority === 'number' &&
            typeof symbol.normalized === 'string' &&
            typeof symbol.compact === 'string' &&
            Array.isArray(symbol.terms) &&
            symbol.terms.every((term: unknown) => typeof term === 'string'),
        ),
    )
  );
}
