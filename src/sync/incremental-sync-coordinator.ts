// SPDX-License-Identifier: MPL-2.0
import type { WikiSearchDatabase } from '../storage/database';
import { isIncrementalSyncScheduleState } from '../storage/sync-state';
import { ensureVersionContractForWrite } from '../storage/version-contract';

const LOCK_NAME = 'cu-wiki-local-search:incremental-sync:v1';
const SCHEDULE_STATE_KEY = 'incremental-sync-schedule';
const DEFAULT_INTERVAL_MS = 5 * 60 * 1_000;
const DEFAULT_JITTER_MS = 60 * 1_000;

export type CoordinatedSyncResult = 'ran' | 'not-due' | 'lock-unavailable';
export type ExclusiveSyncResult = 'ran' | 'lock-unavailable';

interface IncrementalSyncScheduleState {
  lastSuccessAt: number;
  nextDueAt: number;
}

interface LockManagerAdapter {
  request<T>(
    name: string,
    options: LockOptions,
    callback: LockGrantedCallback<T>,
  ): Promise<T>;
}

export interface IncrementalSyncCoordinatorOptions {
  intervalMs?: number;
  jitterMs?: number;
  lockManager?: LockManagerAdapter | null;
  now?: () => number;
  random?: () => number;
}

export class IncrementalSyncCoordinator {
  private readonly intervalMs: number;
  private readonly jitterMs: number;
  private readonly lockManager: LockManagerAdapter | undefined;
  private readonly now: () => number;
  private readonly random: () => number;

  constructor(
    private readonly database: WikiSearchDatabase,
    options: IncrementalSyncCoordinatorOptions = {},
  ) {
    this.intervalMs = options.intervalMs ?? DEFAULT_INTERVAL_MS;
    this.jitterMs = options.jitterMs ?? DEFAULT_JITTER_MS;
    this.lockManager =
      options.lockManager === null
        ? undefined
        : (options.lockManager ?? globalThis.navigator?.locks);
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
  }

  async runIfDue(task: () => Promise<boolean | void>): Promise<CoordinatedSyncResult> {
    if (!this.lockManager) return 'lock-unavailable';

    return this.lockManager.request(
      LOCK_NAME,
      { ifAvailable: true, mode: 'exclusive' },
      async (lock) => {
        if (!lock) return 'lock-unavailable';

        const rawStored = (await this.database.syncState.get(SCHEDULE_STATE_KEY))?.value;
        const stored = isIncrementalSyncScheduleState(rawStored)
          ? rawStored
          : undefined;
        if (stored && this.now() < stored.nextDueAt) return 'not-due';

        await ensureVersionContractForWrite(this.database);
        const completed = await task();
        if (completed === false) return 'ran';
        const lastSuccessAt = this.now();
        const jitter = Math.floor(Math.max(0, Math.min(1, this.random())) * this.jitterMs);
        await this.database.syncState.put({
          key: SCHEDULE_STATE_KEY,
          value: {
            lastSuccessAt,
            nextDueAt: lastSuccessAt + this.intervalMs + jitter,
          } satisfies IncrementalSyncScheduleState,
        });
        return 'ran';
      },
    );
  }

  async runExclusive(task: () => Promise<void>): Promise<ExclusiveSyncResult> {
    return this.requestExclusive(task, false);
  }

  async runExclusiveIfAvailable(
    task: () => Promise<void>,
  ): Promise<ExclusiveSyncResult> {
    return this.requestExclusive(task, true);
  }

  private async requestExclusive(
    task: () => Promise<void>,
    ifAvailable: boolean,
  ): Promise<ExclusiveSyncResult> {
    if (!this.lockManager) return 'lock-unavailable';

    return this.lockManager.request(
      LOCK_NAME,
      { mode: 'exclusive', ifAvailable },
      async (lock) => {
        if (!lock) return 'lock-unavailable';
        await ensureVersionContractForWrite(this.database);
        await task();
        return 'ran';
      },
    );
  }
}
