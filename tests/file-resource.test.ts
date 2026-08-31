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
});

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
