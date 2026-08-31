// SPDX-License-Identifier: MPL-2.0
import { isWikiLoginRequired, WikiApi, WikiApiError } from '../src/sync/wiki-api';

describe('WikiApi retry behavior', () => {
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
