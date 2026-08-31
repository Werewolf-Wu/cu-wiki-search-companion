// SPDX-License-Identifier: MPL-2.0
import { cut, cut_for_search } from 'jieba-wasm/node';

import { Analyzer } from '../src/analyzer/analyzer';
import { TitleIndex } from '../src/search/title-index';
import type { PageRecord } from '../src/types';

const analyzer = new Analyzer({ cut, cutForSearch: cut_for_search });

function page(id: number, title: string, namespace = 0): PageRecord {
  return {
    id,
    title,
    normalizedTitle: analyzer.normalize(title),
    namespace,
    namespaceName: namespace === 0 ? '（主）' : '模块',
    isRedirect: false,
    localSeq: id,
    seenInTitleSync: 1,
  };
}

describe('TitleIndex', () => {
  it('ranks exact and infix CJK matches', () => {
    const index = new TitleIndex(analyzer);
    index.rebuild([page(1, '12号鹿弹'), page(2, '12号霰弹弹盒'), page(3, '鹿弹')]);

    expect(index.search('鹿弹').slice(0, 2).map(({ title }) => title)).toEqual([
      '鹿弹',
      '12号鹿弹',
    ]);
  });

  it('supports traditional queries and latin mid-run queries', () => {
    const index = new TitleIndex(analyzer);
    index.rebuild([page(1, '医用级兴奋剂'), page(2, '模块:Popups', 828)]);

    expect(index.search('醫用級興奮劑')[0]?.title).toBe('医用级兴奋剂');
    expect(index.search('opu')[0]?.title).toBe('模块:Popups');
  });

  it('filters namespaces and replaces changed documents', () => {
    const index = new TitleIndex(analyzer);
    index.rebuild([page(1, '测试页面'), page(2, '模块:测试', 828)]);
    expect(index.search('测试', 828).map(({ id }) => id)).toEqual([2]);

    index.update([page(1, '重命名页面')]);
    expect(index.search('重命名')[0]?.id).toBe(1);
    expect(index.search('测试').map(({ id }) => id)).not.toContain(1);
  });

  it('uses page id as a stable tie-breaker regardless of index insertion order', () => {
    const forward = new TitleIndex(analyzer);
    const reverse = new TitleIndex(analyzer);
    const tiedPages = [page(1, '测试甲'), page(2, '测试乙')];
    forward.rebuild(tiedPages);
    reverse.rebuild([...tiedPages].reverse());

    expect(forward.search('测试').map(({ id }) => id)).toEqual([1, 2]);
    expect(reverse.search('测试').map(({ id }) => id)).toEqual([1, 2]);
  });

  it('finds a single CJK character inside a multi-character title', () => {
    const index = new TitleIndex(analyzer);
    index.rebuild([page(1, '紧急治疗指南')]);

    expect(index.search('治')[0]?.id).toBe(1);
  });

  it('preserves an update that arrives while an async rebuild is yielding', async () => {
    const index = new TitleIndex(analyzer);
    index.rebuild([page(1, '现有页面'), page(2, '第二页旧标题')]);

    const rebuilding = index.rebuildAsync(
      [page(1, '现有页面'), page(2, '第二页旧标题')],
      1,
    );
    index.update([page(2, '第二页最新标题')]);

    await expect(rebuilding).resolves.toBeUndefined();
    expect(index.search('最新标题')[0]?.id).toBe(2);
    expect(index.search('旧').map(({ id }) => id)).not.toContain(2);
  });
});
