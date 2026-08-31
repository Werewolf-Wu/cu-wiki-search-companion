// SPDX-License-Identifier: MPL-2.0
import 'fake-indexeddb/auto';

import { cut, cut_for_search } from 'jieba-wasm/node';

import { Analyzer } from '../src/analyzer/analyzer';
import { extractContent } from '../src/content/extract-content';
import { extractWikitext } from '../src/content/extract-wikitext';
import { ContentIndex } from '../src/search/content-index';
import { WikiSearchDatabase } from '../src/storage/database';
import { prepareContentJobs, syncContent } from '../src/sync/content-sync';
import { WikiApi } from '../src/sync/wiki-api';
import type { PageRecord } from '../src/types';

const analyzer = new Analyzer({ cut, cutForSearch: cut_for_search });

describe('wikitext content search', () => {
  it('keeps visible links and language variants while removing hidden markup', () => {
    const extracted = extractWikitext(`
      <!-- 不应索引 -->
      == 医疗 ==
      [[医用级兴奋剂|强效兴奋剂]]用于-{zh-hans:急救;zh-hant:急救處置}-。
      {{物品信息框|代码=highgradestimulant}}
      <ref>隐藏来源文字</ref>
    `);

    expect(extracted).toContain('医用级兴奋剂 强效兴奋剂');
    expect(extracted).toContain('急救 急救處置');
    expect(extracted).toContain('highgradestimulant');
    expect(extracted).not.toContain('不应索引');
    expect(extracted).not.toContain('隐藏来源文字');
  });

  it('extracts deeply nested BSON without exhausting the JavaScript call stack', () => {
    const depth = 12_000;
    const source = `${'{"level":'.repeat(depth)}"deepMarker"${'}'.repeat(depth)}`;

    expect(extractContent('BSON', source)).toContain('deepMarker');
  });

  it('indexes extracted body text and returns a useful snippet', () => {
    const index = new ContentIndex(analyzer);
    index.rebuild([
      page(1, '医疗指导', '使用[[医用级兴奋剂]]可以进行紧急救治。'),
      page(2, '武器指导', '手枪使用九毫米子弹。'),
    ]);

    expect(index.search('紧急救治')[0]).toMatchObject({
      kind: 'content',
      title: '医疗指导',
      snippet: expect.stringContaining('紧急救治'),
    });
  });

  it('centers snippets on traditional and full-width query matches', () => {
    const index = new ContentIndex(analyzer);
    const distantPrefix = '无关前言'.repeat(30);
    index.rebuild([
      page(1, '繁简页面', `${distantPrefix}紧急救治发生在这里。`),
      page(2, '全角页面', `${distantPrefix}设备编号 ABC123 位于这里。`),
    ]);

    expect(index.search('緊急救治')[0]?.snippet).toContain('紧急救治');
    expect(index.search('ＡＢＣ１２３')[0]?.snippet).toContain('ABC123');
  });

  it('fetches wikitext and BSON in ordinary-user-sized batches and resumes from cache', async () => {
    const calls: URL[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://casualtiesunknown.huijiwiki.com');
      calls.push(url);
      const ids = (url.searchParams.get('pageids') ?? '').split('|').map(Number);
      return json({
        query: {
          pages: ids.map((id) => ({
            pageid: id,
            ns: 0,
            title: id === 1 ? '医疗指导' : '武器指导',
            revisions: [
              {
                revid: id * 10,
                slots: {
                  main: {
                    contentmodel: id === 3 ? 'BSON' : 'wikitext',
                    content:
                      id === 1
                        ? '紧急救治正文'
                        : id === 2
                          ? '手枪正文'
                          : '{"id":"pistol","description":"半自动手枪"}',
                  },
                },
              },
            ],
          })),
        },
      });
    });
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.bulkPut([
      page(1, '医疗指导', undefined, 10),
      page(2, '武器指导', undefined, 20),
      { ...page(3, 'Data:Item/pistol.json', undefined, 30), contentModel: 'BSON' },
      { ...page(4, '旧标题', undefined, 40), isRedirect: true },
      { ...page(5, 'MediaWiki:Common.css', undefined, 50), contentModel: 'css' },
    ]);
    await database.syncState.put({ key: 'local-sequence', value: 5 });
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });
    const indexedBatches: number[][] = [];

    const first = await syncContent(database, api, {
      requestIntervalMs: 0,
      onBatch: (pages) => {
        indexedBatches.push(pages.map(({ id }) => id));
      },
    });
    const second = await syncContent(database, api, { requestIntervalMs: 0 });

    expect(first).toEqual({ total: 3, done: 3, pending: 0, failed: 0 });
    expect(second).toEqual(first);
    expect(calls).toHaveLength(1);
    expect((calls[0]!.searchParams.get('pageids') ?? '').split('|')).toHaveLength(3);
    expect(calls[0]!.searchParams.get('rvprop')).toBe('ids|content');
    expect(calls[0]!.searchParams.has('rvlimit')).toBe(false);
    expect(indexedBatches).toEqual([[1, 2, 3]]);
    expect((await database.pages.get(1))?.content).toBe('紧急救治正文');
    expect((await database.pages.get(1))?.contentRevisionId).toBe(10);
    expect((await database.pages.get(1))?.localSeq).toBe(6);
    expect((await database.pages.get(2))?.localSeq).toBe(7);
    expect((await database.pages.get(3))?.localSeq).toBe(8);
    expect((await database.syncState.get('local-sequence'))?.value).toBe(8);
    expect((await database.pages.get(3))?.content).toContain('半自动手枪');
    expect(await database.jobs.count()).toBe(3);

    database.close();
    await database.delete();
  });

  it('does not advance the local sequence when a forced response repeats identical content', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '相同正文', '没有变化', 10));
    await database.syncState.put({ key: 'local-sequence', value: 4 });
    const api = new WikiApi({
      fetcher: vi.fn(async () =>
        json({
          query: {
            pages: [
              {
                pageid: 1,
                revisions: [
                  {
                    revid: 10,
                    slots: { main: { contentmodel: 'wikitext', content: '没有变化' } },
                  },
                ],
              },
            ],
          },
        }),
      ) as typeof fetch,
      retries: 0,
    });

    await syncContent(database, api, { force: true, requestIntervalMs: 0 });

    expect((await database.pages.get(1))?.localSeq).toBe(1);
    expect((await database.syncState.get('local-sequence'))?.value).toBe(4);

    database.close();
    await database.delete();
  });

  it('rolls back both content and sequence when their commit fails', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '原子写入', undefined, 10));
    await database.syncState.put({ key: 'local-sequence', value: 3 });
    await prepareContentJobs(database, false);
    const originalPut = database.syncState.put.bind(database.syncState);
    vi.spyOn(database.syncState, 'put').mockImplementation((record) => {
      if (record.key === 'local-sequence') throw new Error('模拟序列写入失败');
      return originalPut(record);
    });
    const api = new WikiApi({
      fetcher: vi.fn(async () =>
        json({
          query: {
            pages: [
              {
                pageid: 1,
                revisions: [
                  {
                    revid: 10,
                    slots: { main: { contentmodel: 'wikitext', content: '新正文' } },
                  },
                ],
              },
            ],
          },
        }),
      ) as typeof fetch,
      retries: 0,
    });

    await expect(syncContent(database, api, { requestIntervalMs: 0 })).rejects.toThrow(
      '模拟序列写入失败',
    );

    expect(await database.pages.get(1)).toMatchObject({
      content: undefined,
      contentRevisionId: undefined,
      localSeq: 1,
    });
    expect((await database.syncState.get('local-sequence'))?.value).toBe(3);

    database.close();
    await database.delete();
  });

  it('does not overwrite a newer revision job created while jobs are being prepared', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '准备竞态', '旧正文', 10));
    const writerDatabase = new WikiSearchDatabase(database.name);
    await writerDatabase.open();
    const jobId = await database.jobs.add({
      type: 'wikitext-content',
      pageId: 1,
      status: 'done',
      targetRevisionId: 10,
    });
    const originalFilter = database.jobs.filter.bind(database.jobs);
    let concurrentWrite: Promise<void> | undefined;
    vi.spyOn(database.jobs, 'filter').mockImplementation((predicate) => {
      const collection = originalFilter(predicate);
      if (concurrentWrite) return collection;
      const originalToArray = collection.toArray.bind(collection);
      vi.spyOn(collection, 'toArray').mockImplementation(
        (async () => {
          const jobs = await originalToArray();
          concurrentWrite = writerDatabase.transaction(
            'rw',
            writerDatabase.pages,
            writerDatabase.jobs,
            async () => {
              await writerDatabase.pages.update(1, { revisionId: 20 });
              await writerDatabase.jobs.put({
                id: jobId,
                type: 'wikitext-content',
                pageId: 1,
                status: 'pending',
                targetRevisionId: 20,
              });
            },
          );
          return jobs;
        }) as never,
      );
      return collection;
    });

    await prepareContentJobs(database, false);
    await concurrentWrite;

    expect(await database.pages.get(1)).toMatchObject({ revisionId: 20 });
    expect(await database.jobs.get(jobId)).toMatchObject({
      status: 'pending',
      targetRevisionId: 20,
    });

    writerDatabase.close();
    database.close();
    await database.delete();
  });

  it('removes jobs when a page no longer has a searchable content model', async () => {
    const calls: number[][] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://casualtiesunknown.huijiwiki.com');
      const ids = (url.searchParams.get('pageids') ?? '').split('|').map(Number);
      calls.push(ids);
      return json({
        query: {
          pages: ids.map((id) => ({
            pageid: id,
            revisions: [
              {
                revid: id * 10,
                slots: { main: { contentmodel: 'wikitext', content: `正文 ${id}` } },
              },
            ],
          })),
        },
      });
    });
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.bulkPut([
      page(1, '保留页面', undefined, 10),
      { ...page(2, 'Data:Item/removed.json', undefined, 20), contentModel: 'BSON' },
    ]);
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    await syncContent(database, api, { requestIntervalMs: 0 });
    await database.pages.update(2, { contentModel: 'css' });
    const afterModelChange = await syncContent(database, api, { requestIntervalMs: 0 });

    expect(afterModelChange).toEqual({ total: 1, done: 1, pending: 0, failed: 0 });
    expect(calls).toEqual([[1, 2]]);

    database.close();
    await database.delete();
  });

  it('resumes at the remaining batch after a later request fails', async () => {
    const calls: number[][] = [];
    let failSecondBatch = true;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://casualtiesunknown.huijiwiki.com');
      const ids = (url.searchParams.get('pageids') ?? '').split('|').map(Number);
      calls.push(ids);
      if (ids[0] === 51 && failSecondBatch) {
        failSecondBatch = false;
        throw new Error('模拟第二批网络中断');
      }
      return json({
        query: {
          pages: ids.map((id) => ({
            pageid: id,
            revisions: [
              {
                revid: id * 10,
                slots: { main: { contentmodel: 'wikitext', content: `正文 ${id}` } },
              },
            ],
          })),
        },
      });
    });
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.bulkPut(
      Array.from({ length: 51 }, (_, offset) =>
        page(offset + 1, `测试页面 ${offset + 1}`, undefined, (offset + 1) * 10),
      ),
    );
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    await expect(syncContent(database, api, { requestIntervalMs: 0 })).rejects.toThrow(
      '模拟第二批网络中断',
    );
    const resumed = await syncContent(database, api, { requestIntervalMs: 0 });

    expect(calls.map((ids) => [ids[0], ids.at(-1), ids.length])).toEqual([
      [1, 50, 50],
      [51, 51, 1],
      [51, 51, 1],
    ]);
    expect(resumed).toEqual({ total: 51, done: 51, pending: 0, failed: 0 });

    database.close();
    await database.delete();
  });

  it('only restores jobs claimed by the failing content sync', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '失败批次', undefined, 10));
    let otherJobId: number | undefined;
    const fetcher = vi.fn(async () => {
      otherJobId = await database.jobs.add({
        type: 'wikitext-content',
        pageId: 99,
        status: 'running',
        targetRevisionId: 990,
        updatedAt: Date.now(),
      });
      throw new Error('模拟当前批次网络中断');
    });
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    await expect(syncContent(database, api, { requestIntervalMs: 0 })).rejects.toThrow(
      '模拟当前批次网络中断',
    );

    expect(
      await database.jobs.filter((job) => job.pageId === 1).first(),
    ).toMatchObject({ status: 'pending', targetRevisionId: 10 });
    expect(await database.jobs.get(otherJobId)).toMatchObject({
      status: 'running',
      targetRevisionId: 990,
    });

    database.close();
    await database.delete();
  });

  it('rejects a stale revision response without rolling cached content backward', async () => {
    const fetcher = vi.fn(async () =>
      json({
        query: {
          pages: [
            {
              pageid: 1,
              revisions: [
                {
                  revid: 15,
                  slots: { main: { contentmodel: 'wikitext', content: '较旧响应正文' } },
                },
              ],
            },
          ],
        },
      }),
    );
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(
      page(1, '竞态页面', 'RC 已写入的新正文', 20),
    );
    await database.pages.update(1, { contentRevisionId: 10 });
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    await expect(
      syncContent(database, api, { requestIntervalMs: 0 }),
    ).rejects.toThrow('正文响应版本落后');

    expect(await database.pages.get(1)).toMatchObject({
      revisionId: 20,
      contentRevisionId: 10,
      content: 'RC 已写入的新正文',
    });
    expect(
      await database.jobs.filter((job) => job.pageId === 1).first(),
    ).toMatchObject({ status: 'pending', targetRevisionId: 20 });

    database.close();
    await database.delete();
  });

  it('does not recreate a content job after an incremental delete wins the race', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put(page(1, '同步中删除', '旧正文', 10));
    const fetcher = vi.fn(async () => {
      await database.transaction('rw', database.pages, database.jobs, async () => {
        const stored = await database.pages.get(1);
        if (!stored) throw new Error('测试页面缺失');
        await database.pages.put({
          ...stored,
          deleted: true,
          content: undefined,
          contentRevisionId: undefined,
          localSeq: 2,
        });
        const jobIds = await database.jobs
          .filter((job) => job.pageId === 1)
          .primaryKeys();
        await database.jobs.bulkDelete(jobIds);
      });
      return json({
        query: {
          pages: [
            {
              pageid: 1,
              revisions: [
                {
                  revid: 10,
                  slots: { main: { contentmodel: 'wikitext', content: '过期响应正文' } },
                },
              ],
            },
          ],
        },
      });
    });
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    await syncContent(database, api, { force: true, requestIntervalMs: 0 });

    expect(await database.pages.get(1)).toMatchObject({
      deleted: true,
      content: undefined,
      contentRevisionId: undefined,
    });
    expect(await database.jobs.filter((job) => job.pageId === 1).count()).toBe(0);

    database.close();
    await database.delete();
  });
});

