// SPDX-License-Identifier: MPL-2.0
import type { Analyzer } from '../analyzer/analyzer';
import type { WikiSearchDatabase } from '../storage/database';
import {
  isReconciliationSyncState,
  LOCAL_SEQUENCE_KEY,
  readLocalSequence,
  readValidatedSyncState,
} from '../storage/sync-state';
import type {
  JobRecord,
  PageRecord,
  RecentChangeSyncState,
  ReconciliationReason,
  ReconciliationSyncResult,
  ReconciliationSyncState,
} from '../types';
import {
  CONTENT_JOB_TYPE,
  contentJobFromProjection,
  contentJobMatchesProjection,
  isContentJobEligible,
  projectContentJob,
  searchablePageFactChanged,
} from './content-job-policy';
import { readFileResourceSyncState } from './file-resource-sync';
import { readRecentChangeSyncState } from './recent-change-sync';
import { readTitleSyncState } from './title-sync';
import { delay, isWikiLoginRequired, type WikiApi } from './wiki-api';

const RECONCILIATION_SYNC_KEY = 'reconciliation-sync';
const RECENT_CHANGES_SYNC_KEY = 'recent-changes-sync';
const DATA_CODE_SYNC_KEY = 'data-code-sync';
const FILE_NAMESPACE = 6;
const RECONCILIATION_SCAN_PROTOCOL = 2;
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1_000;

interface SiteInfoResponse {
  curtimestamp?: string;
  query?: {
    namespaces?: Record<string, { id: number; name: string; canonical?: string }>;
  };
}

interface AllPagesResponse {
  continue?: { gapcontinue?: string };
  query?: {
    pages?: Array<{
      pageid: number;
      ns: number;
      title: string;
      redirect?: boolean;
      lastrevid?: number;
      contentmodel?: string;
    }>;
  };
}

export interface ReconciliationSyncOptions {
  force?: boolean;
  intervalMs?: number;
  requestIntervalMs?: number;
  now?: () => number;
  onProgress?: (state: ReconciliationSyncState) => void;
}

export async function readReconciliationSyncState(
  database: WikiSearchDatabase,
): Promise<ReconciliationSyncState | undefined> {
  return readValidatedSyncState(
    database,
    RECONCILIATION_SYNC_KEY,
    isReconciliationSyncState,
  );
}

