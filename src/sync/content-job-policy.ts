// SPDX-License-Identifier: MPL-2.0
import type { JobRecord, PageRecord } from '../types';

export const CONTENT_JOB_TYPE = 'wikitext-content';

export interface ContentJobProjection {
  status: JobRecord['status'];
  targetRevisionId: number | undefined;
  error: undefined;
}

export function isSearchableContentModel(contentModel: string | undefined): boolean {
  const normalized = contentModel?.toLocaleLowerCase();
  return normalized === 'wikitext' || normalized === 'bson' || normalized === 'scribunto';
}

export function isContentJobEligible(
  page: Pick<PageRecord, 'deleted' | 'isRedirect' | 'contentModel'>,
): boolean {
  return !page.deleted && !page.isRedirect && isSearchableContentModel(page.contentModel);
}

export function projectContentJob(
  page: Pick<PageRecord, 'content' | 'contentRevisionId' | 'revisionId'>,
  force: boolean,
): ContentJobProjection {
  const upToDate =
    !force &&
    typeof page.content === 'string' &&
    page.contentRevisionId === page.revisionId;
  return {
    status: upToDate ? 'done' : 'pending',
    targetRevisionId: page.revisionId,
    error: undefined,
  };
}

export function contentJobMatchesProjection(
  job: JobRecord | undefined,
  pageId: number,
  projection: ContentJobProjection,
): boolean {
  return (
    job !== undefined &&
    job.type === CONTENT_JOB_TYPE &&
    job.pageId === pageId &&
    job.status === projection.status &&
    job.targetRevisionId === projection.targetRevisionId &&
    job.error === projection.error
  );
}

export function contentJobFromProjection(
  pageId: number,
  projection: ContentJobProjection,
  existing: JobRecord | undefined,
  updatedAt: number,
): JobRecord {
  return {
    ...existing,
    type: CONTENT_JOB_TYPE,
    pageId,
    ...projection,
    updatedAt,
  };
}

/** Facts shared by RecentChanges and reconciliation for searchable page rows. */
export function searchablePageFactChanged(
  previous: PageRecord | undefined,
  next: PageRecord,
): boolean {
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