describe('BSON content search', () => {
  it('indexes JSON keys and scalar values from Data pages', () => {
    const source = JSON.stringify({
      id: 'bricks',
      locales: {
        'zh-CN': {
          name: '砖块',
          description: '可用于搭建耐火墙体',
        },
      },
      properties: { blastResistance: 12.5, craftable: true },
    });

    expect(extractContent('BSON', source)).toBe(
      'id bricks locales zh-CN name 砖块 description 可用于搭建耐火墙体 properties blastResistance 12.5 craftable true',
    );

    const index = new ContentIndex(analyzer);
    index.rebuild([
      {
        ...page(3500, 'Data:Block/bricks.json', source, 24680),
        namespace: 3500,
        namespaceName: 'Data',
        contentModel: 'BSON',
      },
    ]);

    expect(index.search('耐火墙体')[0]).toMatchObject({
      kind: 'content',
      title: 'Data:Block/bricks.json',
      snippet: expect.stringContaining('耐火墙体'),
    });
    expect(index.search('blastResistance')[0]?.title).toBe('Data:Block/bricks.json');
  });

});

function page(
  id: number,
  title: string,
  content?: string,
  revisionId = id * 10,
): PageRecord {
  return {
    id,
    title,
    normalizedTitle: analyzer.normalize(title),
    namespace: 0,
    namespaceName: '（主）',
    isRedirect: false,
    revisionId,
    contentModel: 'wikitext',
    content,
    contentRevisionId: content === undefined ? undefined : revisionId,
    localSeq: id,
    seenInTitleSync: 1,
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
