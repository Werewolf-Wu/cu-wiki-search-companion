// SPDX-License-Identifier: MPL-2.0
import type { WikiSearchDatabase } from './database';
import {
  isNonNegativeSafeInteger,
  readValidatedSyncState,
} from './sync-state';

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

export class FactWriteCompatibilityError extends Error {
  override readonly name = 'FactWriteCompatibilityError';

  constructor(readonly reason: string) {
    super(`事实写入版本不兼容：${reason}`);
  }
}

/** Reads compatibility without registering or migrating persisted state. */
export async function inspectVersionContract(
  database: WikiSearchDatabase,
): Promise<VersionContractState> {
  return evaluateVersionContract(database, false);
}

/** Registers known legacy state or runs supported migrations before a fact write. */
export async function ensureVersionContractForWrite(
  database: WikiSearchDatabase,
): Promise<Extract<VersionContractState, { status: 'compatible' }>> {
  const state = await evaluateVersionContract(database, true);
  if (state.status === 'incompatible') {
    throw new FactWriteCompatibilityError(state.reason);
  }
  return state;
}

/**
 * Registers the pre-P4 schema-v3 layout as the one known legacy fact format.
 * Derived format changes never delete facts or alter remote sync cursors here.
 */
export async function initializeVersionContract(
  database: WikiSearchDatabase,
): Promise<VersionContractState> {
  return evaluateVersionContract(database, true);
}

async function evaluateVersionContract(
  database: WikiSearchDatabase,
  allowWrites: boolean,
): Promise<VersionContractState> {
  const record = await database.syncState.get(CACHE_VERSION_CONTRACT_KEY);
  if (record === undefined) {
    if (database.verno !== CURRENT_VERSION_CONTRACT.databaseSchema) {
      return incompatible('本地数据库 schema 版本不兼容');
    }
    if (allowWrites) {
      await database.syncState.put({
        key: CACHE_VERSION_CONTRACT_KEY,
        value: CURRENT_VERSION_CONTRACT,
      });
    }
    return {
      status: 'compatible',
      contract: CURRENT_VERSION_CONTRACT,
      registeredLegacy: allowWrites,
      migrated: false,
    };
  }

  if (!isVersionContract(record.value)) {
    return incompatible('本地版本契约无法识别');
  }
  const stored = record.value;
  if (stored.databaseSchema !== CURRENT_VERSION_CONTRACT.databaseSchema) {
    return incompatible('本地数据库 schema 版本不兼容', stored);
  }
  const futureFact =
    stored.pageFacts > CURRENT_VERSION_CONTRACT.pageFacts ||
    stored.contentJobFormat > CURRENT_VERSION_CONTRACT.contentJobFormat;
  if (futureFact) {
    return incompatible('本地页面事实由更新版本创建，已停止后台写入', stored);
  }

  const factsNeedMigration =
    stored.pageFacts < CURRENT_VERSION_CONTRACT.pageFacts ||
    stored.contentJobFormat < CURRENT_VERSION_CONTRACT.contentJobFormat;
  if (factsNeedMigration) {
    if (!allowWrites) {
      return incompatible('本地页面事实版本过旧且没有安全迁移路径', stored);
    }
    const migrated = await migrateFacts(database, stored);
    if (!migrated) {
      return incompatible('本地页面事实版本过旧且没有安全迁移路径', stored);
    }
    await database.syncState.put({
      key: CACHE_VERSION_CONTRACT_KEY,
      value: CURRENT_VERSION_CONTRACT,
    });
  }
  return {
    status: 'compatible',
    contract: factsNeedMigration ? CURRENT_VERSION_CONTRACT : stored,
    registeredLegacy: false,
    migrated: factsNeedMigration,
  };
}

function incompatible(
  reason: string,
  contract?: CacheVersionContract,
): Extract<VersionContractState, { status: 'incompatible' }> {
  return {
    status: 'incompatible',
    contract,
    reason,
    registeredLegacy: false,
    migrated: false,
  };
}

export async function readCacheVersionContract(
  database: WikiSearchDatabase,
): Promise<CacheVersionContract | undefined> {
  return readValidatedSyncState(
    database,
    CACHE_VERSION_CONTRACT_KEY,
    isVersionContract,
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

export function isVersionContract(value: unknown): value is CacheVersionContract {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<CacheVersionContract>;
  return (
    isNonNegativeSafeInteger(candidate.databaseSchema) &&
    isNonNegativeSafeInteger(candidate.pageFacts) &&
    isNonNegativeSafeInteger(candidate.contentJobFormat) &&
    isNonNegativeSafeInteger(candidate.analyzerPipeline) &&
    isNonNegativeSafeInteger(candidate.dataCodeFormat) &&
    isNonNegativeSafeInteger(candidate.extractors?.wikitext) &&
    isNonNegativeSafeInteger(candidate.extractors.bson) &&
    isNonNegativeSafeInteger(candidate.extractors.lua) &&
    isNonNegativeSafeInteger(candidate.indexes?.title) &&
    isNonNegativeSafeInteger(candidate.indexes.content) &&
    isNonNegativeSafeInteger(candidate.indexes.lua) &&
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
