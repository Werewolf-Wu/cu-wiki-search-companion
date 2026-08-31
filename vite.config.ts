// SPDX-License-Identifier: MPL-2.0
import { defineConfig } from 'vite';
import monkey from 'vite-plugin-monkey';

export default defineConfig({
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
        version: '0.2.0',
        description: '在编辑页本地同步并搜索未知伤亡中文维基标题',
        author: 'Werewolf-Wu and contributors',
        homepageURL: 'https://github.com/Werewolf-Wu/cu-wiki-search-companion',
        license: 'MPL-2.0',
        match: ['https://casualtiesunknown.huijiwiki.com/*'],
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
