// SPDX-License-Identifier: MPL-2.0
import type { Analyzer } from '../analyzer/analyzer';
import type { WikiSearchDatabase } from '../storage/database';
import type {
  PageRecord,
  RecentChangeMarker,
  RecentChangeSyncResult,
  RecentChangeSyncState,
  SyncStateRecord,
} from '../types';
import { readFileResourceSyncState } from './file-resource-sync';
import { readTitleSyncState } from './title-sync';
import { delay, type WikiApi, WikiApiError } from './wiki-api';

const RECENT_CHANGES_SYNC_KEY = 'recent-changes-sync';
const LOCAL_SEQUENCE_KEY = 'local-sequence';
const DEFAULT_OVERLAP_MS = 5 * 60 * 1_000;
const BATCH_SIZE = 50;
const CONTENT_JOB_TYPE = 'wikitext-content';
const PAGE_AFFECTING_LOG_TYPES = new Set([
  'contentmodel',
  'delete',
  'import',
  'merge',
  'move',
  'upload',
]);

interface ServerClockResponse {
  curtimestamp?: string;
}

interface RawRecentChange {
  type: 'edit' | 'new' | 'log';
  ns: number;
  title: string;
  pageid: number;
  revid: number;
  old_revid: number;
  rcid: number;
  timestamp: string;
  bot?: boolean;
  logtype?: string;
  logaction?: string;
  logparams?: Record<string, unknown>;
}

interface RecentChangesResponse {
  continue?: { rccontinue?: string };
  query?: { recentchanges?: RawRecentChange[] };
}

interface RawPageInfo {
  pageid?: number;
  ns?: number;
  title?: string;
  missing?: boolean;
  redirect?: boolean;
  lastrevid?: number;
  contentmodel?: string;
}

interface PageInfoResponse {
  query?: { pages?: RawPageInfo[] };
}

interface ContentResponse {
  query?: {
    pages?: Array<{
      pageid: number;
      revisions?: Array<{
        revid: number;
        slots?: { main?: { contentmodel?: string; content?: string } };
      }>;
    }>;
  };
}

interface PageCandidates {
  byPageId: Map<number, RawRecentChange>;
  titles: Set<string>;
}

export interface RecentChangeSyncOptions {
  overlapMs?: number;
  requestIntervalMs?: number;
}

