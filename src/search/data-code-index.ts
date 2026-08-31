// SPDX-License-Identifier: MPL-2.0
import type { Analyzer } from '../analyzer/analyzer';
import type { DataCodeRecord } from '../types';

export interface DataCodeSearchResult {
  kind: 'data-code';
  source: string;
  code: string;
  chineseName: string;
  dataType: string;
  score: number;
}

interface IndexedDataCode {
  record: DataCodeRecord;
  compactSearchValues: string[];
  normalizedCode: string;
}

export class DataCodeIndex {
  private readonly entries: IndexedDataCode[];

  constructor(
    private readonly analyzer: Analyzer,
    records: DataCodeRecord[],
  ) {
    this.entries = records.map((record) => ({
      record,
      compactSearchValues: (
        record.normalizedSearchValues ?? [record.normalizedSearchText ?? record.normalizedName]
      ).map((value) => analyzer.compactNormalized(value)),
      normalizedCode: record.code.normalize('NFKC').toLowerCase(),
    }));
  }

  search(query: string, limit = 20): DataCodeSearchResult[] {
    const normalizedQuery = this.analyzer.normalize(query);
    const compactQuery = this.analyzer.compactNormalized(normalizedQuery);
    if (!compactQuery) return [];

    const matches: DataCodeSearchResult[] = [];
    for (const { record, compactSearchValues, normalizedCode } of this.entries) {
      let fieldScore = 0;
      for (const compactValue of compactSearchValues) {
        const fieldPosition = compactValue.indexOf(compactQuery);
        if (fieldPosition < 0) continue;
        let candidateScore = 10_000 - fieldPosition * 10 - compactValue.length;
        if (compactValue === compactQuery) candidateScore += 1_000_000;
        else if (fieldPosition === 0) candidateScore += 100_000;
        fieldScore = Math.max(fieldScore, candidateScore);
      }
      const codePosition = normalizedCode.indexOf(normalizedQuery);
      if (!fieldScore && codePosition < 0) continue;

      let score = fieldScore;
      if (codePosition >= 0) {
        let codeScore = 5_000 - codePosition * 10 - normalizedCode.length;
        if (normalizedCode === normalizedQuery) codeScore += 500_000;
        else if (codePosition === 0) codeScore += 50_000;
        score = Math.max(score, codeScore);
      }
      matches.push({
        kind: 'data-code',
        source: record.source,
        code: record.code,
        chineseName: record.chineseName,
        dataType: record.dataType,
        score,
      });
    }

    return matches
      .sort((left, right) => right.score - left.score || left.code.localeCompare(right.code))
      .slice(0, limit);
  }

  get size(): number {
    return this.entries.length;
  }
}
