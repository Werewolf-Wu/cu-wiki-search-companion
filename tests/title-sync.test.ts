// SPDX-License-Identifier: MPL-2.0
import 'fake-indexeddb/auto';

import { cut, cut_for_search } from 'jieba-wasm/node';

import { Analyzer } from '../src/analyzer/analyzer';
import { WikiSearchDatabase } from '../src/storage/database';
import { syncTitles } from '../src/sync/title-sync';
import { WikiApi } from '../src/sync/wiki-api';
import { abortTransactionAfterCallback } from './transaction-abort';

const analyzer = new Analyzer({ cut, cutForSearch: cut_for_search });

describe('title sync', () => {
  it('retries a title batch whose transaction aborts during commit', async () => {
    const calls: URL[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://casualtiesunknown.huijiwiki.com');
      calls.push(url);
      if (url.searchParams.get('meta') === 'siteinfo') {
        return json({ query: { namespaces: { 0: { id: 0, name: '' } } } });
      }
      if (url.searchParams.get('gapcontinue') === '第二批') {
        return json({
          query: {
            pages: [
              {
                pageid: 2,
                ns: 0,
                title: '第二批标题',
                lastrevid: 2,
                contentmodel: 'wikitext',
              },
            ],
          },
        });
      }
      return json({
        continue: { gapcontinue: '第二批' },
        query: {
          pages: [
            {
              pageid: 1,
              ns: 0,
              title: '必须重试的首批标题',
              lastrevid: 1,
              contentmodel: 'wikitext',
            },
          ],
        },
      });
    });
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });
    abortTransactionAfterCallback(database);

    await expect(
      syncTitles(database, api, analyzer, { requestIntervalMs: 0 }),
    ).rejects.toBeDefined();

    expect(await database.pages.get(1)).toBeUndefined();
    expect((await database.syncState.get('title-sync'))?.value).toMatchObject({
      status: 'failed',
      namespaceIndex: 0,
      pagesFetched: 0,
    });
    expect((await database.syncState.get('title-sync'))?.value).not.toHaveProperty(
      'apcontinue',
    );

    const resumed = await syncTitles(database, api, analyzer, { requestIntervalMs: 0 });

    expect(resumed).toMatchObject({ status: 'complete', pagesFetched: 2 });
    expect(await database.pages.get(1)).toMatchObject({
      title: '必须重试的首批标题',
      deleted: false,
    });
    expect(await database.pages.get(2)).toMatchObject({
      title: '第二批标题',
      deleted: false,
    });
    expect(
      calls.filter(
        (url) => url.searchParams.has('gapnamespace') && !url.searchParams.has('gapcontinue'),
      ),
    ).toHaveLength(2);

    database.close();
    await database.delete();
  });

  it('retries title pruning when the completion transaction aborts', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://casualtiesunknown.huijiwiki.com');
      if (url.searchParams.get('meta') === 'siteinfo') {
        return json({ query: { namespaces: { 0: { id: 0, name: '' } } } });
      }
      return json({ query: { pages: [] } });
    });
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put({
      id: 1,
      title: '远端已经删除的旧标题',
      normalizedTitle: analyzer.normalize('远端已经删除的旧标题'),
      namespace: 0,
      namespaceName: '（主）',
      isRedirect: false,
      localSeq: 1,
      seenInTitleSync: 1,
      deleted: false,
      revisionId: 1,
      contentModel: 'wikitext',
    });
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });
    abortTransactionAfterCallback(database, 2);

    await expect(
      syncTitles(database, api, analyzer, { requestIntervalMs: 0 }),
    ).rejects.toBeDefined();

    expect(await database.pages.get(1)).toMatchObject({ deleted: false, localSeq: 1 });
    expect((await database.syncState.get('title-sync'))?.value).toMatchObject({
      status: 'failed',
      namespaceIndex: 1,
      pagesFetched: 0,
    });
    expect((await database.syncState.get('title-sync'))?.value).not.toHaveProperty(
      'completedAt',
    );

    const resumed = await syncTitles(database, api, analyzer, { requestIntervalMs: 0 });

    expect(resumed).toMatchObject({ status: 'complete', namespaceIndex: 1 });
    expect(await database.pages.get(1)).toMatchObject({ deleted: true, localSeq: 2 });

    database.close();
    await database.delete();
  });

  it('persists cursor progress and avoids duplicate fetches after completion', async () => {
    const calls: URL[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://casualtiesunknown.huijiwiki.com');
      calls.push(url);
      const parameters = url.searchParams;
      if (parameters.get('meta') === 'siteinfo') {
        return json({
          query: {
            namespaces: {
              0: { id: 0, name: '' },
              6: { id: 6, name: '文件' },
              10: { id: 10, name: '模板' },
            },
          },
        });
      }
      if (parameters.get('gapnamespace') === '0' && !parameters.has('gapcontinue')) {
        return json({
          continue: { gapcontinue: '下一页' },
          query: {
            pages: [
              { pageid: 1, ns: 0, title: '12号鹿弹', lastrevid: 11, contentmodel: 'wikitext' },
            ],
          },
        });
      }
      if (parameters.get('gapnamespace') === '0') {
        return json({
          query: {
            pages: [
              {
                pageid: 2,
                ns: 0,
                title: '鹿弹',
                redirect: true,
                lastrevid: 12,
                contentmodel: 'wikitext',
              },
            ],
          },
        });
      }
      return json({
        query: {
          pages: [
            { pageid: 3, ns: 10, title: '模板:物品', lastrevid: 13, contentmodel: 'wikitext' },
          ],
        },
      });
    });
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    const batches: number[][] = [];
    const first = await syncTitles(database, api, analyzer, {
      requestIntervalMs: 0,
      onBatch: (pages) => {
        batches.push(pages.map(({ id }) => id));
      },
    });
    const callsAfterFirstSync = calls.length;
    const second = await syncTitles(database, api, analyzer);

    expect(first.status).toBe('complete');
    expect(first.pagesFetched).toBe(3);
    expect(second.completedAt).toBe(first.completedAt);
    expect(calls).toHaveLength(callsAfterFirstSync);
    expect(batches).toEqual([[1], [2], [3]]);
    expect(await database.pages.count()).toBe(3);
    expect((await database.pages.get(2))?.isRedirect).toBe(true);
    expect((await database.pages.get(2))?.revisionId).toBe(12);
    expect((await database.pages.get(2))?.contentModel).toBe('wikitext');
    expect(calls.every((url) => url.searchParams.get('maxlag') === '5')).toBe(true);
    expect(calls.some((url) => url.searchParams.get('gapnamespace') === '6')).toBe(false);

    database.close();
    await database.delete();
  });

  it('does not replace a newer local revision with an older allpages row', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://casualtiesunknown.huijiwiki.com');
      if (url.searchParams.get('meta') === 'siteinfo') {
        return json({ query: { namespaces: { 0: { id: 0, name: '' } } } });
      }
      return json({
        query: {
          pages: [
            {
              pageid: 1,
              ns: 0,
              title: '竞态标题页',
              lastrevid: 12,
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
      title: '竞态标题页',
      normalizedTitle: analyzer.normalize('竞态标题页'),
      namespace: 0,
      namespaceName: '（主）',
      isRedirect: false,
      localSeq: 1,
      seenInTitleSync: 0,
      deleted: false,
      revisionId: 20,
      contentModel: 'wikitext',
      content: 'RC 已写入的新正文',
      contentRevisionId: 20,
    });
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    await syncTitles(database, api, analyzer, { requestIntervalMs: 0 });

    expect(await database.pages.get(1)).toMatchObject({
      revisionId: 20,
      contentRevisionId: 20,
      content: 'RC 已写入的新正文',
      deleted: false,
    });
    expect((await database.syncState.get('local-sequence'))?.value).toBe(1);

    database.close();
    await database.delete();
  });

  it('clears cached content when a completed title scan tombstones a page', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://casualtiesunknown.huijiwiki.com');
      if (url.searchParams.get('meta') === 'siteinfo') {
        return json({ query: { namespaces: { 0: { id: 0, name: '' } } } });
      }
      return json({ query: { pages: [] } });
    });
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put({
      id: 1,
      title: '远程已删除',
      normalizedTitle: analyzer.normalize('远程已删除'),
      namespace: 0,
      namespaceName: '（主）',
      isRedirect: false,
      localSeq: 1,
      seenInTitleSync: 1,
      deleted: false,
      revisionId: 10,
      contentModel: 'wikitext',
      content: '不得复活的旧正文',
      contentRevisionId: 10,
    });
    await database.syncState.put({ key: 'local-sequence', value: 1 });
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    await syncTitles(database, api, analyzer, { requestIntervalMs: 0 });

    expect(await database.pages.get(1)).toMatchObject({
      deleted: true,
      content: undefined,
      contentRevisionId: undefined,
    });

    database.close();
    await database.delete();
  });

  it('resumes a failed title scan from its saved continuation', async () => {
    const requests: URL[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://casualtiesunknown.huijiwiki.com');
      requests.push(url);
      if (url.searchParams.get('meta') === 'siteinfo') {
        return json({ query: { namespaces: { 0: { id: 0, name: '' } } } });
      }
      if (!url.searchParams.has('gapcontinue')) {
        return json({
          continue: { gapcontinue: '第二页' },
          query: {
            pages: [
              { pageid: 1, ns: 0, title: '已完成首页', lastrevid: 10, contentmodel: 'wikitext' },
            ],
          },
        });
      }
      return json({
        query: {
          pages: [
            { pageid: 2, ns: 0, title: '恢复后次页', lastrevid: 20, contentmodel: 'wikitext' },
          ],
        },
      });
    });
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put({
      id: 1,
      title: '已完成首页',
      normalizedTitle: analyzer.normalize('已完成首页'),
      namespace: 0,
      namespaceName: '（主）',
      isRedirect: false,
      localSeq: 1,
      seenInTitleSync: 100,
      deleted: false,
      revisionId: 10,
      contentModel: 'wikitext',
    });
    await database.syncState.bulkPut([
      { key: 'local-sequence', value: 1 },
      {
        key: 'title-sync',
        value: {
          status: 'failed',
          namespaceIds: [0],
          namespaceNames: { 0: '（主）' },
          namespaceIndex: 0,
          apcontinue: '第二页',
          generation: 100,
          pagesFetched: 1,
          startedAt: 100,
          error: '断网',
        },
      },
    ]);
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    const result = await syncTitles(database, api, analyzer, { requestIntervalMs: 0 });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.searchParams.get('gapcontinue')).toBe('第二页');
    expect(result).toMatchObject({
      status: 'complete',
      generation: 100,
      pagesFetched: 2,
    });
    expect(await database.pages.get(1)).toMatchObject({ deleted: false });
    expect(await database.pages.get(2)).toMatchObject({ title: '恢复后次页' });
    expect((await database.syncState.get('title-sync'))?.value).not.toHaveProperty(
      'apcontinue',
    );

    requests.length = 0;
    const forced = await syncTitles(database, api, analyzer, {
      force: true,
      requestIntervalMs: 0,
    });
    expect(requests[0]?.searchParams.get('meta')).toBe('siteinfo');
    expect(requests[1]?.searchParams.has('gapcontinue')).toBe(false);
    expect(forced.generation).not.toBe(100);

    database.close();
    await database.delete();
  });

  it('persists new title continuations only as gapcontinue', async () => {
    let failSecondPage = true;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://casualtiesunknown.huijiwiki.com');
      if (url.searchParams.get('meta') === 'siteinfo') {
        return json({ query: { namespaces: { 0: { id: 0, name: '' } } } });
      }
      if (!url.searchParams.has('gapcontinue')) {
        return json({
          continue: { gapcontinue: '精确的下一页游标' },
          query: {
            pages: [
              { pageid: 1, ns: 0, title: '首页', lastrevid: 1, contentmodel: 'wikitext' },
            ],
          },
        });
      }
      if (failSecondPage) {
        failSecondPage = false;
        throw new TypeError('模拟断网');
      }
      return json({ query: { pages: [] } });
    });
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    await expect(
      syncTitles(database, api, analyzer, { requestIntervalMs: 0 }),
    ).rejects.toThrow();

    expect((await database.syncState.get('title-sync'))?.value).toMatchObject({
      status: 'failed',
      gapcontinue: '精确的下一页游标',
    });
    expect((await database.syncState.get('title-sync'))?.value).not.toHaveProperty(
      'apcontinue',
    );

    await expect(
      syncTitles(database, api, analyzer, { requestIntervalMs: 0 }),
    ).resolves.toMatchObject({ status: 'complete', pagesFetched: 1 });
    expect(
      fetcher.mock.calls.some(([input]) =>
        new URL(String(input), 'https://casualtiesunknown.huijiwiki.com').searchParams.has(
          'apcontinue',
        ),
      ),
    ).toBe(false);

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
