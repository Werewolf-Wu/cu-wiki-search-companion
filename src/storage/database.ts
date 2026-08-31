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
