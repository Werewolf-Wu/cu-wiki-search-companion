// SPDX-License-Identifier: MPL-2.0
import 'fake-indexeddb/auto';

import { cut, cut_for_search } from 'jieba-wasm/node';

import { Analyzer } from '../src/analyzer/analyzer';
import {
  DEFAULT_DATA_CODE_RULES,
  dataFieldProjection,
  parseDataFieldRules,
  upgradeDefaultDataCodeRules,
} from '../src/data/data-field-rules';
import { DataCodeIndex } from '../src/search/data-code-index';
import { WikiSearchDatabase } from '../src/storage/database';
import { parseDataCodeResponse, syncDataCodes } from '../src/sync/data-code-sync';

const analyzer = new Analyzer({ cut, cutForSearch: cut_for_search });
const LEGACY_DEFAULT_DATA_CODE_RULES = `# jq 风格路径子集；所选路径的标量值会用于查找对应代码名
Block = .locales["zh-CN"].name
Entity = .locales["zh-CN"].name, .locales["zh-CN"].description
Editor = .locales["zh-CN"].name, .locales["zh-CN"].description
Item = .locales["zh-CN"].name, .locales["zh-CN"].description
Liquid = .locales["zh-CN"].name
Localization = .locales["zh-CN"].name, .locales["zh-CN"].description
Moodle = .locales["zh-CN"].name, .locales["zh-CN"].description
WorldFluid = .locales["zh-CN"].name, .locales["zh-CN"].description
* = .locales["zh-CN"].name`;

