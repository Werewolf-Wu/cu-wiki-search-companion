// SPDX-License-Identifier: MPL-2.0
import { Analyzer, createIntlSegmenter } from './analyzer';

export interface AnalyzerLoadResult {
  analyzer: Analyzer;
  engine: 'bootstrap' | 'jieba-wasm' | 'Intl.Segmenter';
  warning?: string;
}

interface JiebaModule {
  default(input: Uint8Array): Promise<unknown>;
  cut(text: string): string[];
  cut_for_search(text: string): string[];
}

async function resourceUrl(name: string): Promise<string> {
  if (typeof GM_getResourceURL === 'function') {
    return GM_getResourceURL(name);
  }
  if (typeof GM !== 'undefined' && typeof GM.getResourceUrl === 'function') {
    return GM.getResourceUrl(name);
  }
  throw new Error('Tampermonkey resource API is unavailable');
}

export async function loadAnalyzer(): Promise<AnalyzerLoadResult> {
  try {
    const [glueResponse, wasmResponse] = await Promise.all([
      fetch(await resourceUrl('JIEBA_GLUE')),
      fetch(await resourceUrl('JIEBA_WASM')),
    ]);
    if (!glueResponse.ok) throw new Error(`jieba glue returned HTTP ${glueResponse.status}`);
    if (!wasmResponse.ok) throw new Error(`WASM resource returned HTTP ${wasmResponse.status}`);
    const glueUrl = URL.createObjectURL(
      new Blob([await glueResponse.text()], { type: 'text/javascript' }),
    );
    let jieba: JiebaModule;
    try {
      // Hide the native import expression from Vite. Otherwise one runtime blob
      // import makes the whole userscript depend on SystemJS @require files.
      const importModule = new Function('url', 'return import(url)') as (
        url: string,
      ) => Promise<JiebaModule>;
      jieba = await importModule(glueUrl);
    } finally {
      URL.revokeObjectURL(glueUrl);
    }
    await jieba.default(new Uint8Array(await wasmResponse.arrayBuffer()));
    return {
      analyzer: new Analyzer(
        { cut: jieba.cut, cutForSearch: jieba.cut_for_search },
        'jieba-wasm',
      ),
      engine: 'jieba-wasm',
    };
  } catch (error) {
    const warning = error instanceof Error ? error.message : String(error);
    return {
      analyzer: new Analyzer(createIntlSegmenter(), 'Intl.Segmenter'),
      engine: 'Intl.Segmenter',
      warning,
    };
  }
}
