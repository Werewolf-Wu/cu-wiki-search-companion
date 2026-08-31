// SPDX-License-Identifier: MPL-2.0

export interface StagedPreparationOptions {
  prepareLocal(): Promise<void>;
  settle(): Promise<void>;
}

/**
 * Keeps an already-usable local stage while allowing a failed settlement to
 * be requested again. Concurrent callers share the same stage promises.
 */
export class StagedPreparationCoordinator {
  private localPromise: Promise<void> | undefined;
  private settledPromise: Promise<void> | undefined;

  constructor(private readonly options: StagedPreparationOptions) {}

  prepareLocal(): Promise<void> {
    if (this.localPromise) return this.localPromise;
    const attempt = Promise.resolve().then(() => this.options.prepareLocal());
    const tracked = attempt.catch((error: unknown) => {
      if (this.localPromise === tracked) this.localPromise = undefined;
      throw error;
    });
    this.localPromise = tracked;
    return tracked;
  }

  prepare(): Promise<void> {
    if (this.settledPromise) return this.settledPromise;
    const attempt = (async () => {
      await this.prepareLocal();
      await this.options.settle();
    })();
    const tracked = attempt.catch((error: unknown) => {
      if (this.settledPromise === tracked) this.settledPromise = undefined;
      throw error;
    });
    this.settledPromise = tracked;
    return tracked;
  }

  waitForActiveLocal(): Promise<void> {
    const active = this.localPromise;
    if (!active) return Promise.resolve();
    return active.then(
      () => undefined,
      () => undefined,
    );
  }

  invalidateSettlement(): void {
    this.settledPromise = undefined;
  }
}
