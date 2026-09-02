// SPDX-License-Identifier: MPL-2.0
import 'fake-indexeddb/auto';

import { Analyzer, createBootstrapSegmenter } from '../src/analyzer/analyzer';
import { WikiSearchDatabase } from '../src/storage/database';
import { syncRecentChanges } from '../src/sync/recent-change-sync';
import { WikiApi } from '../src/sync/wiki-api';
import type { PageRecord, TitleSyncState } from '../src/types';
import { abortTransactionAfterCallback } from './transaction-abort';

const analyzer = new Analyzer(createBootstrapSegmenter());

describe('RecentChanges incremental sync', () => {
  it('reports no deferred content when the incremental sync has no baseline', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.syncState.put({ key: 'local-sequence', value: 7 });
    const fetcher = vi.fn();
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    const result = await syncRecentChanges(database, api, analyzer, {
      requestIntervalMs: 0,
    });

    expect(result).toEqual({
      status: 'no-baseline',
      eventsSeen: 0,
      candidates: 0,
      changedPages: [],
      deferredContentPageIds: [],
      filesChanged: false,
      dataCodesInvalidated: false,
      throughLocalSeq: 7,
    });
    expect(fetcher).not.toHaveBeenCalled();

    await destroy(database);
  });

  it('commits a changed page body and the frozen server cursor together', async () => {
    const requests: URL[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://casualtiesunknown.huijiwiki.com');
      requests.push(url);
      const parameters = url.searchParams;
      if (parameters.get('curtimestamp') === '1') {
        return json({ curtimestamp: '2026-08-31T03:10:00Z', query: { general: {} } });
      }
      if (parameters.get('list') === 'recentchanges') {
        return json({
          query: {
            recentchanges: [
              {
                type: 'edit',
                ns: 0,
                title: '12号鹿弹',
                pageid: 1,
                revid: 12,
                old_revid: 11,
                rcid: 101,
                bot: false,
                timestamp: '2026-08-31T03:06:00Z',
              },
            ],
          },
        });
      }
      if (parameters.get('prop') === 'info') {
        return json({
          query: {
            pages: [
              {
                pageid: 1,
                ns: 0,
                title: '12号鹿弹',
                contentmodel: 'wikitext',
                lastrevid: 12,
              },
            ],
          },
        });
      }
      return json({
        query: {
          pages: [
            {
              pageid: 1,
              ns: 0,
              title: '12号鹿弹',
              revisions: [
                {
                  revid: 12,
                  slots: { main: { contentmodel: 'wikitext', content: '最新鹿弹正文' } },
                },
              ],
            },
          ],
        },
      });
    });
    const database = await databaseWithBaseline([
      page({ revisionId: 11, contentRevisionId: 11, content: '旧正文' }),
    ]);
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    const result = await syncRecentChanges(database, api, analyzer, {
      requestIntervalMs: 0,
    });

    expect(result).toMatchObject({
      status: 'complete',
      through: '2026-08-31T03:10:00Z',
      eventsSeen: 1,
      candidates: 1,
    });
    expect(await database.pages.get(1)).toMatchObject({
      revisionId: 12,
      contentRevisionId: 12,
      content: '最新鹿弹正文',
      deleted: false,
    });
    expect((await database.syncState.get('recent-changes-sync'))?.value).toMatchObject({
      through: '2026-08-31T03:10:00Z',
    });
    expect((await database.syncState.get('local-sequence'))?.value).toBe(2);
    expect(
      await database.jobs.filter((job) => job.pageId === 1).first(),
    ).toMatchObject({
      type: 'wikitext-content',
      status: 'done',
      targetRevisionId: 12,
    });
    const recentChangesRequest = requests.find(
      (request) => request.searchParams.get('list') === 'recentchanges',
    );
    expect(recentChangesRequest?.searchParams.get('rcdir')).toBe('newer');
    expect(recentChangesRequest?.searchParams.get('rcstart')).toBe(
      '2026-08-31T02:55:00.000Z',
    );
    expect(recentChangesRequest?.searchParams.get('rcend')).toBe('2026-08-31T03:10:00Z');
    expect(recentChangesRequest?.searchParams.get('assert')).toBe('user');
    expect(recentChangesRequest?.searchParams.has('rcshow')).toBe(false);

    await destroy(database);
  });

  it('retries a mixed batch whose transaction aborts after its callback', async () => {
    const requests: URL[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://casualtiesunknown.huijiwiki.com');
      requests.push(url);
      const parameters = url.searchParams;
      if (parameters.get('curtimestamp') === '1') {
        return json({ curtimestamp: '2026-08-31T03:10:00Z', query: { general: {} } });
      }
      if (parameters.get('list') === 'recentchanges') {
        return json({
          query: {
            recentchanges: [
              {
                type: 'edit',
                ns: 0,
                title: '更新页',
                pageid: 1,
                revid: 12,
                old_revid: 11,
                rcid: 101,
                timestamp: '2026-08-31T03:06:00Z',
              },
              {
                type: 'log',
                ns: 0,
                title: '删除页',
                pageid: 2,
                revid: 0,
                old_revid: 21,
                rcid: 102,
                timestamp: '2026-08-31T03:07:00Z',
                logtype: 'delete',
                logaction: 'delete',
                logparams: {},
              },
            ],
          },
        });
      }
      if (parameters.get('prop') === 'info') {
        return json({
          query: {
            pages: [
              {
                pageid: 1,
                ns: 0,
                title: '更新页',
                contentmodel: 'wikitext',
                lastrevid: 12,
              },
              { pageid: 2, ns: 0, title: '删除页', missing: true },
            ],
          },
        });
      }
      return json({
        query: {
          pages: [
            {
              pageid: 1,
              revisions: [
                {
                  revid: 12,
                  slots: { main: { contentmodel: 'wikitext', content: '更新后正文' } },
                },
              ],
            },
          ],
        },
      });
    });
    const oldUpdatedPage = page({
      title: '更新页',
      normalizedTitle: analyzer.normalize('更新页'),
      revisionId: 11,
      contentRevisionId: 11,
      content: '更新前正文',
    });
    const oldDeletedPage = page({
      id: 2,
      title: '删除页',
      normalizedTitle: analyzer.normalize('删除页'),
      localSeq: 2,
      revisionId: 21,
      contentRevisionId: 21,
      content: '删除前正文',
    });
    const oldCursor = {
      through: '2026-08-31T03:05:00Z',
      completedAt: Date.parse('2026-08-31T03:05:01Z'),
      recentChanges: [{ rcid: 100, timestamp: '2026-08-31T03:04:00Z' }],
    };
    const database = await databaseWithBaseline([oldUpdatedPage, oldDeletedPage]);
    await database.syncState.bulkPut([
      { key: 'local-sequence', value: 2 },
      { key: 'recent-changes-sync', value: oldCursor },
    ]);
    const updatedJobId = await database.jobs.add({
      type: 'wikitext-content',
      pageId: 1,
      status: 'done',
      targetRevisionId: 11,
      updatedAt: 100,
    });
    const deletedJobId = await database.jobs.add({
      type: 'wikitext-content',
      pageId: 2,
      status: 'done',
      targetRevisionId: 21,
      updatedAt: 200,
    });
    const oldJobs = await database.jobs.toArray();
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });
    abortTransactionAfterCallback(database);

    await expect(
      syncRecentChanges(database, api, analyzer, { requestIntervalMs: 0 }),
    ).rejects.toBeDefined();

    expect(await database.pages.get(1)).toEqual(oldUpdatedPage);
    expect(await database.pages.get(2)).toEqual(oldDeletedPage);
    expect(await database.jobs.toArray()).toEqual(oldJobs);
    expect((await database.syncState.get('local-sequence'))?.value).toBe(2);
    expect((await database.syncState.get('recent-changes-sync'))?.value).toEqual(
      oldCursor,
    );

    const resumed = await syncRecentChanges(database, api, analyzer, {
      requestIntervalMs: 0,
    });

    expect(resumed).toMatchObject({ status: 'complete', throughLocalSeq: 4 });
    expect(await database.pages.get(1)).toMatchObject({
      revisionId: 12,
      contentRevisionId: 12,
      content: '更新后正文',
      localSeq: 3,
    });
    expect(await database.pages.get(2)).toMatchObject({
      deleted: true,
      content: undefined,
      contentRevisionId: undefined,
      localSeq: 4,
    });
    expect(await database.jobs.get(updatedJobId)).toMatchObject({
      status: 'done',
      targetRevisionId: 12,
    });
    expect(await database.jobs.get(deletedJobId)).toBeUndefined();
    expect((await database.syncState.get('local-sequence'))?.value).toBe(4);
    expect((await database.syncState.get('recent-changes-sync'))?.value).toMatchObject({
      through: '2026-08-31T03:10:00Z',
    });
    expect(
      requests.filter((request) => request.searchParams.get('list') === 'recentchanges'),
    ).toHaveLength(2);

    await destroy(database);
  });

  it('allocates page sequences after concurrent facts written while the API is in flight', async () => {
    const database = await databaseWithBaseline([
      page({ revisionId: 11, contentRevisionId: 11, content: '旧正文' }),
    ]);
    let concurrentFactWritten = false;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://casualtiesunknown.huijiwiki.com');
      const parameters = url.searchParams;
      if (parameters.get('curtimestamp') === '1') {
        return json({ curtimestamp: '2026-08-31T03:10:00Z', query: { general: {} } });
      }
      if (parameters.get('list') === 'recentchanges') {
        return json({
          query: {
            recentchanges: [
              {
                type: 'edit',
                ns: 0,
                title: '12号鹿弹',
                pageid: 1,
                revid: 12,
                old_revid: 11,
                rcid: 102,
                timestamp: '2026-08-31T03:06:00Z',
              },
            ],
          },
        });
      }
      if (parameters.get('prop') === 'info') {
        return json({
          query: {
            pages: [
              {
                pageid: 1,
                ns: 0,
                title: '12号鹿弹',
                contentmodel: 'wikitext',
                lastrevid: 12,
              },
            ],
          },
        });
      }
      if (!concurrentFactWritten) {
        concurrentFactWritten = true;
        await database.transaction('rw', database.pages, database.syncState, async () => {
          await database.pages.put(page({ id: 2, title: '并发事实', localSeq: 2 }));
          await database.syncState.bulkPut([
            { key: 'local-sequence', value: 2 },
            { key: 'recent-changes-sync', value: { fileChangeSeq: 2 } },
          ]);
        });
      }
      return json({
        query: {
          pages: [
            {
              pageid: 1,
              revisions: [
                {
                  revid: 12,
                  slots: { main: { contentmodel: 'wikitext', content: '最新正文' } },
                },
              ],
            },
          ],
        },
      });
    });
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    const result = await syncRecentChanges(database, api, analyzer, {
      requestIntervalMs: 0,
    });

    expect(result).toMatchObject({ status: 'complete', throughLocalSeq: 3 });
    expect((await database.pages.get(1))?.localSeq).toBe(3);
    expect((await database.pages.get(2))?.localSeq).toBe(2);
    expect((await database.syncState.get('local-sequence'))?.value).toBe(3);
    expect((await database.syncState.get('recent-changes-sync'))?.value).toMatchObject({
      fileChangeSeq: 2,
    });

    await destroy(database);
  });

  it('consumes a bot-heavy continuation chain and coalesces repeated page edits', async () => {
    const requests: URL[] = [];
    const botEvents = Array.from({ length: 1_000 }, (_, offset) => ({
      type: 'edit',
      ns: 0,
      title: '批量更新页',
      pageid: 1,
      revid: 100 + offset,
      old_revid: 99 + offset,
      rcid: offset + 1,
      bot: true,
      timestamp: '2026-08-31T03:06:00Z',
    }));
    const humanEvent = {
      type: 'edit',
      ns: 0,
      title: '人工更新页',
      pageid: 2,
      revid: 2_200,
      old_revid: 2_199,
      rcid: 1_001,
      bot: false,
      timestamp: '2026-08-31T03:07:00Z',
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://casualtiesunknown.huijiwiki.com');
      requests.push(url);
      const parameters = url.searchParams;
      if (parameters.get('curtimestamp') === '1') {
        return json({ curtimestamp: '2026-08-31T03:10:00Z', query: { general: {} } });
      }
      if (parameters.get('list') === 'recentchanges') {
        const cursor = parameters.get('rccontinue');
        if (!cursor) {
          return json({
            continue: { rccontinue: 'page-2', continue: '-||' },
            query: { recentchanges: botEvents.slice(0, 500) },
          });
        }
        if (cursor === 'page-2') {
          return json({
            continue: { rccontinue: 'page-3', continue: '-||' },
            query: { recentchanges: botEvents.slice(500) },
          });
        }
        return json({
          query: { recentchanges: [botEvents[999], humanEvent] },
        });
      }
      return json({
        query: {
          pages: [
            {
              pageid: 1,
              ns: 0,
              title: '批量更新页',
              contentmodel: 'wikitext',
              lastrevid: 1_099,
            },
            {
              pageid: 2,
              ns: 0,
              title: '人工更新页',
              contentmodel: 'wikitext',
              lastrevid: 2_200,
            },
          ],
        },
      });
    });
    const database = await databaseWithBaseline([
      page({
        id: 1,
        title: '批量更新页',
        normalizedTitle: analyzer.normalize('批量更新页'),
        revisionId: 1_099,
        contentRevisionId: 1_099,
        content: '已是最新正文',
      }),
      page({
        id: 2,
        title: '人工更新页',
        normalizedTitle: analyzer.normalize('人工更新页'),
        revisionId: 2_200,
        contentRevisionId: 2_200,
        content: '已是最新正文',
      }),
    ]);
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    const result = await syncRecentChanges(database, api, analyzer, {
      requestIntervalMs: 0,
    });

    expect(result).toMatchObject({
      status: 'complete',
      eventsSeen: 1_001,
      candidates: 2,
    });
    const recentRequests = requests.filter(
      (request) => request.searchParams.get('list') === 'recentchanges',
    );
    expect(recentRequests).toHaveLength(3);
    expect(recentRequests.map((request) => request.searchParams.get('rccontinue'))).toEqual([
      null,
      'page-2',
      'page-3',
    ]);
    expect(recentRequests.every((request) => !request.searchParams.has('rcshow'))).toBe(true);
    const infoRequests = requests.filter((request) => request.searchParams.get('prop') === 'info');
    expect(infoRequests).toHaveLength(1);
    expect(infoRequests[0]?.searchParams.get('pageids')).toBe('1|2');

    await destroy(database);
  });

  it('reconciles move and delete logs without treating zero revision ids as content revisions', async () => {
    const requests: URL[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://casualtiesunknown.huijiwiki.com');
      requests.push(url);
      const parameters = url.searchParams;
      if (parameters.get('curtimestamp') === '1') {
        return json({ curtimestamp: '2026-08-31T03:10:00Z', query: { general: {} } });
      }
      if (parameters.get('list') === 'recentchanges') {
        return json({
          query: {
            recentchanges: [
              {
                type: 'log',
                ns: 0,
                title: '旧页面',
                pageid: 0,
                revid: 0,
                old_revid: 0,
                rcid: 201,
                timestamp: '2026-08-31T03:06:00Z',
                logtype: 'move',
                logaction: 'move',
                logparams: { target_ns: 0, target_title: '新页面', suppressredirect: true },
              },
              {
                type: 'log',
                ns: 0,
                title: '将删除',
                pageid: 4,
                revid: 0,
                old_revid: 0,
                rcid: 202,
                timestamp: '2026-08-31T03:07:00Z',
                logtype: 'delete',
                logaction: 'delete',
                logparams: {},
              },
              {
                type: 'log',
                ns: 2,
                title: '用户:未建页示例',
                pageid: 0,
                revid: 0,
                old_revid: 0,
                rcid: 203,
                timestamp: '2026-08-31T03:08:00Z',
                logtype: 'newusers',
                logaction: 'create',
                logparams: {},
              },
              {
                type: 'edit',
                ns: 0,
                title: '新页面',
                pageid: 3,
                revid: 30,
                old_revid: 29,
                rcid: 204,
                timestamp: '2026-08-31T03:09:00Z',
              },
            ],
          },
        });
      }
      if (parameters.get('pageids') === '4|3') {
        return json({
          query: {
            pages: [
              { pageid: 4, missing: true },
              {
                pageid: 3,
                ns: 0,
                title: '新页面',
                contentmodel: 'wikitext',
                lastrevid: 30,
              },
            ],
          },
        });
      }
      if (parameters.get('titles')) {
        return json({
          query: {
            pages: [
              { ns: 0, title: '旧页面', missing: true },
              {
                pageid: 3,
                ns: 0,
                title: '新页面',
                contentmodel: 'wikitext',
                lastrevid: 30,
              },
            ],
          },
        });
      }
      throw new Error(`不应请求正文：${url}`);
    });
    const database = await databaseWithBaseline([
      page({
        id: 3,
        title: '旧页面',
        normalizedTitle: analyzer.normalize('旧页面'),
        revisionId: 30,
        contentRevisionId: 30,
        content: '移动前正文',
      }),
      page({
        id: 4,
        title: '将删除',
        normalizedTitle: analyzer.normalize('将删除'),
        revisionId: 40,
        contentRevisionId: 40,
        content: '将被删除正文',
      }),
    ]);
    await database.jobs.put({
      type: 'wikitext-content',
      pageId: 4,
      status: 'done',
      targetRevisionId: 40,
    });
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    const result = await syncRecentChanges(database, api, analyzer, {
      requestIntervalMs: 0,
    });

    expect(result.status).toBe('complete');
    if (result.status !== 'complete') throw new Error('增量同步未完成');
    expect(result.changedPages.map(({ id }) => id).sort()).toEqual([3, 4]);
    expect((await database.syncState.get('local-sequence'))?.value).toBe(3);
    expect(await database.pages.get(3)).toMatchObject({
      title: '新页面',
      revisionId: 30,
      contentRevisionId: 30,
      deleted: false,
    });
    expect(await database.pages.get(4)).toMatchObject({
      title: '将删除',
      deleted: true,
      content: undefined,
      contentRevisionId: undefined,
    });
    expect(
      await database.jobs.filter((job) => job.pageId === 4).count(),
    ).toBe(0);
    const titleRequest = requests.find((request) => request.searchParams.has('titles'));
    expect(titleRequest?.searchParams.get('titles')).toBe('旧页面|新页面');
    expect(titleRequest?.searchParams.get('titles')).not.toContain('只注册未建页');
    expect(
      requests.filter((request) => request.searchParams.get('prop') === 'revisions'),
    ).toHaveLength(0);

    await destroy(database);
  });

  it('never overwrites a newer local revision with an older remote response', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://casualtiesunknown.huijiwiki.com');
      const parameters = url.searchParams;
      if (parameters.get('curtimestamp') === '1') {
        return json({ curtimestamp: '2026-08-31T03:10:00Z', query: { general: {} } });
      }
      if (parameters.get('list') === 'recentchanges') {
        return json({
          query: {
            recentchanges: [
              {
                type: 'edit',
                ns: 0,
                title: '乱序页面',
                pageid: 1,
                revid: 12,
                old_revid: 11,
                rcid: 301,
                timestamp: '2026-08-31T03:06:00Z',
              },
            ],
          },
        });
      }
      if (parameters.get('prop') === 'info') {
        return json({
          query: {
            pages: [
              {
                pageid: 1,
                ns: 0,
                title: '乱序页面',
                contentmodel: 'wikitext',
                lastrevid: 12,
              },
            ],
          },
        });
      }
      return json({
        query: {
          pages: [
            {
              pageid: 1,
              revisions: [
                {
                  revid: 12,
                  slots: { main: { contentmodel: 'wikitext', content: '过期正文' } },
                },
              ],
            },
          ],
        },
      });
    });
    const database = await databaseWithBaseline([
      page({
        title: '乱序页面',
        normalizedTitle: analyzer.normalize('乱序页面'),
        revisionId: 20,
        contentRevisionId: 20,
        content: '更新的本地正文',
      }),
    ]);
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    const result = await syncRecentChanges(database, api, analyzer, {
      requestIntervalMs: 0,
    });

    expect(result).toMatchObject({ status: 'complete', changedPages: [] });
    expect(await database.pages.get(1)).toMatchObject({
      revisionId: 20,
      contentRevisionId: 20,
      content: '更新的本地正文',
    });
    expect((await database.syncState.get('recent-changes-sync'))?.value).toMatchObject({
      through: '2026-08-31T03:10:00Z',
    });

    await destroy(database);
  });

  it('pauses cleanly when RecentChanges requires a logged-in user', async () => {
    const fetcher = vi.fn(async () =>
      json({
        error: {
          code: 'assertuserfailed',
          info: 'Assertion that the user is logged in failed',
        },
      }),
    );
    const database = await databaseWithBaseline([
      page({ revisionId: 11, contentRevisionId: 11, content: '仍可搜索的缓存' }),
    ]);
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 4 });

    const result = await syncRecentChanges(database, api, analyzer, {
      requestIntervalMs: 0,
    });

    expect(result).toMatchObject({
      status: 'login-required',
      eventsSeen: 0,
      candidates: 0,
      deferredContentPageIds: [],
    });
    expect(fetcher).toHaveBeenCalledOnce();
    expect(await database.pages.get(1)).toMatchObject({
      revisionId: 11,
      content: '仍可搜索的缓存',
    });
    expect(await database.syncState.get('recent-changes-sync')).toBeUndefined();

    await destroy(database);
  });

  it.each(['page-info', 'content'] as const)(
    'pauses without advancing the cursor when %s requires login',
    async (loginStage) => {
      const fetcher = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'https://casualtiesunknown.huijiwiki.com');
        const parameters = url.searchParams;
        if (parameters.get('curtimestamp') === '1') {
          return json({ curtimestamp: '2026-08-31T03:10:00Z', query: { general: {} } });
        }
        if (parameters.get('list') === 'recentchanges') {
          return json({
            query: {
              recentchanges: [
                {
                  type: 'edit',
                  ns: 0,
                  title: '登录中断页',
                  pageid: 1,
                  revid: 12,
                  old_revid: 11,
                  rcid: 302,
                  timestamp: '2026-08-31T03:06:00Z',
                },
              ],
            },
          });
        }
        if (parameters.get('prop') === 'info') {
          if (loginStage === 'page-info') return loginRequired();
          return json({
            query: {
              pages: [
                {
                  pageid: 1,
                  ns: 0,
                  title: '登录中断页',
                  contentmodel: 'wikitext',
                  lastrevid: 12,
                },
              ],
            },
          });
        }
        return loginRequired();
      });
      const database = await databaseWithBaseline([
        page({
          title: '登录中断页',
          normalizedTitle: analyzer.normalize('登录中断页'),
          revisionId: 11,
          contentRevisionId: 11,
          content: '仍可搜索的缓存',
        }),
      ]);
      const priorState = {
        through: '2026-08-31T03:05:00Z',
        completedAt: Date.parse('2026-08-31T03:05:01Z'),
        recentChanges: [{ rcid: 300, timestamp: '2026-08-31T03:04:00Z' }],
      };
      await database.syncState.put({ key: 'recent-changes-sync', value: priorState });
      const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

      const result = await syncRecentChanges(database, api, analyzer, {
        requestIntervalMs: 0,
      });

      expect(result).toMatchObject({
        status: 'login-required',
        deferredContentPageIds: [],
      });
      expect((await database.syncState.get('recent-changes-sync'))?.value).toEqual(
        priorState,
      );
      expect(await database.pages.get(1)).toMatchObject({
        revisionId: 11,
        contentRevisionId: 11,
        content: '仍可搜索的缓存',
      });

      await destroy(database);
    },
  );

  it('updates an initialized file cache without leaking files into ordinary pages', async () => {
    const requests: URL[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://casualtiesunknown.huijiwiki.com');
      requests.push(url);
      const parameters = url.searchParams;
      if (parameters.get('curtimestamp') === '1') {
        return json({ curtimestamp: '2026-08-31T03:10:00Z', query: { general: {} } });
      }
      if (parameters.get('list') === 'recentchanges') {
        return json({
          query: {
            recentchanges: [
              {
                type: 'log',
                ns: 6,
                title: '文件:更新.png',
                pageid: 6,
                revid: 60,
                old_revid: 59,
                rcid: 401,
                timestamp: '2026-08-31T03:06:00Z',
                logtype: 'upload',
                logaction: 'overwrite',
                logparams: {},
              },
              {
                type: 'log',
                ns: 6,
                title: '文件:删除.png',
                pageid: 7,
                revid: 0,
                old_revid: 0,
                rcid: 402,
                timestamp: '2026-08-31T03:07:00Z',
                logtype: 'delete',
                logaction: 'delete',
                logparams: {},
              },
            ],
          },
        });
      }
      if (parameters.get('prop') === 'info') {
        return json({
          query: {
            pages: [
              {
                pageid: 6,
                ns: 6,
                title: '文件:更新.png',
                contentmodel: 'wikitext',
                lastrevid: 60,
              },
              { pageid: 7, missing: true },
            ],
          },
        });
      }
      throw new Error(`文件资源不应请求正文：${url}`);
    });
    const database = await databaseWithBaseline([]);
    await database.fileResources.bulkPut([
      filePage(6, '文件:更新.png', 59),
      filePage(7, '文件:删除.png', 70),
    ]);
    await database.syncState.put({
      key: 'file-resource-sync',
      value: {
        status: 'complete',
        namespaceIds: [6],
        namespaceNames: { 6: '文件' },
        namespaceIndex: 1,
        generation: 10,
        pagesFetched: 2,
        startedAt: Date.parse('2026-08-31T02:00:00Z'),
        completedAt: Date.parse('2026-08-31T02:01:00Z'),
      } satisfies TitleSyncState,
    });
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    const result = await syncRecentChanges(database, api, analyzer, {
      requestIntervalMs: 0,
    });

    expect(result).toMatchObject({ status: 'complete', filesChanged: true });
    const updatedFile = await database.fileResources.get(6);
    expect(updatedFile).toMatchObject({
      revisionId: 60,
      deleted: false,
      seenInFileSync: 10,
    });
    expect(updatedFile).not.toHaveProperty('seenInTitleSync');
    const deletedFile = await database.fileResources.get(7);
    expect(deletedFile).toMatchObject({
      deleted: true,
      writerSeq: 3,
    });
    expect(deletedFile).not.toHaveProperty('seenInTitleSync');
    expect(await database.pages.get(6)).toBeUndefined();
    expect(await database.pages.get(7)).toBeUndefined();
    expect(
      requests.filter((request) => request.searchParams.get('prop') === 'revisions'),
    ).toHaveLength(0);

    await destroy(database);
  });

  it('rejects a recent-change state corrupted after the initial read', async () => {
    const database = await databaseWithBaseline([]);
    await database.syncState.put({
      key: 'recent-changes-sync',
      value: {
        through: '2026-08-31T03:05:00Z',
        completedAt: Date.parse('2026-08-31T03:05:01Z'),
        recentChanges: [],
        fileChangeSeq: 1,
      },
    });
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://casualtiesunknown.huijiwiki.com');
      if (url.searchParams.get('curtimestamp') === '1') {
        return json({ curtimestamp: '2026-08-31T03:10:00Z', query: { general: {} } });
      }
      if (url.searchParams.get('list') === 'recentchanges') {
        await database.syncState.put({
          key: 'recent-changes-sync',
          value: { through: 123, completedAt: 1, recentChanges: [] },
        });
        return json({ query: { recentchanges: [] } });
      }
      throw new Error(`不应请求：${url}`);
    });
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    await expect(
      syncRecentChanges(database, api, analyzer, { requestIntervalMs: 0 }),
    ).rejects.toThrow('同步状态 "recent-changes-sync" 已损坏');

    expect((await database.syncState.get('recent-changes-sync'))?.value).toMatchObject({
      through: 123,
    });
    expect((await database.syncState.get('local-sequence'))?.value).toBe(1);

    await destroy(database);
  });

  it('invalidates the derived Data code cache when a Data page changes', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://casualtiesunknown.huijiwiki.com');
      const parameters = url.searchParams;
      if (parameters.get('curtimestamp') === '1') {
        return json({ curtimestamp: '2026-08-31T03:10:00Z', query: { general: {} } });
      }
      if (parameters.get('list') === 'recentchanges') {
        return json({
          query: {
            recentchanges: [
              {
                type: 'edit',
                ns: 3500,
                title: 'Data:Item/pistol.json',
                pageid: 8,
                revid: 81,
                old_revid: 80,
                rcid: 501,
                timestamp: '2026-08-31T03:06:00Z',
              },
            ],
          },
        });
      }
      if (parameters.get('prop') === 'info') {
        return json({
          query: {
            pages: [
              {
                pageid: 8,
                ns: 3500,
                title: 'Data:Item/pistol.json',
                contentmodel: 'BSON',
                lastrevid: 81,
              },
            ],
          },
        });
      }
      return json({
        query: {
          pages: [
            {
              pageid: 8,
              revisions: [
                {
                  revid: 81,
                  slots: {
                    main: {
                      contentmodel: 'BSON',
                      content: '{"id":"pistol","locales":{"zh-CN":{"name":"手枪"}}}',
                    },
                  },
                },
              ],
            },
          ],
        },
      });
    });
    const database = await databaseWithBaseline([
      page({
        id: 8,
        title: 'Data:Item/pistol.json',
        normalizedTitle: analyzer.normalize('Data:Item/pistol.json'),
        namespace: 3500,
        namespaceName: 'Data',
        revisionId: 80,
        contentRevisionId: 80,
        contentModel: 'BSON',
        content: '{"id":"pistol"}',
      }),
    ]);
    await database.syncState.put({
      key: 'data-code-sync',
      value: {
        syncedAt: Date.parse('2026-08-31T03:00:00Z'),
        count: 655,
        rulesSource: 'Item = .locales["zh-CN"].name',
        indexVersion: 2,
      },
    });
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    const result = await syncRecentChanges(database, api, analyzer, {
      requestIntervalMs: 0,
    });

    expect(result).toMatchObject({ status: 'complete', dataCodesInvalidated: true });
    expect((await database.syncState.get('data-code-sync'))?.value).toMatchObject({
      syncedAt: 0,
      count: 655,
      rulesSource: 'Item = .locales["zh-CN"].name',
      indexVersion: 2,
    });

    await destroy(database);
  });

  it('invalidates derived Data codes when a page moves out of the Data namespace', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const parameters = new URL(
        String(input),
        'https://casualtiesunknown.huijiwiki.com',
      ).searchParams;
      if (parameters.get('curtimestamp') === '1') {
        return json({ curtimestamp: '2026-08-31T03:10:00Z', query: { general: {} } });
      }
      if (parameters.get('list') === 'recentchanges') {
        return json({
          query: {
            recentchanges: [
              {
                type: 'log',
                ns: 3500,
                title: 'Data:Item/old.json',
                pageid: 0,
                revid: 0,
                old_revid: 0,
                rcid: 502,
                timestamp: '2026-08-31T03:06:00Z',
                logtype: 'move',
                logaction: 'move',
                logparams: { target_title: '移出后页面' },
              },
            ],
          },
        });
      }
      return json({
        query: {
          pages: [
            { ns: 3500, title: 'Data:Item/old.json', missing: true },
            {
              pageid: 8,
              ns: 0,
              title: '移出后页面',
              contentmodel: 'BSON',
              lastrevid: 80,
            },
          ],
        },
      });
    });
    const database = await databaseWithBaseline([
      page({
        id: 8,
        title: 'Data:Item/old.json',
        normalizedTitle: analyzer.normalize('Data:Item/old.json'),
        namespace: 3500,
        namespaceName: 'Data',
        revisionId: 80,
        contentRevisionId: 80,
        contentModel: 'BSON',
        content: '{"id":"old"}',
      }),
    ]);
    await database.syncState.put({
      key: 'data-code-sync',
      value: { syncedAt: 100, count: 1, indexVersion: 2 },
    });
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    const result = await syncRecentChanges(database, api, analyzer, {
      requestIntervalMs: 0,
    });

    expect(result).toMatchObject({ status: 'complete', dataCodesInvalidated: true });
    expect(await database.pages.get(8)).toMatchObject({
      namespace: 0,
      title: '移出后页面',
      deleted: false,
    });
    expect((await database.syncState.get('data-code-sync'))?.value).toMatchObject({
      syncedAt: 0,
      count: 1,
    });

    await destroy(database);
  });

  it('commits other pages and defers a body that advanced past its info snapshot', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const parameters = new URL(
        String(input),
        'https://casualtiesunknown.huijiwiki.com',
      ).searchParams;
      if (parameters.get('curtimestamp') === '1') {
        return json({ curtimestamp: '2026-08-31T03:10:00Z', query: { general: {} } });
      }
      if (parameters.get('list') === 'recentchanges') {
        return json({
          query: {
            recentchanges: [
              {
                type: 'edit',
                ns: 0,
                title: '竞态页面',
                pageid: 1,
                revid: 12,
                old_revid: 11,
                rcid: 601,
                timestamp: '2026-08-31T03:06:00Z',
              },
              {
                type: 'edit',
                ns: 0,
                title: '正常页面',
                pageid: 2,
                revid: 22,
                old_revid: 21,
                rcid: 602,
                timestamp: '2026-08-31T03:07:00Z',
              },
            ],
          },
        });
      }
      if (parameters.get('prop') === 'info') {
        return json({
          query: {
            pages: [
              {
                pageid: 1,
                ns: 0,
                title: '竞态页面',
                contentmodel: 'wikitext',
                lastrevid: 12,
              },
              {
                pageid: 2,
                ns: 0,
                title: '正常页面',
                contentmodel: 'wikitext',
                lastrevid: 22,
              },
            ],
          },
        });
      }
      return json({
        query: {
          pages: [
            {
              pageid: 1,
              revisions: [
                {
                  revid: 13,
                  slots: { main: { contentmodel: 'wikitext', content: '不可采用的正文' } },
                },
              ],
            },
            {
              pageid: 2,
              revisions: [
                {
                  revid: 22,
                  slots: { main: { contentmodel: 'wikitext', content: '正常新正文' } },
                },
              ],
            },
          ],
        },
      });
    });
    const database = await databaseWithBaseline([
      page({
        title: '竞态页面',
        normalizedTitle: analyzer.normalize('竞态页面'),
        revisionId: 11,
        contentRevisionId: 11,
        content: '竞态旧正文',
      }),
      page({
        id: 2,
        title: '正常页面',
        normalizedTitle: analyzer.normalize('正常页面'),
        revisionId: 21,
        contentRevisionId: 21,
        content: '正常旧正文',
      }),
    ]);
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    const result = await syncRecentChanges(database, api, analyzer, {
      requestIntervalMs: 0,
    });

    expect(result).toMatchObject({
      status: 'complete',
      through: '2026-08-31T03:10:00Z',
      deferredContentPageIds: [1],
    });
    expect(await database.pages.get(1)).toMatchObject({
      revisionId: 12,
      contentRevisionId: 11,
      content: '竞态旧正文',
      deleted: false,
    });
    expect(await database.pages.get(2)).toMatchObject({
      revisionId: 22,
      contentRevisionId: 22,
      content: '正常新正文',
      deleted: false,
    });
    expect(
      await database.jobs.filter((job) => job.pageId === 1).first(),
    ).toMatchObject({
      type: 'wikitext-content',
      status: 'pending',
      targetRevisionId: 12,
    });
    expect((await database.syncState.get('recent-changes-sync'))?.value).toMatchObject({
      through: '2026-08-31T03:10:00Z',
    });

    await destroy(database);
  });

  it('does not create or revive pages explicitly missing from the body response', async () => {
    let round = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const parameters = new URL(
        String(input),
        'https://casualtiesunknown.huijiwiki.com',
      ).searchParams;
      if (parameters.get('curtimestamp') === '1') {
        round += 1;
        return json({
          curtimestamp:
            round === 1 ? '2026-08-31T03:10:00Z' : '2026-08-31T03:20:00Z',
          query: { general: {} },
        });
      }
      if (parameters.get('list') === 'recentchanges') {
        return json({
          query: {
            recentchanges:
              round === 1
                ? [
                    {
                      type: 'new',
                      ns: 0,
                      title: '瞬时新页',
                      pageid: 3,
                      revid: 30,
                      old_revid: 0,
                      rcid: 603,
                      timestamp: '2026-08-31T03:06:00Z',
                    },
                    {
                      type: 'new',
                      ns: 0,
                      title: '已有墓碑页',
                      pageid: 4,
                      revid: 40,
                      old_revid: 0,
                      rcid: 604,
                      timestamp: '2026-08-31T03:07:00Z',
                    },
                  ]
                : [
                    {
                      type: 'log',
                      ns: 0,
                      title: '瞬时新页',
                      pageid: 3,
                      revid: 0,
                      old_revid: 0,
                      rcid: 605,
                      timestamp: '2026-08-31T03:11:00Z',
                      logtype: 'delete',
                      logaction: 'delete',
                      logparams: {},
                    },
                    {
                      type: 'log',
                      ns: 0,
                      title: '已有墓碑页',
                      pageid: 4,
                      revid: 0,
                      old_revid: 0,
                      rcid: 606,
                      timestamp: '2026-08-31T03:12:00Z',
                      logtype: 'delete',
                      logaction: 'delete',
                      logparams: {},
                    },
                  ],
          },
        });
      }
      if (parameters.get('prop') === 'info') {
        return json({
          query: {
            pages:
              round === 1
                ? [
                    {
                      pageid: 3,
                      ns: 0,
                      title: '瞬时新页',
                      contentmodel: 'wikitext',
                      lastrevid: 30,
                    },
                    {
                      pageid: 4,
                      ns: 0,
                      title: '已有墓碑页',
                      contentmodel: 'wikitext',
                      lastrevid: 40,
                    },
                  ]
                : [
                    { pageid: 3, ns: 0, title: '瞬时新页', missing: true },
                    { pageid: 4, ns: 0, title: '已有墓碑页', missing: true },
                  ],
          },
        });
      }
      return json({
        query: {
          pages: [
            { pageid: 3, ns: 0, title: '瞬时新页', missing: true },
            { pageid: 4, ns: 0, title: '已有墓碑页', missing: true },
          ],
        },
      });
    });
    const tombstone = page({
      id: 4,
      title: '已有墓碑页',
      normalizedTitle: analyzer.normalize('已有墓碑页'),
      revisionId: 39,
      contentRevisionId: undefined,
      content: undefined,
      deleted: true,
    });
    const database = await databaseWithBaseline([tombstone]);
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    const firstResult = await syncRecentChanges(database, api, analyzer, {
      requestIntervalMs: 0,
    });

    expect(firstResult).toMatchObject({
      status: 'complete',
      through: '2026-08-31T03:10:00Z',
      deferredContentPageIds: [],
    });
    expect(await database.pages.get(3)).toBeUndefined();
    expect(await database.pages.get(4)).toEqual(tombstone);
    expect(
      await database.jobs
        .filter((job) => job.pageId === 3 || job.pageId === 4)
        .count(),
    ).toBe(0);
    expect((await database.syncState.get('recent-changes-sync'))?.value).toMatchObject({
      through: '2026-08-31T03:10:00Z',
    });

    const deleteResult = await syncRecentChanges(database, api, analyzer, {
      requestIntervalMs: 0,
    });

    expect(deleteResult).toMatchObject({
      status: 'complete',
      through: '2026-08-31T03:20:00Z',
      deferredContentPageIds: [],
    });
    expect(await database.pages.get(3)).toBeUndefined();
    expect(await database.pages.get(4)).toEqual(tombstone);
    expect((await database.syncState.get('recent-changes-sync'))?.value).toMatchObject({
      through: '2026-08-31T03:20:00Z',
    });

    await destroy(database);
  });

  it('preserves an active page and its done job until a later delete change closes it', async () => {
    let round = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const parameters = new URL(
        String(input),
        'https://casualtiesunknown.huijiwiki.com',
      ).searchParams;
      if (parameters.get('curtimestamp') === '1') {
        round += 1;
        return json({
          curtimestamp:
            round === 1 ? '2026-08-31T03:10:00Z' : '2026-08-31T03:20:00Z',
          query: { general: {} },
        });
      }
      if (parameters.get('list') === 'recentchanges') {
        return json({
          query: {
            recentchanges: [
              round === 1
                ? {
                    type: 'edit',
                    ns: 0,
                    title: '删除竞态页',
                    pageid: 5,
                    revid: 51,
                    old_revid: 50,
                    rcid: 607,
                    timestamp: '2026-08-31T03:06:00Z',
                  }
                : {
                    type: 'log',
                    ns: 0,
                    title: '删除竞态页',
                    pageid: 5,
                    revid: 0,
                    old_revid: 0,
                    rcid: 608,
                    timestamp: '2026-08-31T03:11:00Z',
                    logtype: 'delete',
                    logaction: 'delete',
                    logparams: {},
                  },
            ],
          },
        });
      }
      if (parameters.get('prop') === 'info') {
        return json({
          query: {
            pages: [
              round === 1
                ? {
                    pageid: 5,
                    ns: 0,
                    title: '删除竞态页',
                    contentmodel: 'wikitext',
                    lastrevid: 51,
                  }
                : {
                    pageid: 5,
                    ns: 0,
                    title: '删除竞态页',
                    missing: true,
                  },
            ],
          },
        });
      }
      return json({
        query: {
          pages: [{ pageid: 5, ns: 0, title: '删除竞态页', missing: true }],
        },
      });
    });
    const activePage = page({
      id: 5,
      title: '删除竞态页',
      normalizedTitle: analyzer.normalize('删除竞态页'),
      revisionId: 50,
      contentRevisionId: 50,
      content: '删除前旧正文',
    });
    const database = await databaseWithBaseline([activePage]);
    const jobId = await database.jobs.add({
      type: 'wikitext-content',
      pageId: 5,
      status: 'done',
      targetRevisionId: 50,
      updatedAt: 123,
    });
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    const firstResult = await syncRecentChanges(database, api, analyzer, {
      requestIntervalMs: 0,
    });

    expect(firstResult).toMatchObject({
      status: 'complete',
      through: '2026-08-31T03:10:00Z',
      changedPages: [],
      deferredContentPageIds: [],
      throughLocalSeq: 1,
    });
    expect(await database.pages.get(5)).toEqual(activePage);
    expect(await database.jobs.get(jobId)).toEqual({
      id: jobId,
      type: 'wikitext-content',
      pageId: 5,
      status: 'done',
      targetRevisionId: 50,
      updatedAt: 123,
    });
    expect((await database.syncState.get('recent-changes-sync'))?.value).toMatchObject({
      through: '2026-08-31T03:10:00Z',
    });

    const deleteResult = await syncRecentChanges(database, api, analyzer, {
      requestIntervalMs: 0,
    });

    expect(deleteResult).toMatchObject({
      status: 'complete',
      through: '2026-08-31T03:20:00Z',
      throughLocalSeq: 2,
    });
    expect(await database.pages.get(5)).toMatchObject({
      revisionId: 50,
      content: undefined,
      contentRevisionId: undefined,
      deleted: true,
      localSeq: 2,
    });
    expect(await database.jobs.get(jobId)).toBeUndefined();
    expect((await database.syncState.get('recent-changes-sync'))?.value).toMatchObject({
      through: '2026-08-31T03:20:00Z',
    });

    await destroy(database);
  });

  it.each([
    ['missing its revision', { pageid: 1 }],
    [
      'older than the info snapshot',
      {
        pageid: 1,
        revisions: [
          {
            revid: 11,
            slots: { main: { contentmodel: 'wikitext', content: '过期正文' } },
          },
        ],
      },
    ],
    [
      'missing its content',
      {
        pageid: 1,
        revisions: [
          { revid: 12, slots: { main: { contentmodel: 'wikitext' } } },
        ],
      },
    ],
  ] as const)(
    'does not commit pages or cursor when a required body response is %s',
    async (_case, bodyPage) => {
      const fetcher = vi.fn(async (input: RequestInfo | URL) => {
        const url = new URL(String(input), 'https://casualtiesunknown.huijiwiki.com');
        const parameters = url.searchParams;
        if (parameters.get('curtimestamp') === '1') {
          return json({
            curtimestamp: '2026-08-31T03:10:00Z',
            query: { general: {} },
          });
        }
        if (parameters.get('list') === 'recentchanges') {
          return json({
            query: {
              recentchanges: [
                {
                  type: 'edit',
                  ns: 0,
                  title: '缺正文页',
                  pageid: 1,
                  revid: 12,
                  old_revid: 11,
                  rcid: 601,
                  timestamp: '2026-08-31T03:06:00Z',
                },
              ],
            },
          });
        }
        if (parameters.get('prop') === 'info') {
          return json({
            query: {
              pages: [
                {
                  pageid: 1,
                  ns: 0,
                  title: '缺正文页',
                  contentmodel: 'wikitext',
                  lastrevid: 12,
                },
              ],
            },
          });
        }
        return json({ query: { pages: [bodyPage] } });
      });
      const database = await databaseWithBaseline([
        page({
          title: '缺正文页',
          normalizedTitle: analyzer.normalize('缺正文页'),
          revisionId: 11,
          contentRevisionId: 11,
          content: '旧正文仍应保留',
        }),
      ]);
      const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

      await expect(
        syncRecentChanges(database, api, analyzer, { requestIntervalMs: 0 }),
      ).rejects.toThrow('页面正文响应缺失');

      expect(await database.pages.get(1)).toMatchObject({
        revisionId: 11,
        contentRevisionId: 11,
        content: '旧正文仍应保留',
      });
      expect(await database.syncState.get('recent-changes-sync')).toBeUndefined();
      expect((await database.syncState.get('local-sequence'))?.value).toBe(1);

      await destroy(database);
    },
  );
});