export async function syncRecentChanges(
  database: WikiSearchDatabase,
  api: WikiApi,
  analyzer: Analyzer,
  options: RecentChangeSyncOptions = {},
): Promise<RecentChangeSyncResult> {
  const [titleState, fileState, incrementalState, sequenceRecord] = await Promise.all([
    readTitleSyncState(database),
    readFileResourceSyncState(database),
    readRecentChangeSyncState(database),
    database.syncState.get(LOCAL_SEQUENCE_KEY) as Promise<SyncStateRecord<number> | undefined>,
  ]);
  const initialSequence = sequenceRecord?.value ?? 0;
  if (titleState?.status !== 'complete') return inactiveResult('no-baseline', initialSequence);

  const overlapMs = options.overlapMs ?? DEFAULT_OVERLAP_MS;
  const baseline = incrementalState?.through ?? new Date(titleState.startedAt).toISOString();
  const startedAt = new Date(Date.parse(baseline) - overlapMs).toISOString();
  let clock: ServerClockResponse;
  try {
    clock = await api.query<ServerClockResponse>({
      assert: 'user',
      curtimestamp: 1,
      meta: 'siteinfo',
      siprop: 'general',
    });
  } catch (error) {
    if (isLoginRequired(error)) return inactiveResult('login-required', initialSequence);
    throw error;
  }
  if (!clock.curtimestamp) throw new Error('Wiki API 未返回服务器时间');
  const through = clock.curtimestamp;

  let collectedEvents: RawRecentChange[];
  try {
    collectedEvents = await collectRecentChanges(
      api,
      startedAt,
      through,
      options.requestIntervalMs ?? 300,
    );
  } catch (error) {
    if (isLoginRequired(error)) return inactiveResult('login-required', initialSequence);
    throw error;
  }
  const events = deduplicateRecentChanges(
    collectedEvents,
    incrementalState?.recentChanges ?? [],
  );
  const candidates = collectPageCandidates(events);
  let infoPages: RawPageInfo[];
  try {
    infoPages = deduplicatePageInfo(
      await fetchPageInfo(
        api,
        [...candidates.byPageId.keys()],
        [...candidates.titles],
        options.requestIntervalMs ?? 300,
      ),
    );
  } catch (error) {
    if (isLoginRequired(error)) return inactiveResult('login-required', initialSequence);
    throw error;
  }
  const regularInfoPages = infoPages.filter(
    (page) => pageNamespace(page, candidates) !== 6,
  );
  const fileInfoPages = infoPages.filter(
    (page) => pageNamespace(page, candidates) === 6,
  );
  const activeInfoPages = regularInfoPages.filter(
    (page): page is RawPageInfo & { pageid: number } =>
      !page.missing && typeof page.pageid === 'number',
  );
  const storedPages = new Map(
    (await database.pages.bulkGet(activeInfoPages.map(({ pageid }) => pageid)))
      .filter((page): page is PageRecord => page !== undefined)
      .map((page) => [page.id, page]),
  );
  const contentPageIds = activeInfoPages
    .filter(
      (page): page is RawPageInfo & { pageid: number; lastrevid: number } =>
        typeof page.pageid === 'number' &&
        typeof page.lastrevid === 'number' &&
        !page.missing &&
        !page.redirect &&
        isSearchableContentModel(page.contentmodel) &&
        (storedPages.get(page.pageid)?.revisionId ?? 0) <= page.lastrevid &&
        storedPages.get(page.pageid)?.contentRevisionId !== page.lastrevid,
    )
    .map((page) => page.pageid);
  let revisions: Awaited<ReturnType<typeof fetchContent>>;
  try {
    revisions = await fetchContent(
      api,
      contentPageIds,
      options.requestIntervalMs ?? 300,
    );
  } catch (error) {
    if (isLoginRequired(error)) return inactiveResult('login-required', initialSequence);
    throw error;
  }
  const contentPageIdSet = new Set(contentPageIds);
  const expectedRevisionByPageId = new Map(
    activeInfoPages.flatMap((page) =>
      typeof page.lastrevid === 'number' && contentPageIdSet.has(page.pageid)
        ? [[page.pageid, page.lastrevid] as const]
        : [],
    ),
  );
  for (const [pageId, expectedRevision] of expectedRevisionByPageId) {
    const received = revisions.get(pageId);
    if (!received || received.revid !== expectedRevision) {
      throw new Error(`页面正文响应缺失或版本不一致：${pageId}`);
    }
  }
  const recentChanges = retainedMarkers(
    incrementalState?.recentChanges ?? [],
    events,
    through,
    overlapMs,
  );
  let changedPages: PageRecord[] = [];
  let sequence = initialSequence;
  let filesChanged = false;
  let dataCodesInvalidated = false;

  await database.transaction(
    'rw',
    database.pages,
    database.fileResources,
    database.jobs,
    database.syncState,
    async () => {
    const currentSequenceRecord = (await database.syncState.get(
      LOCAL_SEQUENCE_KEY,
    )) as SyncStateRecord<number> | undefined;
    sequence = currentSequenceRecord?.value ?? initialSequence;
    const missingTitles = regularInfoPages
      .filter((page) => page.missing && typeof page.title === 'string')
      .map((page) => page.title as string);
    const pagesByMissingTitle = missingTitles.length
      ? await database.pages.where('title').anyOf(missingTitles).toArray()
      : [];
    const pageIds = new Set([
      ...activeInfoPages.map(({ pageid }) => pageid),
      ...regularInfoPages.flatMap((page) =>
        page.missing && typeof page.pageid === 'number' ? [page.pageid] : [],
      ),
      ...pagesByMissingTitle.map(({ id }) => id),
    ]);
    const currentPages = new Map(
      (await database.pages.bulkGet([...pageIds]))
        .filter((page): page is PageRecord => page !== undefined)
        .map((page) => [page.id, page]),
    );
    const existingJobs = await database.jobs
      .filter((job) => job.type === CONTENT_JOB_TYPE && pageIds.has(job.pageId))
      .toArray();
    const jobsByPageId = new Map(existingJobs.map((job) => [job.pageId, job]));
    const nextPages = new Map<number, PageRecord>();
    const activePageIds = new Set(activeInfoPages.map(({ pageid }) => pageid));
    for (const raw of activeInfoPages) {
      const oldPage = currentPages.get(raw.pageid);
      if (
        oldPage &&
        typeof oldPage.revisionId === 'number' &&
        typeof raw.lastrevid === 'number' &&
        oldPage.revisionId > raw.lastrevid
      ) {
        nextPages.set(oldPage.id, {
          ...oldPage,
          seenInTitleSync: titleState.generation,
        });
        continue;
      }
      const revision = revisions.get(raw.pageid);
      const candidate = candidates.byPageId.get(raw.pageid);
      const contentEligible = !raw.redirect && isSearchableContentModel(raw.contentmodel);
      const nextPage: PageRecord = {
        ...oldPage,
        id: raw.pageid,
        title: raw.title ?? oldPage?.title ?? candidate?.title ?? String(raw.pageid),
        normalizedTitle: analyzer.normalize(
          raw.title ?? oldPage?.title ?? candidate?.title ?? String(raw.pageid),
        ),
        namespace: raw.ns ?? oldPage?.namespace ?? candidate?.ns ?? 0,
        namespaceName:
          titleState.namespaceNames[raw.ns ?? oldPage?.namespace ?? 0] ??
          String(raw.ns ?? oldPage?.namespace ?? 0),
        isRedirect: Boolean(raw.redirect),
        localSeq: oldPage?.localSeq ?? sequence,
        seenInTitleSync: titleState.generation,
        deleted: false,
        revisionId: raw.lastrevid,
        contentModel: revision?.contentModel ?? raw.contentmodel ?? oldPage?.contentModel,
        ...(contentEligible
          ? revision
            ? { content: revision.content, contentRevisionId: revision.revid }
            : {}
          : { content: undefined, contentRevisionId: undefined }),
      };
      if (pageChanged(oldPage, nextPage)) {
        sequence += 1;
        nextPage.localSeq = sequence;
        changedPages.push(nextPage);
        if (nextPage.namespace === 3500) dataCodesInvalidated = true;
      }
      nextPages.set(nextPage.id, nextPage);
    }

    for (const raw of regularInfoPages) {
      if (!raw.missing || typeof raw.pageid !== 'number' || activePageIds.has(raw.pageid)) {
        continue;
      }
      const oldPage = currentPages.get(raw.pageid);
      if (!oldPage) continue;
      const deletedPage = tombstone(oldPage, titleState.generation);
      if (pageChanged(oldPage, deletedPage)) {
        sequence += 1;
        deletedPage.localSeq = sequence;
        changedPages.push(deletedPage);
        if (deletedPage.namespace === 3500) dataCodesInvalidated = true;
      }
      nextPages.set(deletedPage.id, deletedPage);
    }
    for (const oldPage of pagesByMissingTitle) {
      if (activePageIds.has(oldPage.id) || nextPages.has(oldPage.id)) continue;
      const deletedPage = tombstone(oldPage, titleState.generation);
      if (pageChanged(oldPage, deletedPage)) {
        sequence += 1;
        deletedPage.localSeq = sequence;
        changedPages.push(deletedPage);
        if (deletedPage.namespace === 3500) dataCodesInvalidated = true;
      }
      nextPages.set(deletedPage.id, deletedPage);
    }
    if (nextPages.size) await database.pages.bulkPut([...nextPages.values()]);
    const jobsToPut = [...nextPages.values()].flatMap((page) => {
      if (page.deleted || page.isRedirect || !isSearchableContentModel(page.contentModel)) {
        return [];
      }
      const upToDate =
        typeof page.content === 'string' && page.contentRevisionId === page.revisionId;
      return [
        {
          ...jobsByPageId.get(page.id),
          type: CONTENT_JOB_TYPE,
          pageId: page.id,
          status: upToDate ? ('done' as const) : ('pending' as const),
          targetRevisionId: page.revisionId,
          error: undefined,
          updatedAt: Date.now(),
        },
      ];
    });
    const retainedJobPageIds = new Set(jobsToPut.map(({ pageId }) => pageId));
    const staleJobIds = existingJobs.flatMap((job) =>
      !retainedJobPageIds.has(job.pageId) && job.id !== undefined ? [job.id] : [],
    );
    if (staleJobIds.length) await database.jobs.bulkDelete(staleJobIds);
    if (jobsToPut.length) await database.jobs.bulkPut(jobsToPut);

    if (dataCodesInvalidated) {
      const dataCodeState = await database.syncState.get('data-code-sync');
      if (dataCodeState?.value && typeof dataCodeState.value === 'object') {
        await database.syncState.put({
          key: 'data-code-sync',
          value: { ...dataCodeState.value, syncedAt: 0 },
        });
      }
    }

    if (fileState?.status === 'complete') {
      const activeFiles = fileInfoPages.filter(
        (page): page is RawPageInfo & { pageid: number } =>
          !page.missing && typeof page.pageid === 'number',
      );
      const missingFileTitles = fileInfoPages
        .filter((page) => page.missing && typeof page.title === 'string')
        .map((page) => page.title as string);
      const filesByMissingTitle = missingFileTitles.length
        ? await database.fileResources.where('title').anyOf(missingFileTitles).toArray()
        : [];
      const fileIds = new Set([
        ...activeFiles.map(({ pageid }) => pageid),
        ...fileInfoPages.flatMap((page) =>
          page.missing && typeof page.pageid === 'number' ? [page.pageid] : [],
        ),
      ]);
      const storedFiles = new Map(
        (await database.fileResources.bulkGet([...fileIds]))
          .filter((file): file is PageRecord => file !== undefined)
          .map((file) => [file.id, file]),
      );
      const filesToPut: PageRecord[] = [];
      const activeFileIds = new Set(activeFiles.map(({ pageid }) => pageid));
      for (const raw of activeFiles) {
        const oldFile = storedFiles.get(raw.pageid);
        if (
          oldFile &&
          typeof oldFile.revisionId === 'number' &&
          typeof raw.lastrevid === 'number' &&
          oldFile.revisionId > raw.lastrevid
        ) {
          filesToPut.push({ ...oldFile, seenInTitleSync: fileState.generation });
          continue;
        }
        const title = raw.title ?? oldFile?.title ?? candidates.byPageId.get(raw.pageid)?.title;
        if (!title) continue;
        const nextFile: PageRecord = {
          ...oldFile,
          id: raw.pageid,
          title,
          normalizedTitle: analyzer.normalize(title),
          namespace: 6,
          namespaceName: '文件',
          isRedirect: Boolean(raw.redirect),
          localSeq: oldFile?.localSeq ?? sequence,
          seenInTitleSync: fileState.generation,
          deleted: false,
          revisionId: raw.lastrevid,
          contentModel: raw.contentmodel ?? oldFile?.contentModel,
        };
        if (pageChanged(oldFile, nextFile)) {
          sequence += 1;
          nextFile.localSeq = sequence;
          nextFile.writerSeq = sequence;
          filesChanged = true;
        }
        filesToPut.push(nextFile);
      }
      const filesToDelete = new Set<number>();
      for (const raw of fileInfoPages) {
        if (
          !raw.missing ||
          typeof raw.pageid !== 'number' ||
          activeFileIds.has(raw.pageid) ||
          !storedFiles.has(raw.pageid)
        ) {
          continue;
        }
        filesToDelete.add(raw.pageid);
      }
      for (const file of filesByMissingTitle) {
        if (!activeFileIds.has(file.id)) filesToDelete.add(file.id);
      }
      if (filesToDelete.size) {
        const filesById = new Map([
          ...storedFiles,
          ...filesByMissingTitle.map((file) => [file.id, file] as const),
        ]);
        const tombstones: PageRecord[] = [];
        for (const fileId of filesToDelete) {
          const file = filesById.get(fileId);
          if (!file || file.deleted) continue;
          sequence += 1;
          tombstones.push({
            ...file,
            deleted: true,
            localSeq: sequence,
            writerSeq: sequence,
          });
        }
        if (tombstones.length) {
          filesChanged = true;
          await database.fileResources.bulkPut(tombstones);
        }
      }
      if (filesToPut.length) await database.fileResources.bulkPut(filesToPut);
    }
    const currentRecentState = (await database.syncState.get(
      RECENT_CHANGES_SYNC_KEY,
    ))?.value as Partial<RecentChangeSyncState> | undefined;
    const state: RecentChangeSyncState = {
      through,
      completedAt: Date.now(),
      recentChanges,
      fileChangeSeq: filesChanged
        ? sequence
        : maximumSequence(
            incrementalState?.fileChangeSeq,
            currentRecentState?.fileChangeSeq,
          ),
    };
    await database.syncState.bulkPut([
      { key: LOCAL_SEQUENCE_KEY, value: sequence },
      { key: RECENT_CHANGES_SYNC_KEY, value: state },
    ]);
    },
  );

  return {
    status: 'complete',
    startedAt,
    through,
    eventsSeen: events.length,
    candidates: candidates.byPageId.size + candidates.titles.size,
    changedPages,
    filesChanged,
    dataCodesInvalidated,
    throughLocalSeq: sequence,
  };
}

