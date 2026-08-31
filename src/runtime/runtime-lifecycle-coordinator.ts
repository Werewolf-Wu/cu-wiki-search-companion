// SPDX-License-Identifier: MPL-2.0

export interface StorageInvalidation {
  pages: boolean;
  files: boolean;
  data: boolean;
}

export type StorageInvalidationRequest = Partial<StorageInvalidation>;

export interface ExclusiveWriter {
  runExclusive(task: () => Promise<void>): Promise<'ran' | 'lock-unavailable'>;
}

export interface MirrorRefreshTasks {
  syncTitles(): Promise<void>;
  reconcile(): Promise<void>;
  syncData(): Promise<void>;
  syncContent(): Promise<void>;
}

export interface RuntimeLifecycleCoordinatorOptions {
  applyStorageInvalidation(invalidation: StorageInvalidation): Promise<void>;
  writer?: ExclusiveWriter;
}

export class RuntimeLifecycleCoordinator {
  private pendingInvalidation = emptyInvalidation();
  private refreshPromise: Promise<void> | undefined;
  private readonly writerPromises = new Map<
    string,
    Promise<'ran' | 'lock-unavailable'>
  >();

  constructor(private readonly options: RuntimeLifecycleCoordinatorOptions) {}

  runContentWriter(
    task: () => Promise<void>,
    afterRelease?: () => Promise<void>,
  ): Promise<'ran' | 'lock-unavailable'> {
    return this.runWriter('content', task, afterRelease);
  }

  runWriter(
    key: string,
    task: () => Promise<void>,
    afterRelease?: () => Promise<void>,
  ): Promise<'ran' | 'lock-unavailable'> {
    const active = this.writerPromises.get(key);
    if (active) return active;
    const request = Promise.resolve().then(async () => {
      let result: 'ran' | 'lock-unavailable';
      try {
        result = this.options.writer
          ? await this.options.writer.runExclusive(task)
          : (await task(), 'ran' as const);
      } catch (error) {
        try {
          await afterRelease?.();
        } catch {
          // The writer failure is authoritative; a derived refresh can retry later.
        }
        throw error;
      }
      if (result === 'ran') await afterRelease?.();
      return result;
    });
    const tracked = request.finally(() => {
      if (this.writerPromises.get(key) === tracked) this.writerPromises.delete(key);
    });
    this.writerPromises.set(key, tracked);
    return tracked;
  }

  refreshStorage(invalidation: StorageInvalidationRequest): Promise<void> {
    this.mergeInvalidation(invalidation);
    return this.ensureRefreshStarted();
  }

  deferStorageRefresh(invalidation: StorageInvalidationRequest): void {
    this.mergeInvalidation(invalidation);
  }

  resumeStorageRefresh(): Promise<void> {
    if (!hasInvalidation(this.pendingInvalidation)) {
      return this.refreshPromise ?? Promise.resolve();
    }
    return this.ensureRefreshStarted();
  }

  async refreshMirror(tasks: MirrorRefreshTasks): Promise<void> {
    await tasks.syncTitles();
    await tasks.reconcile();
    await tasks.syncData();
    await tasks.syncContent();
  }

  private ensureRefreshStarted(): Promise<void> {
    if (this.refreshPromise) return this.refreshPromise;
    const request = Promise.resolve().then(() => this.drainStorageRefreshes());
    const tracked = request.finally(() => {
      if (this.refreshPromise === tracked) this.refreshPromise = undefined;
    });
    this.refreshPromise = tracked;
    return tracked;
  }

  private async drainStorageRefreshes(): Promise<void> {
    while (hasInvalidation(this.pendingInvalidation)) {
      const invalidation = this.pendingInvalidation;
      this.pendingInvalidation = emptyInvalidation();
      try {
        await this.options.applyStorageInvalidation(invalidation);
      } catch (error) {
        this.mergeInvalidation(invalidation);
        throw error;
      }
    }
  }

  private mergeInvalidation(invalidation: StorageInvalidationRequest): void {
    this.pendingInvalidation.pages ||= invalidation.pages === true;
    this.pendingInvalidation.files ||= invalidation.files === true;
    this.pendingInvalidation.data ||= invalidation.data === true;
  }
}

function emptyInvalidation(): StorageInvalidation {
  return { pages: false, files: false, data: false };
}

function hasInvalidation(invalidation: StorageInvalidation): boolean {
  return invalidation.pages || invalidation.files || invalidation.data;
}
