// SPDX-License-Identifier: MPL-2.0
import 'fake-indexeddb/auto';

import { cut, cut_for_search } from 'jieba-wasm/node';

import { Analyzer } from '../src/analyzer/analyzer';
import {
  snapshotKey,
  VersionedSearchIndexCache,
} from '../src/search/versioned-search-index-cache';
import { WikiSearchDatabase } from '../src/storage/database';
import type { IndexSnapshotRecord, PageRecord } from '../src/types';

const analyzer = new Analyzer(
  { cut, cutForSearch: cut_for_search },
  'jieba-wasm',
);

describe('VersionedSearchIndexCache', () => {
  it('restores title, content snippets, and structured Lua matches identically', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.bulkPut([
      page(1, '医疗指导', '使用医用级兴奋剂进行紧急救治。', 'wikitext', 1),
      page(
        2,
        '模块:About',
        `local p = {}; function p.sleepQuality() return { _meta = '睡眠质量' } end; return p`,
        'Scribunto',
        2,
      ),
    ]);
    await database.syncState.put({ key: 'local-sequence', value: 2 });
    const firstCache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    const firstTitle = await firstCache.restoreOrRebuild('title', analyzer);
    const firstContent = await firstCache.restoreOrRebuild('content', analyzer);
    const firstLua = await firstCache.restoreOrRebuild('lua', analyzer);
    const expected = {
      title: firstTitle.index.search('医疗'),
      content: firstContent.index.search('紧急救治'),
      lua: firstLua.index.search('_meta'),
    };

    expect(firstTitle.source).toBe('rebuild');
    await firstCache.publish(firstTitle);
    await firstCache.publish(firstContent);
    await firstCache.publish(firstLua);

    const restoredCache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    const restoredTitle = await restoredCache.restoreOrRebuild('title', analyzer);
    const restoredContent = await restoredCache.restoreOrRebuild('content', analyzer);
    const restoredLua = await restoredCache.restoreOrRebuild('lua', analyzer);

    expect(restoredTitle.source).toBe('snapshot');
    expect(restoredContent.source).toBe('snapshot');
    expect(restoredLua.source).toBe('snapshot');
    expect(restoredTitle.index.search('医疗')).toEqual(expected.title);
    expect(restoredContent.index.search('紧急救治')).toEqual(expected.content);
    expect(restoredLua.index.search('_meta')).toEqual(expected.lua);

    database.close();
    await database.delete();
  });

  it('replays added, renamed, content-changed, and tombstoned pages across sequence gaps', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.bulkPut([
      page(1, '废弃手册', '旧的治疗正文', 'wikitext', 1),
      page(2, '模块:旧模块', `return { oldKey = '旧值' }`, 'Scribunto', 2),
    ]);
    await database.syncState.put({ key: 'local-sequence', value: 2 });
    const cache = new VersionedSearchIndexCache(database, { storage: unlimitedStorage() });
    await cache.publish(await cache.restoreOrRebuild('title', analyzer));
    await cache.publish(await cache.restoreOrRebuild('content', analyzer));
    await cache.publish(await cache.restoreOrRebuild('lua', analyzer));

    await database.pages.bulkPut([
      page(1, '新医疗标题', '更新后的深度治疗正文', 'wikitext', 4),
      { ...page(2, '模块:旧模块', '', 'Scribunto', 5), deleted: true },
      page(3, '新增页面', '全新内容', 'wikitext', 6),
    ]);
    // 3 由 fileResources 写入占用；pages 的 localSeq 不要求连续。
    await database.syncState.put({ key: 'local-sequence', value: 6 });

    const restoredCache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    const title = await restoredCache.restoreOrRebuild('title', analyzer);
    const content = await restoredCache.restoreOrRebuild('content', analyzer);
    const lua = await restoredCache.restoreOrRebuild('lua', analyzer);

    expect(title).toMatchObject({ source: 'snapshot', replayedPages: 3, throughLocalSeq: 6 });
    expect(content).toMatchObject({ source: 'snapshot', replayedPages: 3 });
    expect(lua).toMatchObject({ source: 'snapshot', replayedPages: 3 });
    expect(title.index.search('废弃手册')).toEqual([]);
    expect(title.index.search('新医疗')[0]?.title).toBe('新医疗标题');
    expect(title.index.search('新增')[0]?.title).toBe('新增页面');
    expect(content.index.search('深度治疗')[0]?.title).toBe('新医疗标题');
    expect(lua.index.search('oldKey')).toEqual([]);

    database.close();
    await database.delete();
  });

  it.each([
    ['invalid JSON', async (record: IndexSnapshotRecord) => {
      record.json = '{invalid';
      record.payloadBytes = new TextEncoder().encode(record.json).byteLength;
      record.sha256 = await digest(record.json);
    }],
    ['wrong SHA', async (record: IndexSnapshotRecord) => {
      record.sha256 = '0'.repeat(64);
    }],
    ['wrong document count', async (record: IndexSnapshotRecord) => {
      record.documentCount += 1;
    }],
    ['future sequence', async (record: IndexSnapshotRecord) => {
      record.throughLocalSeq += 100;
    }],
  ])('falls back to local pages for %s corruption', async (_label, mutate) => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '损坏回退', '仍可本地搜索', 'wikitext', 1));
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    const first = new VersionedSearchIndexCache(database, { storage: unlimitedStorage() });
    await first.publish(await first.restoreOrRebuild('title', analyzer));
    const record = await database.indexSnapshots.get(snapshotKey('title'));
    if (!record) throw new Error('测试快照未发布');
    await mutate(record);
    await database.indexSnapshots.put(record);

    const restored = await new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    }).restoreOrRebuild('title', analyzer);

    expect(restored.source).toBe('rebuild');
    expect(restored.index.search('损坏回退')[0]?.title).toBe('损坏回退');
    expect(await database.indexSnapshots.get(snapshotKey('title'))).toBeUndefined();

    database.close();
    await database.delete();
  });

  it('does not let an older handle overwrite a higher-sequence snapshot', async () => {
    const name = `test-${crypto.randomUUID()}`;
    const firstDatabase = new WikiSearchDatabase(name);
    const secondDatabase = new WikiSearchDatabase(name);
    await firstDatabase.open();
    await secondDatabase.open();
    await firstDatabase.pages.put(page(1, '第一版', '正文', 'wikitext', 1));
    await firstDatabase.syncState.put({ key: 'local-sequence', value: 1 });
    const firstCache = new VersionedSearchIndexCache(firstDatabase, {
      storage: unlimitedStorage(),
    });
    const secondCache = new VersionedSearchIndexCache(secondDatabase, {
      storage: unlimitedStorage(),
    });
    const olderHandle = await firstCache.restoreOrRebuild('title', analyzer);
    const newerHandle = await secondCache.restoreOrRebuild('title', analyzer);
    await firstDatabase.pages.put(page(1, '第二版', '正文', 'wikitext', 2));
    await firstDatabase.syncState.put({ key: 'local-sequence', value: 2 });
    await secondCache.refresh(newerHandle);

    expect((await secondCache.publish(newerHandle)).status).toBe('published');
    expect(await firstCache.publish(olderHandle)).toEqual({
      status: 'skipped',
      reason: 'sequence-changed',
    });
    expect((await firstDatabase.indexSnapshots.get(snapshotKey('title')))?.throughLocalSeq).toBe(2);

    firstDatabase.close();
    secondDatabase.close();
    await firstDatabase.delete();
  });

  it('refreshes and retries a debounced publish after its handle falls behind', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '第一版标题', '正文', 'wikitext', 1));
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    const cache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
      publishDelayMs: 1,
    });
    const handle = await cache.restoreOrRebuild('title', analyzer);

    await database.pages.put(page(1, '第二版标题', '正文', 'wikitext', 2));
    await database.syncState.put({ key: 'local-sequence', value: 2 });
    cache.schedulePublish(handle);

    await vi.waitFor(async () => {
      expect(await database.indexSnapshots.get(snapshotKey('title'))).toMatchObject({
        throughLocalSeq: 2,
      });
    });
    expect(handle.throughLocalSeq).toBe(2);
    expect(handle.index.search('第二版')[0]?.title).toBe('第二版标题');

    database.close();
    await database.delete();
  });

  it('keeps a serialized candidate tied to the sequence it actually contains', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '序列化前', '正文', 'wikitext', 1));
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    let releaseEstimate!: () => void;
    const estimateBlocked = new Promise<void>((resolve) => {
      releaseEstimate = resolve;
    });
    let estimateStarted!: () => void;
    const estimateCalled = new Promise<void>((resolve) => {
      estimateStarted = resolve;
    });
    const cache = new VersionedSearchIndexCache(database, {
      storage: {
        estimate: async () => {
          estimateStarted();
          await estimateBlocked;
          return { usage: 1_000, quota: 1024 * 1024 * 1024 };
        },
      },
    });
    const handle = await cache.restoreOrRebuild('title', analyzer);

    const publishing = cache.publish(handle);
    await estimateCalled;
    await database.pages.put(page(1, '序列化后', '正文', 'wikitext', 2));
    await database.syncState.put({ key: 'local-sequence', value: 2 });
    await cache.refresh(handle);
    releaseEstimate();

    expect(await publishing).toEqual({ status: 'skipped', reason: 'sequence-changed' });
    expect(await database.indexSnapshots.get(snapshotKey('title'))).toBeUndefined();

    database.close();
    await database.delete();
  });

  it('clears only snapshots and suppresses an immediate republish in the same session', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '保留事实', '正文', 'wikitext', 1));
    await database.syncState.bulkPut([
      { key: 'local-sequence', value: 1 },
      { key: 'recent-changes-sync', value: { through: 'keep-me', completedAt: 10 } },
    ]);
    const cache = new VersionedSearchIndexCache(database, { storage: unlimitedStorage() });
    const handle = await cache.restoreOrRebuild('title', analyzer);
    await cache.publish(handle);

    await cache.clear();

    expect(await database.indexSnapshots.count()).toBe(0);
    expect(await database.pages.count()).toBe(1);
    expect((await database.syncState.get('recent-changes-sync'))?.value).toMatchObject({
      through: 'keep-me',
    });
    expect(await cache.publish(handle)).toEqual({
      status: 'skipped',
      reason: 'cleared-this-session',
    });

    database.close();
    await database.delete();
  });

  it('rebuilds locally for an analyzer-engine change and skips publishing without quota', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '兼容键页面', '本地正文', 'wikitext', 1));
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    const first = new VersionedSearchIndexCache(database, { storage: unlimitedStorage() });
    await first.publish(await first.restoreOrRebuild('title', analyzer));
    const changedAnalyzer = new Analyzer(
      { cut, cutForSearch: cut_for_search },
      'different-engine',
    );
    const noQuota = new VersionedSearchIndexCache(database, {
      storage: { estimate: async () => ({ usage: 1_000, quota: 1_000 }) },
    });

    const rebuilt = await noQuota.restoreOrRebuild('title', changedAnalyzer);

    expect(rebuilt.source).toBe('rebuild');
    expect(rebuilt.index.search('兼容键')[0]?.title).toBe('兼容键页面');
    expect(await noQuota.publish(rebuilt)).toEqual({ status: 'skipped', reason: 'quota' });

    database.close();
    await database.delete();
  });
});

function page(
  id: number,
  title: string,
  content: string,
  contentModel: string,
  localSeq: number,
): PageRecord {
  return {
    id,
    title,
    normalizedTitle: analyzer.normalize(title),
    namespace: contentModel === 'Scribunto' ? 828 : 0,
    namespaceName: contentModel === 'Scribunto' ? '模块' : '（主）',
    isRedirect: false,
    localSeq,
    seenInTitleSync: 1,
    revisionId: id * 10,
    contentRevisionId: id * 10,
    contentModel,
    content,
  };
}

function unlimitedStorage(): Pick<StorageManager, 'estimate'> {
  return {
    estimate: vi.fn(async () => ({ usage: 1_000, quota: 1024 * 1024 * 1024 })),
  };
}

async function digest(value: string): Promise<string> {
  const result = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(result)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}
