// SPDX-License-Identifier: MPL-2.0
import Dexie, { type EntityTable } from 'dexie';

import type {
  DataCodeRecord,
  IndexSnapshotRecord,
  JobRecord,
  PageRecord,
  SyncStateRecord,
} from '../types';

export const DATABASE_NAME = 'cu-wiki-local-search';

export class WikiSearchDatabase extends Dexie {
  dataCodes!: EntityTable<DataCodeRecord, 'source'>;
  fileResources!: EntityTable<PageRecord, 'id'>;
  pages!: EntityTable<PageRecord, 'id'>;
  jobs!: EntityTable<JobRecord, 'id'>;
  syncState!: EntityTable<SyncStateRecord, 'key'>;
  indexSnapshots!: EntityTable<IndexSnapshotRecord, 'key'>;

  constructor(name = DATABASE_NAME) {
    super(name);
    this.version(1).stores({
      pages: '&id, title, namespace, localSeq, isRedirect, deleted',
      jobs: '++id, type, pageId, status',
      syncState: '&key',
      indexSnapshots: '&key, throughLocalSeq',
    });
    this.version(2).stores({
      pages: '&id, title, namespace, localSeq, isRedirect, deleted',
      jobs: '++id, type, pageId, status',
      syncState: '&key',
      indexSnapshots: '&key, throughLocalSeq',
      dataCodes: '&source, code, chineseName, dataType',
    });
    this.version(3).stores({
      pages: '&id, title, namespace, localSeq, isRedirect, deleted',
      fileResources: '&id, title, normalizedTitle',
      jobs: '++id, type, pageId, status',
      syncState: '&key',
      indexSnapshots: '&key, throughLocalSeq',
      dataCodes: '&source, code, chineseName, dataType',
    });
  }
}

/**
 * Streams the cold-start title facts so full page bodies are never retained in
 * the array shared with the lightweight title index.
 */
export async function readActivePageHeaders(
  database: WikiSearchDatabase,
): Promise<PageRecord[]> {
  const headers: PageRecord[] = [];
  await database.pages
    .filter((page) => !page.deleted)
    .each((page) => {
      headers.push(toPageHeader(page));
    });
  return headers;
}

/** Streams lean title facts after a sequence, including deletion tombstones. */
export async function readPageHeadersAfter(
  database: WikiSearchDatabase,
  localSeq: number,
): Promise<PageRecord[]> {
  const headers: PageRecord[] = [];
  await database.pages
    .where('localSeq')
    .above(localSeq)
    .each((page) => {
      headers.push(toPageHeader(page));
    });
  return headers;
}

function toPageHeader(page: PageRecord): PageRecord {
  return {
    id: page.id,
    title: page.title,
    normalizedTitle: page.normalizedTitle,
    namespace: page.namespace,
    namespaceName: page.namespaceName,
    isRedirect: page.isRedirect,
    localSeq: page.localSeq,
    seenInTitleSync: page.seenInTitleSync,
    deleted: page.deleted,
  };
}
