// SPDX-License-Identifier: MPL-2.0
import 'fake-indexeddb/auto';

import { WikiSearchDatabase } from '../src/storage/database';
import {
  CACHE_VERSION_CONTRACT_KEY,
  CURRENT_VERSION_CONTRACT,
  createCompatibilityKey,
  initializeVersionContract,
  type CacheVersionContract,
} from '../src/storage/version-contract';

describe('cache version contract', () => {
  it('uses analyzer pipeline v2 for CJK unigram indexes', () => {
    expect(CURRENT_VERSION_CONTRACT.analyzerPipeline).toBe(2);
  });

  it('bumps only the corrected wikitext and Lua extractor contracts', () => {
    expect(CURRENT_VERSION_CONTRACT).toMatchObject({
      databaseSchema: 3,
      pageFacts: 1,
      contentJobFormat: 1,
      extractors: { wikitext: 2, bson: 1, lua: 2 },
      indexes: { title: 1, content: 1, lua: 1 },
    });
  });

  it('registers known schema-v3 legacy data without deleting facts, jobs, or cursors', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put({
      id: 1,
      title: '医疗指导',
      normalizedTitle: '医疗指导',
      namespace: 0,
      namespaceName: '（主）',
      isRedirect: false,
      localSeq: 7,
      seenInTitleSync: 1,
    });
    await database.jobs.put({ type: 'wikitext-content', pageId: 1, status: 'pending' });
    await database.syncState.bulkPut([
      { key: 'local-sequence', value: 7 },
      { key: 'recent-changes-sync', value: { through: 'rc-cursor', completedAt: 10 } },
      { key: 'reconciliation-sync', value: { status: 'complete', completedAt: 20 } },
    ]);

    const result = await initializeVersionContract(database);

    expect(result).toMatchObject({ status: 'compatible', registeredLegacy: true });
    expect(await database.pages.count()).toBe(1);
    expect(await database.jobs.count()).toBe(1);
    expect((await database.syncState.get('recent-changes-sync'))?.value).toMatchObject({
      through: 'rc-cursor',
    });
    expect((await database.syncState.get('reconciliation-sync'))?.value).toMatchObject({
      completedAt: 20,
    });
    expect((await database.syncState.get(CACHE_VERSION_CONTRACT_KEY))?.value).toEqual(
      CURRENT_VERSION_CONTRACT,
    );

    database.close();
    await database.delete();
  });

  it('invalidates only indexes affected by an analyzer or extractor change', () => {
    const current = CURRENT_VERSION_CONTRACT;
    const analyzerChanged: CacheVersionContract = {
      ...current,
      analyzerPipeline: current.analyzerPipeline + 1,
    };
    const wikitextChanged: CacheVersionContract = {
      ...current,
      extractors: { ...current.extractors, wikitext: current.extractors.wikitext + 1 },
    };
    const bsonChanged: CacheVersionContract = {
      ...current,
      extractors: { ...current.extractors, bson: current.extractors.bson + 1 },
    };
    const luaChanged: CacheVersionContract = {
      ...current,
      extractors: { ...current.extractors, lua: current.extractors.lua + 1 },
    };

    for (const kind of ['title', 'content', 'lua'] as const) {
      expect(createCompatibilityKey(kind, 'jieba-wasm', analyzerChanged)).not.toBe(
        createCompatibilityKey(kind, 'jieba-wasm', current),
      );
    }
    expect(createCompatibilityKey('title', 'jieba-wasm', wikitextChanged)).toBe(
      createCompatibilityKey('title', 'jieba-wasm', current),
    );
    expect(createCompatibilityKey('content', 'jieba-wasm', wikitextChanged)).not.toBe(
      createCompatibilityKey('content', 'jieba-wasm', current),
    );
    expect(createCompatibilityKey('content', 'jieba-wasm', bsonChanged)).not.toBe(
      createCompatibilityKey('content', 'jieba-wasm', current),
    );
    expect(createCompatibilityKey('lua', 'jieba-wasm', wikitextChanged)).toBe(
      createCompatibilityKey('lua', 'jieba-wasm', current),
    );
    expect(createCompatibilityKey('lua', 'jieba-wasm', luaChanged)).not.toBe(
      createCompatibilityKey('lua', 'jieba-wasm', current),
    );
  });

  it('does not rewrite an equivalent contract whose keys were stored in another order', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    const current = CURRENT_VERSION_CONTRACT;
    const reordered: CacheVersionContract = {
      libraries: {
        jieba: current.libraries.jieba,
        minisearch: current.libraries.minisearch,
      },
      dataCodeFormat: current.dataCodeFormat,
      indexes: {
        lua: current.indexes.lua,
        content: current.indexes.content,
        title: current.indexes.title,
      },
      extractors: {
        lua: current.extractors.lua,
        bson: current.extractors.bson,
        wikitext: current.extractors.wikitext,
      },
      analyzerPipeline: current.analyzerPipeline,
      contentJobFormat: current.contentJobFormat,
      pageFacts: current.pageFacts,
      databaseSchema: current.databaseSchema,
    };
    await database.syncState.put({ key: CACHE_VERSION_CONTRACT_KEY, value: reordered });
    const put = vi.spyOn(database.syncState, 'put');

    await expect(initializeVersionContract(database)).resolves.toMatchObject({
      status: 'compatible',
      registeredLegacy: false,
      migrated: false,
    });
    expect(put).not.toHaveBeenCalled();

    database.close();
    await database.delete();
  });

  it('marks a newer local fact format incompatible without changing stored data', async () => {
    const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
    await database.open();
    await database.pages.put({
      id: 9,
      title: '未来页面',
      normalizedTitle: '未来页面',
      namespace: 0,
      namespaceName: '（主）',
      isRedirect: false,
      localSeq: 1,
      seenInTitleSync: 1,
    });
    await database.syncState.put({
      key: CACHE_VERSION_CONTRACT_KEY,
      value: {
        ...CURRENT_VERSION_CONTRACT,
        pageFacts: CURRENT_VERSION_CONTRACT.pageFacts + 1,
      },
    });

    await expect(initializeVersionContract(database)).resolves.toMatchObject({
      status: 'incompatible',
    });
    expect(await database.pages.count()).toBe(1);

    database.close();
    await database.delete();
  });

  it.each([
    ['NaN', Number.NaN],
    ['negative', -1],
    ['fraction', 1.5],
    ['unsafe', Number.MAX_SAFE_INTEGER + 1],
  ])('rejects %s values in every numeric contract field', async (_label, invalid) => {
    const corruptContracts: CacheVersionContract[] = [
      { ...CURRENT_VERSION_CONTRACT, databaseSchema: invalid },
      { ...CURRENT_VERSION_CONTRACT, pageFacts: invalid },
      { ...CURRENT_VERSION_CONTRACT, contentJobFormat: invalid },
      { ...CURRENT_VERSION_CONTRACT, analyzerPipeline: invalid },
      { ...CURRENT_VERSION_CONTRACT, dataCodeFormat: invalid },
      {
        ...CURRENT_VERSION_CONTRACT,
        extractors: { ...CURRENT_VERSION_CONTRACT.extractors, wikitext: invalid },
      },
      {
        ...CURRENT_VERSION_CONTRACT,
        extractors: { ...CURRENT_VERSION_CONTRACT.extractors, bson: invalid },
      },
      {
        ...CURRENT_VERSION_CONTRACT,
        extractors: { ...CURRENT_VERSION_CONTRACT.extractors, lua: invalid },
      },
      {
        ...CURRENT_VERSION_CONTRACT,
        indexes: { ...CURRENT_VERSION_CONTRACT.indexes, title: invalid },
      },
      {
        ...CURRENT_VERSION_CONTRACT,
        indexes: { ...CURRENT_VERSION_CONTRACT.indexes, content: invalid },
      },
      {
        ...CURRENT_VERSION_CONTRACT,
        indexes: { ...CURRENT_VERSION_CONTRACT.indexes, lua: invalid },
      },
    ];

    for (const contract of corruptContracts) {
      const database = new WikiSearchDatabase(`test-${crypto.randomUUID()}`);
      await database.open();
      await database.syncState.put({ key: CACHE_VERSION_CONTRACT_KEY, value: contract });

      await expect(initializeVersionContract(database)).resolves.toMatchObject({
        status: 'incompatible',
      });

      database.close();
      await database.delete();
    }
  });
});