export async function readRecentChangeSyncState(
  database: WikiSearchDatabase,
): Promise<RecentChangeSyncState | undefined> {
  return (await database.syncState.get(RECENT_CHANGES_SYNC_KEY))?.value as
    | RecentChangeSyncState
    | undefined;
}

async function collectRecentChanges(
  api: WikiApi,
  startedAt: string,
  through: string,
  requestIntervalMs: number,
): Promise<RawRecentChange[]> {
  const events: RawRecentChange[] = [];
  let rccontinue: string | undefined;
  do {
    const response = await api.query<RecentChangesResponse>({
      assert: 'user',
      list: 'recentchanges',
      rcdir: 'newer',
      rcend: through,
      rclimit: 500,
      rcprop: 'title|ids|timestamp|flags|loginfo',
      rcstart: startedAt,
      rctype: 'edit|new|log',
      ...(rccontinue ? { rccontinue } : {}),
    });
    events.push(...(response.query?.recentchanges ?? []));
    rccontinue = response.continue?.rccontinue;
    if (rccontinue) await delay(requestIntervalMs);
  } while (rccontinue);
  return events;
}

function collectPageCandidates(events: RawRecentChange[]): PageCandidates {
  const byPageId = new Map<number, RawRecentChange>();
  const titles = new Set<string>();
  for (const event of events) {
    if (event.type === 'edit' || event.type === 'new') {
      if (event.pageid <= 0) continue;
      const previous = byPageId.get(event.pageid);
      if (!previous || event.revid >= previous.revid) byPageId.set(event.pageid, event);
      continue;
    }
    if (!event.logtype || !PAGE_AFFECTING_LOG_TYPES.has(event.logtype)) continue;
    if (event.logtype === 'move') {
      if (event.title) titles.add(event.title);
      const targetTitle = event.logparams?.target_title;
      if (typeof targetTitle === 'string' && targetTitle) titles.add(targetTitle);
      continue;
    }
    if (event.pageid > 0) byPageId.set(event.pageid, event);
    else if (event.title) titles.add(event.title);
  }
  return { byPageId, titles };
}

