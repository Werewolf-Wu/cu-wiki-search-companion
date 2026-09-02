// SPDX-License-Identifier: MPL-2.0
import type { WikiSearchDatabase } from './database';

export const CACHE_VERSION_CONTRACT_KEY = 'cache-version-contract';

export interface CacheVersionContract {
  databaseSchema: number;
  pageFacts: number;
  contentJobFormat: number;
  analyzerPipeline: number;
  extractors: {
    wikitext: number;
    bson: number;
    lua: number;
  };
  indexes: {
    title: number;
    content: number;
    lua: number;
  };
  dataCodeFormat: number;
  libraries: {
    minisearch: string;
    jieba: string;
  };
}

export type SearchIndexKind = 'title' | 'content' | 'lua';

export const CURRENT_VERSION_CONTRACT: CacheVersionContract = Object.freeze({
  databaseSchema: 3,
  pageFacts: 1,
  contentJobFormat: 1,
  analyzerPipeline: 2,
  extractors: Object.freeze({ wikitext: 2, bson: 1, lua: 2 }),
  indexes: Object.freeze({ title: 1, content: 1, lua: 1 }),
  dataCodeFormat: 2,
  libraries: Object.freeze({ minisearch: '7.2.0', jieba: '2.4.0' }),
});

export type VersionContractState =
  | {
      status: 'compatible';
      contract: CacheVersionContract;
      registeredLegacy: boolean;
      migrated: boolean;
    }
  | {
      status: 'incompatible';
      contract?: CacheVersionContract;
      reason: string;
      registeredLegacy: false;
      migrated: false;
    };

/**
 * Registers the pre-P4 schema-v3 layout as the one known legacy fact format.
 * Derived format changes never delete facts or alter remote sync cursors here.
 */
export async function initializeVersionContract(
  database: WikiSearchDatabase,
): Promise<VersionContractState> {
  const record = await database.syncState.get(CACHE_VERSION_CONTRACT_KEY);
  if (record === undefined) {
    await database.syncState.put({
      key: CACHE_VERSION_CONTRACT_KEY,
      value: CURRENT_VERSION_CONTRACT,
    });
    return {
      status: 'compatible',
      contract: CURRENT_VERSION_CONTRACT,
      registeredLegacy: true,
      migrated: false,
    };
  }

  if (!isVersionContract(record.value)) {
    return {
      status: 'incompatible',
      reason: '本地版本契约无法识别',
      registeredLegacy: false,
      migrated: false,
    };
  }
  const stored = record.value;
  const futureFact =
    stored.databaseSchema > CURRENT_VERSION_CONTRACT.databaseSchema ||
    stored.pageFacts > CURRENT_VERSION_CONTRACT.pageFacts ||
    stored.contentJobFormat > CURRENT_VERSION_CONTRACT.contentJobFormat;
  if (futureFact) {
    return {
      status: 'incompatible',
      contract: stored,
      reason: '本地页面事实由更新版本创建，已停止后台写入',
      registeredLegacy: false,
      migrated: false,
    };
  }

  const factsNeedMigration =
    stored.pageFacts < CURRENT_VERSION_CONTRACT.pageFacts ||
    stored.contentJobFormat < CURRENT_VERSION_CONTRACT.contentJobFormat;
  if (factsNeedMigration) {
    const migrated = await migrateFacts(database, stored);
    if (!migrated) {
      return {
        status: 'incompatible',
        contract: stored,
        reason: '本地页面事实版本过旧且没有安全迁移路径',
        registeredLegacy: false,
        migrated: false,
      };
    }
  }

  if (!areStructurallyEqual(stored, CURRENT_VERSION_CONTRACT)) {
    await database.syncState.put({
      key: CACHE_VERSION_CONTRACT_KEY,
      value: CURRENT_VERSION_CONTRACT,
    });
  }
  return {
    status: 'compatible',
    contract: CURRENT_VERSION_CONTRACT,
    registeredLegacy: false,
    migrated: factsNeedMigration,
  };
}

function areStructurallyEqual(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((value, index) => areStructurallyEqual(value, right[index]))
    );
  }
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  const rightKeys = Object.keys(rightRecord);
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key) =>
        Object.hasOwn(rightRecord, key) &&
        areStructurallyEqual(leftRecord[key], rightRecord[key]),
    )
  );
}

export function createCompatibilityKey(
  kind: SearchIndexKind,
  analyzerEngine: string,
  contract: CacheVersionContract = CURRENT_VERSION_CONTRACT,
): string {
  const shared = {
    analyzerPipeline: contract.analyzerPipeline,
    analyzerEngine,
    minisearch: contract.libraries.minisearch,
    jieba: contract.libraries.jieba,
    index: contract.indexes[kind],
  };
  if (kind === 'content') {
    return JSON.stringify({
      ...shared,
      wikitextExtractor: contract.extractors.wikitext,
      bsonExtractor: contract.extractors.bson,
    });
  }
  if (kind === 'lua') {
    return JSON.stringify({ ...shared, luaExtractor: contract.extractors.lua });
  }
  return JSON.stringify(shared);
}

function isVersionContract(value: unknown): value is CacheVersionContract {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CacheVersionContract>;
  return (
    typeof candidate.databaseSchema === 'number' &&
    typeof candidate.pageFacts === 'number' &&
    typeof candidate.contentJobFormat === 'number' &&
    typeof candidate.analyzerPipeline === 'number' &&
    typeof candidate.dataCodeFormat === 'number' &&
    typeof candidate.extractors?.wikitext === 'number' &&
    typeof candidate.extractors.bson === 'number' &&
    typeof candidate.extractors.lua === 'number' &&
    typeof candidate.indexes?.title === 'number' &&
    typeof candidate.indexes.content === 'number' &&
    typeof candidate.indexes.lua === 'number' &&
    typeof candidate.libraries?.minisearch === 'string' &&
    typeof candidate.libraries.jieba === 'string'
  );
}

async function migrateFacts(
  _database: WikiSearchDatabase,
  _stored: CacheVersionContract,
): Promise<boolean> {
  // Version 1 is the first explicit page/job fact format. Pre-P4 schema-v3
  // databases are registered through the missing-contract branch above.
  return false;
}
