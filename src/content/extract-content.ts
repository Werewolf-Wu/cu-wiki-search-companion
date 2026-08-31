// SPDX-License-Identifier: MPL-2.0
import { extractWikitext } from './extract-wikitext';

export function extractContent(contentModel: string | undefined, source: string): string {
  switch (contentModel?.toLocaleLowerCase()) {
    case 'wikitext':
      return extractWikitext(source);
    case 'bson':
      return extractJson(source);
    default:
      return '';
  }
}

function extractJson(source: string): string {
  let parsed: unknown;
  try {
    parsed = JSON.parse(source) as unknown;
  } catch {
    return '';
  }

  const tokens = new Set<string>();
  collectJsonTokens(parsed, tokens);
  return [...tokens].join(' ').replace(/\s+/g, ' ').trim();
}

function collectJsonTokens(value: unknown, tokens: Set<string>): void {
  const pending: Array<
    | { kind: 'value'; value: unknown }
    | { kind: 'token'; value: string }
  > = [{ kind: 'value', value }];

  while (pending.length) {
    const item = pending.pop()!;
    if (item.kind === 'token') {
      tokens.add(item.value);
      continue;
    }
    const current = item.value;
    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) {
        pending.push({ kind: 'value', value: current[index] });
      }
      continue;
    }
    if (current && typeof current === 'object') {
      const entries = Object.entries(current);
      for (let index = entries.length - 1; index >= 0; index -= 1) {
        const [key, child] = entries[index]!;
        pending.push({ kind: 'value', value: child });
        pending.push({ kind: 'token', value: key });
      }
      continue;
    }
    if (current === null) continue;
    if (typeof current === 'string') {
      if (current.trim()) tokens.add(current.trim());
    } else if (typeof current === 'number' || typeof current === 'boolean') {
      tokens.add(String(current));
    }
  }
}
