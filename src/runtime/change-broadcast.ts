// SPDX-License-Identifier: MPL-2.0
import type { StorageInvalidationRequest } from './runtime-lifecycle-coordinator';

export type ChangeBroadcastEffect =
  | { type: 'reset' }
  | {
      type: 'refresh';
      invalidation: StorageInvalidationRequest;
      dataRefresh: 'pending' | 'complete' | 'unchanged';
    };

export function changeBroadcastEffect(message: unknown): ChangeBroadcastEffect {
  const record =
    message && typeof message === 'object'
      ? (message as {
          type?: unknown;
          filesChanged?: unknown;
          dataCodesInvalidated?: unknown;
        })
      : undefined;
  if (record?.type === 'reset') return { type: 'reset' };
  if (record?.type === 'files-committed') {
    return {
      type: 'refresh',
      invalidation: { files: true },
      dataRefresh: 'unchanged',
    };
  }
  if (record?.type === 'data-committed') {
    return {
      type: 'refresh',
      invalidation: { data: true },
      dataRefresh: 'pending',
    };
  }
  return {
    type: 'refresh',
    invalidation: {
      pages: true,
      files: record?.filesChanged === true,
    },
    dataRefresh: record?.dataCodesInvalidated === true ? 'pending' : 'unchanged',
  };
}
