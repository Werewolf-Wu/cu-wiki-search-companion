// SPDX-License-Identifier: MPL-2.0
import { defineConfig } from 'vite';
import monkey from 'vite-plugin-monkey';

const environment =
  (globalThis as typeof globalThis & {
    process?: { env?: Record<string, string | undefined> };
  }).process?.env ?? {};
const buildId =
  environment.CU_WIKI_BUILD_ID ?? environment.GITHUB_SHA ?? 'development';
const buildMarker = `CU_WIKI_BUILD_ID:${buildId}`;
const wikiOrigin = 'https://casualtiesunknown.huijiwiki.com';
const userscriptMatches = (['edit', 'submit'] as const).flatMap((action) => [
  `${wikiOrigin}/*?action=${action}`,
  `${wikiOrigin}/*?action=${action}&*`,
  `${wikiOrigin}/*?*&action=${action}`,
  `${wikiOrigin}/*?*&action=${action}&*`,
]);

export default defineConfig({
  define: {
    __CU_WIKI_BUILD_ID__: JSON.stringify(buildMarker),
  },
  build: {
    license: {
      fileName: 'THIRD_PARTY_NOTICES.md',
    },
  },
  plugins: [
    monkey({
      entry: 'src/main.ts',
      userscript: {
        name: '未知伤亡维基 · 本地搜索',
        namespace: 'https://casualtiesunknown.huijiwiki.com/',
        version: '0.3.1',
        description: '在编辑页本地同步并搜索未知伤亡中文维基标题',
        author: 'Werewolf-Wu and contributors',
        homepageURL: 'https://github.com/Werewolf-Wu/cu-wiki-search-companion',
        license: 'MPL-2.0',
        match: userscriptMatches,
        'run-at': 'document-end',
        noframes: true,
        resource: {
          JIEBA_GLUE:
            'https://cdn.jsdelivr.net/npm/jieba-wasm@2.4.0/pkg/web/jieba_rs_wasm.js',
          JIEBA_WASM:
            'https://cdn.jsdelivr.net/npm/jieba-wasm@2.4.0/pkg/web/jieba_rs_wasm_bg.wasm',
        },
        grant: [
          'GM_getResourceURL',
          'GM_getValue',
          'GM_setValue',
          'GM_deleteValue',
          'GM_openInTab',
          'GM_setClipboard',
          'unsafeWindow',
        ],
      },
      build: {
        fileName: 'cu-wiki-local-search.user.js',
        metaFileName: true,
      },
    }),
  ],
});
