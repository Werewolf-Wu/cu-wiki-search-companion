// SPDX-License-Identifier: MPL-2.0

export interface VisibilityAdapter {
  isVisible(): boolean;
  subscribe(listener: () => void): () => void;
}

export interface CooperativeTaskSchedulerOptions {
  visibility?: VisibilityAdapter;
  yieldTask?: () => Promise<void>;
}

/**
 * Yields long, derived-cache work without treating a background timer as a
 * progress guarantee. Hidden documents wait for the next visible transition;
 * visible documents prefer scheduler.yield, then MessageChannel, then a timer.
 */
export class CooperativeTaskScheduler {
  private readonly visibility: VisibilityAdapter | undefined;
  private readonly yieldTask: () => Promise<void>;

  constructor(options: CooperativeTaskSchedulerOptions = {}) {
    this.visibility = options.visibility ?? browserVisibilityAdapter();
    this.yieldTask = options.yieldTask ?? browserYieldTask;
  }

  async yield(signal?: AbortSignal): Promise<void> {
    await this.waitUntilVisible(signal);
    throwIfAborted(signal);
    await waitForAbortable(this.yieldTask(), signal);
    throwIfAborted(signal);
    await this.waitUntilVisible(signal);
  }

  async waitUntilVisible(signal?: AbortSignal): Promise<void> {
    throwIfAborted(signal);
    if (!this.visibility || this.visibility.isVisible()) return;

    await new Promise<void>((resolve, reject) => {
      let unsubscribe = (): void => undefined;
      const cleanup = (): void => {
        unsubscribe();
        signal?.removeEventListener('abort', onAbort);
      };
      const onVisible = (): void => {
        if (!this.visibility?.isVisible()) return;
        cleanup();
        resolve();
      };
      const onAbort = (): void => {
        cleanup();
        reject(abortReason(signal));
      };
      unsubscribe = this.visibility!.subscribe(onVisible);
      signal?.addEventListener('abort', onAbort, { once: true });

      // Close the subscribe/check race for adapters backed by event targets.
      if (this.visibility!.isVisible()) onVisible();
      else if (signal?.aborted) onAbort();
    });
  }
}

export const browserTaskScheduler = new CooperativeTaskScheduler();

function browserVisibilityAdapter(): VisibilityAdapter | undefined {
  if (typeof document === 'undefined') return undefined;
  return {
    isVisible: () => document.visibilityState === 'visible',
    subscribe: (listener) => {
      document.addEventListener('visibilitychange', listener);
      return () => document.removeEventListener('visibilitychange', listener);
    },
  };
}

async function browserYieldTask(): Promise<void> {
  const taskScheduler = (globalThis as typeof globalThis & {
    scheduler?: { yield?: () => Promise<void> };
  }).scheduler;
  if (typeof taskScheduler?.yield === 'function') {
    try {
      await taskScheduler.yield();
      return;
    } catch {
      // Some browsers expose the API in a userscript realm but reject calls.
      // Continue through the cross-browser fallbacks.
    }
  }

  if (typeof MessageChannel === 'function') {
    try {
      await new Promise<void>((resolve, reject) => {
        let channel: MessageChannel | undefined;
        try {
          channel = new MessageChannel();
          channel.port1.onmessage = () => {
            channel?.port1.close();
            channel?.port2.close();
            resolve();
          };
          channel.port2.postMessage(undefined);
        } catch (error) {
          channel?.port1.close();
          channel?.port2.close();
          reject(error);
        }
      });
      return;
    } catch {
      // Fall through to the timer when MessageChannel is unavailable in this realm.
    }
  }

  await new Promise<void>((resolve) => globalThis.setTimeout(resolve, 0));
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw abortReason(signal);
}

function waitForAbortable(task: Promise<void>, signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return task;
  throwIfAborted(signal);
  return new Promise<void>((resolve, reject) => {
    const cleanup = (): void => signal.removeEventListener('abort', onAbort);
    const onAbort = (): void => {
      cleanup();
      reject(abortReason(signal));
    };
    signal.addEventListener('abort', onAbort, { once: true });
    task.then(
      () => {
        cleanup();
        resolve();
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
    if (signal.aborted) onAbort();
  });
}

function abortReason(signal: AbortSignal | undefined): Error {
  if (signal?.reason instanceof Error) return signal.reason;
  return new DOMException('任务已取消', 'AbortError');
}