function pageNamespace(page: RawPageInfo, candidates: PageCandidates): number | undefined {
  if (typeof page.ns === 'number') return page.ns;
  if (typeof page.pageid === 'number') return candidates.byPageId.get(page.pageid)?.ns;
  return undefined;
}

async function fetchPageInfo(
  api: WikiApi,
  pageIds: number[],
  titles: string[],
  requestIntervalMs: number,
): Promise<RawPageInfo[]> {
  const result: RawPageInfo[] = [];
  const pageIdBatches = chunks(pageIds, BATCH_SIZE);
  for (const [index, batch] of pageIdBatches.entries()) {
    const response = await api.query<PageInfoResponse>({
      pageids: batch.join('|'),
      prop: 'info',
    });
    result.push(...(response.query?.pages ?? []));
    if (index + 1 < pageIdBatches.length || titles.length) await delay(requestIntervalMs);
  }
  const titleBatches = chunks(titles, BATCH_SIZE);
  for (const [index, batch] of titleBatches.entries()) {
    const response = await api.query<PageInfoResponse>({
      prop: 'info',
      titles: batch.join('|'),
    });
    result.push(...(response.query?.pages ?? []));
    if (index + 1 < titleBatches.length) await delay(requestIntervalMs);
  }
  return result;
}

async function fetchContent(
  api: WikiApi,
  pageIds: number[],
  requestIntervalMs: number,
): Promise<Map<number, { revid: number; contentModel?: string; content: string }>> {
  const result = new Map<number, { revid: number; contentModel?: string; content: string }>();
  const batches = chunks(pageIds, BATCH_SIZE);
  for (const [index, batch] of batches.entries()) {
    const response = await api.query<ContentResponse>({
      pageids: batch.join('|'),
      prop: 'revisions',
      rvprop: 'ids|content',
      rvslots: 'main',
    });
    for (const raw of response.query?.pages ?? []) {
      const revision = raw.revisions?.[0];
      const slot = revision?.slots?.main;
      if (revision && typeof slot?.content === 'string') {
        result.set(raw.pageid, {
          revid: revision.revid,
          contentModel: slot.contentmodel,
          content: slot.content,
        });
      }
    }
    if (index + 1 < batches.length) await delay(requestIntervalMs);
  }
  return result;
}

