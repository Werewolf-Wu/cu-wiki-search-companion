// SPDX-License-Identifier: MPL-2.0
import 'fake-indexeddb/auto';

import { cut, cut_for_search } from 'jieba-wasm/node';

import { Analyzer } from '../src/analyzer/analyzer';
import { LinearTitleIndex } from '../src/search/title-index';
import { WikiSearchDatabase } from '../src/storage/database';
import { syncFileResources } from '../src/sync/file-resource-sync';
import { WikiApi } from '../src/sync/wiki-api';

const analyzer = new Analyzer({ cut, cutForSearch: cut_for_search });

describe('file resource search', () => {
  it('syncs namespace 6 separately, resumes from cache, and keeps normal titles clean', async () => {
    const calls: URL[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://casualtiesunknown.huijiwiki.com');
      calls.push(url);
      if (!url.searchParams.has('gapcontinue')) {
        return json({
          continue: { gapcontinue: 'Item morphine.png' },
          query: {
            pages: [
              {
                pageid: 6001,
                ns: 6,
                title: '文件:Block footstep mushroombody 2.ogg',
                lastrevid: 61,
                contentmodel: 'wikitext',
              },
            ],
          },
        });
      }
      return json({
        query: {
          pages: [
            {
              pageid: 6002,
              ns: 6,
              title: '文件:Item morphine.png',
              lastrevid: 62,
              contentmodel: 'wikitext',
            },
          ],
        },
      });
    });
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put({
      id: 1,
      title: '吗啡',
      normalizedTitle: analyzer.normalize('吗啡'),
      namespace: 0,
      namespaceName: '（主）',
      isRedirect: false,
      localSeq: 1,
      seenInTitleSync: 1,
    });
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    const first = await syncFileResources(database, api, analyzer, { requestIntervalMs: 0 });
    const callsAfterFirstSync = calls.length;
    const second = await syncFileResources(database, api, analyzer, { requestIntervalMs: 0 });
    const normalIndex = new LinearTitleIndex(analyzer, await database.pages.toArray());
    const fileIndex = new LinearTitleIndex(analyzer, await database.fileResources.toArray());

    expect(first.status).toBe('complete');
    expect(first.pagesFetched).toBe(2);
    expect(second.completedAt).toBe(first.completedAt);
    expect(calls).toHaveLength(callsAfterFirstSync);
    expect(
      calls.every(
        (url) =>
          url.searchParams.get('gapnamespace') === '6' &&
          url.searchParams.get('gaplimit') === '500' &&
          url.searchParams.get('maxlag') === '5',
      ),
    ).toBe(true);
    expect(await database.pages.count()).toBe(1);
    expect(await database.fileResources.count()).toBe(2);
    expect((await database.fileResources.get(6001))?.writerSeq).toBe(2);
    expect((await database.fileResources.get(6002))?.writerSeq).toBe(3);
    expect((await database.syncState.get('local-sequence'))?.value).toBe(3);
    expect((await database.syncState.get('recent-changes-sync'))?.value).toMatchObject({
      fileChangeSeq: 3,
    });
    expect(normalIndex.search('morphine')).toEqual([]);
    expect(fileIndex.search('morphine')[0]?.title).toBe('文件:Item morphine.png');

    database.close();
    await database.delete();
  });

  it('does not replace a newer file row with an older allpages result', async () => {
    const fetcher = vi.fn(async () =>
      json({
        query: {
          pages: [
            {
              pageid: 6001,
              ns: 6,
              title: '文件:竞态.png',
              lastrevid: 60,
              contentmodel: 'wikitext',
            },
          ],
        },
      }),
    );
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.fileResources.put({
      id: 6001,
      title: '文件:竞态.png',
      normalizedTitle: analyzer.normalize('文件:竞态.png'),
      namespace: 6,
      namespaceName: '文件',
      isRedirect: false,
      localSeq: 70,
      seenInTitleSync: 0,
      deleted: false,
      revisionId: 70,
      contentModel: 'wikitext',
    });
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    await syncFileResources(database, api, analyzer, { requestIntervalMs: 0 });

    expect(await database.fileResources.get(6001)).toMatchObject({
      revisionId: 70,
      deleted: false,
    });

    database.close();
    await database.delete();
  });

  it('persists file changes without resetting the RecentChanges cursor or markers', async () => {
    const fetcher = vi.fn(async () =>
      json({
        query: {
          pages: [
            {
              pageid: 6001,
              ns: 6,
              title: '文件:新资源.png',
              lastrevid: 61,
              contentmodel: 'wikitext',
            },
          ],
        },
      }),
    );
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    const recentState = {
      through: '2026-08-31T03:10:00Z',
      completedAt: 100,
      recentChanges: [{ rcid: 41, timestamp: '2026-08-31T03:09:00Z' }],
      fileChangeSeq: 4,
    };
    await database.syncState.bulkPut([
      { key: 'local-sequence', value: 5 },
      { key: 'recent-changes-sync', value: recentState },
    ]);
    await database.fileResources.put({
      id: 6000,
      title: '文件:过期资源.png',
      normalizedTitle: analyzer.normalize('文件:过期资源.png'),
      namespace: 6,
      namespaceName: '文件',
      isRedirect: false,
      localSeq: 60,
      writerSeq: 5,
      seenInTitleSync: 1,
      deleted: false,
      revisionId: 60,
      contentModel: 'wikitext',
    });
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    await syncFileResources(database, api, analyzer, { requestIntervalMs: 0 });

    expect((await database.syncState.get('recent-changes-sync'))?.value).toEqual({
      ...recentState,
      fileChangeSeq: 7,
    });
    expect((await database.fileResources.get(6001))?.writerSeq).toBe(6);
    expect(await database.fileResources.get(6000)).toBeUndefined();

    database.close();
    await database.delete();
  });

  it('resumes a failed file scan from its saved continuation', async () => {
    const requests: URL[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://casualtiesunknown.huijiwiki.com');
      requests.push(url);
      if (!url.searchParams.has('gapcontinue')) {
        return json({
          continue: { gapcontinue: '文件:第二页.png' },
          query: {
            pages: [
              {
                pageid: 6001,
                ns: 6,
                title: '文件:已完成首页.png',
                lastrevid: 61,
                contentmodel: 'wikitext',
              },
            ],
          },
        });
      }
      return json({
        query: {
          pages: [
            {
              pageid: 6002,
              ns: 6,
              title: '文件:第二页.png',
              lastrevid: 62,
              contentmodel: 'wikitext',
            },
          ],
        },
      });
    });
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.fileResources.put({
      id: 6001,
      title: '文件:已完成首页.png',
      normalizedTitle: analyzer.normalize('文件:已完成首页.png'),
      namespace: 6,
      namespaceName: '文件',
      isRedirect: false,
      localSeq: 61,
      seenInTitleSync: 100,
      deleted: false,
      revisionId: 61,
      contentModel: 'wikitext',
    });
    await database.syncState.bulkPut([
      { key: 'local-sequence', value: 1 },
      {
        key: 'file-resource-sync',
        value: {
          status: 'failed',
          namespaceIds: [6],
          namespaceNames: { 6: '文件' },
          namespaceIndex: 0,
          apcontinue: '文件:第二页.png',
          generation: 100,
          pagesFetched: 1,
          startedAt: 100,
          error: '断网',
        },
      },
    ]);
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    const result = await syncFileResources(database, api, analyzer, {
      requestIntervalMs: 0,
    });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.searchParams.get('gapcontinue')).toBe('文件:第二页.png');
    expect(result).toMatchObject({
      status: 'complete',
      generation: 100,
      pagesFetched: 2,
    });
    expect(await database.fileResources.get(6001)).toMatchObject({ deleted: false });
    expect(await database.fileResources.get(6002)).toMatchObject({
      title: '文件:第二页.png',
    });

    requests.length = 0;
    const forced = await syncFileResources(database, api, analyzer, {
      force: true,
      requestIntervalMs: 0,
    });
    expect(requests[0]?.searchParams.has('gapcontinue')).toBe(false);
    expect(forced.generation).not.toBe(100);

    database.close();
    await database.delete();
  });
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
