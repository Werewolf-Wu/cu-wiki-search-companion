// SPDX-License-Identifier: MPL-2.0
import type { Analyzer } from '../analyzer/analyzer';
import type { WikiSearchDatabase } from '../storage/database';
import {
  LOCAL_SEQUENCE_KEY,
  readLocalSequence,
  readValidatedTitleSyncState,
} from '../storage/sync-state';
import type {
  PageRecord,
  TitleSyncProgress,
  TitleSyncState,
} from '../types';
import { requestAllPages } from './all-pages';
import { delay, WikiApi } from './wiki-api';

const FILE_RESOURCE_SYNC_KEY = 'file-resource-sync';
const RECENT_CHANGES_SYNC_KEY = 'recent-changes-sync';
const FILE_NAMESPACE = 6;

export interface FileResourceSyncOptions {
  force?: boolean;
  requestIntervalMs?: number;
  onProgress?: (progress: TitleSyncProgress) => void;
  onBatch?: (files: PageRecord[]) => void | Promise<void>;
}

export async function readFileResourceSyncState(
  database: WikiSearchDatabase,
): Promise<TitleSyncState | undefined> {
  return readValidatedTitleSyncState(database, FILE_RESOURCE_SYNC_KEY);
}

export async function syncFileResources(
  database: WikiSearchDatabase,
  api: WikiApi,
  analyzer: Analyzer,
  options: FileResourceSyncOptions = {},
): Promise<TitleSyncState> {
  const existing = await readFileResourceSyncState(database);
  if (existing?.status === 'complete' && !options.force) {
    report(existing, options.onProgress);
    return existing;
  }

  let state: TitleSyncState;
  if (!existing || options.force) {
    state = {
      status: 'running',
      namespaceIds: [FILE_NAMESPACE],
      namespaceNames: { [FILE_NAMESPACE]: '文件' },
      namespaceIndex: 0,
      generation: Date.now(),
      pagesFetched: 0,
      startedAt: Date.now(),
    };
    await database.syncState.put({ key: FILE_RESOURCE_SYNC_KEY, value: state });
  } else {
    state = { ...existing, status: 'running', error: undefined };
  }

  try {
    while (state.namespaceIndex === 0) {
      report(state, options.onProgress);
      const response = await requestAllPages(api, {
        namespace: FILE_NAMESPACE,
        gapcontinue: state.gapcontinue,
      });
      const rawFiles = response.query?.pages ?? [];
      const nextContinue = response.continue?.gapcontinue;
      let storedBatch: PageRecord[] = [];

      const committedState = await database.transaction(
        'rw',
        database.fileResources,
        database.pages,
        database.syncState,
        async () => {
          const ids = rawFiles.map(({ pageid }) => pageid);
          const existingFiles = new Map(
            (await database.fileResources.bulkGet(ids))
              .filter((file): file is PageRecord => file !== undefined)
              .map((file) => [file.id, file]),
          );
          let sequence = await readLocalSequence(database);
          const initialSequence = sequence;
          storedBatch = rawFiles.map((rawFile) => {
            const oldFile = existingFiles.get(rawFile.pageid);
            if (
              oldFile &&
              typeof oldFile.revisionId === 'number' &&
              typeof rawFile.lastrevid === 'number' &&
              oldFile.revisionId > rawFile.lastrevid
            ) {
              return {
                ...withoutLegacyTitleGeneration(oldFile),
                seenInFileSync: state.generation,
              };
            }
            const nextFile: PageRecord = {
              ...(oldFile ? withoutLegacyTitleGeneration(oldFile) : {}),
              id: rawFile.pageid,
              title: rawFile.title,
              normalizedTitle: analyzer.normalize(rawFile.title),
              namespace: FILE_NAMESPACE,
              namespaceName: '文件',
              isRedirect: Boolean(rawFile.redirect),
              revisionId: rawFile.lastrevid,
              contentModel: rawFile.contentmodel,
              localSeq: oldFile?.localSeq ?? rawFile.lastrevid ?? rawFile.pageid,
              seenInFileSync: state.generation,
              deleted: false,
            };
            if (fileFactChanged(oldFile, nextFile)) {
              sequence += 1;
              nextFile.writerSeq = sequence;
            }
            return nextFile;
          });
          const nextState: TitleSyncState = {
            ...state,
            pagesFetched: state.pagesFetched + rawFiles.length,
            namespaceIndex: nextContinue ? 0 : 1,
            ...(nextContinue ? { gapcontinue: nextContinue } : { gapcontinue: undefined }),
          };
          const recentChangeRecord =
            sequence === initialSequence
              ? undefined
              : await database.syncState.get(RECENT_CHANGES_SYNC_KEY);
          await database.fileResources.bulkPut(storedBatch);
          await database.syncState.bulkPut([
            { key: FILE_RESOURCE_SYNC_KEY, value: nextState },
            ...(sequence === initialSequence
              ? []
              : [
                  { key: LOCAL_SEQUENCE_KEY, value: sequence },
                  {
                    key: RECENT_CHANGES_SYNC_KEY,
                    value: withFileChangeSequence(recentChangeRecord?.value, sequence),
                  },
                ]),
          ]);
          return nextState;
        },
      );
      state = committedState;

      await options.onBatch?.(storedBatch);
      report(state, options.onProgress);
      if (state.namespaceIndex === 0) await delay(options.requestIntervalMs ?? 300);
    }

    const completedState = await database.transaction(
      'rw',
      database.fileResources,
      database.pages,
      database.syncState,
      async () => {
        const staleIds: number[] = [];
        const migratedFiles: PageRecord[] = [];
        await database.fileResources.each((file) => {
          if ((file.seenInFileSync ?? file.seenInTitleSync) !== state.generation) {
            staleIds.push(file.id);
            return;
          }
          if (file.seenInFileSync === undefined) {
            migratedFiles.push({
              ...withoutLegacyTitleGeneration(file),
              seenInFileSync: state.generation,
            });
          }
        });
        const sequence = (await readLocalSequence(database)) + staleIds.length;
        const recentChangeRecord = staleIds.length
          ? await database.syncState.get(RECENT_CHANGES_SYNC_KEY)
          : undefined;
        if (migratedFiles.length) await database.fileResources.bulkPut(migratedFiles);
        await database.fileResources.bulkDelete(staleIds);
        const nextState: TitleSyncState = {
          ...state,
          status: 'complete',
          completedAt: Date.now(),
        };
        await database.syncState.bulkPut([
          { key: FILE_RESOURCE_SYNC_KEY, value: nextState },
          ...(staleIds.length
            ? [
                { key: LOCAL_SEQUENCE_KEY, value: sequence },
                {
                  key: RECENT_CHANGES_SYNC_KEY,
                  value: withFileChangeSequence(recentChangeRecord?.value, sequence),
                },
              ]
            : []),
        ]);
        return nextState;
      },
    );
    state = completedState;
    report(state, options.onProgress);
    return state;
  } catch (error) {
    state = {
      ...state,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
    await database.syncState.put({ key: FILE_RESOURCE_SYNC_KEY, value: state });
    report(state, options.onProgress);
    throw error;
  }
}

function fileFactChanged(oldFile: PageRecord | undefined, nextFile: PageRecord): boolean {
  return (
    !oldFile ||
    oldFile.title !== nextFile.title ||
    oldFile.namespace !== nextFile.namespace ||
    oldFile.isRedirect !== nextFile.isRedirect ||
    oldFile.revisionId !== nextFile.revisionId ||
    oldFile.contentModel !== nextFile.contentModel ||
    Boolean(oldFile.deleted) !== Boolean(nextFile.deleted)
  );
}

function withoutLegacyTitleGeneration(file: PageRecord): PageRecord {
  const { seenInTitleSync: _legacyFileGeneration, ...currentFile } = file;
  return currentFile;
}

function withFileChangeSequence(value: unknown, sequence: number): Record<string, unknown> {
  const state =
    value !== null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const previous = typeof state.fileChangeSeq === 'number' ? state.fileChangeSeq : 0;
  return { ...state, fileChangeSeq: Math.max(previous, sequence) };
}

function report(
  state: TitleSyncState,
  callback: FileResourceSyncOptions['onProgress'],
): void {
  callback?.({
    status: state.status,
    pagesFetched: state.pagesFetched,
    namespaceIndex: state.namespaceIndex,
    namespaceCount: 1,
    namespaceName: '文件',
    error: state.error,
  });
}