function deduplicateRecentChanges(
  events: RawRecentChange[],
  previous: RecentChangeMarker[],
): RawRecentChange[] {
  const seen = new Set(previous.map(({ rcid }) => rcid));
  const result: RawRecentChange[] = [];
  for (const event of events) {
    if (seen.has(event.rcid)) continue;
    seen.add(event.rcid);
    result.push(event);
  }
  return result;
}

function retainedMarkers(
  previous: RecentChangeMarker[],
  events: RawRecentChange[],
  through: string,
  overlapMs: number,
): RecentChangeMarker[] {
  const cutoff = Date.parse(through) - overlapMs;
  const unique = new Map<number, RecentChangeMarker>();
  for (const marker of previous) {
    if (Date.parse(marker.timestamp) >= cutoff) unique.set(marker.rcid, marker);
  }
  for (const event of events) {
    if (Date.parse(event.timestamp) >= cutoff) {
      unique.set(event.rcid, { rcid: event.rcid, timestamp: event.timestamp });
    }
  }
  return [...unique.values()];
}

function maximumSequence(...values: Array<number | undefined>): number | undefined {
  const sequences = values.filter((value): value is number => typeof value === 'number');
  return sequences.length ? Math.max(...sequences) : undefined;
}

function chunks<T>(values: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) {
    result.push(values.slice(index, index + size));
  }
  return result;
}

