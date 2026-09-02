// SPDX-License-Identifier: MPL-2.0
import type { WikiSearchDatabase } from './database';
import type {
  DataCodeSyncState,
  RecentChangeMarker,
  RecentChangeSyncState,
  ReconciliationSyncState,
  TitleSyncState,
} from '../types';

export const LOCAL_SEQUENCE_KEY = 'local-sequence';

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

export async function readValidatedSyncState<T>(
  database: WikiSearchDatabase,
  key: string,
  validator: (value: unknown) => value is T,
): Promise<T | undefined> {
  const record = await database.syncState.get(key);
  if (record === undefined) return undefined;
  if (validator(record.value)) return record.value;
  throw new Error(`同步状态 "${key}" 已损坏：对象结构或字段类型无效`);
}

export function isTitleSyncState(
  value: unknown,
): value is TitleSyncState & { apcontinue?: string } {
  if (!isObjectRecord(value)) return false;
  if (!isOneOf(value.status, ['running', 'complete', 'failed'])) return false;
  if (!isNonNegativeIntegerArray(value.namespaceIds)) return false;
  if (!isNamespaceNames(value.namespaceNames)) return false;
  if (!isNonNegativeSafeInteger(value.namespaceIndex)) return false;
  if (value.namespaceIndex > value.namespaceIds.length) return false;
  if (value.gapcontinue !== undefined && typeof value.gapcontinue !== 'string') return false;
  if (value.apcontinue !== undefined && typeof value.apcontinue !== 'string') return false;
  if (!isNonNegativeSafeInteger(value.generation)) return false;
  if (!isNonNegativeSafeInteger(value.pagesFetched)) return false;
  if (!isNonNegativeSafeInteger(value.startedAt)) return false;
  if (value.completedAt !== undefined && !isNonNegativeSafeInteger(value.completedAt)) {
    return false;
  }
  return value.error === undefined || typeof value.error === 'string';
}

export async function readValidatedTitleSyncState(
  database: WikiSearchDatabase,
  key: string,
): Promise<TitleSyncState | undefined> {
  const state = await readValidatedSyncState(database, key, isTitleSyncState);
  if (state === undefined) return undefined;
  const { apcontinue, ...normalized } = state;
  return normalized.gapcontinue === undefined && apcontinue !== undefined
    ? { ...normalized, gapcontinue: apcontinue }
    : normalized;
}

export function isRecentChangeSyncState(value: unknown): value is RecentChangeSyncState {
  if (!isObjectRecord(value)) return false;
  const hasCursorState =
    value.through !== undefined ||
    value.completedAt !== undefined ||
    value.recentChanges !== undefined;
  const hasValidCursorState =
    isTimestamp(value.through) &&
    isNonNegativeSafeInteger(value.completedAt) &&
    Array.isArray(value.recentChanges) &&
    value.recentChanges.every(isRecentChangeMarker);
  if (hasCursorState && !hasValidCursorState) return false;
  const hasFileSequence = value.fileChangeSeq !== undefined;
  if (hasFileSequence && !isNonNegativeSafeInteger(value.fileChangeSeq)) return false;
  return hasValidCursorState || hasFileSequence;
}

export function isReconciliationSyncState(
  value: unknown,
): value is ReconciliationSyncState {
  if (!isObjectRecord(value)) return false;
  if (!isOneOf(value.status, ['running', 'complete', 'failed'])) return false;
  if (!isOneOf(value.reason, ['scheduled', 'rc-gap', 'manual'])) return false;
  if (!isNonNegativeIntegerArray(value.namespaceIds)) return false;
  if (!isNamespaceNames(value.namespaceNames)) return false;
  if (!isNonNegativeSafeInteger(value.namespaceIndex)) return false;
  if (value.namespaceIndex > value.namespaceIds.length) return false;
  if (value.gapcontinue !== undefined && typeof value.gapcontinue !== 'string') return false;
  if (value.scanProtocol !== undefined && !isNonNegativeSafeInteger(value.scanProtocol)) {
    return false;
  }
  if (!isNonNegativeSafeInteger(value.generation)) return false;
  if (!isNonNegativeSafeInteger(value.startLocalSeq)) return false;
  if (
    value.throughLocalSeq !== undefined &&
    !isNonNegativeSafeInteger(value.throughLocalSeq)
  ) {
    return false;
  }
  if (value.scanProtocol !== undefined && value.throughLocalSeq === undefined) return false;
  if (!isTimestamp(value.serverStartedAt)) return false;
  if (!isNonNegativeSafeInteger(value.pagesFetched)) return false;
  if (!isNonNegativeSafeInteger(value.pagesChanged)) return false;
  if (typeof value.filesChanged !== 'boolean') return false;
  if (typeof value.dataCodesInvalidated !== 'boolean') return false;
  if (!isNonNegativeSafeInteger(value.startedAt)) return false;
  if (value.completedAt !== undefined && !isNonNegativeSafeInteger(value.completedAt)) {
    return false;
  }
  return value.error === undefined || typeof value.error === 'string';
}

export function isDataCodeSyncState(value: unknown): value is DataCodeSyncState {
  if (!isObjectRecord(value)) return false;
  if (!isNonNegativeSafeInteger(value.syncedAt)) return false;
  if (!isNonNegativeSafeInteger(value.count)) return false;
  if (value.rulesSource !== undefined && typeof value.rulesSource !== 'string') return false;
  return value.indexVersion === undefined || isNonNegativeSafeInteger(value.indexVersion);
}

export function isIncrementalSyncScheduleState(
  value: unknown,
): value is { lastSuccessAt: number; nextDueAt: number } {
  return (
    isObjectRecord(value) &&
    isNonNegativeSafeInteger(value.lastSuccessAt) &&
    isNonNegativeSafeInteger(value.nextDueAt)
  );
}

/**
 * Reads the committed local write sequence. Older databases can be missing the
 * explicit state record, so recover it from page writes and file writer
 * sequences. A file row's legacy localSeq is a revision marker, not a writer
 * sequence, and must never participate in this fallback.
 */
export async function readLocalSequence(database: WikiSearchDatabase): Promise<number> {
  const record = await database.syncState.get(LOCAL_SEQUENCE_KEY);
  if (record !== undefined) {
    if (isNonNegativeSafeInteger(record.value)) return record.value;
    throw new Error(
      `同步状态 "${LOCAL_SEQUENCE_KEY}" 已损坏：值必须是非负安全整数`,
    );
  }

  let maximum = 0;
  await database.pages.each((page) => {
    if (isNonNegativeSafeInteger(page.localSeq)) maximum = Math.max(maximum, page.localSeq);
  });
  await database.fileResources.each((file) => {
    if (isNonNegativeSafeInteger(file.writerSeq)) {
      maximum = Math.max(maximum, file.writerSeq);
    }
  });
  return maximum;
}

function isObjectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isOneOf<T extends string>(value: unknown, choices: readonly T[]): value is T {
  return typeof value === 'string' && choices.includes(value as T);
}

function isNonNegativeIntegerArray(value: unknown): value is number[] {
  return Array.isArray(value) && value.every(isNonNegativeSafeInteger);
}

function isNamespaceNames(value: unknown): value is Record<number, string> {
  return isObjectRecord(value) && Object.values(value).every((name) => typeof name === 'string');
}

function isTimestamp(value: unknown): value is string {
  return typeof value === 'string' && Number.isFinite(Date.parse(value));
}

function isRecentChangeMarker(value: unknown): value is RecentChangeMarker {
  return (
    isObjectRecord(value) &&
    isNonNegativeSafeInteger(value.rcid) &&
    isTimestamp(value.timestamp)
  );
}
