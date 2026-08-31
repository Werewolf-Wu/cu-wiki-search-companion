// SPDX-License-Identifier: MPL-2.0

/** Shares one successfully prepared analyzer across interactive and local work. */
export class AnalyzerPreparationCoordinator<TAnalyzer> {
  private analyzerPromise: Promise<TAnalyzer> | undefined;

  constructor(private readonly loadAnalyzer: () => Promise<TAnalyzer>) {}

  prepare(): Promise<TAnalyzer> {
    if (this.analyzerPromise) return this.analyzerPromise;
    const attempt = Promise.resolve().then(() => this.loadAnalyzer());
    const tracked = attempt.catch((error: unknown) => {
      if (this.analyzerPromise === tracked) this.analyzerPromise = undefined;
      throw error;
    });
    this.analyzerPromise = tracked;
    return tracked;
  }

  async runLocal<TResult>(
    task: (analyzer: TAnalyzer) => Promise<TResult>,
  ): Promise<TResult> {
    return task(await this.prepare());
  }
}
