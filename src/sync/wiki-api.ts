// SPDX-License-Identifier: MPL-2.0
import {
  DEFAULT_REQUEST_TIMEOUT_MS,
  runWithRequestTimeout,
} from './request-timeout';

export interface WikiApiOptions {
  fetcher?: typeof fetch;
  retries?: number;
  baseDelayMs?: number;
  requestTimeoutMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

interface ApiErrorPayload {
  error?: { code?: string; info?: string };
}

export class WikiApiError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly info: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'WikiApiError';
  }
}

export class WikiApi {
  private readonly fetcher: typeof fetch;
  private readonly retries: number;
  private readonly baseDelayMs: number;
  private readonly requestTimeoutMs: number;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(options: WikiApiOptions = {}) {
    this.fetcher = options.fetcher ?? fetch.bind(globalThis);
    this.retries = options.retries ?? 4;
    this.baseDelayMs = options.baseDelayMs ?? 1_000;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.sleep = options.sleep ?? delay;
  }

  async query<T>(parameters: Record<string, string | number>): Promise<T> {
    const search = new URLSearchParams({
      action: 'query',
      format: 'json',
      formatversion: '2',
      maxlag: '5',
    });
    for (const [key, value] of Object.entries(parameters)) {
      search.set(key, String(value));
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      let retryAfterMs: number | undefined;
      try {
        const payload = await runWithRequestTimeout(
          async (signal) => {
            const response = await this.fetcher(`/api.php?${search.toString()}`, {
              credentials: 'same-origin',
              headers: { Accept: 'application/json' },
              signal,
            });
            retryAfterMs = parseRetryAfter(response.headers.get('Retry-After'));
            if (!response.ok) {
              const loginRequired = response.status === 401 || response.status === 403;
              throw new WikiApiError(
                `Wiki API returned HTTP ${response.status}`,
                `http-${response.status}`,
                response.statusText || 'HTTP error',
                !loginRequired,
                response.status,
              );
            }
            const payload = (await response.json()) as T & ApiErrorPayload;
            if (payload.error) {
              const code = payload.error.code ?? 'api-error';
              const info = payload.error.info ?? 'unknown error';
              throw new WikiApiError(
                `${code}: ${info}`,
                code,
                info,
                code === 'maxlag',
              );
            }
            return payload;
          },
          this.requestTimeoutMs,
        );
        return payload;
      } catch (error) {
        lastError = error;
        if (
          attempt === this.retries ||
          (error instanceof WikiApiError && !error.retryable)
        ) {
          break;
        }
        await this.sleep(retryAfterMs ?? this.baseDelayMs * 2 ** attempt);
      }
    }
    throw lastError;
  }
}

export function isWikiLoginRequired(error: unknown): boolean {
  return (
    error instanceof WikiApiError &&
    (error.status === 401 ||
      error.status === 403 ||
      error.code === 'assertuserfailed' ||
      error.code === 'readapidenied' ||
      error.code === 'permissiondenied')
  );
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;

  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return seconds * 1_000;

  const timestamp = Date.parse(value);
  if (Number.isNaN(timestamp)) return undefined;
  return Math.max(0, timestamp - Date.now());
}
