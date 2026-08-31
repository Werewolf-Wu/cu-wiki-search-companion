// SPDX-License-Identifier: MPL-2.0
import 'fake-indexeddb/auto';

import { cut, cut_for_search } from 'jieba-wasm/node';

import { Analyzer } from '../src/analyzer/analyzer';
import { WikiSearchDatabase } from '../src/storage/database';
import { reconcileWikiMirror } from '../src/sync/reconciliation-sync';
import { WikiApi } from '../src/sync/wiki-api';
import type { PageRecord, TitleSyncState } from '../src/types';

const analyzer = new Analyzer({ cut, cutForSearch: cut_for_search });
const now = Date.parse('2026-08-31T06:00:00Z');

describe('full mirror reconciliation', () => {
  it('repairs a missing local page, closes a remote deletion, and repairs content jobs', async () => {
    const calls: URL[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://casualtiesunknown.huijiwiki.com');
      calls.push(url);
      if (url.searchParams.get('meta') === 'siteinfo') {
        return json({
          curtimestamp: '2026-08-31T06:00:05Z',
          query: {
            namespaces: {
              0: { id: 0, name: '' },
              6: { id: 6, name: '文件' },
            },
          },
        });
      }
      return json({
        query: {
          pages: [
            {
              pageid: 2,
              ns: 0,
              title: '对账补回页',
              lastrevid: 20,
              contentmodel: 'wikitext',
            },
            {
              pageid: 3,
              ns: 0,
              title: '已有完整页',
              lastrevid: 30,
              contentmodel: 'wikitext',
            },
          ],
        },
      });
    });
    const database = await databaseWithBaseline([
      page({ id: 1, title: '远端已删除页', revisionId: 10, localSeq: 1 }),
      page({
        id: 3,
        title: '已有完整页',
        revisionId: 30,
        content: '仍然有效的正文',
        contentRevisionId: 30,
        localSeq: 2,
      }),
    ]);
    await database.jobs.bulkAdd([
      { type: 'wikitext-content', pageId: 1, status: 'done', targetRevisionId: 10 },
      { type: 'wikitext-content', pageId: 999, status: 'failed', targetRevisionId: 1 },
    ]);
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    const result = await reconcileWikiMirror(database, api, analyzer, {
      now: () => now,
      requestIntervalMs: 0,
    });

    expect(result).toMatchObject({
      status: 'complete',
      reason: 'scheduled',
      pagesFetched: 2,
      pagesChanged: 2,
      filesChanged: false,
    });
    expect(await database.pages.get(1)).toMatchObject({
      deleted: true,
      content: undefined,
      contentRevisionId: undefined,
    });
    expect(await database.pages.get(2)).toMatchObject({
      title: '对账补回页',
      revisionId: 20,
      deleted: false,
    });
    expect(await database.pages.get(3)).toMatchObject({
      content: '仍然有效的正文',
      contentRevisionId: 30,
      deleted: false,
    });
    const jobs = await database.jobs.orderBy('pageId').toArray();
    expect(jobs).toEqual([
      expect.objectContaining({
        pageId: 2,
        status: 'pending',
        targetRevisionId: 20,
      }),
      expect.objectContaining({
        pageId: 3,
        status: 'done',
        targetRevisionId: 30,
      }),
    ]);
    expect((await database.syncState.get('recent-changes-sync'))?.value).toMatchObject({
      through: '2026-08-31T06:00:05Z',
    });
    expect(
      calls.every(
        (url) =>
          url.searchParams.get('assert') === 'user' &&
          url.searchParams.get('maxlag') === '5',
      ),
    ).toBe(true);
    const allPagesCall = calls.find((url) => url.searchParams.has('gapnamespace'));
    expect(allPagesCall?.searchParams.get('gaplimit')).toBe('500');
    expect(allPagesCall?.searchParams.get('prop')).toBe('info');
    expect(calls.some((url) => url.searchParams.get('gapnamespace') === '6')).toBe(false);

    await destroy(database);
  });

  it('stays idle inside 24 hours but reconciles an explicit long RecentChanges gap', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://casualtiesunknown.huijiwiki.com');
      if (url.searchParams.get('meta') === 'siteinfo') {
        return json({
          curtimestamp: '2026-08-31T06:00:05Z',
          query: { namespaces: { 0: { id: 0, name: '' } } },
        });
      }
      return json({ query: { pages: [] } });
    });
    const database = await databaseWithBaseline([], {
      completedAt: now - 60 * 60 * 1_000,
      recentThrough: '2026-08-31T05:00:00Z',
    });
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    const notDue = await reconcileWikiMirror(database, api, analyzer, {
      now: () => now,
      requestIntervalMs: 0,
    });
    expect(notDue.status).toBe('not-due');
    expect(fetcher).not.toHaveBeenCalled();

    await database.syncState.put({
      key: 'recent-changes-sync',
      value: {
        through: '2026-07-17T06:00:00Z',
        completedAt: now - 45 * 24 * 60 * 60 * 1_000,
        recentChanges: [],
      },
    });
    const gapRepair = await reconcileWikiMirror(database, api, analyzer, {
      now: () => now,
      requestIntervalMs: 0,
    });

    expect(gapRepair).toMatchObject({ status: 'complete', reason: 'rc-gap' });
    expect(fetcher).toHaveBeenCalledTimes(2);

    await destroy(database);
  });

  it('resumes from the last committed allpages cursor after an interrupted batch', async () => {
    let failSecondBatch = true;
    const calls: URL[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://casualtiesunknown.huijiwiki.com');
      calls.push(url);
      if (url.searchParams.get('meta') === 'siteinfo') {
        return json({
          curtimestamp: '2026-08-31T06:00:05Z',
          query: { namespaces: { 0: { id: 0, name: '' } } },
        });
      }
      if (!url.searchParams.has('gapcontinue')) {
        return json({
          continue: { gapcontinue: '第二批' },
          query: {
            pages: [
              {
                pageid: 10,
                ns: 0,
                title: '第一批页',
                lastrevid: 10,
                contentmodel: 'wikitext',
              },
            ],
          },
        });
      }
      if (failSecondBatch) {
        failSecondBatch = false;
        throw new TypeError('模拟断网');
      }
      return json({
        query: {
          pages: [
            {
              pageid: 11,
              ns: 0,
              title: '第二批页',
              lastrevid: 11,
              contentmodel: 'wikitext',
            },
          ],
        },
      });
    });
    const database = await databaseWithBaseline([]);
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    await expect(
      reconcileWikiMirror(database, api, analyzer, {
        now: () => now,
        requestIntervalMs: 0,
      }),
    ).rejects.toThrow('模拟断网');
    expect(await database.pages.get(10)).toMatchObject({ title: '第一批页' });
    expect((await database.syncState.get('reconciliation-sync'))?.value).toMatchObject({
      status: 'failed',
      gapcontinue: '第二批',
      pagesFetched: 1,
    });

    const resumed = await reconcileWikiMirror(database, api, analyzer, {
      now: () => now + 1_000,
      requestIntervalMs: 0,
    });

    expect(resumed).toMatchObject({ status: 'complete', pagesFetched: 2 });
    expect(await database.pages.get(11)).toMatchObject({ title: '第二批页' });
    expect(calls.filter((url) => url.searchParams.get('meta') === 'siteinfo')).toHaveLength(1);
    expect(calls.filter((url) => !url.searchParams.has('gapcontinue'))).toHaveLength(2);

    await destroy(database);
  });

  it('does not resurrect or prune pages written after the reconciliation fence', async () => {
    const database = await databaseWithBaseline([
      page({ id: 1, title: '扫描期间被删除', revisionId: 10, localSeq: 2 }),
    ]);
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://casualtiesunknown.huijiwiki.com');
      if (url.searchParams.get('meta') === 'siteinfo') {
        return json({
          curtimestamp: '2026-08-31T06:00:05Z',
          query: { namespaces: { 0: { id: 0, name: '' } } },
        });
      }
      await database.transaction('rw', database.pages, database.syncState, async () => {
        const deleted = await database.pages.get(1);
        if (!deleted) throw new Error('测试基线缺页');
        await database.pages.bulkPut([
          {
            ...deleted,
            deleted: true,
            content: undefined,
            contentRevisionId: undefined,
            localSeq: 3,
          },
          page({ id: 9, title: '扫描期间新建', revisionId: 90, localSeq: 4 }),
        ]);
        await database.syncState.bulkPut([
          { key: 'local-sequence', value: 4 },
          {
            key: 'recent-changes-sync',
            value: {
              through: '2026-08-31T06:00:10Z',
              completedAt: now + 10_000,
              recentChanges: [],
            },
          },
        ]);
      });
      return json({
        query: {
          pages: [
            {
              pageid: 1,
              ns: 0,
              title: '扫描期间被删除',
              lastrevid: 10,
              contentmodel: 'wikitext',
            },
          ],
        },
      });
    });
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    await reconcileWikiMirror(database, api, analyzer, {
      now: () => now,
      requestIntervalMs: 0,
    });

    expect(await database.pages.get(1)).toMatchObject({ deleted: true, localSeq: 3 });
    expect(await database.pages.get(9)).toMatchObject({ deleted: false, localSeq: 4 });
    expect((await database.syncState.get('recent-changes-sync'))?.value).toMatchObject({
      through: '2026-08-31T06:00:10Z',
    });

    await destroy(database);
  });

  it('does not roll pages or files back when allpages returns an older revision', async () => {
    const database = await databaseWithBaseline([
      page({
        id: 20,
        title: '本地较新页面',
        revisionId: 20,
        contentRevisionId: 20,
        content: '保留本地较新正文',
        localSeq: 2,
      }),
    ]);
    await database.fileResources.put(
      page({
        id: 6001,
        title: '文件:本地较新.png',
        namespace: 6,
        namespaceName: '文件',
        revisionId: 20,
        localSeq: 2,
      }),
    );
    await database.syncState.put({
      key: 'file-resource-sync',
      value: {
        status: 'complete',
        namespaceIds: [6],
        namespaceNames: { 6: '文件' },
        namespaceIndex: 1,
        generation: 1,
        pagesFetched: 1,
        startedAt: now - 48 * 60 * 60 * 1_000,
        completedAt: now - 48 * 60 * 60 * 1_000,
      } satisfies TitleSyncState,
    });
    const api = new WikiApi({
      fetcher: vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'https://casualtiesunknown.huijiwiki.com');
        if (url.searchParams.get('meta') === 'siteinfo') {
          return json({
            curtimestamp: '2026-08-31T06:00:05Z',
            query: {
              namespaces: {
                0: { id: 0, name: '' },
                6: { id: 6, name: '文件' },
              },
            },
          });
        }
        const isFile = url.searchParams.get('gapnamespace') === '6';
        return json({
          query: {
            pages: [
              {
                pageid: isFile ? 6001 : 20,
                ns: isFile ? 6 : 0,
                title: isFile ? '文件:远端旧标题.png' : '远端旧标题',
                lastrevid: 19,
                contentmodel: 'wikitext',
              },
            ],
          },
        });
      }) as typeof fetch,
      retries: 0,
    });

    const result = await reconcileWikiMirror(database, api, analyzer, {
      now: () => now,
      requestIntervalMs: 0,
    });

    expect(result).toMatchObject({ pagesChanged: 0, filesChanged: false });
    expect(await database.pages.get(20)).toMatchObject({
      title: '本地较新页面',
      revisionId: 20,
      contentRevisionId: 20,
      content: '保留本地较新正文',
      seenInTitleSync: now,
    });
    expect(await database.fileResources.get(6001)).toMatchObject({
      title: '文件:本地较新.png',
      revisionId: 20,
      seenInTitleSync: now,
    });

    await destroy(database);
  });

  it('reconciles an initialized file cache without treating legacy revision-based localSeq as a concurrent write', async () => {
    const database = await databaseWithBaseline([]);
    await database.fileResources.put(
      page({
        id: 6001,
        title: '文件:远端已删除.png',
        namespace: 6,
        namespaceName: '文件',
        revisionId: 10_000,
        localSeq: 10_000,
      }),
    );
    await database.syncState.put({
      key: 'file-resource-sync',
      value: {
        status: 'complete',
        namespaceIds: [6],
        namespaceNames: { 6: '文件' },
        namespaceIndex: 1,
        generation: 1,
        pagesFetched: 1,
        startedAt: now - 48 * 60 * 60 * 1_000,
        completedAt: now - 48 * 60 * 60 * 1_000,
      } satisfies TitleSyncState,
    });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://casualtiesunknown.huijiwiki.com');
      if (url.searchParams.get('meta') === 'siteinfo') {
        return json({
          curtimestamp: '2026-08-31T06:00:05Z',
          query: {
            namespaces: {
              0: { id: 0, name: '' },
              6: { id: 6, name: '文件' },
            },
          },
        });
      }
      if (url.searchParams.get('gapnamespace') === '6') {
        return json({
          query: {
            pages: [
              {
                pageid: 6002,
                ns: 6,
                title: '文件:对账补回.png',
                lastrevid: 60,
                contentmodel: 'wikitext',
              },
            ],
          },
        });
      }
      return json({ query: { pages: [] } });
    });
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    const result = await reconcileWikiMirror(database, api, analyzer, {
      now: () => now,
      requestIntervalMs: 0,
    });

    expect(result).toMatchObject({ status: 'complete', filesChanged: true });
    expect(await database.fileResources.get(6001)).toMatchObject({ deleted: true });
    expect(await database.fileResources.get(6002)).toMatchObject({
      deleted: false,
      title: '文件:对账补回.png',
    });
    expect((await database.syncState.get('recent-changes-sync'))?.value).toMatchObject({
      fileChangeSeq: expect.any(Number),
    });

    await destroy(database);
  });

  it('invalidates derived Data codes and removes stale content when lastrevid changes', async () => {
    const database = await databaseWithBaseline([
      page({
        id: 350,
        title: 'Data:Block/bricks.json',
        namespace: 3500,
        namespaceName: 'Data',
        revisionId: 40,
        contentModel: 'BSON',
        content: '{"stats":{"health":600}}',
        contentRevisionId: 40,
        localSeq: 2,
      }),
    ]);
    await database.jobs.add({
      type: 'wikitext-content',
      pageId: 350,
      status: 'done',
      targetRevisionId: 40,
    });
    await database.syncState.put({
      key: 'data-code-sync',
      value: { syncedAt: now, count: 655, indexVersion: 2 },
    });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://casualtiesunknown.huijiwiki.com');
      if (url.searchParams.get('meta') === 'siteinfo') {
        return json({
          curtimestamp: '2026-08-31T06:00:05Z',
          query: { namespaces: { 3500: { id: 3500, name: 'Data' } } },
        });
      }
      return json({
        query: {
          pages: [
            {
              pageid: 350,
              ns: 3500,
              title: 'Data:Block/bricks.json',
              lastrevid: 41,
              contentmodel: 'BSON',
            },
          ],
        },
      });
    });
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    const result = await reconcileWikiMirror(database, api, analyzer, {
      now: () => now,
      requestIntervalMs: 0,
    });

    expect(result).toMatchObject({
      status: 'complete',
      pagesChanged: 1,
      dataCodesInvalidated: true,
    });
    expect(await database.pages.get(350)).toMatchObject({
      revisionId: 41,
      content: undefined,
      contentRevisionId: undefined,
    });
    expect((await database.jobs.where('pageId').equals(350).first())).toMatchObject({
      status: 'pending',
      targetRevisionId: 41,
    });
    expect((await database.syncState.get('data-code-sync'))?.value).toMatchObject({
      syncedAt: 0,
    });

    await destroy(database);
  });
});

