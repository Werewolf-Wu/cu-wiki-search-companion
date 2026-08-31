// SPDX-License-Identifier: MPL-2.0
import { build } from 'vite';
import nightlyWorkflow from '../.github/workflows/nightly.yml?raw';

describe('userscript activation metadata', () => {
  it('builds edit/submit-only match patterns into both metadata headers', async () => {
    const result = await build({ build: { write: false } });
    const outputs = (Array.isArray(result) ? result : [result]).flatMap((entry) =>
      'output' in entry ? entry.output : [],
    );
    const userScript = outputs.find(
      (entry) => entry.type === 'chunk' && entry.fileName === 'cu-wiki-local-search.user.js',
    );
    const metaFile = outputs.find(
      (entry) => entry.type === 'asset' && entry.fileName === 'cu-wiki-local-search.meta.js',
    );
    if (userScript?.type !== 'chunk' || metaFile?.type !== 'asset') {
      throw new Error('Vite build did not return both userscript metadata artifacts');
    }
    const metaSource =
      typeof metaFile.source === 'string'
        ? metaFile.source
        : new TextDecoder().decode(metaFile.source);
    const userMatches = metadataMatches(userScript.code);
    const metaMatches = metadataMatches(metaSource);

    expect(metaMatches).toEqual(userMatches);
    expect(userMatches).not.toContain('https://casualtiesunknown.huijiwiki.com/*');
    for (const url of [
      'https://casualtiesunknown.huijiwiki.com/wiki/首页',
      'https://casualtiesunknown.huijiwiki.com/wiki/首页?oldid=10',
      'https://casualtiesunknown.huijiwiki.com/wiki/首页?action=view',
      'https://casualtiesunknown.huijiwiki.com/index.php?title=首页&diff=10',
    ]) {
      expect(matchesAnyPattern(url, userMatches), url).toBe(false);
    }
    for (const url of [
      'https://casualtiesunknown.huijiwiki.com/wiki/首页?action=edit',
      'https://casualtiesunknown.huijiwiki.com/wiki/首页?action=edit&section=1',
      'https://casualtiesunknown.huijiwiki.com/index.php?title=首页&action=edit',
      'https://casualtiesunknown.huijiwiki.com/index.php?title=首页&action=edit&section=1',
      'https://casualtiesunknown.huijiwiki.com/wiki/首页?action=submit',
      'https://casualtiesunknown.huijiwiki.com/wiki/首页?action=submit&section=1',
      'https://casualtiesunknown.huijiwiki.com/index.php?title=首页&action=submit',
      'https://casualtiesunknown.huijiwiki.com/index.php?title=首页&action=submit&section=1',
    ]) {
      expect(matchesAnyPattern(url, userMatches), url).toBe(true);
    }
  });

  it('queues same-ref nightly runs without cancelling an in-progress release update', () => {
    const concurrencyBlock = /concurrency:\s*\n([\s\S]*?)\n\npermissions:/.exec(
      nightlyWorkflow,
    )?.[1];

    expect(concurrencyBlock).toContain(
      'group: nightly-${{ github.workflow }}-${{ github.ref }}',
    );
    expect(concurrencyBlock).toContain('cancel-in-progress: false');
  });
});

function metadataMatches(source: string): string[] {
  return source
    .split('\n')
    .flatMap((line) => /^\/\/ @match\s+(\S+)\s*$/.exec(line)?.[1] ?? []);
}

function matchesAnyPattern(url: string, patterns: string[]): boolean {
  return patterns.some((pattern) => matchesPattern(url, pattern));
}

function matchesPattern(url: string, pattern: string): boolean {
  const target = new URL(url);
  const separator = pattern.indexOf('/', 'https://'.length);
  const patternOrigin = pattern.slice(0, separator);
  if (target.origin !== patternOrigin) return false;
  const pathPattern = pattern.slice(separator);
  const expression = pathPattern
    .split('*')
    .map((part) => part.replace(/[|\\{}()[\]^$+?.-]/g, '\\$&'))
    .join('.*');
  return new RegExp(`^${expression}$`).test(`${target.pathname}${target.search}`);
}
