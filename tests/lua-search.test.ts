// SPDX-License-Identifier: MPL-2.0
import 'fake-indexeddb/auto';

import { cut, cut_for_search } from 'jieba-wasm/node';

import { Analyzer } from '../src/analyzer/analyzer';
import { extractLua } from '../src/content/extract-lua';
import { ContentIndex } from '../src/search/content-index';
import { LuaModuleIndex } from '../src/search/lua-module-index';
import { WikiSearchDatabase } from '../src/storage/database';
import { syncContent } from '../src/sync/content-sync';
import { WikiApi } from '../src/sync/wiki-api';
import type { PageRecord } from '../src/types';

const analyzer = new Analyzer({ cut, cutForSearch: cut_for_search });

describe('Lua module search', () => {
  it('extracts searchable symbols without indexing commented-out code', () => {
    const extracted = extractLua(`
      -- require('Module:Fake')
      local p = {}
      local dependency = require('Module:Base/查询工具')
      local label = "其他同名条目"

      function p.render_read_error(frame)
        return {
          ok = false,
          ["error-code"] = 'malformed_record',
          [1] = "first",
          nested = { detail = true }
        }
      end

      p.alias = function()
        return label
      end

      return p
    `);

    expect(extracted.functions).toEqual(
      expect.arrayContaining(['p.render_read_error', 'p.alias']),
    );
    expect(extracted.returnKeys).toEqual(
      expect.arrayContaining(['ok', 'error-code', '1', 'nested', 'render_read_error', 'alias']),
    );
    expect(extracted.strings).toEqual(
      expect.arrayContaining([
        'Module:Base/查询工具',
        '其他同名条目',
        'malformed_record',
        'first',
      ]),
    );
    expect(extracted.dependencies).toEqual(['Module:Base/查询工具']);
    expect(extracted.searchableText).not.toContain('Module:Fake');
  });

  it('stops numeric tokens before comments and adjacent operators', () => {
    const extracted = extractLua(`
      local x=1-- "hidden line"
      local y=1--[[hidden block]]
      local z=1+require('Module:Visible')
    `);

    expect(extracted.strings).not.toContain('hidden line');
    expect(extracted.strings).not.toContain('hidden block');
    expect(extracted.dependencies).toEqual(['Module:Visible']);
  });

  it('distinguishes assignments from comparison operators when collecting returned keys', () => {
    const returnedRoot = extractLua(`
      local p = {}
      p.foo == expected
      p.bar ~= expected
      p.baz <= expected
      p.qux >= expected
      p.real = true
      return p
    `);
    const returnedTable = extractLua(`
      return {
        identifier = true,
        ["string-key"] = true,
        [7] = true,
        candidate == expected
      }
    `);

    expect(returnedRoot.returnKeys).toEqual(['real']);
    expect(returnedTable.returnKeys).toEqual(['identifier', 'string-key', '7']);
  });

  it('skips an extreme member path and continues extracting later symbols', () => {
    const extremePath = `p${Array.from(
      { length: 400 },
      (_, index) => `.member${index}`,
    ).join('')}`;
    const extracted = extractLua(`
      function ${extremePath}() end
      function p.visible() end
      local dependency = require('Module:StillVisible')
      return p
    `);

    expect(extracted.functions).toContain('p.visible');
    expect(extracted.functions).not.toContain(extremePath);
    expect(extracted.dependencies).toEqual(['Module:StillVisible']);
  });

  it('keeps structured Lua matches out of ordinary body search', () => {
    const luaPage = page(
      828,
      '模块:Base/查询工具',
      `
        local p = {}
        local helper = require('Module:Base/数据工具')
        function p.render_read_error()
          return { ["error-code"] = 'malformed_record' }
        end
        return p
      `,
      'Scribunto',
    );
    const documentation = page(
      829,
      '模块:Base/查询工具/doc',
      '这是普通说明正文。',
      'wikitext',
    );
    const luaIndex = new LuaModuleIndex(analyzer);
    const contentIndex = new ContentIndex(analyzer);

    luaIndex.rebuild([luaPage, documentation]);
    contentIndex.rebuild([luaPage, documentation]);

    expect(luaIndex.size).toBe(1);
    expect(luaIndex.search('render_read_error')[0]).toMatchObject({
      kind: 'lua',
      title: '模块:Base/查询工具',
      matches: expect.arrayContaining([
        { kind: 'function', value: 'p.render_read_error' },
      ]),
    });
    expect(luaIndex.search('error-code')[0]?.matches[0]).toEqual({
      kind: 'return-key',
      value: 'error-code',
    });
    expect(luaIndex.search('Module:Base/数据工具')[0]?.matches).toEqual(
      expect.arrayContaining([
        { kind: 'dependency', value: 'Module:Base/数据工具' },
      ]),
    );
    expect(luaIndex.search('普通说明')).toEqual([]);
    expect(contentIndex.search('malformed_record')).toEqual([]);
    expect(contentIndex.search('普通说明')[0]?.title).toBe('模块:Base/查询工具/doc');
  });

  it('ranks an exact returned key above the same text used as an ordinary string', () => {
    const stringOnly = page(
      830,
      '模块:短字符串',
      `local p = {}; local label = '_meta'; return p`,
      'Scribunto',
    );
    const generatedTable = page(
      831,
      '模块:Data/Recipes',
      `return { _meta = { version = '7.0.1' }, ${Array.from(
        { length: 400 },
        (_, index) => `["recipe.${index}"] = { id = "item.${index}" }`,
      ).join(',')} }`,
      'Scribunto',
    );
    const index = new LuaModuleIndex(analyzer);
    index.rebuild([stringOnly, generatedTable]);

    expect(index.search('_meta')[0]).toMatchObject({
      title: '模块:Data/Recipes',
      matches: [{ kind: 'return-key', value: '_meta' }],
    });
  });

  it('finds a short camelCase function segment through the public Lua search', () => {
    const index = new LuaModuleIndex(analyzer);
    index.rebuild([
      page(
        833,
        '模块:CamelCase',
        'local p = {}; function p.getId() return 1 end; return p',
        'Scribunto',
      ),
    ]);

    expect(index.search('id')[0]).toMatchObject({
      title: '模块:CamelCase',
      matches: expect.arrayContaining([{ kind: 'function', value: 'p.getId' }]),
    });
  });

  it('finds a single CJK character inside a multi-character Lua string', () => {
    const index = new LuaModuleIndex(analyzer);
    index.rebuild([
      page(834, '模块:中文字符串', `return { label = '诊断字符串' }`, 'Scribunto'),
    ]);

    expect(index.search('串')[0]?.id).toBe(834);
  });

  it('preserves a Lua update that arrives while an async rebuild is yielding', async () => {
    const index = new LuaModuleIndex(analyzer);
    const oldPages = [
      page(835, '模块:First', `return { label = '稳定符号' }`, 'Scribunto'),
      page(836, '模块:Second', `return { label = '过时符号' }`, 'Scribunto'),
    ];
    index.rebuild(oldPages);

    const rebuilding = index.rebuildAsync(oldPages, 1);
    index.update([
      page(836, '模块:Second', `return { label = '并发最新符号' }`, 'Scribunto'),
    ]);

    await expect(rebuilding).resolves.toBeUndefined();
    expect(index.search('最新符号').map(({ id }) => id)).toContain(836);
    expect(index.search('过时').map(({ id }) => id)).not.toContain(836);
  });

  it('uses the cooperative scheduler between Lua rebuild batches', async () => {
    const scheduler = { yield: vi.fn(async () => undefined) };
    const index = new LuaModuleIndex(analyzer, scheduler);

    await index.rebuildAsync(
      [
        page(837, '模块:One', `return { one = '一' }`, 'Scribunto'),
        page(838, '模块:Two', `return { two = '二' }`, 'Scribunto'),
      ],
      1,
    );

    expect(scheduler.yield).toHaveBeenCalledTimes(2);
  });

  it('indexes the final entry in a large generated return table', () => {
    const generatedSource = `return { ${Array.from(
      { length: 3_000 },
      (_, index) =>
        `["recipe.${index}"] = { id = "item.${index}", label = "配方 ${index}" }`,
    ).join(',')} }`;
    const index = new LuaModuleIndex(analyzer);

    index.rebuild([page(832, '模块:Data/大型生成表', generatedSource, 'Scribunto')]);

    expect(index.search('recipe.2999')[0]?.title).toBe('模块:Data/大型生成表');
  });

  it('syncs Scribunto through the shared 50-page content queue while excluding CSS', async () => {
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
                slots: {
                  main: {
                    contentmodel: id === 2 ? 'Scribunto' : 'wikitext',
                    content: id === 2 ? 'local p = {}; function p.main() end; return p' : '正文',
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
      page(1, '普通页面', '', 'wikitext'),
      page(2, '模块:About', '', 'Scribunto'),
      page(3, 'MediaWiki:Common.css', '', 'css'),
    ]);
    await database.pages.toCollection().modify({ content: undefined, contentRevisionId: undefined });
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 0 });

    const progress = await syncContent(database, api, { requestIntervalMs: 0 });

    expect(progress).toEqual({ total: 2, done: 2, pending: 0, failed: 0 });
    expect(calls).toEqual([[1, 2]]);
    expect((await database.pages.get(2))?.contentModel).toBe('Scribunto');

    database.close();
    await database.delete();
  });
});

function page(
  id: number,
  title: string,
  content: string,
  contentModel: string,
): PageRecord {
  return {
    id,
    title,
    normalizedTitle: analyzer.normalize(title),
    namespace: 828,
    namespaceName: '模块',
    isRedirect: false,
    localSeq: id,
    seenInTitleSync: 1,
    revisionId: id * 10,
    contentRevisionId: id * 10,
    contentModel,
    content,
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
