// SPDX-License-Identifier: MPL-2.0
import { describe, expect, it } from 'vitest';

import { Analyzer, createBootstrapSegmenter } from '../analyzer/analyzer';
import type { PageRecord } from '../types';
import { CombinedTitleIndex, LinearTitleIndex, type TitleSearchBackend } from './title-index';

const analyzer = new Analyzer(createBootstrapSegmenter());
const pages: PageRecord[] = [
  page(1, '12号鹿弹', 0, ''),
  page(2, '模板:PopupNotice', 10, '模板'),
  page(3, '鹿弹', 0, ''),
  { ...page(4, '已删除标题', 0, ''), deleted: true },
];

describe('LinearTitleIndex', () => {
  it('is immediately searchable by Chinese substring and ranks exact titles first', () => {
    const index = new LinearTitleIndex(analyzer, pages);

    expect(index.search('鹿彈').map((result) => result.title)).toEqual(['鹿弹', '12号鹿弹']);
  });

  it('supports Latin infixes and namespace filtering', () => {
    const index = new LinearTitleIndex(analyzer, pages);

    expect(index.search('opu', 10).map((result) => result.title)).toEqual([
      '模板:PopupNotice',
    ]);
    expect(index.search('opu', 0)).toEqual([]);
  });

  it('keeps direct fallback matches when the enhanced index misses', () => {
    const emptyPrimary: TitleSearchBackend = { size: pages.length, search: () => [] };
    const index = new CombinedTitleIndex(
      emptyPrimary,
      new LinearTitleIndex(analyzer, pages),
    );

    expect(index.search('鹿弹')[0]?.title).toBe('鹿弹');
  });
});

function page(id: number, title: string, namespace: number, namespaceName: string): PageRecord {
  return {
    id,
    title,
    normalizedTitle: analyzer.normalize(title),
    namespace,
    namespaceName,
    isRedirect: false,
    localSeq: id,
    seenInTitleSync: 1,
  };
}
