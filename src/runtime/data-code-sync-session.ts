// SPDX-License-Identifier: MPL-2.0

export type DataCodeSessionResult<T> =
  | { status: 'complete'; value: T }
  | { status: 'error'; error: unknown };

export interface DataCodeSyncSessionOptions<T> {
  refresh(force: boolean): Promise<T>;
  save(source: string): Promise<T>;
  apply(value: T): Promise<void> | void;
}

/** Coalesces refreshes while preserving one failure-isolated operation FIFO. */
export class DataCodeSyncSession<T> {
  private refreshRequest: Promise<DataCodeSessionResult<T>> | undefined;
  private operationQueue: Promise<void> = Promise.resolve();

  constructor(private readonly options: DataCodeSyncSessionOptions<T>) {}

  refresh(force: boolean): Promise<DataCodeSessionResult<T>> {
    if (this.refreshRequest) return this.refreshRequest;
    const request = this.enqueue(() => this.options.refresh(force));
    const tracked = request.finally(() => {
      if (this.refreshRequest === tracked) this.refreshRequest = undefined;
    });
    this.refreshRequest = tracked;
    return tracked;
  }

  save(source: string): Promise<DataCodeSessionResult<T>> {
    return this.enqueue(() => this.options.save(source));
  }

  private enqueue(task: () => Promise<T>): Promise<DataCodeSessionResult<T>> {
    const request = this.operationQueue.then(() => this.execute(task));
    this.operationQueue = request.then(() => undefined);
    return request;
  }

  private async execute(task: () => Promise<T>): Promise<DataCodeSessionResult<T>> {
    try {
      const value = await task();
      await this.options.apply(value);
      return { status: 'complete', value };
    } catch (error) {
      return { status: 'error', error };
    }
  }
}
