// SPDX-License-Identifier: MPL-2.0

export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;

export class RequestTimeoutError extends Error {
  constructor(readonly timeoutMs: number) {
    super(`请求超时（${timeoutMs} ms）`);
    this.name = 'RequestTimeoutError';
  }
}

export async function runWithRequestTimeout<T>(
  task: (signal: AbortSignal) => Promise<T>,
  timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
): Promise<T> {
  const finiteTimeout =
    Number.isFinite(timeoutMs) && timeoutMs >= 0 ? timeoutMs : DEFAULT_REQUEST_TIMEOUT_MS;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timedOut = new Promise<never>((_resolve, reject) => {
    timer = globalThis.setTimeout(() => {
      const error = new RequestTimeoutError(finiteTimeout);
      reject(error);
      controller.abort(error);
    }, finiteTimeout);
  });

  try {
    return await Promise.race([task(controller.signal), timedOut]);
  } finally {
    if (timer !== undefined) globalThis.clearTimeout(timer);
  }
}
