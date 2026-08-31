// SPDX-License-Identifier: MPL-2.0
import type { Analyzer } from '../analyzer/analyzer';
import type { WikiSearchDatabase } from '../storage/database';
import type {
  PageRecord,
  SyncStateRecord,
  TitleSyncProgress,
  TitleSyncState,
} from '../types';
import { delay, WikiApi } from './wiki-api';

const TITLE_SYNC_KEY = 'title-sync';
const SEQUENCE_KEY = 'local-sequence';

interface SiteInfoResponse {
  query: {
    namespaces: Record<string, { id: number; name: string; canonical?: string }>;
  };
}

interface AllPagesResponse {
  continue?: { gapcontinue?: string };
  query?: {
    pages: Array<{
      pageid: number;
      ns: number;
      title: string;
      redirect?: boolean;
      lastrevid?: number;
      contentmodel?: string;
    }>;
  };
}

export interface TitleSyncOptions {
  force?: boolean;
  requestIntervalMs?: number;
  onProgress?: (progress: TitleSyncProgress) => void;
  onBatch?: (pages: PageRecord[]) => void | Promise<void>;
}

export async function readTitleSyncState(
  database: WikiSearchDatabase,
): Promise<TitleSyncState | undefined> {
  return (await database.syncState.get(TITLE_SYNC_KEY))?.value as
    | TitleSyncState
    | undefined;
}

export async function syncTitles(
  database: WikiSearchDatabase,
  api: WikiApi,
  analyzer: Analyzer,
  options: TitleSyncOptions = {},
): Promise<TitleSyncState> {
  const existing = await readTitleSyncState(database);
  if (existing?.status === 'complete' && !options.force) {
    report(existing, options.onProgress);
    return existing;
  }

  let state: TitleSyncState;
  if (!existing || options.force) {
    const siteInfo = await api.query<SiteInfoResponse>({
      meta: 'siteinfo',
      siprop: 'namespaces',
    });
    const namespaces = Object.values(siteInfo.query.namespaces)
      .filter(({ id }) => id >= 0 && id !== 6)
      .sort((left, right) => left.id - right.id);
    state = {
      status: 'running',
      namespaceIds: namespaces.map(({ id }) => id),
      namespaceNames: Object.fromEntries(
        namespaces.map(({ id, name, canonical }) => [id, name || canonical || '（主）']),
      ),
      namespaceIndex: 0,
      generation: Date.now(),
      pagesFetched: 0,
      startedAt: Date.now(),
    };
    await database.syncState.put({ key: TITLE_SYNC_KEY, value: state });
  } else {
    state = { ...existing, status: 'running', error: undefined };
  }

  try {
    while (state.namespaceIndex < state.namespaceIds.length) {
      const namespace = state.namespaceIds[state.namespaceIndex];
      if (namespace === undefined) break;
      report(state, options.onProgress);

      const response = await api.query<AllPagesResponse>({
        generator: 'allpages',
        prop: 'info',
        gaplimit: 500,
        gapnamespace: namespace,
        ...(state.apcontinue ? { gapcontinue: state.apcontinue } : {}),
      });
      const rawPages = response.query?.pages ?? [];
      const nextContinue = response.continue?.gapcontinue;
      let storedBatch: PageRecord[] = [];

      await database.transaction('rw', database.pages, database.syncState, async () => {
        const ids = rawPages.map(({ pageid }) => pageid);
        const existingPages = new Map(
          (await database.pages.bulkGet(ids))
            .filter((page): page is PageRecord => page !== undefined)
            .map((page) => [page.id, page]),
        );
        const sequenceRecord = (await database.syncState.get(SEQUENCE_KEY)) as
          | SyncStateRecord<number>
          | undefined;
        let sequence = sequenceRecord?.value ?? 0;

        storedBatch = rawPages.map((rawPage) => {
          const oldPage = existingPages.get(rawPage.pageid);
          if (
            oldPage &&
            typeof oldPage.revisionId === 'number' &&
            typeof rawPage.lastrevid === 'number' &&
            oldPage.revisionId > rawPage.lastrevid
          ) {
            return {
              ...oldPage,
              seenInTitleSync: state.generation,
            };
          }
          const changed =
            !oldPage ||
            oldPage.title !== rawPage.title ||
            oldPage.namespace !== rawPage.ns ||
            oldPage.isRedirect !== Boolean(rawPage.redirect) ||
            oldPage.revisionId !== rawPage.lastrevid ||
            oldPage.contentModel !== rawPage.contentmodel ||
            oldPage.deleted;
          if (changed) sequence += 1;
          return {
            ...oldPage,
            id: rawPage.pageid,
            title: rawPage.title,
            normalizedTitle: analyzer.normalize(rawPage.title),
            namespace: rawPage.ns,
            namespaceName: state.namespaceNames[rawPage.ns] ?? String(rawPage.ns),
            isRedirect: Boolean(rawPage.redirect),
            revisionId: rawPage.lastrevid,
            contentModel: rawPage.contentmodel,
            localSeq: changed ? sequence : (oldPage?.localSeq ?? sequence),
            seenInTitleSync: state.generation,
            deleted: false,
          };
        });

        const nextState: TitleSyncState = {
          ...state,
          pagesFetched: state.pagesFetched + rawPages.length,
          namespaceIndex: nextContinue
            ? state.namespaceIndex
            : state.namespaceIndex + 1,
          ...(nextContinue ? { apcontinue: nextContinue } : { apcontinue: undefined }),
        };
        await database.pages.bulkPut(storedBatch);
        await database.syncState.bulkPut([
          { key: SEQUENCE_KEY, value: sequence },
          { key: TITLE_SYNC_KEY, value: nextState },
        ]);
        state = nextState;
      });

      await options.onBatch?.(storedBatch);
      report(state, options.onProgress);
      if (state.namespaceIndex < state.namespaceIds.length) {
        await delay(options.requestIntervalMs ?? 300);
      }
    }

    await database.transaction('rw', database.pages, database.syncState, async () => {
      const stalePages = await database.pages
        .filter((page) => !page.deleted && page.seenInTitleSync !== state.generation)
        .toArray();
      const sequenceRecord = (await database.syncState.get(SEQUENCE_KEY)) as
        | SyncStateRecord<number>
        | undefined;
      let sequence = sequenceRecord?.value ?? 0;
      for (const page of stalePages) {
        sequence += 1;
        page.deleted = true;
        page.content = undefined;
        page.contentRevisionId = undefined;
        page.localSeq = sequence;
      }
      await database.pages.bulkPut(stalePages);
      state = { ...state, status: 'complete', completedAt: Date.now() };
      await database.syncState.bulkPut([
        { key: SEQUENCE_KEY, value: sequence },
        { key: TITLE_SYNC_KEY, value: state },
      ]);
    });
    report(state, options.onProgress);
    return state;
  } catch (error) {
    state = {
      ...state,
      status: 'failed',
      error: error instanceof Error ? error.message : String(error),
    };
    await database.syncState.put({ key: TITLE_SYNC_KEY, value: state });
    report(state, options.onProgress);
    throw error;
  }
}

function report(
  state: TitleSyncState,
  callback: TitleSyncOptions['onProgress'],
): void {
  callback?.({
    status: state.status,
    pagesFetched: state.pagesFetched,
    namespaceIndex: state.namespaceIndex,
    namespaceCount: state.namespaceIds.length,
    namespaceName: state.namespaceNames[state.namespaceIds[state.namespaceIndex] ?? -1],
    error: state.error,
  });
}
