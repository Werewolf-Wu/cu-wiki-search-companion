// SPDX-License-Identifier: MPL-2.0
import { cut, cut_for_search } from 'jieba-wasm/node';

import { Analyzer, bigrams, latinParts, latinRuns } from '../src/analyzer/analyzer';

const analyzer = new Analyzer({ cut, cutForSearch: cut_for_search });

describe('Analyzer', () => {
  it('normalizes width, case and traditional Chinese', () => {
    expect(analyzer.normalize(' ＭＯＤ　安裝教學 ')).toBe('mod 安装教学');
    expect(analyzer.compact('L.R.D. 血清')).toBe('lrd血清');
  });

  it('adds CJK bigrams and jieba search tokens to documents', () => {
    const tokens = analyzer.documentTokens('医用级兴奋剂');
    expect(tokens).toEqual(expect.arrayContaining(['医用', '兴奋', '奋剂']));
  });

  it('keeps a lone CJK character as the only query token', () => {
    expect(analyzer.queryTokens('鹿')).toEqual(['鹿']);
  });

  it('supports latin infix matching with 3-grams', () => {
    expect(latinParts('Popups')).toContain('opu');
    expect(latinRuns('模块:Foo.bar-test')).toEqual(['Foo.bar', 'test']);
  });

  it('creates Unicode-safe CJK bigrams', () => {
    expect(bigrams('鹿弹')).toEqual(['鹿弹']);
  });
});