describe('Data code lookup', () => {
  it('upgrades the exact legacy default rules', () => {
    expect(upgradeDefaultDataCodeRules(LEGACY_DEFAULT_DATA_CODE_RULES)).toBe(
      DEFAULT_DATA_CODE_RULES,
    );
    expect(upgradeDefaultDataCodeRules(undefined)).toBeUndefined();
  });

  it('preserves custom Data code rules byte for byte', () => {
    const custom = LEGACY_DEFAULT_DATA_CODE_RULES.replace(
      'Block = .locales["zh-CN"].name',
      'Block = .locales["zh-CN"].name, .stats.health',
    );

    expect(upgradeDefaultDataCodeRules(custom)).toBe(custom);
  });

  it('treats whitespace or comment edits as custom rules', () => {
    const editedSources = [
      LEGACY_DEFAULT_DATA_CODE_RULES.replace('Block =', 'Block  ='),
      LEGACY_DEFAULT_DATA_CODE_RULES.replace('# jq', '# 自定义 jq'),
    ];

    for (const source of editedSources) {
      expect(upgradeDefaultDataCodeRules(source)).toBe(source);
    }
  });

  it('finds top-level codes through default Wiki zh-CN names', () => {
    const rules = parseDataFieldRules(DEFAULT_DATA_CODE_RULES);
    const records = parseDataCodeResponse(
      {
        _returned: 2,
        _embedded: [
          {
            _id: 'Data:Entity/beartrap.json',
            id: 'beartrap',
            locales: { 'zh-CN': { name: '老旧机械' } },
            wiki: { locales: { 'zh-CN': { name: '捕兽夹' } } },
          },
          {
            _id: 'Data:Liquid/urine.json',
            id: 'urine',
            locales: { 'zh-CN': { name: '柠檬水' } },
            wiki: { locales: { 'zh-CN': { name: '柠檬水（尿）' } } },
          },
        ],
      },
      analyzer,
      123,
      rules,
    );
    const index = new DataCodeIndex(analyzer, records);

    expect(dataFieldProjection(rules)).toMatchObject({
      'wiki.locales.zh-CN.name': 1,
    });
    expect(records[0]?.normalizedSearchValues).toContain(analyzer.normalize('捕兽夹'));
    expect(records[1]?.normalizedSearchValues).toContain(
      analyzer.normalize('柠檬水（尿）'),
    );
    expect(index.search('捕兽夹')[0]).toMatchObject({
      code: 'beartrap',
      chineseName: '老旧机械',
    });
    expect(index.search('尿')[0]).toMatchObject({
      code: 'urine',
      chineseName: '柠檬水',
    });
  });

  it('extracts zh-CN names and finds their code names locally', () => {
    const rules = parseDataFieldRules(`
      Item = .locales["zh-CN"].name, .locales["zh-CN"].description, .properties.searchAliases[]
      Liquid = .locales["zh-CN"].name
      * = .locales["zh-CN"].name
    `);
    const records = parseDataCodeResponse(
      {
        _returned: 3,
        _embedded: [
          {
            ...document('Data:Item/pistol.json', 'pistol', '手枪'),
            locales: { 'zh-CN': { name: '手枪', description: '最常见的随身枪械' } },
            properties: { searchAliases: ['半自动武器', '随身枪械'], internalNote: '不要命中' },
          },
          document('Data:Item/smallmagazine.json', 'smallmagazine', '手枪弹匣'),
          document('Data:Liquid/morphine.json', 'morphine', '吗啡'),
          { _id: 'Data:Item/invalid.json', id: 'invalid', locales: { EN: { name: 'Invalid' } } },
        ],
      },
      analyzer,
      123,
      rules,
    );
    const index = new DataCodeIndex(analyzer, records);

    expect(records).toHaveLength(3);
    expect(index.search('手枪')[0]).toMatchObject({
      chineseName: '手枪',
      code: 'pistol',
      source: 'Data:Item/pistol.json',
      dataType: 'Item',
    });
    expect(index.search('半自动武器')[0]?.code).toBe('pistol');
    expect(index.search('不要命中')).toEqual([]);
    expect(index.search('morph')[0]?.chineseName).toBe('吗啡');
  });

  it('uses ordinary-user-sized 500-row pages and reuses the daily cache', async () => {
    const nameAndAliases = `
      Item = .locales["zh-CN"].name, .properties.searchAliases[]
      Liquid = .locales["zh-CN"].name
      * = .locales["zh-CN"].name
    `;
    const healthOnly = `
      Item = .stats.health
      Liquid = .stats.health
      * = .stats.health
    `;
    const calls: URL[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://casualtiesunknown.huijiwiki.com');
      calls.push(url);
      const page = Number(url.searchParams.get('page'));
      return json({
        _id: 'casualtiesunknown',
        _returned: page === 1 ? 500 : 1,
        _embedded:
          page === 1
            ? [document('Data:Item/pistol.json', 'pistol', '手枪')]
            : [document('Data:Liquid/morphine.json', 'morphine', '吗啡')],
      });
    });
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);

    const first = await syncDataCodes(database, analyzer, {
      fetcher: fetcher as typeof fetch,
      retries: 0,
      rulesSource: nameAndAliases,
    });
    const second = await syncDataCodes(database, analyzer, {
      fetcher: fetcher as typeof fetch,
      retries: 0,
      rulesSource: nameAndAliases,
    });
    const afterRuleChange = await syncDataCodes(database, analyzer, {
      fetcher: fetcher as typeof fetch,
      retries: 0,
      rulesSource: healthOnly,
    });

    expect(first.refreshed).toBe(true);
    expect(first.records).toHaveLength(2);
    expect(second.refreshed).toBe(false);
    expect(afterRuleChange.refreshed).toBe(true);
    expect(calls).toHaveLength(4);
    expect(calls.map((url) => url.searchParams.get('page'))).toEqual(['1', '2', '1', '2']);
    expect(calls.every((url) => url.searchParams.get('pagesize') === '500')).toBe(true);
    expect(JSON.parse(calls[0]!.searchParams.get('keys') ?? '{}')).toEqual({
      id: 1,
      'locales.zh-CN.name': 1,
      'properties.searchAliases': 1,
    });
    expect(JSON.parse(calls[2]!.searchParams.get('keys') ?? '{}')).toEqual({
      id: 1,
      'locales.zh-CN.name': 1,
      'stats.health': 1,
    });

    database.close();
    await database.delete();
  });

  it('times out a stalled Data request without clearing the existing cache', async () => {
    let requestSignal: AbortSignal | null | undefined;
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        requestSignal = init?.signal;
        return new Promise<Response>(() => undefined);
      },
    );
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.dataCodes.put({
      source: 'Data:Item/cached.json',
      code: 'cached',
      chineseName: '已缓存',
      normalizedName: '已缓存',
      dataType: 'Item',
      syncedAt: 100,
    });
    await database.syncState.put({
      key: 'data-code-sync',
      value: { syncedAt: 100, count: 1, indexVersion: 2 },
    });
    const outcome = syncDataCodes(database, analyzer, {
      fetcher: fetcher as typeof fetch,
      force: true,
      requestTimeoutMs: 10,
      retries: 0,
    }).then(
      () => ({ status: 'resolved' as const }),
      (error: unknown) => ({
        status: 'rejected' as const,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    const guard = new Promise<{ status: 'test-guard' }>((resolve) => {
      setTimeout(() => resolve({ status: 'test-guard' }), 100);
    });

    await expect(Promise.race([outcome, guard])).resolves.toMatchObject({
      status: 'rejected',
      message: expect.stringContaining('请求超时'),
    });
    expect(requestSignal?.aborted).toBe(true);
    expect(await database.dataCodes.toArray()).toEqual([
      expect.objectContaining({ source: 'Data:Item/cached.json', code: 'cached' }),
    ]);

    database.close();
    await database.delete();
  });

  it('times out when a Data response body never finishes', async () => {
    let requestSignal: AbortSignal | null | undefined;
    const fetcher = vi.fn(
      async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        requestSignal = init?.signal;
        return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      },
    );
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.dataCodes.put({
      source: 'Data:Item/cached-body.json',
      code: 'cached-body',
      chineseName: '正文缓存',
      normalizedName: '正文缓存',
      dataType: 'Item',
      syncedAt: 100,
    });
    const outcome = syncDataCodes(database, analyzer, {
      fetcher: fetcher as typeof fetch,
      force: true,
      requestTimeoutMs: 10,
      retries: 0,
    }).then(
      () => ({ status: 'resolved' as const }),
      (error: unknown) => ({
        status: 'rejected' as const,
        message: error instanceof Error ? error.message : String(error),
      }),
    );
    const guard = new Promise<{ status: 'test-guard' }>((resolve) => {
      setTimeout(() => resolve({ status: 'test-guard' }), 100);
    });

    await expect(Promise.race([outcome, guard])).resolves.toMatchObject({
      status: 'rejected',
      message: expect.stringContaining('请求超时'),
    });
    expect(requestSignal?.aborted).toBe(true);
    expect(await database.dataCodes.toArray()).toEqual([
      expect.objectContaining({
        source: 'Data:Item/cached-body.json',
        code: 'cached-body',
      }),
    ]);

    database.close();
    await database.delete();
  });
});

function document(source: string, code: string, chineseName: string) {
  return {
    _id: source,
    id: code,
    locales: { 'zh-CN': { name: chineseName } },
  };
}

function json(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}
