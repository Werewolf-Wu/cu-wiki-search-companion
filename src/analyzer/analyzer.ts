// SPDX-License-Identifier: MPL-2.0
import OpenCC from 'opencc-js';

export interface WordSegmenter {
  cut(text: string): string[];
  cutForSearch(text: string): string[];
}

const CJK_CHARACTER = /[\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/;
const LATIN_RUN_CHARACTER = /[A-Za-z0-9._]/;
const toSimplified = OpenCC.Converter({ from: 't', to: 'cn' });

export class Analyzer {
  constructor(
    private readonly segmenter: WordSegmenter,
    readonly compatibilityEngine = 'custom',
  ) {}

  normalize(value: string): string {
    return toSimplified(value.normalize('NFKC'))
      .toLowerCase()
      .replace(/\s+/g, ' ')
      .trim();
  }

  compact(value: string): string {
    return this.compactNormalized(this.normalize(value));
  }

  compactNormalized(normalized: string): string {
    return normalized.replace(
      /[^0-9a-z\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff]/g,
      '',
    );
  }

  cjkOf(value: string): string {
    return [...value].filter((character) => CJK_CHARACTER.test(character)).join('');
  }

  documentTokens(value: string): string[] {
    const tokens = new Set(this.documentTokensFromNormalized(this.normalize(value)));
    addLatinTokens(tokens, value.normalize('NFKC'));
    return [...tokens];
  }

  documentTokensFromNormalized(normalized: string): string[] {
    const tokens = new Set<string>();

    for (const word of this.segmenter.cutForSearch(normalized)) {
      if (word.trim()) tokens.add(word);
    }
    addCjkTokens(tokens, normalized);
    addLatinTokens(tokens, normalized);

    return [...tokens];
  }

  queryTokens(value: string): string[] {
    const normalized = this.normalize(value);
    const cjk = this.cjkOf(normalized);

    if (
      cjk.length === 1 &&
      normalized.replace(/[^0-9a-z.]/g, '') === '' &&
      cjk === normalized
    ) {
      return [normalized];
    }

    const tokens = new Set<string>();
    addCjkTokens(tokens, normalized);
    addLatinTokens(tokens, normalized);
    addLatinTokens(tokens, value.normalize('NFKC'));
    for (const word of this.segmenter.cut(normalized)) {
      if (word.trim().length >= 2) tokens.add(word);
    }
    return [...tokens];
  }
}

export function bigrams(value: string): string[] {
  const characters = [...value];
  const result: string[] = [];
  for (let index = 0; index + 1 < characters.length; index += 1) {
    result.push(`${characters[index]}${characters[index + 1]}`);
  }
  return result;
}

function cjkRuns(value: string): string[] {
  const result: string[] = [];
  let current = '';
  for (const character of value) {
    if (CJK_CHARACTER.test(character)) {
      current += character;
    } else if (current) {
      result.push(current);
      current = '';
    }
  }
  if (current) result.push(current);
  return result;
}

export function latinRuns(value: string): string[] {
  const result: string[] = [];
  let current = '';
  for (const character of value) {
    if (LATIN_RUN_CHARACTER.test(character)) {
      current += character;
    } else if (current) {
      result.push(current);
      current = '';
    }
  }
  if (current) result.push(current);
  return result;
}

export function latinParts(run: string): string[] {
  const lower = run.toLowerCase();
  const parts = new Set<string>();
  if (/[a-z0-9]/.test(lower)) parts.add(lower);

  for (const part of lower.split(/[._]+/)) {
    if (part) parts.add(part);
  }

  const camelParts = run
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .split(/[ ._]+/);
  for (const part of camelParts) {
    const normalized = part.toLowerCase();
    if (normalized) parts.add(normalized);
  }

  const bare = lower.replace(/[^a-z0-9]/g, '');
  if (bare.length >= 4) {
    for (let index = 0; index + 2 < bare.length; index += 1) {
      parts.add(bare.slice(index, index + 3));
    }
  }
  return [...parts];
}

function addCjkTokens(tokens: Set<string>, value: string): void {
  for (const run of cjkRuns(value)) {
    if ([...run].length === 1) tokens.add(run);
    for (const bigram of bigrams(run)) tokens.add(bigram);
  }
}

function addLatinTokens(tokens: Set<string>, value: string): void {
  for (const run of latinRuns(value)) {
    for (const part of latinParts(run)) tokens.add(part);
  }
}

export function createIntlSegmenter(): WordSegmenter {
  const segmenter = new Intl.Segmenter('zh', { granularity: 'word' });
  const cut = (text: string): string[] =>
    [...segmenter.segment(text)]
      .filter((part) => part.isWordLike)
      .map((part) => part.segment);
  return { cut, cutForSearch: cut };
}

export function createBootstrapSegmenter(): WordSegmenter {
  const whole = (text: string): string[] => (text ? [text] : []);
  return { cut: whole, cutForSearch: whole };
}
