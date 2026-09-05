// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
import 'fake-indexeddb/auto';

import { DEFAULT_DATA_CODE_RULES } from '../src/data/data-field-rules';
import { CURRENT_VERSION_CONTRACT } from '../src/storage/version-contract';

interface DebugSearch {
  ready: boolean;
  engine: string;
  indexedPages: number;
  indexedFiles: number;
  indexedContentPages: number;
  indexedLuaModules: number;
  contentIndexReadyMs?: number;
  luaIndexReadyMs?: number;
  search(query: string): Array<{ title: string }>;
  searchContent(query: string): Array<{ title: string }>;
  searchLua(query: string): Array<{ title: string }>;
}

it.each(['normal', 'early-click', 'no-locks'])('boots the real entrypoint and prepares cached modes (%s)', async (scenario) => {
  const earlyClick = scenario === 'early-click';
  const noLocks = scenario === 'no-locks';
  vi.resetModules();
  const { WikiSearchDatabase } = await import('../src/storage/database');
  const cryptoModule = 'node:crypto';
  const { webcrypto } = await import(cryptoModule) as { webcrypto: Crypto };
  const database = new WikiSearchDatabase();
  const listeners: Array<[EventTarget, string, EventListenerOrEventListenerObject, boolean]> = [];
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const originalTimeout = globalThis.setTimeout;
  const resource = vi.fn(() => { throw new Error('Use the real Intl fallback in this test'); });
  const fetcher = vi.fn(async () => { throw new Error('Unexpected remote request'); });
  let releaseOpen: () => void = () => undefined;
  let changeChannel: EventTarget | undefined;
  class TestChannel extends EventTarget {
    constructor() { super(); changeChannel = this; }
    postMessage(): void {}
    close(): void {}
  }
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('GM_info', { script: { version: '0.3.3' } });
  vi.stubGlobal('__CU_WIKI_BUILD_ID__', 'test-composition');
  vi.stubGlobal('GM_getValue', () => DEFAULT_DATA_CODE_RULES);
  vi.stubGlobal('GM_setValue', vi.fn());
  vi.stubGlobal('GM_getResourceURL', resource);
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('BroadcastChannel', TestChannel);
  vi.stubGlobal('scheduler', { yield: async () => undefined });
  vi.stubGlobal('unsafeWindow', Object.assign(window, {
    mw: { config: { get: (key: string) => key === 'wgAction' ? 'edit' : 'wikitext' } },
  }));
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
  Object.defineProperty(navigator, 'locks', {
    configurable: true,
    value: noLocks ? undefined : { request: async (_name: string, _options: LockOptions, callback: LockGrantedCallback<unknown>) =>
      callback({ name: 'composition-test', mode: 'exclusive' }) },
  });
  if (noLocks) vi.spyOn(console, 'error').mockImplementation(() => undefined);
  vi.spyOn(window, 'setInterval').mockReturnValue(1);
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((handler, timeout, ...args) => {
    const timer = originalTimeout(handler, timeout, ...args);
    timers.push(timer);
    return timer;
  });
  for (const target of [window, document]) {
    const add = target.addEventListener.bind(target);
    vi.spyOn(target, 'addEventListener').mockImplementation((type, listener, options) => {
      if (listener) listeners.push([target, type, listener, typeof options === 'boolean' ? options : options?.capture ?? false]);
      add(type, listener, options);
    });
  }
  try {
    await database.open();
    await database.pages.bulkPut([
      { id: 1, title: '医疗指南', normalizedTitle: '医疗指南', namespace: 0, namespaceName: '（主）',
        isRedirect: false, localSeq: 1, revisionId: 1, contentRevisionId: 1,
        contentModel: 'wikitext', content: '使用医疗绷带', seenInTitleSync: 1 },
      { id: 2, title: '模块:Health', normalizedTitle: '模块:health', namespace: 828, namespaceName: '模块',
        isRedirect: false, localSeq: 2, revisionId: 1, contentRevisionId: 1,
        contentModel: 'Scribunto', content: 'local p = {}\nfunction p.heal() return "bandage" end\nreturn p', seenInTitleSync: 1 },
    ]);
    await database.dataCodes.put({ source: 'Data:Item/bandage', code: 'bandage', chineseName: '绷带',
      normalizedName: '绷带', dataType: 'Item', syncedAt: Date.now() });
    await database.syncState.bulkPut([
      { key: 'cache-version-contract', value: CURRENT_VERSION_CONTRACT },
      { key: 'local-sequence', value: 2 },
      { key: 'title-sync', value: { status: 'complete', generation: 1, namespaceIds: [0, 828],
        namespaceNames: { 0: '（主）', 828: '模块' }, namespaceIndex: 2, pagesFetched: 2, startedAt: 1, completedAt: 2 } },
      { key: 'incremental-sync-schedule', value: { lastSuccessAt: Date.now(), nextDueAt: Number.MAX_SAFE_INTEGER } },
      { key: 'data-code-sync', value: { count: 1, syncedAt: Date.now(), indexVersion: 2, rulesSource: DEFAULT_DATA_CODE_RULES } },
    ]);
    if (earlyClick) {
      const gate = new Promise<void>((resolve) => { releaseOpen = resolve; });
      const open = WikiSearchDatabase.prototype.open;
      vi.spyOn(WikiSearchDatabase.prototype, 'open').mockImplementation(function (this: InstanceType<typeof WikiSearchDatabase>) {
        return open.call(this).then(async (value) => { await gate; return value; });
      });
    }
    await import('../src/main');
    const debug = () => (window as unknown as { __CU_WIKI_SEARCH__?: DebugSearch }).__CU_WIKI_SEARCH__;
    const root = document.querySelector('#cu-wiki-search-host')!.shadowRoot!;
    const mode = root.querySelector<HTMLSelectElement>('.mode')!;
    if (earlyClick) {
      mode.value = 'content';
      mode.dispatchEvent(new Event('change'));
      expect(debug()?.ready).toBe(false);
      expect(resource).not.toHaveBeenCalled();
      releaseOpen();
    }
    await vi.waitFor(() => expect(debug()?.ready).toBe(true));
    expect(debug()?.search('医疗').map(({ title }) => title)).toEqual(['医疗指南']);
    if (!earlyClick) {
      expect(debug()).toMatchObject({ engine: 'bootstrap', indexedPages: 2,
        indexedFiles: 0, indexedContentPages: 0, indexedLuaModules: 0 });
      expect(resource).not.toHaveBeenCalled();
      expect(await database.indexSnapshots.count()).toBe(0);
      mode.value = 'content';
      mode.dispatchEvent(new Event('change'));
    }
    if (noLocks) {
      await vi.waitFor(() => expect(debug()?.indexedContentPages).toBe(1));
      await vi.waitFor(() => expect(root.querySelector('.status')?.textContent).toContain('Web Locks'));
    } else {
      await vi.waitFor(() => expect(debug()?.contentIndexReadyMs).toEqual(expect.any(Number)));
    }
    expect(debug()?.searchContent('绷带').map(({ title }) => title)).toEqual(['医疗指南']);
    expect(debug()?.indexedLuaModules).toBe(0);
    expect(await database.indexSnapshots.get('search-index:lua')).toBeUndefined();

    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await database.transaction('rw', database.pages, database.syncState, async () => {
      await database.pages.update(1, { content: '使用绷带与纱布', localSeq: 3 });
      await database.syncState.put({ key: 'local-sequence', value: 3 });
    });
    changeChannel!.dispatchEvent(new MessageEvent('message', { data: { type: 'committed' } }));
    expect(debug()?.searchContent('纱布')).toEqual([]);
    expect(debug()?.indexedLuaModules).toBe(0);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(debug()?.searchContent('纱布').map(({ title }) => title)).toEqual(['医疗指南']));
    expect(debug()?.indexedLuaModules).toBe(0);

    mode.value = 'lua';
    mode.dispatchEvent(new Event('change'));
    if (noLocks) {
      await vi.waitFor(() => expect(debug()?.indexedLuaModules).toBe(1));
    } else {
      await vi.waitFor(() => expect(debug()?.luaIndexReadyMs).toEqual(expect.any(Number)));
    }
    expect(debug()?.searchLua('heal').map(({ title }) => title)).toEqual(['模块:Health']);
    expect(debug()?.searchContent('绷带').map(({ title }) => title)).toEqual(['医疗指南']);
    expect(fetcher).not.toHaveBeenCalled();
  } finally {
    releaseOpen();
    for (const timer of timers) clearTimeout(timer);
    for (const [target, type, listener, capture] of listeners) target.removeEventListener(type, listener, capture);
    document.querySelector('#cu-wiki-search-host')?.remove();
    database.close();
    await database.delete();
    Reflect.deleteProperty(window, '__CU_WIKI_SEARCH__');
    Reflect.deleteProperty(window, 'mw');
    Reflect.deleteProperty(navigator, 'locks');
    Reflect.deleteProperty(document, 'visibilityState');
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  }
});
