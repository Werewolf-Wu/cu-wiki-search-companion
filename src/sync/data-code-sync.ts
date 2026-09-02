// SPDX-License-Identifier: MPL-2.0
import type { Analyzer } from '../analyzer/analyzer';
import {
  DEFAULT_DATA_CODE_RULES,
  dataFieldProjection,
  extractDataFieldValues,
  parseDataFieldRules,
  type DataFieldRules,
} from '../data/data-field-rules';
import type { WikiSearchDatabase } from '../storage/database';
import { isDataCodeSyncState } from '../storage/sync-state';
import type { DataCodeRecord, DataCodeSyncState } from '../types';
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  runWithRequestTimeout,
} from './request-timeout';
import { delay } from './wiki-api';

const DATA_CODE_SYNC_KEY = 'data-code-sync';
const PAGE_SIZE = 500;
const MAX_PAGES = 20;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1_000;
const DATA_CODE_INDEX_VERSION = 2;

interface MongoDataDocument {
  [key: string]: unknown;
  _id?: unknown;
  id?: unknown;
  locales?: { 'zh-CN'?: { name?: unknown } };
}

interface MongoDataResponse {
  _embedded?: unknown;
  _returned?: unknown;
}

export interface DataCodeSyncOptions {
  force?: boolean;
  maxAgeMs?: number;
  fetcher?: typeof fetch;
  requestTimeoutMs?: number;
  retries?: number;
  rulesSource?: string;
}

export interface DataCodeSyncResult {
  records: DataCodeRecord[];
  refreshed: boolean;
}

export async function readDataCodeSyncState(
  database: WikiSearchDatabase,
): Promise<DataCodeSyncState | undefined> {
  const value = (await database.syncState.get(DATA_CODE_SYNC_KEY))?.value;
  return isDataCodeSyncState(value) ? value : undefined;
}

export async function syncDataCodes(
  database: WikiSearchDatabase,
  analyzer: Analyzer,
  options: DataCodeSyncOptions = {},
): Promise<DataCodeSyncResult> {
  const state = await readDataCodeSyncState(database);
  const cached = await database.dataCodes.toArray();
  const rulesSource = options.rulesSource ?? DEFAULT_DATA_CODE_RULES;
  const rules = parseDataFieldRules(rulesSource);
  const projection = dataFieldProjection(rules);
  const maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
  if (
    !options.force &&
    cached.length > 0 &&
    state &&
    state.indexVersion === DATA_CODE_INDEX_VERSION &&
    state.rulesSource === rulesSource &&
    Date.now() - state.syncedAt < maxAgeMs
  ) {
    return { records: cached, refreshed: false };
  }

  const fetcher = options.fetcher ?? fetch.bind(globalThis);
  const requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
  const syncedAt = Date.now();
  const recordsBySource = new Map<string, DataCodeRecord>();
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const response = await fetchMongoPage(
      fetcher,
      page,
      options.retries ?? 3,
      projection,
      requestTimeoutMs,
    );
    const records = parseDataCodeResponse(response, analyzer, syncedAt, rules);
    for (const record of records) recordsBySource.set(record.source, record);
    if (returnedCount(response) < PAGE_SIZE) break;
    if (page === MAX_PAGES) throw new Error('Mongo Data 分页超过安全上限');
  }

  const records = [...recordsBySource.values()];
  if (!records.length) throw new Error('Mongo Data 未返回可用的简体中文名称');
  await database.transaction('rw', database.dataCodes, database.syncState, async () => {
    await database.dataCodes.clear();
    await database.dataCodes.bulkPut(records);
    await database.syncState.put({
      key: DATA_CODE_SYNC_KEY,
      value: {
        syncedAt,
        count: records.length,
        rulesSource,
        indexVersion: DATA_CODE_INDEX_VERSION,
      } satisfies DataCodeSyncState,
    });
  });
  return { records, refreshed: true };
}

export function parseDataCodeResponse(
  response: MongoDataResponse,
  analyzer: Analyzer,
  syncedAt: number,
  rules: DataFieldRules = parseDataFieldRules(DEFAULT_DATA_CODE_RULES),
): DataCodeRecord[] {
  if (!Array.isArray(response._embedded)) throw new Error('Mongo Data 响应缺少 _embedded');
  const records: DataCodeRecord[] = [];
  for (const value of response._embedded as MongoDataDocument[]) {
    const source = typeof value?._id === 'string' ? value._id : '';
    const code = typeof value?.id === 'string' ? value.id : '';
    const chineseName = value?.locales?.['zh-CN']?.name;
    if (!source || !code || typeof chineseName !== 'string' || !chineseName.trim()) continue;
    const match = /^Data:([^/]+)/.exec(source);
    const searchValues = extractDataFieldValues(value, source, rules);
    const searchText = searchValues.join(' ');
    records.push({
      source,
      code,
      chineseName: chineseName.trim(),
      normalizedName: analyzer.normalize(chineseName),
      searchText,
      normalizedSearchText: analyzer.normalize(searchText),
      normalizedSearchValues: searchValues.map((fieldValue) => analyzer.normalize(fieldValue)),
      dataType: match?.[1] ?? 'Data',
      syncedAt,
    });
  }
  return records;
}

async function fetchMongoPage(
  fetcher: typeof fetch,
  page: number,
  retries: number,
  projection: Record<string, 1> | undefined,
  requestTimeoutMs: number,
): Promise<MongoDataResponse> {
  const parameters = new URLSearchParams({
    page: String(page),
    pagesize: String(PAGE_SIZE),
  });
  if (projection) parameters.set('keys', JSON.stringify(projection));
  let lastError: unknown;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    try {
      return await runWithRequestTimeout(
        async (signal) => {
          const response = await fetcher(`/api/rest_v1/namespace/data?${parameters}`, {
            credentials: 'same-origin',
            headers: { Accept: 'application/json' },
            signal,
          });
          if (!response.ok) throw new Error(`Mongo Data API 返回 HTTP ${response.status}`);
          return (await response.json()) as MongoDataResponse;
        },
        requestTimeoutMs,
      );
    } catch (error) {
      lastError = error;
      if (attempt === retries) break;
      await delay(500 * 2 ** attempt);
    }
  }
  throw lastError;
}

function returnedCount(response: MongoDataResponse): number {
  if (typeof response._returned === 'number') return response._returned;
  return Array.isArray(response._embedded) ? response._embedded.length : 0;
}
