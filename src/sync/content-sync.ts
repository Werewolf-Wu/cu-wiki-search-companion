// SPDX-License-Identifier: MPL-2.0
import type { WikiSearchDatabase } from '../storage/database';
import type {
  ContentSyncProgress,
  JobRecord,
  PageRecord,
  SyncStateRecord,
} from '../types';
import { delay, type WikiApi } from './wiki-api';

const CONTENT_JOB_TYPE = 'wikitext-content';
const LOCAL_SEQUENCE_KEY = 'local-sequence';
const BATCH_SIZE = 50;

interface ContentResponse {
  query?: {
    pages?: Array<{
      pageid: number;
      ns: number;
      title: string;
      revisions?: Array<{
        revid: number;
        slots?: { main?: { contentmodel?: string; content?: string } };
      }>;
    }>;
  };
}

export interface ContentSyncOptions {
  force?: boolean;
  requestIntervalMs?: number;
  onBatch?: (pages: PageRecord[]) => void | Promise<void>;
  onProgress?: (progress: ContentSyncProgress) => void;
}

export async function syncContent(
  database: WikiSearchDatabase,
  api: WikiApi,
  options: ContentSyncOptions = {},
): Promise<ContentSyncProgress> {
  await prepareContentJobs(database, options.force ?? false);
  reportProgress(await progress(database), options.onProgress);
  const claimedJobs = new Map<number, number>();

  try {
    while (true) {
      const batch = await database.jobs
        .where('status')
        .equals('pending')
        .filter((job) => job.type === CONTENT_JOB_TYPE)
        .limit(BATCH_SIZE)
        .toArray();
      if (!batch.length) break;

      const now = Date.now();
      await database.transaction('rw', database.jobs, async () => {
        for (const job of batch) {
          job.status = 'running';
          job.error = undefined;
          job.updatedAt = now;
        }
        await database.jobs.bulkPut(batch);
      });
      for (const job of batch) {
        if (job.id !== undefined) claimedJobs.set(job.id, now);
      }

      const response = await api.query<ContentResponse>({
        prop: 'revisions',
        pageids: batch.map((job) => job.pageId).join('|'),
        rvprop: 'ids|content',
        rvslots: 'main',
      });
      const rawById = new Map((response.query?.pages ?? []).map((page) => [page.pageid, page]));
      const updatedPages: PageRecord[] = [];

      await database.transaction(
        'rw',
        database.pages,
        database.jobs,
        database.syncState,
        async () => {
        const storedPages = new Map(
          (await database.pages.bulkGet(batch.map((job) => job.pageId)))
            .filter((page): page is PageRecord => page !== undefined)
            .map((page) => [page.id, page]),
        );
        const currentJobs = new Map(
          (await database.jobs.bulkGet(batch.flatMap((job) => job.id ?? [])))
            .filter((job): job is JobRecord => job !== undefined)
            .map((job) => [job.id, job]),
        );
        const jobsToPut: JobRecord[] = [];
        const jobsToDelete: number[] = [];
        const sequenceRecord = (await database.syncState.get(
          LOCAL_SEQUENCE_KEY,
        )) as SyncStateRecord<number> | undefined;
        const newestPage = sequenceRecord
          ? undefined
          : await database.pages.orderBy('localSeq').last();
        let sequence = sequenceRecord?.value ?? newestPage?.localSeq ?? 0;
        const initialSequence = sequence;
        for (const requestedJob of batch) {
          const job =
            requestedJob.id === undefined ? undefined : currentJobs.get(requestedJob.id);
          if (!job || (job.status !== 'running' && job.status !== 'pending')) continue;
          const stored = storedPages.get(job.pageId);
          if (
            !stored ||
            stored.deleted ||
            stored.isRedirect ||
            !isSearchableContentModel(stored.contentModel)
          ) {
            if (job.id !== undefined) jobsToDelete.push(job.id);
            continue;
          }

          const raw = rawById.get(job.pageId);
          const revision = raw?.revisions?.[0];
          const slot = revision?.slots?.main;
          if (!revision || typeof slot?.content !== 'string') {
            job.status = 'failed';
            job.error = '页面或正文响应缺失';
            job.updatedAt = Date.now();
            jobsToPut.push(job);
            continue;
          }

          const expectedRevision = Math.max(
            stored.revisionId ?? 0,
            stored.contentRevisionId ?? 0,
            job.targetRevisionId ?? 0,
          );
          if (revision.revid < expectedRevision) {
            throw new Error(
              `正文响应版本落后：页面 ${job.pageId} 期望 ${expectedRevision}，收到 ${revision.revid}`,
            );
          }

          const nextContentModel = slot.contentmodel ?? stored.contentModel ?? 'wikitext';
          const searchableFactChanged =
            stored.content !== slot.content ||
            stored.contentModel?.toLocaleLowerCase() !==
              nextContentModel.toLocaleLowerCase();
          stored.content = slot.content;
          stored.contentRevisionId = revision.revid;
          stored.contentModel = nextContentModel;
          stored.revisionId = Math.max(stored.revisionId ?? 0, revision.revid);
          if (searchableFactChanged) {
            sequence += 1;
            stored.localSeq = sequence;
          }
          job.status = 'done';
          job.targetRevisionId = stored.revisionId;
          job.error = undefined;
          job.updatedAt = Date.now();
          updatedPages.push(stored);
          jobsToPut.push(job);
        }
        await database.pages.bulkPut(updatedPages);
        if (jobsToDelete.length) await database.jobs.bulkDelete(jobsToDelete);
        if (jobsToPut.length) await database.jobs.bulkPut(jobsToPut);
        if (sequence !== initialSequence) {
          await database.syncState.put({ key: LOCAL_SEQUENCE_KEY, value: sequence });
        }
        },
      );

      await options.onBatch?.(updatedPages);
      reportProgress(await progress(database), options.onProgress);
      await delay(options.requestIntervalMs ?? 300);
    }
  } catch (error) {
    await database.transaction('rw', database.jobs, async () => {
      const running = (await database.jobs.bulkGet([...claimedJobs.keys()])).filter(
        (job): job is JobRecord =>
          job !== undefined &&
          job.type === CONTENT_JOB_TYPE &&
          job.status === 'running' &&
          job.id !== undefined &&
          job.updatedAt === claimedJobs.get(job.id),
      );
      for (const job of running) {
        job.status = 'pending';
        job.updatedAt = Date.now();
      }
      await database.jobs.bulkPut(running);
    });
    throw error;
  }

  const finalProgress = await progress(database);
  reportProgress(finalProgress, options.onProgress);
  return finalProgress;
}

