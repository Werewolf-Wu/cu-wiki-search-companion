// SPDX-License-Identifier: MPL-2.0
import Dexie from 'dexie';

import type { WikiSearchDatabase } from '../src/storage/database';

/** Aborts a real Dexie transaction after its callback has completed. */
export function abortTransactionAfterCallback(
  database: WikiSearchDatabase,
  ordinal = 1,
): void {
  const original = database.transaction;
  let callbacksCompleted = 0;
  const replacement = function (this: WikiSearchDatabase, ...args: unknown[]) {
    const scopeIndex = args.length - 1;
    const scope = args[scopeIndex] as (...scopeArgs: unknown[]) => unknown;
    args[scopeIndex] = async (...scopeArgs: unknown[]) => {
      const result = await scope(...scopeArgs);
      callbacksCompleted += 1;
      if (callbacksCompleted === ordinal) {
        database.transaction = original;
        Dexie.currentTransaction?.abort();
      }
      return result;
    };
    return Reflect.apply(original, this, args);
  };
  database.transaction = replacement as typeof database.transaction;
}
