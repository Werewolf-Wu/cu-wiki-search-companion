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
  it('rebuilds a missing title snapshot without bulk-loading page bodies', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '轻量标题', '不应随标题数组保留的长正文', 'wikitext', 1));
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    const bulkRead = vi
      .spyOn(database.pages, 'toArray')
      .mockRejectedValue(new Error('禁止批量物化完整页面记录'));
    const cache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });

    const rebuilt = await cache.restoreOrRebuild('title', analyzer);

    expect(rebuilt.source).toBe('rebuild');
    expect(rebuilt.index.search('轻量标题')[0]?.title).toBe('轻量标题');
    expect(bulkRead).not.toHaveBeenCalled();
    bulkRead.mockRestore();
    database.close();
    await database.delete();
  });

  it('publishes the snapshot format for the corrected analyzer and extractors', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '新版格式', '正文', 'wikitext', 1));
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    const cache = new VersionedSearchIndexCache(database, { storage: unlimitedStorage() });
    const result = await cache.publish(await cache.restoreOrRebuild('title', analyzer));

    expect(result).toMatchObject({
      status: 'published',
      record: { snapshotFormatVersion: 2 },
    });

    database.close();
    await database.delete();
  });

  it('encodes a serialized snapshot once for both byte length and SHA-256', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '单次编码', '正文', 'wikitext', 1));
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    const cache = new VersionedSearchIndexCache(database, { storage: unlimitedStorage() });
    const handle = await cache.restoreOrRebuild('title', analyzer);
    const encode = vi.spyOn(TextEncoder.prototype, 'encode');

    const result = await cache.publish(handle);

    expect(result.status).toBe('published');
    expect(encode).toHaveBeenCalledTimes(1);
    encode.mockRestore();
    database.close();
    await database.delete();
  });

  it('recovers a missing local sequence from page facts for restore, publish, and inspect', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '页面序列恢复', '正文', 'wikitext', 7));
    const cache = new VersionedSearchIndexCache(database, { storage: unlimitedStorage() });

    const handle = await cache.restoreOrRebuild('title', analyzer);
    const published = await cache.publish(handle);
    const inspection = (await cache.inspect()).find(({ kind }) => kind === 'title');

    expect(handle.throughLocalSeq).toBe(7);
    expect(published).toMatchObject({
      status: 'published',
      record: { throughLocalSeq: 7 },
    });
    expect(inspection).toMatchObject({ status: 'available', throughLocalSeq: 7 });

    database.close();
    await database.delete();
  });

  it('recovers a missing local sequence from file writerSeq and ignores legacy file localSeq', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.fileResources.put({
      ...page(9, 'File:writer-sequence.png', '', 'wikitext', 999),
      writerSeq: 9,
    });
    const cache = new VersionedSearchIndexCache(database, { storage: unlimitedStorage() });

    const handle = await cache.restoreOrRebuild('title', analyzer);
    const published = await cache.publish(handle);

    expect(handle.throughLocalSeq).toBe(9);
    expect(published).toMatchObject({
      status: 'published',
      record: { throughLocalSeq: 9 },
    });
    expect((await cache.inspect()).find(({ kind }) => kind === 'title')).toMatchObject({
      status: 'available',
      throughLocalSeq: 9,
    });

    database.close();
    await database.delete();
  });

  it.each([
    ['string', '7'],
    ['NaN', Number.NaN],
    ['negative number', -1],
  ])('does not use a %s local sequence in snapshot arithmetic', async (_label, value) => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '坏状态回退', '正文', 'wikitext', 7));
    await database.syncState.put({ key: 'local-sequence', value });
    const cache = new VersionedSearchIndexCache(database, { storage: unlimitedStorage() });

    const handle = await cache.restoreOrRebuild('title', analyzer);
    const published = await cache.publish(handle);

    expect(handle.throughLocalSeq).toBe(7);
    expect(published).toMatchObject({
      status: 'published',
      record: { throughLocalSeq: 7 },
    });

    database.close();
    await database.delete();
  });

  it('clears a rejected snapshot message after the rebuilt snapshot is published', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '诊断恢复', '正文', 'wikitext', 1));
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    const firstCache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    await firstCache.publish(await firstCache.restoreOrRebuild('title', analyzer));
    const oldSnapshot = await database.indexSnapshots.get(snapshotKey('title'));
    if (!oldSnapshot) throw new Error('测试快照未发布');
    oldSnapshot.snapshotFormatVersion = 1;
    await database.indexSnapshots.put(oldSnapshot);

    const cache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    const rebuilt = await cache.restoreOrRebuild('title', analyzer);
    expect(rebuilt.source).toBe('rebuild');
    await cache.publish(rebuilt);

    expect((await cache.inspect()).find(({ kind }) => kind === 'title')).toMatchObject({
      status: 'available',
      message: undefined,
    });

    database.close();
    await database.delete();
  });

  it('rebuilds a corrupt title snapshot without bulk-loading page bodies', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '损坏后轻量重建', '不应保留的正文', 'wikitext', 1));
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    const firstCache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    await firstCache.publish(await firstCache.restoreOrRebuild('title', analyzer));
    const corrupt = await database.indexSnapshots.get(snapshotKey('title'));
    if (!corrupt) throw new Error('测试快照未发布');
    corrupt.json = '{invalid';
    corrupt.payloadBytes = new TextEncoder().encode(corrupt.json).byteLength;
    corrupt.sha256 = await digest(corrupt.json);
    await database.indexSnapshots.put(corrupt);
    const bulkRead = vi
      .spyOn(database.pages, 'toArray')
      .mockRejectedValue(new Error('禁止批量物化完整页面记录'));

    const rebuilt = await new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    }).restoreOrRebuild('title', analyzer);

    expect(rebuilt.source).toBe('rebuild');
    expect(rebuilt.index.search('损坏后轻量重建')[0]?.title).toBe('损坏后轻量重建');
    expect(bulkRead).not.toHaveBeenCalled();
    bulkRead.mockRestore();
    database.close();
    await database.delete();
  });

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

  it('parses a title snapshot once on restore and reuses its validated fingerprint in inspect', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '单次解析', '正文', 'wikitext', 1));
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    const publishingCache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    await publishingCache.publish(
      await publishingCache.restoreOrRebuild('title', analyzer),
    );
    const cache = new VersionedSearchIndexCache(database, { storage: unlimitedStorage() });
    const parse = vi.spyOn(JSON, 'parse');

    const restored = await cache.restoreOrRebuild('title', analyzer);

    expect(restored.source).toBe('snapshot');
    expect(parse).toHaveBeenCalledTimes(1);
    parse.mockClear();
    expect((await cache.inspect()).find(({ kind }) => kind === 'title')).toMatchObject({
      status: 'available',
    });
    expect(parse).not.toHaveBeenCalled();

    parse.mockRestore();
    database.close();
    await database.delete();
  });

  it('parses and rejects corrupt JSON during a cold inspection', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '冷检查损坏', '正文', 'wikitext', 1));
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    const publishingCache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    await publishingCache.publish(
      await publishingCache.restoreOrRebuild('title', analyzer),
    );
    const corrupt = await database.indexSnapshots.get(snapshotKey('title'));
    if (!corrupt) throw new Error('测试快照未发布');
    corrupt.json = '{invalid';
    corrupt.payloadBytes = new TextEncoder().encode(corrupt.json).byteLength;
    corrupt.sha256 = await digest(corrupt.json);
    await database.indexSnapshots.put(corrupt);
    const parse = vi.spyOn(JSON, 'parse');

    const inspection = await new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    }).inspect();

    expect(inspection.find(({ kind }) => kind === 'title')).toMatchObject({
      status: 'corrupt',
    });
    expect(parse).toHaveBeenCalledTimes(1);

    parse.mockRestore();
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

  it('keeps a newer snapshot published while an older corrupt restore is failing', async () => {
    const name = `test-${crypto.randomUUID()}`;
    const restoringDatabase = new WikiSearchDatabase(name);
    const publishingDatabase = new WikiSearchDatabase(name);
    await restoringDatabase.open();
    await publishingDatabase.open();
    await restoringDatabase.pages.put(page(1, '第一版', '正文', 'wikitext', 1));
    await restoringDatabase.syncState.put({ key: 'local-sequence', value: 1 });
    const publishingCache = new VersionedSearchIndexCache(publishingDatabase, {
      storage: unlimitedStorage(),
    });
    const publishingHandle = await publishingCache.restoreOrRebuild('title', analyzer);
    await publishingCache.publish(publishingHandle);
    const corrupt = await restoringDatabase.indexSnapshots.get(snapshotKey('title'));
    if (!corrupt) throw new Error('测试快照未发布');
    corrupt.json = '{invalid';
    corrupt.payloadBytes = new TextEncoder().encode(corrupt.json).byteLength;
    corrupt.sha256 = await digest(corrupt.json);
    await restoringDatabase.indexSnapshots.put(corrupt);

    let releaseValidation!: () => void;
    const validationBlocked = new Promise<void>((resolve) => {
      releaseValidation = resolve;
    });
    let validationStarted!: () => void;
    const validationCalled = new Promise<void>((resolve) => {
      validationStarted = resolve;
    });
    const originalDigest = crypto.subtle.digest.bind(crypto.subtle);
    const digestSpy = vi.spyOn(crypto.subtle, 'digest').mockImplementation(async (...args) => {
      validationStarted();
      await validationBlocked;
      return originalDigest(...args);
    });
    const restoringCache = new VersionedSearchIndexCache(restoringDatabase, {
      storage: unlimitedStorage(),
    });
    const restoring = restoringCache.restoreOrRebuild('title', analyzer);
    await validationCalled;
    digestSpy.mockRestore();

    await publishingDatabase.pages.put(page(1, '第二版', '正文', 'wikitext', 2));
    await publishingDatabase.syncState.put({ key: 'local-sequence', value: 2 });
    await publishingCache.refresh(publishingHandle);
    expect((await publishingCache.publish(publishingHandle)).status).toBe('published');
    releaseValidation();
    await restoring;

    const verifier = await new VersionedSearchIndexCache(publishingDatabase, {
      storage: unlimitedStorage(),
    }).restoreOrRebuild('title', analyzer);
    expect(verifier.source).toBe('snapshot');
    expect(verifier.throughLocalSeq).toBe(2);
    expect(verifier.index.search('第二版')[0]?.title).toBe('第二版');

    restoringDatabase.close();
    publishingDatabase.close();
    await restoringDatabase.delete();
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

  it('refreshes through a file-only writer sequence before retrying a debounced publish', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '文件序列前', '正文', 'wikitext', 7));
    const cache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
      publishDelayMs: 1,
    });
    const handle = await cache.restoreOrRebuild('title', analyzer);
    await database.fileResources.put({
      ...page(9, 'File:writer-sequence.png', '', 'wikitext', 999),
      writerSeq: 9,
    });

    cache.schedulePublish(handle);

    await vi.waitFor(async () => {
      expect(await database.indexSnapshots.get(snapshotKey('title'))).toMatchObject({
        throughLocalSeq: 9,
      });
    });
    expect(handle.throughLocalSeq).toBe(9);

    database.close();
    await database.delete();
  });

  it('stops debounced retries when refresh cannot advance a stale handle', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '不可倒退', '正文', 'wikitext', 7));
    await database.syncState.put({ key: 'local-sequence', value: 7 });
    const cache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
      publishDelayMs: 1,
    });
    const handle = await cache.restoreOrRebuild('title', analyzer);
    await database.syncState.put({ key: 'local-sequence', value: 6 });
    const publish = vi.spyOn(cache, 'publish');

    cache.schedulePublish(handle);
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(handle.throughLocalSeq).toBe(7);
    expect(publish).toHaveBeenCalledTimes(1);
    expect(await database.indexSnapshots.get(snapshotKey('title'))).toBeUndefined();

    await cache.clear();
    database.close();
    await database.delete();
  });

  it('serializes concurrent refreshes of one handle so its version cannot move backward', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, 'initialPage', '正文', 'wikitext', 1));
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    const cache = new VersionedSearchIndexCache(database, { storage: unlimitedStorage() });
    const handle = await cache.restoreOrRebuild('title', analyzer);
    const updateAsync = handle.index.updateAsync.bind(handle.index);
    let updateCall = 0;
    let firstUpdateStarted!: () => void;
    const firstUpdateCalled = new Promise<void>((resolve) => {
      firstUpdateStarted = resolve;
    });
    let releaseFirstUpdate!: () => void;
    const firstUpdateBlocked = new Promise<void>((resolve) => {
      releaseFirstUpdate = resolve;
    });
    handle.index.updateAsync = async (pages, batchSize) => {
      updateCall += 1;
      if (updateCall === 1) {
        firstUpdateStarted();
        await firstUpdateBlocked;
      }
      await updateAsync(pages, batchSize);
    };

    await database.pages.put(page(1, 'obsoletePayload', '正文', 'wikitext', 2));
    await database.syncState.put({ key: 'local-sequence', value: 2 });
    const olderRefresh = cache.refresh(handle);
    await firstUpdateCalled;
    await database.pages.put(page(1, 'currentSignal', '正文', 'wikitext', 3));
    await database.syncState.put({ key: 'local-sequence', value: 3 });
    const newerRefresh = cache.refresh(handle);
    setTimeout(releaseFirstUpdate, 25);

    await Promise.all([olderRefresh, newerRefresh]);

    expect(handle.throughLocalSeq).toBe(3);
    expect(handle.index.search('currentSignal')[0]?.title).toBe('currentSignal');
    expect(handle.index.search('obsoletePayload')).toEqual([]);

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

  it('does not let an already-started publish recreate a snapshot after clear returns', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '清除后仍可搜索', '正文', 'wikitext', 1));
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    const initialCache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    await initialCache.publish(await initialCache.restoreOrRebuild('title', analyzer));
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
    expect(handle.source).toBe('snapshot');
    await database.pages.put(page(1, '清除后仍可搜索', '更新正文', 'wikitext', 2));
    await database.syncState.put({ key: 'local-sequence', value: 2 });
    await cache.refresh(handle);

    const publishing = cache.publish(handle);
    await estimateCalled;
    await cache.clear();
    releaseEstimate();

    expect(await publishing).toEqual({
      status: 'skipped',
      reason: 'cleared-this-session',
    });
    expect(await database.indexSnapshots.get(snapshotKey('title'))).toBeUndefined();
    expect((await cache.inspect()).map(({ kind, status }) => ({ kind, status }))).toEqual([
      { kind: 'title', status: 'missing' },
      { kind: 'content', status: 'missing' },
      { kind: 'lua', status: 'missing' },
    ]);
    expect(handle.index.search('清除后仍可搜索')[0]?.title).toBe('清除后仍可搜索');

    database.close();
    await database.delete();
  });

  it('fences an already-started publish from another cache instance after clear', async () => {
    const name = `test-${crypto.randomUUID()}`;
    const clearingDatabase = new WikiSearchDatabase(name);
    const publishingDatabase = new WikiSearchDatabase(name);
    await clearingDatabase.open();
    await publishingDatabase.open();
    await clearingDatabase.pages.put(page(1, '跨标签清理', '正文', 'wikitext', 1));
    await clearingDatabase.syncState.put({ key: 'local-sequence', value: 1 });
    let releaseEstimate!: () => void;
    const estimateBlocked = new Promise<void>((resolve) => {
      releaseEstimate = resolve;
    });
    let estimateStarted!: () => void;
    const estimateCalled = new Promise<void>((resolve) => {
      estimateStarted = resolve;
    });
    const clearingCache = new VersionedSearchIndexCache(clearingDatabase, {
      storage: unlimitedStorage(),
    });
    const publishingCache = new VersionedSearchIndexCache(publishingDatabase, {
      storage: {
        estimate: async () => {
          estimateStarted();
          await estimateBlocked;
          return { usage: 1_000, quota: 1024 * 1024 * 1024 };
        },
      },
    });
    const staleHandle = await publishingCache.restoreOrRebuild('title', analyzer);

    const publishing = publishingCache.publish(staleHandle);
    await estimateCalled;
    await clearingCache.clear();
    releaseEstimate();

    expect(await publishing).toEqual({
      status: 'skipped',
      reason: 'cleared-this-session',
    });
    expect(await clearingDatabase.indexSnapshots.count()).toBe(0);

    clearingDatabase.close();
    publishingDatabase.close();
    await clearingDatabase.delete();
  });

  it('lets rebuilt handles publish after clear while rejecting old handles at the same sequence', async () => {
    const name = `test-${crypto.randomUUID()}`;
    const rebuildingDatabase = new WikiSearchDatabase(name);
    const staleDatabase = new WikiSearchDatabase(name);
    await rebuildingDatabase.open();
    await staleDatabase.open();
    await rebuildingDatabase.pages.put(page(1, '代际重建', '正文', 'wikitext', 1));
    await rebuildingDatabase.syncState.put({ key: 'local-sequence', value: 1 });
    const rebuildingCache = new VersionedSearchIndexCache(rebuildingDatabase, {
      storage: unlimitedStorage(),
      now: () => 222,
    });
    const staleCache = new VersionedSearchIndexCache(staleDatabase, {
      storage: unlimitedStorage(),
      now: () => 111,
    });
    const staleHandle = await staleCache.restoreOrRebuild('title', analyzer);

    await rebuildingCache.clear();
    rebuildingCache.allowPublishing();
    const rebuiltHandle = await rebuildingCache.restoreOrRebuild('title', analyzer);

    expect(await staleCache.publish(staleHandle)).toEqual({
      status: 'skipped',
      reason: 'cleared-this-session',
    });
    expect(await rebuildingCache.publish(rebuiltHandle)).toMatchObject({
      status: 'published',
      record: { createdAt: 222 },
    });
    expect(await rebuildingDatabase.indexSnapshots.get(snapshotKey('title'))).toMatchObject({
      createdAt: 222,
    });

    rebuildingDatabase.close();
    staleDatabase.close();
    await rebuildingDatabase.delete();
  });

  it('returns not-newer before checking quota for an already-current snapshot', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '无需重写', '正文', 'wikitext', 1));
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    const initialCache = new VersionedSearchIndexCache(database, {
      storage: unlimitedStorage(),
    });
    await initialCache.publish(await initialCache.restoreOrRebuild('title', analyzer));
    const estimate = vi.fn(async () => ({ usage: 1_000, quota: 1_000 }));
    const restoredCache = new VersionedSearchIndexCache(database, {
      storage: { estimate },
    });
    const restored = await restoredCache.restoreOrRebuild('title', analyzer);

    expect(await restoredCache.publish(restored)).toEqual({
      status: 'skipped',
      reason: 'not-newer',
    });
    expect(estimate).not.toHaveBeenCalled();

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