export async function prepareContentJobs(
  database: WikiSearchDatabase,
  force: boolean,
): Promise<void> {
  await database.transaction('rw', database.pages, database.jobs, async () => {
    const [pages, existingJobs] = await Promise.all([
      database.pages
        .filter(
          (page) =>
            !page.deleted && !page.isRedirect && isSearchableContentModel(page.contentModel),
        )
        .toArray(),
      database.jobs.filter((job) => job.type === CONTENT_JOB_TYPE).toArray(),
    ]);
    const existingByPage = new Map(existingJobs.map((job) => [job.pageId, job]));
    const eligiblePageIds = new Set(pages.map((page) => page.id));
    const now = Date.now();
    const jobs = pages.map((page) => {
      const existing = existingByPage.get(page.id);
      const upToDate =
        !force &&
        typeof page.content === 'string' &&
        page.contentRevisionId === page.revisionId;
      return {
        ...existing,
        type: CONTENT_JOB_TYPE,
        pageId: page.id,
        status: upToDate ? 'done' : 'pending',
        targetRevisionId: page.revisionId,
        error: undefined,
        updatedAt: now,
      } satisfies JobRecord;
    });
    const staleJobIds = existingJobs
      .filter((job) => !eligiblePageIds.has(job.pageId) && job.id !== undefined)
      .map((job) => job.id as number);
    if (staleJobIds.length) await database.jobs.bulkDelete(staleJobIds);
    if (jobs.length) await database.jobs.bulkPut(jobs);
  });
}

export const syncWikitextContent = syncContent;

function isSearchableContentModel(contentModel: string | undefined): boolean {
  const normalized = contentModel?.toLocaleLowerCase();
  return normalized === 'wikitext' || normalized === 'bson' || normalized === 'scribunto';
}

async function progress(database: WikiSearchDatabase): Promise<ContentSyncProgress> {
  const jobs = await database.jobs.filter((job) => job.type === CONTENT_JOB_TYPE).toArray();
  return {
    total: jobs.length,
    done: jobs.filter((job) => job.status === 'done').length,
    pending: jobs.filter((job) => job.status === 'pending' || job.status === 'running').length,
    failed: jobs.filter((job) => job.status === 'failed').length,
  };
}

function reportProgress(
  value: ContentSyncProgress,
  callback: ContentSyncOptions['onProgress'],
): void {
  callback?.(value);
}
