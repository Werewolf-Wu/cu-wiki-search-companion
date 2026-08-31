// SPDX-License-Identifier: MPL-2.0

export interface ContentSyncSessionOptions {
  synchronize(force: boolean): Promise<void>;
  reportFailure(error: unknown): void;
}

/** Shares one content attempt while keeping failures observable and retryable. */
export class ContentSyncSession {
  private active: Promise<void> | undefined;

  constructor(private readonly options: ContentSyncSessionOptions) {}

  run(force: boolean): Promise<void> {
    if (this.active) return this.active;
    const attempt = Promise.resolve().then(() => this.options.synchronize(force));
    const reported = attempt.catch((error: unknown) => {
      try {
        this.options.reportFailure(error);
      } catch {
        // Reporting must not replace the synchronization failure.
      }
      throw error;
    });
    const tracked = reported.finally(() => {
      if (this.active === tracked) this.active = undefined;
    });
    this.active = tracked;
    return tracked;
  }
}
