// SPDX-License-Identifier: MPL-2.0
import { loadAnalyzer } from './load-jieba';

describe('loadAnalyzer', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns a stable Chinese warning when the userscript resource API is unavailable', async () => {
    vi.stubGlobal('GM_getResourceURL', undefined);
    vi.stubGlobal('GM', undefined);

    await expect(loadAnalyzer()).resolves.toMatchObject({
      engine: 'Intl.Segmenter',
      warning: '无法访问中文分词资源（resource-api-unavailable）',
    });
  });

  it('returns a stable Chinese warning when the jieba glue request fails', async () => {
    vi.stubGlobal('GM_getResourceURL', (name: string) => name);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input) === 'JIEBA_GLUE'
          ? new Response('', { status: 503 })
          : new Response(new Uint8Array(), { status: 200 }),
      ),
    );

    await expect(loadAnalyzer()).resolves.toMatchObject({
      engine: 'Intl.Segmenter',
      warning: '中文分词脚本加载失败（jieba-glue-http-error）',
    });
  });

  it('returns a stable Chinese warning when the jieba WASM request fails', async () => {
    vi.stubGlobal('GM_getResourceURL', (name: string) => name);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) =>
        String(input) === 'JIEBA_WASM'
          ? new Response('', { status: 503 })
          : new Response('', { status: 200 }),
      ),
    );

    await expect(loadAnalyzer()).resolves.toMatchObject({
      engine: 'Intl.Segmenter',
      warning: '中文分词 WASM 加载失败（jieba-wasm-http-error）',
    });
  });
});