export async function reconcileWikiMirror(
  database: WikiSearchDatabase,
  api: WikiApi,
  analyzer: Analyzer,
  options: ReconciliationSyncOptions = {},
): Promise<ReconciliationSyncResult> {
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
  const [titleState, fileState, recentState, existingState, initialSequence] =
    await Promise.all([
      readTitleSyncState(database),
      readFileResourceSyncState(database),
      readRecentChangeSyncState(database),
      readReconciliationSyncState(database),
      readLocalSequence(database),
    ]);
  if (titleState?.status !== 'complete') {
    return inactiveResult('no-baseline', initialSequence);
  }

  let state: ReconciliationSyncState;
  const interruptedState =
    existingState?.status === 'running' || existingState?.status === 'failed';
  const canResume =
    interruptedState && existingState.scanProtocol === RECONCILIATION_SCAN_PROTOCOL;
  if (canResume) {
    state = { ...existingState, status: 'running', error: undefined };
    await database.syncState.put({ key: RECONCILIATION_SYNC_KEY, value: state });
  } else {
    const reason = interruptedState
      ? existingState.reason
      : reconciliationReason(
          options.force ?? false,
          now(),
          intervalMs,
          existingState?.completedAt ?? titleState.completedAt ?? titleState.startedAt,
          recentState?.through,
        );
    if (!reason) return inactiveResult('not-due', initialSequence);

    let siteInfo: SiteInfoResponse;
    try {
      siteInfo = await api.query<SiteInfoResponse>({
        assert: 'user',
        curtimestamp: 1,
        meta: 'siteinfo',
        siprop: 'namespaces',
      });
    } catch (error) {
      if (isWikiLoginRequired(error)) return inactiveResult('login-required', initialSequence);
      throw error;
    }
    if (!siteInfo.curtimestamp) throw new Error('Wiki API 未返回对账服务器时间');
    const namespaces = Object.values(siteInfo.query?.namespaces ?? {})
      .filter(({ id }) => id >= 0 && (id !== FILE_NAMESPACE || fileState?.status === 'complete'))
      .sort((left, right) => left.id - right.id);
    state = {
      status: 'running',
      scanProtocol: RECONCILIATION_SCAN_PROTOCOL,
      reason,
      namespaceIds: namespaces.map(({ id }) => id),
      namespaceNames: Object.fromEntries(
        namespaces.map(({ id, name, canonical }) => [
          id,
          name || canonical || '（主）',
        ]),
      ),
      namespaceIndex: 0,
      generation: now(),
      startLocalSeq: initialSequence,
      throughLocalSeq: initialSequence,
      serverStartedAt: siteInfo.curtimestamp,
      pagesFetched: 0,
      pagesChanged: 0,
      filesChanged: false,
      dataCodesInvalidated: false,
      startedAt: now(),
    };
    await database.syncState.put({ key: RECONCILIATION_SYNC_KEY, value: state });
  }

  try {
    while (state.namespaceIndex < state.namespaceIds.length) {
      options.onProgress?.(state);
      const namespace = state.namespaceIds[state.namespaceIndex];
      if (namespace === undefined) break;
      const response = await api.query<AllPagesResponse>({
        assert: 'user',
        generator: 'allpages',
        prop: 'info',
        gaplimit: 500,
        gapnamespace: namespace,
        ...(state.gapcontinue ? { gapcontinue: state.gapcontinue } : {}),
      });
      const rawPages = response.query?.pages ?? [];
      const nextContinue = response.continue?.gapcontinue;
      const isFileBatch = namespace === FILE_NAMESPACE;

      const committedState = await database.transaction(
        'rw',
        database.pages,
        database.fileResources,
        database.syncState,
        async () => {
          const table = isFileBatch ? database.fileResources : database.pages;
          const existingPages = new Map(
            (await table.bulkGet(rawPages.map(({ pageid }) => pageid)))
              .filter((page): page is PageRecord => page !== undefined)
              .map((page) => [page.id, page]),
          );
          let sequence = await readLocalSequence(database);
          let changed = 0;
          let dataChanged = false;
          const storedPages = rawPages.map((rawPage): PageRecord => {
            const oldPage = existingPages.get(rawPage.pageid);
            const writtenAfterFence = isFileBatch
              ? (oldPage?.writerSeq ?? 0) > state.startLocalSeq
              : (oldPage?.localSeq ?? 0) > state.startLocalSeq;
            if (oldPage && writtenAfterFence) {
              return {
                ...(isFileBatch ? withoutLegacyTitleGeneration(oldPage) : oldPage),
                seenInReconciliation: state.generation,
              };
            }
            const remoteRevisionIsOlder =
              oldPage?.revisionId !== undefined &&
              rawPage.lastrevid !== undefined &&
              oldPage.revisionId > rawPage.lastrevid;
            if (oldPage && remoteRevisionIsOlder) {
              return {
                ...(isFileBatch ? withoutLegacyTitleGeneration(oldPage) : oldPage),
                seenInReconciliation: state.generation,
              };
            }
            const revisionChanged = oldPage?.revisionId !== rawPage.lastrevid;
            const nextPage: PageRecord = {
              ...(isFileBatch && oldPage
                ? withoutLegacyTitleGeneration(oldPage)
                : oldPage),
              id: rawPage.pageid,
              title: rawPage.title,
              normalizedTitle: analyzer.normalize(rawPage.title),
              namespace: rawPage.ns,
              namespaceName:
                state.namespaceNames[rawPage.ns] ?? String(rawPage.ns),
              isRedirect: Boolean(rawPage.redirect),
              localSeq: oldPage?.localSeq ?? sequence,
              deleted: false,
              revisionId: rawPage.lastrevid,
              contentModel: rawPage.contentmodel,
              ...(isFileBatch
                ? {
                    seenInFileSync:
                      oldPage?.seenInFileSync ??
                      oldPage?.seenInTitleSync ??
                      fileState?.generation ??
                      0,
                  }
                : {
                    seenInTitleSync:
                      oldPage?.seenInTitleSync ?? titleState.generation,
                  }),
              seenInReconciliation: state.generation,
              ...(revisionChanged
                ? { content: undefined, contentRevisionId: undefined }
                : {}),
            };
            if (searchablePageFactChanged(oldPage, nextPage)) {
              sequence += 1;
              nextPage.localSeq = sequence;
              if (isFileBatch) nextPage.writerSeq = sequence;
              changed += 1;
              if (oldPage?.namespace === 3500 || rawPage.ns === 3500) {
                dataChanged = true;
              }
            }
            return nextPage;
          });
          const nextState: ReconciliationSyncState = {
            ...state,
            pagesFetched: state.pagesFetched + rawPages.length,
            pagesChanged: state.pagesChanged + (isFileBatch ? 0 : changed),
            filesChanged: state.filesChanged || (isFileBatch && changed > 0),
            dataCodesInvalidated: state.dataCodesInvalidated || dataChanged,
            throughLocalSeq: sequence,
            namespaceIndex: nextContinue
              ? state.namespaceIndex
              : state.namespaceIndex + 1,
            ...(nextContinue
              ? { gapcontinue: nextContinue }
              : { gapcontinue: undefined }),
          };
          if (storedPages.length) await table.bulkPut(storedPages);
          if (dataChanged) {
            const dataCodeState = await database.syncState.get(DATA_CODE_SYNC_KEY);
            if (dataCodeState?.value && typeof dataCodeState.value === 'object') {
              await database.syncState.put({
                key: DATA_CODE_SYNC_KEY,
                value: { ...dataCodeState.value, syncedAt: 0 },
              });
            }
          }
          await database.syncState.bulkPut([
            { key: LOCAL_SEQUENCE_KEY, value: sequence },
            { key: RECONCILIATION_SYNC_KEY, value: nextState },
          ]);
          return nextState;
        },
      );
      state = committedState;

      options.onProgress?.(state);
      if (state.namespaceIndex < state.namespaceIds.length) {
        await delay(options.requestIntervalMs ?? 300);
      }
    }

    let sequence = await finalizeReconciliation(database, state, now());
    state = (await readReconciliationSyncState(database)) ?? state;
    options.onProgress?.(state);
    return {
      status: 'complete',
      reason: state.reason,
      serverStartedAt: state.serverStartedAt,
      pagesFetched: state.pagesFetched,
      pagesChanged: state.pagesChanged,
      filesChanged: state.filesChanged,
      dataCodesInvalidated: state.dataCodesInvalidated,
      throughLocalSeq: sequence,
    };
  } catch (error) {
    if (isWikiLoginRequired(error)) return loginRequiredResult(state);
    state = {
      ...state,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
    await database.syncState.put({ key: RECONCILIATION_SYNC_KEY, value: state });
    throw error;
  }
}

async function finalizeReconciliation(
  database: WikiSearchDatabase,
  state: ReconciliationSyncState,
  completedAt: number,
): Promise<number> {
  let finalSequence = state.startLocalSeq;
  await database.transaction(
    'rw',
    database.pages,
    database.fileResources,
    database.jobs,
    database.syncState,
    async () => {
      let sequence = await readLocalSequence(database);
      const stalePages = await database.pages
        .filter(
          (page) =>
            !page.deleted &&
            page.seenInReconciliation !== state.generation &&
            page.localSeq <= state.startLocalSeq,
        )
        .toArray();
      for (const page of stalePages) {
        sequence += 1;
        page.deleted = true;
        page.content = undefined;
        page.contentRevisionId = undefined;
        page.localSeq = sequence;
      }
      if (stalePages.length) await database.pages.bulkPut(stalePages);

      let staleFiles: PageRecord[] = [];
      if (state.namespaceIds.includes(FILE_NAMESPACE)) {
        staleFiles = await database.fileResources
          .filter(
            (file) =>
              !file.deleted &&
              file.seenInReconciliation !== state.generation &&
              (file.writerSeq ?? 0) <= state.startLocalSeq,
          )
          .toArray();
        staleFiles = staleFiles.map((file) => {
          sequence += 1;
          return {
            ...withoutLegacyTitleGeneration(file),
            deleted: true,
            localSeq: sequence,
            writerSeq: sequence,
          };
        });
        if (staleFiles.length) await database.fileResources.bulkPut(staleFiles);
      }

      const existingJobs = await database.jobs
        .where('type')
        .equals(CONTENT_JOB_TYPE)
        .toArray();
      const existingByPage = new Map(existingJobs.map((job) => [job.pageId, job]));
      const eligibleIds = new Set<number>();
      const jobsToPut: JobRecord[] = [];
      await database.pages.each((page) => {
        if (!isContentJobEligible(page)) return;
        eligibleIds.add(page.id);
        const existing = existingByPage.get(page.id);
        const projection = projectContentJob(page, false);
        if (!contentJobMatchesProjection(existing, page.id, projection)) {
          jobsToPut.push(
            contentJobFromProjection(page.id, projection, existing, completedAt),
          );
        }
      });
      const staleJobIds = existingJobs.flatMap((job) =>
        !eligibleIds.has(job.pageId) && job.id !== undefined ? [job.id] : [],
      );
      if (staleJobIds.length) await database.jobs.bulkDelete(staleJobIds);
      if (jobsToPut.length) await database.jobs.bulkPut(jobsToPut);

      const pagesChanged = state.pagesChanged + stalePages.length;
      const filesChanged = state.filesChanged || staleFiles.length > 0;
      const dataCodesInvalidated =
        state.dataCodesInvalidated || stalePages.some((page) => page.namespace === 3500);
      if (dataCodesInvalidated) {
        const dataCodeState = await database.syncState.get(DATA_CODE_SYNC_KEY);
        if (dataCodeState?.value && typeof dataCodeState.value === 'object') {
          await database.syncState.put({
            key: DATA_CODE_SYNC_KEY,
            value: { ...dataCodeState.value, syncedAt: 0 },
          });
        }
      }

      const currentRecent = await readRecentChangeSyncState(database);
      const preserveRecent =
        currentRecent &&
        Date.parse(currentRecent.through) > Date.parse(state.serverStartedAt);
      const recentState: RecentChangeSyncState = preserveRecent
        ? {
            ...currentRecent,
            fileChangeSeq: filesChanged ? sequence : currentRecent.fileChangeSeq,
          }
        : {
            through: state.serverStartedAt,
            completedAt,
            recentChanges: [],
            fileChangeSeq: filesChanged ? sequence : currentRecent?.fileChangeSeq,
          };
      const completedState: ReconciliationSyncState = {
        ...state,
        status: 'complete',
        pagesChanged,
        filesChanged,
        dataCodesInvalidated,
        throughLocalSeq: sequence,
        completedAt,
        error: undefined,
      };
      await database.syncState.bulkPut([
        { key: LOCAL_SEQUENCE_KEY, value: sequence },
        { key: RECENT_CHANGES_SYNC_KEY, value: recentState },
        { key: RECONCILIATION_SYNC_KEY, value: completedState },
      ]);
      finalSequence = sequence;
    },
  );
  return finalSequence;
}

function reconciliationReason(
  force: boolean,
  now: number,
  intervalMs: number,
  lastCompletedAt: number,
  recentThrough: string | undefined,
): ReconciliationReason | undefined {
  if (force) return 'manual';
  if (now - lastCompletedAt >= intervalMs) return 'scheduled';
  if (recentThrough && now - Date.parse(recentThrough) >= intervalMs) return 'rc-gap';
  return undefined;
}

function inactiveResult(
  status: 'not-due' | 'no-baseline' | 'login-required',
  throughLocalSeq: number,
): ReconciliationSyncResult {
  return {
    status,
    pagesFetched: 0,
    pagesChanged: 0,
    filesChanged: false,
    dataCodesInvalidated: false,
    throughLocalSeq,
  };
}

function loginRequiredResult(state: ReconciliationSyncState): ReconciliationSyncResult {
  return {
    status: 'login-required',
    pagesFetched: state.pagesFetched,
    pagesChanged: state.pagesChanged,
    filesChanged: state.filesChanged,
    dataCodesInvalidated: state.dataCodesInvalidated,
    throughLocalSeq: state.throughLocalSeq,
  };
}

function withoutLegacyTitleGeneration(file: PageRecord): PageRecord {
  const { seenInTitleSync: _legacyFileGeneration, ...currentFile } = file;
  return currentFile;
}
