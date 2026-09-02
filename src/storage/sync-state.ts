// SPDX-License-Identifier: MPL-2.0
import type { WikiSearchDatabase } from './database';

export const LOCAL_SEQUENCE_KEY = 'local-sequence';

export function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Reads the committed local write sequence. Older databases can be missing the
 * explicit state record, so recover it from page writes and file writer
 * sequences. A file row's legacy localSeq is a revision marker, not a writer
 * sequence, and must never participate in this fallback.
 */
export async function readLocalSequence(database: WikiSearchDatabase): Promise<number> {
  const record = await database.syncState.get(LOCAL_SEQUENCE_KEY);
  if (isNonNegativeSafeInteger(record?.value)) return record.value;

  let maximum = 0;
  await database.pages.each((page) => {
    if (isNonNegativeSafeInteger(page.localSeq)) maximum = Math.max(maximum, page.localSeq);
  });
  await database.fileResources.each((file) => {
    if (isNonNegativeSafeInteger(file.writerSeq)) {
      maximum = Math.max(maximum, file.writerSeq);
    }
  });
  return maximum;
}
