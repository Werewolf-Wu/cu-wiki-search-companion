// SPDX-License-Identifier: MPL-2.0
import 'fake-indexeddb/auto';

import { Analyzer, createBootstrapSegmenter, createIntlSegmenter } from '../src/analyzer/analyzer';
import { LocalDataMaintenance } from '../src/maintenance/local-data-maintenance';
import { PageSearchRuntime } from '../src/runtime/page-search-runtime';
import { VersionedSearchIndexCache } from '../src/search/versioned-search-index-cache';
import { WikiSearchDatabase } from '../src/storage/database';
import type { PageRecord } from '../src/types';

const resources: Array<{ database: WikiSearchDatabase; cache: VersionedSearchIndexCache }> = [];

afterEach(async () => {
  for (const { database, cache } of resources.splice(0)) {
    try { await cache.clear(); } catch { /* A failure test may close the database. */ }
    database.close();
    await database.delete();
  }
});

it('initializes lightly and coalesces content preparation without loading Lua', async () => {
  const { runtime, database, loadAnalyzer, synchronizeContent } = await harness();
  await runtime.initialize();
  expect(runtime.state.engine).toBe('bootstrap');
  expect(runtime.searchTitles('医疗').map(({ title }) => title)).toEqual(['医疗指南']);
  expect(runtime.hasLoadedContentIndex()).toBe(false);
  expect(loadAnalyzer).not.toHaveBeenCalled();
  expect(await database.indexSnapshots.count()).toBe(0);

  await Promise.all([runtime.prepare('content'), runtime.prepare('content')]);
  expect(runtime.searchContent('绷带').map(({ title }) => title)).toEqual(['医疗指南']);
  expect(runtime.searchLua('heal')).toEqual([]);
  expect(await database.indexSnapshots.get('search-index:lua')).toBeUndefined();
  expect(loadAnalyzer).toHaveBeenCalledOnce();
  expect(synchronizeContent).toHaveBeenCalledOnce();
});

it.each([false, true])('finishes same-turn preparation/rebuild without a circular wait (rebuild first: %s)', async (rebuildFirst) => {
  const { runtime } = await harness();
  await runtime.initialize();
  await Promise.all(rebuildFirst
    ? [runtime.rebuildIndexes(), runtime.prepare('content')]
    : [runtime.prepare('content'), runtime.rebuildIndexes()]);
  expect(runtime.searchContent('绷带').map(({ title }) => title)).toEqual(['医疗指南']);
  expect(runtime.searchLua('heal').map(({ title }) => title)).toEqual(['模块:Health']);
}, 1_500);

it('keeps local content usable during a failed settlement and retries without reloading the analyzer', async () => {
  const failure = new Error('network interrupted');
  let rejectNetwork!: (error: Error) => void;
  const blocked = new Promise<void>((_resolve, reject) => { rejectNetwork = reject; });
  let attempts = 0;
  const synchronizeContent = vi.fn(async () => {
    if (++attempts === 1) await blocked;
    return { total: 2, done: 2, pending: 0, failed: 0 };
  });
  const { runtime, loadAnalyzer } = await harness({ synchronizeContent });
  const preparing = runtime.prepare('content');
  const rejected = expect(preparing).rejects.toBe(failure);
  await vi.waitFor(() => expect(synchronizeContent).toHaveBeenCalledOnce());
  expect(runtime.searchContent('绷带').map(({ title }) => title)).toEqual(['医疗指南']);
  rejectNetwork(failure);
  await rejected;
  await runtime.prepare('content');
  expect(runtime.searchContent('绷带').map(({ title }) => title)).toEqual(['医疗指南']);
  expect(loadAnalyzer).toHaveBeenCalledOnce();
  expect(synchronizeContent).toHaveBeenCalledTimes(2);
});

it('refreshes committed content after a failed synchronization and preserves the original error', async () => {
  const failure = new Error('second batch failed');
  let database!: WikiSearchDatabase;
  const { runtime, database: storage } = await harness({ synchronizeContent: async () => {
    await database.transaction('rw', database.pages, database.syncState, async () => {
      await database.pages.update(1, { content: '新提交的纱布', localSeq: 3, revisionId: 2, contentRevisionId: 2 });
      await database.syncState.put({ key: 'local-sequence', value: 3 });
    });
    throw failure;
  } });
  database = storage;
  await expect(runtime.prepare('content')).rejects.toBe(failure);
  expect(runtime.searchContent('纱布').map(({ title }) => title)).toEqual(['医疗指南']);
  expect(runtime.searchContent('绷带')).toEqual([]);
});

it('replays renamed pages, replaced content and tombstones through every loaded query', async () => {
  const { runtime, database } = await harness();
  await runtime.prepare('content');
  await runtime.prepare('lua');
  await database.transaction('rw', database.pages, database.syncState, async () => {
    await database.pages.update(1, { title: '急救手册', normalizedTitle: '急救手册', content: '使用纱布', localSeq: 3 });
    await database.pages.update(2, { deleted: true, content: undefined, localSeq: 4 });
    await database.syncState.put({ key: 'local-sequence', value: 4 });
  });
  await runtime.refresh();
  expect(runtime.searchTitles('医疗')).toEqual([]);
  expect(runtime.searchTitles('急救', 0).map(({ title }) => title)).toEqual(['急救手册']);
  expect(runtime.searchTitles('急救', 828)).toEqual([]);
  expect(runtime.searchContent('纱布').map(({ title }) => title)).toEqual(['急救手册']);
  expect(runtime.searchContent('绷带')).toEqual([]);
  expect(runtime.searchLua('heal')).toEqual([]);
  expect(runtime.searchTitles('Health')).toEqual([]);
});

