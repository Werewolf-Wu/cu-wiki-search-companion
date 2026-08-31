// SPDX-License-Identifier: MPL-2.0

export interface InitialBackgroundRefreshOptions {
  canRun(): boolean;
  isVisible(): boolean;
  syncIncremental(): Promise<void>;
  /** Returns true only when the Data refresh completed successfully. */
  syncData(): Promise<boolean>;
}

/**
 * Owns the one-shot visible startup refresh without assuming that a hidden
 * document, a failed request, or a throttled timer made forward progress.
 */
export class InitialBackgroundRefreshCoordinator {
  private refreshPending = true;
  private active: Promise<void> | undefined;

  constructor(private readonly options: InitialBackgroundRefreshOptions) {}

  get pending(): boolean {
    return this.refreshPending;
  }

  request(): Promise<void> {
    if (!this.refreshPending || !this.options.canRun() || !this.options.isVisible()) {
      return Promise.resolve();
    }
    if (this.active) return this.active;

    const request = (async () => {
      await this.options.syncIncremental();
      if (!this.options.isVisible()) return;
      if (await this.options.syncData()) this.refreshPending = false;
    })();
    const tracked = request.finally(() => {
      if (this.active === tracked) this.active = undefined;
    });
    this.active = tracked;
    return tracked;
  }
}