function deduplicatePageInfo(pages: RawPageInfo[]): RawPageInfo[] {
  const unique = new Map<string, RawPageInfo>();
  for (const page of pages) {
    const key =
      typeof page.pageid === 'number'
        ? `page:${page.pageid}`
        : `title:${page.title ?? ''}`;
    unique.set(key, page);
  }
  return [...unique.values()];
}

function isSearchableContentModel(contentModel: string | undefined): boolean {
  const normalized = contentModel?.toLocaleLowerCase();
  return normalized === 'wikitext' || normalized === 'bson' || normalized === 'scribunto';
}

function pageChanged(previous: PageRecord | undefined, next: PageRecord): boolean {
  if (!previous) return true;
  return (
    previous.title !== next.title ||
    previous.namespace !== next.namespace ||
    previous.namespaceName !== next.namespaceName ||
    previous.isRedirect !== next.isRedirect ||
    previous.deleted !== next.deleted ||
    previous.revisionId !== next.revisionId ||
    previous.contentModel !== next.contentModel ||
    previous.contentRevisionId !== next.contentRevisionId ||
    previous.content !== next.content
  );
}

function tombstone(page: PageRecord, generation: number): PageRecord {
  return {
    ...page,
    content: undefined,
    contentRevisionId: undefined,
    deleted: true,
    seenInTitleSync: generation,
  };
}

function inactiveResult(
  status: 'no-baseline' | 'login-required',
  throughLocalSeq: number,
): RecentChangeSyncResult {
  return {
    status,
    eventsSeen: 0,
    candidates: 0,
    changedPages: [],
    filesChanged: false,
    dataCodesInvalidated: false,
    throughLocalSeq,
  };
}

function isLoginRequired(error: unknown): boolean {
  return (
    error instanceof WikiApiError &&
    (error.code === 'assertuserfailed' ||
      error.code === 'readapidenied' ||
      error.code === 'permissiondenied')
  );
}
