// SPDX-License-Identifier: MPL-2.0
import { isWikiLoginRequired, WikiApi, WikiApiError } from '../src/sync/wiki-api';

describe('WikiApi retry behavior', () => {
  it('times out and aborts a fetcher that never settles', async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | null | undefined;
      const fetcher = vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          requestSignal = init?.signal;
          return new Promise<Response>(() => undefined);
        },
      );
      const api = new WikiApi({
        fetcher: fetcher as typeof fetch,
        retries: 0,
        requestTimeoutMs: 50,
      });
      const outcome = api.query({ list: 'allpages' }).then(
        () => ({ status: 'resolved' as const }),
        (error: unknown) => ({
          status: 'rejected' as const,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      const guard = new Promise<{ status: 'test-guard' }>((resolve) => {
        setTimeout(() => resolve({ status: 'test-guard' }), 100);
      });

      await vi.advanceTimersByTimeAsync(100);

      await expect(Promise.race([outcome, guard])).resolves.toMatchObject({
        status: 'rejected',
        message: expect.stringContaining('请求超时'),
      });
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out when response headers arrive but the JSON body never finishes', async () => {
    vi.useFakeTimers();
    try {
      let requestSignal: AbortSignal | null | undefined;
      const fetcher = vi.fn(
        async (_input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
          requestSignal = init?.signal;
          return new Response(new ReadableStream<Uint8Array>({ start() {} }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        },
      );
      const api = new WikiApi({
        fetcher: fetcher as typeof fetch,
        retries: 0,
        requestTimeoutMs: 50,
      });
      const outcome = api.query({ list: 'allpages' }).then(
        () => ({ status: 'resolved' as const }),
        (error: unknown) => ({
          status: 'rejected' as const,
          message: error instanceof Error ? error.message : String(error),
        }),
      );
      const guard = new Promise<{ status: 'test-guard' }>((resolve) => {
        setTimeout(() => resolve({ status: 'test-guard' }), 100);
      });

      await vi.advanceTimersByTimeAsync(100);

      await expect(Promise.race([outcome, guard])).resolves.toMatchObject({
        status: 'rejected',
        message: expect.stringContaining('请求超时'),
      });
      expect(requestSignal?.aborted).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('honors Retry-After when HTTP 429 is followed by success', async () => {
    const calls: URL[] = [];
    const waits: number[] = [];
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = new URL(String(input), 'https://casualtiesunknown.huijiwiki.com');
      calls.push(url);
      if (calls.length === 1) {
        return new Response(JSON.stringify({ error: 'rate limited' }), {
          status: 429,
          headers: {
            'Content-Type': 'application/json',
            'Retry-After': '2',
          },
        });
      }
      return json({ query: { pages: [] } });
    });
    const api = new WikiApi({
      fetcher: fetcher as typeof fetch,
      retries: 1,
      baseDelayMs: 25,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    await expect(api.query({ list: 'allpages' })).resolves.toEqual({
      query: { pages: [] },
    });

    expect(calls).toHaveLength(2);
    expect(calls.every((url) => url.searchParams.get('maxlag') === '5')).toBe(true);
    expect(waits).toEqual([2_000]);
  });

  it('retries a MediaWiki maxlag payload and honors its Retry-After header', async () => {
    const waits: number[] = [];
    let attempt = 0;
    const fetcher = vi.fn(async () => {
      attempt += 1;
      if (attempt === 1) {
        return json(
          { error: { code: 'maxlag', info: 'Waiting for replica lag to decrease' } },
          { headers: { 'Retry-After': '0.5' } },
        );
      }
      return json({ query: { allpages: [] } });
    });
    const api = new WikiApi({
      fetcher: fetcher as typeof fetch,
      retries: 1,
      baseDelayMs: 25,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    await expect(api.query({ list: 'allpages' })).resolves.toEqual({
      query: { allpages: [] },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([500]);
  });

  it('retries a MediaWiki ratelimited payload before succeeding', async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        json({ error: { code: 'ratelimited', info: 'Too many requests' } }),
      )
      .mockResolvedValueOnce(json({ query: { allpages: [] } }));
    const waits: number[] = [];
    const api = new WikiApi({
      fetcher: fetcher as typeof fetch,
      retries: 1,
      baseDelayMs: 25,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    await expect(api.query({ list: 'allpages' })).resolves.toEqual({
      query: { allpages: [] },
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([25]);
  });

  it.each([400, 404])('fails permanent HTTP %i responses without retrying', async (status) => {
    const fetcher = vi.fn(async () =>
      json({ error: 'permanent request failure' }, { status, statusText: 'Bad Request' }),
    );
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 4 });

    const error = await api.query({ list: 'allpages' }).catch((value) => value);

    expect(error).toBeInstanceOf(WikiApiError);
    expect(error).toMatchObject({
      code: `http-${status}`,
      retryable: false,
      status,
      message: `Wiki API 请求失败（http-${status}）`,
    });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([408, 429, 500])('retries transient HTTP %i responses', async (status) => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(json({ error: 'transient' }, { status }))
      .mockResolvedValueOnce(json({ query: { pages: [] } }));
    const waits: number[] = [];
    const api = new WikiApi({
      fetcher: fetcher as typeof fetch,
      retries: 1,
      baseDelayMs: 20,
      sleep: async (milliseconds) => {
        waits.push(milliseconds);
      },
    });

    await expect(api.query({ prop: 'info' })).resolves.toEqual({ query: { pages: [] } });
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(waits).toEqual([20]);
  });

  it.each(['not-a-delay', '', '-1'])(
    'falls back to exponential delay for the invalid Retry-After header %j',
    async (retryAfter) => {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(
          json(
            { error: 'temporarily unavailable' },
            { status: 503, headers: { 'Retry-After': retryAfter } },
          ),
        )
        .mockResolvedValueOnce(json({ query: { pages: [] } }));
      const waits: number[] = [];
      const api = new WikiApi({
        fetcher: fetcher as typeof fetch,
        retries: 1,
        baseDelayMs: 37,
        sleep: async (milliseconds) => {
          waits.push(milliseconds);
        },
      });

      await expect(api.query({ prop: 'info' })).resolves.toEqual({
        query: { pages: [] },
      });
      expect(waits).toEqual([37]);
    },
  );

  it('honors an HTTP-date Retry-After header before the fallback delay', async () => {
    const now = new Date('2026-09-02T00:00:00.000Z');
    vi.setSystemTime(now);
    try {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(
          json(
            { error: 'temporarily unavailable' },
            {
              status: 503,
              headers: {
                'Retry-After': new Date(now.getTime() + 3_000).toUTCString(),
              },
            },
          ),
        )
        .mockResolvedValueOnce(json({ query: { pages: [] } }));
      const waits: number[] = [];
      const api = new WikiApi({
        fetcher: fetcher as typeof fetch,
        retries: 1,
        baseDelayMs: 37,
        sleep: async (milliseconds) => {
          waits.push(milliseconds);
        },
      });

      await expect(api.query({ prop: 'info' })).resolves.toEqual({ query: { pages: [] } });
      expect(waits).toEqual([3_000]);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retries a fetch network failure but not a malformed successful response', async () => {
    const networkFetcher = vi
      .fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(json({ query: { pages: [] } }));
    const networkApi = new WikiApi({
      fetcher: networkFetcher as typeof fetch,
      retries: 1,
      sleep: async () => undefined,
    });

    await expect(networkApi.query({ prop: 'info' })).resolves.toEqual({
      query: { pages: [] },
    });

    const malformedFetcher = vi.fn(async () =>
      new Response('{invalid', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    const malformedApi = new WikiApi({
      fetcher: malformedFetcher as typeof fetch,
      retries: 3,
    });

    const error = await malformedApi.query({ prop: 'info' }).catch((value) => value);
    expect(error).toMatchObject({
      code: 'malformed-response',
      retryable: false,
      message: 'Wiki API 响应格式无效（malformed-response）',
    });
    expect(malformedFetcher).toHaveBeenCalledOnce();
  });

  it('exposes login assertion failures without retrying them', async () => {
    const fetcher = vi.fn(async () =>
      json({ error: { code: 'assertuserfailed', info: 'Assertion that the user is logged in failed' } }),
    );
    const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 4 });

    const error = await api.query({ list: 'recentchanges', assert: 'user' }).catch((value) => value);

    expect(error).toBeInstanceOf(WikiApiError);
    expect(error).toMatchObject({ code: 'assertuserfailed' });
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it.each([401, 403])(
    'treats HTTP %i as a non-retryable login requirement',
    async (status) => {
      const fetcher = vi.fn(async () =>
        json({ error: 'login required' }, { status, statusText: 'Forbidden' }),
      );
      const api = new WikiApi({ fetcher: fetcher as typeof fetch, retries: 4 });

      const error = await api.query({ list: 'recentchanges' }).catch((value) => value);

      expect(error).toBeInstanceOf(WikiApiError);
      expect(error).toMatchObject({ status, retryable: false });
      expect(isWikiLoginRequired(error)).toBe(true);
      expect(fetcher).toHaveBeenCalledOnce();
    },
  );

  it.each(['assertuserfailed', 'readapidenied', 'permissiondenied'])(
    'recognizes the MediaWiki %s response as a login requirement',
    (code) => {
      expect(isWikiLoginRequired(new WikiApiError(code, code, code, false))).toBe(true);
    },
  );
});

function json(payload: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(payload), {
    ...init,
    headers: { 'Content-Type': 'application/json', ...init.headers },
  });
}
