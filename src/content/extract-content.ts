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
  if (Array.isArray(value)) {
    for (const child of value) collectJsonTokens(child, tokens);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      tokens.add(key);
      collectJsonTokens(child, tokens);
    }
    return;
  }
  if (value === null) return;
  if (typeof value === 'string') {
    if (value.trim()) tokens.add(value.trim());
  } else if (typeof value === 'number' || typeof value === 'boolean') {
    tokens.add(String(value));
  }
}
