// SPDX-License-Identifier: MPL-2.0
import type { WikiSearchDatabase } from '../storage/database';
import { LOCAL_SEQUENCE_KEY, readLocalSequence } from '../storage/sync-state';
import type {
  ContentSyncProgress,
  JobRecord,
  PageRecord,
} from '../types';
import {
  CONTENT_JOB_TYPE,
  contentJobFromProjection,
  contentJobMatchesProjection,
  isContentJobEligible,
  isSearchableContentModel,
  projectContentJob,
} from './content-job-policy';
import { delay, type WikiApi } from './wiki-api';

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
  let currentProgress = await progress(database);
  reportProgress(currentProgress, options.onProgress);
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

      const progressDelta = await database.transaction(
        'rw',
        database.pages,
        database.fileResources,
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
        const delta = emptyProgress();
        let sequence = await readLocalSequence(database);
        const initialSequence = sequence;
        for (const requestedJob of batch) {
          const job =
            requestedJob.id === undefined ? undefined : currentJobs.get(requestedJob.id);
          if (!job) {
            addJobTransition(delta, requestedJob.status, undefined);
            continue;
          }
          if (job.status !== 'running' && job.status !== 'pending') continue;
          const stored = storedPages.get(job.pageId);
          if (
            !stored ||
            stored.deleted ||
            stored.isRedirect ||
            !isSearchableContentModel(stored.contentModel)
          ) {
            if (job.id !== undefined) jobsToDelete.push(job.id);
            addJobTransition(delta, job.status, undefined);
            continue;
          }

          const raw = rawById.get(job.pageId);
          const revision = raw?.revisions?.[0];
          const slot = revision?.slots?.main;
          if (!revision || typeof slot?.content !== 'string') {
            const previousStatus = job.status;
            job.status = 'failed';
            job.error = '页面或正文响应缺失';
            job.updatedAt = Date.now();
            jobsToPut.push(job);
            addJobTransition(delta, previousStatus, job.status);
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
          const previousStatus = job.status;
          job.status = 'done';
          job.targetRevisionId = stored.revisionId;
          job.error = undefined;
          job.updatedAt = Date.now();
          updatedPages.push(stored);
          jobsToPut.push(job);
          addJobTransition(delta, previousStatus, job.status);
        }
        await database.pages.bulkPut(updatedPages);
        if (jobsToDelete.length) await database.jobs.bulkDelete(jobsToDelete);
        if (jobsToPut.length) await database.jobs.bulkPut(jobsToPut);
        if (sequence !== initialSequence) {
          await database.syncState.put({ key: LOCAL_SEQUENCE_KEY, value: sequence });
        }
        return delta;
        },
      );

      await options.onBatch?.(updatedPages);
      currentProgress = applyProgressDelta(currentProgress, progressDelta);
      reportProgress(currentProgress, options.onProgress);
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

  reportProgress(currentProgress, options.onProgress);
  return currentProgress;
}

export async function prepareContentJobs(
  database: WikiSearchDatabase,
  force: boolean,
): Promise<void> {
  await database.transaction('rw', database.pages, database.jobs, async () => {
    const existingJobs = await database.jobs
      .where('type')
      .equals(CONTENT_JOB_TYPE)
      .toArray();
    const existingByPage = new Map(existingJobs.map((job) => [job.pageId, job]));
    const eligiblePageIds = new Set<number>();
    const now = Date.now();
    const jobsToPut: JobRecord[] = [];
    await database.pages.each((page) => {
      if (!isContentJobEligible(page)) return;
      eligiblePageIds.add(page.id);
      const existing = existingByPage.get(page.id);
      const projection = projectContentJob(page, force);
      if (!contentJobMatchesProjection(existing, page.id, projection)) {
        jobsToPut.push(contentJobFromProjection(page.id, projection, existing, now));
      }
    });
    const staleJobIds = existingJobs
      .filter((job) => !eligiblePageIds.has(job.pageId) && job.id !== undefined)
      .map((job) => job.id as number);
    if (staleJobIds.length) await database.jobs.bulkDelete(staleJobIds);
    if (jobsToPut.length) await database.jobs.bulkPut(jobsToPut);
  });
}

export const syncWikitextContent = syncContent;

async function progress(database: WikiSearchDatabase): Promise<ContentSyncProgress> {
  const result = emptyProgress();
  await database.jobs
    .where('type')
    .equals(CONTENT_JOB_TYPE)
    .each((job) => addJobTransition(result, undefined, job.status));
  return result;
}

function emptyProgress(): ContentSyncProgress {
  return { total: 0, done: 0, pending: 0, failed: 0 };
}

function addJobTransition(
  delta: ContentSyncProgress,
  before: JobRecord['status'] | undefined,
  after: JobRecord['status'] | undefined,
): void {
  if (before === after) return;
  if (before === undefined) delta.total += 1;
  else decrementStatus(delta, before);
  if (after === undefined) delta.total -= 1;
  else incrementStatus(delta, after);
}

function incrementStatus(progress: ContentSyncProgress, status: JobRecord['status']): void {
  if (status === 'done') progress.done += 1;
  else if (status === 'failed') progress.failed += 1;
  else progress.pending += 1;
}

function decrementStatus(progress: ContentSyncProgress, status: JobRecord['status']): void {
  if (status === 'done') progress.done -= 1;
  else if (status === 'failed') progress.failed -= 1;
  else progress.pending -= 1;
}

function applyProgressDelta(
  progress: ContentSyncProgress,
  delta: ContentSyncProgress,
): ContentSyncProgress {
  return {
    total: progress.total + delta.total,
    done: progress.done + delta.done,
    pending: progress.pending + delta.pending,
    failed: progress.failed + delta.failed,
  };
}

function reportProgress(
  value: ContentSyncProgress,
  callback: ContentSyncOptions['onProgress'],
): void {
  callback?.(value);
}