async function databaseWithBaseline(pages: PageRecord[]): Promise<WikiSearchDatabase> {
  const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
  await database.open();
  await database.pages.bulkPut(pages);
  await database.syncState.bulkPut([
    { key: 'local-sequence', value: 1 },
    {
      key: 'title-sync',
      value: {
        status: 'complete',
        namespaceIds: [0],
        namespaceNames: { 0: '（主）' },
        namespaceIndex: 1,
        generation: 1,
        pagesFetched: pages.length,
        startedAt: Date.parse('2026-08-31T03:00:00Z'),
        completedAt: Date.parse('2026-08-31T03:00:30Z'),
      } satisfies TitleSyncState,
    },
  ]);
  return database;
}

function page(overrides: Partial<PageRecord> = {}): PageRecord {
  return {
    id: 1,
    title: '12号鹿弹',
    normalizedTitle: analyzer.normalize('12号鹿弹'),
    namespace: 0,
    namespaceName: '（主）',
    isRedirect: false,
    localSeq: 1,
    seenInTitleSync: 1,
    deleted: false,
    contentModel: 'wikitext',
    ...overrides,
  };
}

function filePage(id: number, title: string, revisionId: number): PageRecord {
  return {
    id,
    title,
    normalizedTitle: analyzer.normalize(title),
    namespace: 6,
    namespaceName: '文件',
    isRedirect: false,
    localSeq: revisionId,
    seenInTitleSync: 10,
    deleted: false,
    revisionId,
    contentModel: 'wikitext',
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

function loginRequired(): Response {
  return json({
    error: {
      code: 'assertuserfailed',
      info: 'Assertion that the user is logged in failed',
    },
  });
}
