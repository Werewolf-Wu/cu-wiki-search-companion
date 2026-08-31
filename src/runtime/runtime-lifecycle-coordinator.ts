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
  private contentWriterPromise: Promise<'ran' | 'lock-unavailable'> | undefined;

  constructor(private readonly options: RuntimeLifecycleCoordinatorOptions) {}

  runContentWriter(task: () => Promise<void>): Promise<'ran' | 'lock-unavailable'> {
    if (this.contentWriterPromise) return this.contentWriterPromise;
    const request = Promise.resolve().then(async () => {
      if (this.options.writer) return this.options.writer.runExclusive(task);
      await task();
      return 'ran' as const;
    });
    const tracked = request.finally(() => {
      if (this.contentWriterPromise === tracked) this.contentWriterPromise = undefined;
    });
    this.contentWriterPromise = tracked;
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