it('rebuilds locally without waiting for a pending remote settlement or reinstalling old handles', async () => {
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  const titleWriter = vi.fn(async () => held);
  const { runtime, database, synchronizeContent } = await harness({ synchronizeTitles: titleWriter });
  const preparing = runtime.prepare('content');
  try {
    await vi.waitFor(() => expect(titleWriter).toHaveBeenCalledOnce());
    await database.transaction('rw', database.pages, database.syncState, async () => {
      await database.pages.update(1, { title: '新版医疗指南', normalizedTitle: '新版医疗指南', content: '使用纱布', localSeq: 3 });
      await database.syncState.put({ key: 'local-sequence', value: 3 });
    });
    await runtime.rebuildIndexes();
    expect(synchronizeContent).not.toHaveBeenCalled();
    expect(runtime.searchContent('纱布').map(({ title }) => title)).toEqual(['新版医疗指南']);
    const afterRebuild = await database.indexSnapshots.toArray();
    release();
    await preparing;
    expect(runtime.searchContent('纱布').map(({ title }) => title)).toEqual(['新版医疗指南']);
    expect(runtime.searchContent('绷带')).toEqual([]);
    expect(await database.indexSnapshots.toArray()).toEqual(afterRebuild);
  } finally {
    release();
    await preparing.catch(() => undefined);
  }
}, 1_500);

it('performs a cold maintenance rebuild with no fact synchronization and keeps results after a later rebuild fails', async () => {
  const failure = new Error('snapshot rebuild failed');
  let fail = false;
  let maintenance!: LocalDataMaintenance;
  const result = await harness({ rebuildIndexes: async (analyzer) => {
    if (fail) throw failure;
    return maintenance.rebuildSearchIndexes(analyzer);
  } });
  maintenance = result.maintenance;
  await result.runtime.rebuildIndexes();
  expect(result.synchronizeTitles).not.toHaveBeenCalled();
  expect(result.synchronizeContent).not.toHaveBeenCalled();
  expect(result.runtime.searchContent('绷带').map(({ title }) => title)).toEqual(['医疗指南']);
  expect(result.runtime.searchLua('heal').map(({ title }) => title)).toEqual(['模块:Health']);
  fail = true;
  await expect(result.runtime.rebuildIndexes()).rejects.toBe(failure);
  expect(result.runtime.searchContent('绷带').map(({ title }) => title)).toEqual(['医疗指南']);
  expect(result.runtime.searchLua('heal').map(({ title }) => title)).toEqual(['模块:Health']);
});

it('does not materialize all page bodies when a forced content sync has no loaded derived index', async () => {
  const { runtime, database } = await harness();
  await runtime.initialize();
  const readBodies = vi.spyOn(database.pages, 'toArray');
  await runtime.synchronizeContent(true);
  expect(runtime.hasLoadedContentIndex()).toBe(false);
  expect(readBodies).not.toHaveBeenCalled();
});

function pages(): PageRecord[] {
  return [
    { id: 1, title: '医疗指南', normalizedTitle: '医疗指南', namespace: 0, namespaceName: '（主）',
      isRedirect: false, localSeq: 1, revisionId: 1, contentRevisionId: 1,
      contentModel: 'wikitext', content: '使用医疗绷带' },
    { id: 2, title: '模块:Health', normalizedTitle: '模块:health', namespace: 828, namespaceName: '模块',
      isRedirect: false, localSeq: 2, revisionId: 1, contentRevisionId: 1,
      contentModel: 'Scribunto', content: 'local p = {}\nfunction p.heal() return "bandage" end\nreturn p' },
  ];
}

async function harness(overrides: Partial<ConstructorParameters<typeof PageSearchRuntime>[0]> = {}) {
  const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
  await database.open();
  await database.pages.bulkPut(pages());
  await database.syncState.put({ key: 'local-sequence', value: 2 });
  const cache = new VersionedSearchIndexCache(database);
  resources.push({ database, cache });
  const maintenance = new LocalDataMaintenance(database, cache);
  const loadAnalyzer = vi.fn(async () => ({
    analyzer: new Analyzer(createIntlSegmenter(), 'Intl.Segmenter'),
    engine: 'Intl.Segmenter' as const,
  }));
  const synchronizeTitles = vi.fn(async () => undefined);
  const synchronizeContent = vi.fn(async () => ({ total: 2, done: 2, pending: 0, failed: 0 }));
  const runtime = new PageSearchRuntime({
    database,
    indexCache: cache,
    bootstrapAnalyzer: new Analyzer(createBootstrapSegmenter(), 'bootstrap'),
    loadAnalyzer,
    waitUntilVisible: async () => undefined,
    synchronizeTitles,
    synchronizeContent,
    rebuildIndexes: (analyzer) => maintenance.rebuildSearchIndexes(analyzer),
    ...overrides,
  });
  return { runtime, database, cache, maintenance, loadAnalyzer, synchronizeTitles, synchronizeContent };
}