async function databaseWithBaseline(
  pages: PageRecord[],
  options: { completedAt?: number; recentThrough?: string } = {},
): Promise<WikiSearchDatabase> {
  const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
  await database.open();
  await database.pages.bulkPut(pages);
  const titleState: TitleSyncState = {
    status: 'complete',
    namespaceIds: [0],
    namespaceNames: { 0: '（主）' },
    namespaceIndex: 1,
    generation: 1,
    pagesFetched: pages.length,
    startedAt: now - 48 * 60 * 60 * 1_000,
    completedAt: options.completedAt ?? now - 48 * 60 * 60 * 1_000,
  };
  await database.syncState.bulkPut([
    { key: 'title-sync', value: titleState },
    { key: 'local-sequence', value: 2 },
    {
      key: 'recent-changes-sync',
      value: {
        through: options.recentThrough ?? '2026-08-29T06:00:00Z',
        completedAt: now - 48 * 60 * 60 * 1_000,
        recentChanges: [],
      },
    },
  ]);
  return database;
}

function page(overrides: Partial<PageRecord> = {}): PageRecord {
  const title = overrides.title ?? '测试页';
  return {
    id: overrides.id ?? 1,
    title,
    normalizedTitle: analyzer.normalize(title),
    namespace: 0,
    namespaceName: '（主）',
    isRedirect: false,
    localSeq: 1,
    seenInTitleSync: 1,
    deleted: false,
    revisionId: 1,
    contentModel: 'wikitext',
    ...overrides,
  };
}

async function destroy(database: WikiSearchDatabase): Promise<void> {
  database.close();
  await database.delete();
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
