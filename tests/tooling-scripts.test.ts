// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
import 'fake-indexeddb/auto';

import installUserscriptSource from '../scripts/install-userscript.playwright.js?raw';
import testIndexSnapshotsSource from '../scripts/test-index-snapshots.playwright.js?raw';
import testMaintenanceSource from '../scripts/test-maintenance.playwright.js?raw';
import testReconciliationSource from '../scripts/test-reconciliation.playwright.js?raw';
import { WikiSearchDatabase } from '../src/storage/database';

type RunCodeScript = (page: unknown, userscriptUrl?: string) => Promise<unknown>;
const BrowserURL = globalThis.URL;

describe('browser tooling scripts', () => {
  it('resets deep search state before every snapshot reload', () => {
    expect([...testIndexSnapshotsSource.matchAll(/await reloadCold\(\)/g)]).toHaveLength(4);
    expect([...testIndexSnapshotsSource.matchAll(/await page\.reload/g)]).toHaveLength(1);
    const reset = testIndexSnapshotsSource.slice(
      testIndexSnapshotsSource.indexOf('async function reloadCold'),
      testIndexSnapshotsSource.indexOf('async function waitForColdReady'),
    );
    expect(reset).toContain("mode.value = 'title'");
    expect(reset).not.toContain('dispatchEvent');
    expect(reset).toContain("toggle?.getAttribute('aria-expanded') === 'true'");
    expect(reset).toContain('toggle.click()');
  });

  it('installs through a dedicated edit page without touching existing reader or Tampermonkey pages', async () => {
    const context = new InstallContext();
    const reader = context.addInitial(
      'https://casualtiesunknown.huijiwiki.com/wiki/首页',
    );
    const existingAsk = context.addInitial('chrome-extension://tampermonkey/ask.html');
    const existingInstallation = context.addInitial(
      'https://www.tampermonkey.net/script_installation.php',
    );
    const install = await loadRunCodeScript('install-userscript.playwright.js');

    await install(reader);

    expect(reader.navigations).toEqual([]);
    expect(reader.closed).toBe(false);
    expect(existingAsk.closed).toBe(false);
    expect(existingInstallation.closed).toBe(false);
    expect(context.requestedUrls).toEqual([
      'http://127.0.0.1:8788/cu-wiki-local-search.user.js',
    ]);
    expect(context.createdPages).toHaveLength(3);
    const [dedicatedWikiPage, bridgePage, askPage] = context.createdPages;
    expect(dedicatedWikiPage?.navigations).toEqual([
      'https://casualtiesunknown.huijiwiki.com/wiki/首页?action=edit',
    ]);
    expect(dedicatedWikiPage?.closed).toBe(false);
    expect(dedicatedWikiPage?.readyChecks).toEqual([
      expect.objectContaining({
        argument: {
          version: '0.2.0',
          buildId: 'CU_WIKI_BUILD_ID:test-build',
        },
        predicate: expect.stringMatching(/scriptVersion[\s\S]*buildId/),
      }),
    ]);
    expect(bridgePage?.closed).toBe(true);
    expect(askPage?.closed).toBe(true);
  });

  it('selects an existing query edit page when the outer run-code sandbox has no URL global', async () => {
    const context = new InstallContext();
    const reader = context.addInitial(
      'https://casualtiesunknown.huijiwiki.com/wiki/首页',
    );
    const editor = context.addInitial(
      'https://casualtiesunknown.huijiwiki.com/index.php?title=首页&action=edit',
    );
    const install = await loadRunCodeScript('install-userscript.playwright.js');

    vi.stubGlobal('URL', undefined);
    try {
      await install(reader);
    } finally {
      vi.unstubAllGlobals();
    }

    expect(reader.readyChecks).toEqual([]);
    expect(editor.navigations).toEqual([]);
    expect(editor.closed).toBe(false);
    expect(editor.activationChecks).toEqual([
      expect.stringMatching(/location\.search/),
    ]);
    expect(editor.readyChecks).toEqual([
      expect.objectContaining({
        argument: {
          version: '0.2.0',
          buildId: 'CU_WIKI_BUILD_ID:test-build',
        },
      }),
    ]);
    expect(context.createdPages).toHaveLength(2);
    expect(context.createdPages.every((page) => page.closed)).toBe(true);
  });

  it('uses an explicit non-default userscript URL', async () => {
    const context = new InstallContext();
    const reader = context.addInitial(
      'https://casualtiesunknown.huijiwiki.com/wiki/首页',
    );
    const install = await loadRunCodeScript('install-userscript.playwright.js');
    const userscriptUrl =
      'http://127.0.0.1:8790/cu-wiki-local-search.user.js';

    await install(reader, userscriptUrl);

    expect(context.requestedUrls).toEqual([userscriptUrl]);
    expect(context.createdPages[1]?.navigations).toEqual([userscriptUrl]);
  });

  it('runs reconciliation after removing the probe page and completes the acceptance flow', async () => {
    const reconcile = await loadRunCodeScript('test-reconciliation.playwright.js');
    const page = await ReconciliationPage.create();

    await expect(reconcile(page)).resolves.toMatchObject({
      selected: { id: 42, title: '地下水', revisionId: 420 },
      requestEvidence: { allPagesRequests: 1 },
    });
    expect(page.forceSyncCalls).toBe(1);
    expect(page.cleanupRestores).toBe(0);
  });

  it('does not restore the probe backup when reconciliation commits before forceSync rejects', async () => {
    const reconcile = await loadRunCodeScript('test-reconciliation.playwright.js');
    const page = await ReconciliationPage.create({ rejectAfterCommit: true });

    await expect(reconcile(page)).rejects.toThrow('模拟对账提交后的收尾失败');

    expect(page.forceSyncCalls).toBe(1);
    expect(page.cleanupRestores).toBe(0);
    await expect(page.readProbePage()).resolves.toMatchObject({
      id: 42,
      revisionId: 420,
      localSeq: 11,
    });
    expect(page.requestListenerAttached).toBe(false);
  });

  it('restores the probe backup when forceSync rejects before any durable change', async () => {
    const reconcile = await loadRunCodeScript('test-reconciliation.playwright.js');
    const page = await ReconciliationPage.create({ rejectBeforeCommit: true });

    await expect(reconcile(page)).rejects.toThrow('模拟对账提交前失败');

    expect(page.cleanupRestores).toBe(1);
    await expect(page.readProbePage()).resolves.toMatchObject({
      id: 42,
      revisionId: 420,
      localSeq: 10,
    });
    expect(page.requestListenerAttached).toBe(false);
  });

  it('does not mistake an unchanged prior complete state for this reconciliation run', async () => {
    const reconcile = await loadRunCodeScript('test-reconciliation.playwright.js');
    const page = await ReconciliationPage.create({ resolveWithoutCommit: true });

    await expect(reconcile(page)).rejects.toThrow('对账没有补回本地缺页');

    expect(page.cleanupRestores).toBe(1);
    await expect(page.readProbePage()).resolves.toMatchObject({
      id: 42,
      revisionId: 420,
      localSeq: 10,
    });
    expect(page.requestListenerAttached).toBe(false);
  });

  it('does not restore the probe backup after another writer advances local facts', async () => {
    const reconcile = await loadRunCodeScript('test-reconciliation.playwright.js');
    const page = await ReconciliationPage.create({ advanceSequenceBeforeReject: true });

    await expect(reconcile(page)).rejects.toThrow('模拟其他写者提交后的失败');

    expect(page.cleanupRestores).toBe(0);
    await expect(page.readProbePage()).resolves.toBeUndefined();
    await expect(page.readLocalSequence()).resolves.toBe(11);
    expect(page.requestListenerAttached).toBe(false);
  });

  it('does not overwrite a probe page restored by another writer at a newer revision', async () => {
    const reconcile = await loadRunCodeScript('test-reconciliation.playwright.js');
    const page = await ReconciliationPage.create({ replaceProbeBeforeReject: true });

    await expect(reconcile(page)).rejects.toThrow('模拟探针事实更新后的失败');

    expect(page.cleanupRestores).toBe(0);
    await expect(page.readProbePage()).resolves.toMatchObject({
      id: 42,
      revisionId: 421,
      localSeq: 11,
    });
    expect(page.requestListenerAttached).toBe(false);
  });

  it('aborts before deleting a probe changed after the before snapshot', async () => {
    const reconcile = await loadRunCodeScript('test-reconciliation.playwright.js');
    const page = await ReconciliationPage.create({ replaceProbeBeforeDelete: true });

    await expect(reconcile(page)).rejects.toThrow('探针快照已变化');

    expect(page.forceSyncCalls).toBe(0);
    expect(page.cleanupRestores).toBe(0);
    await expect(page.readProbePage()).resolves.toMatchObject({
      id: 42,
      revisionId: 421,
      localSeq: 11,
    });
    await expect(page.readLocalSequence()).resolves.toBe(11);
    expect(page.requestListenerAttached).toBe(false);
  });

  it('waits for a terminal persistence result before maintenance acceptance completes', async () => {
    const inspectMaintenance = await loadRunCodeScript('test-maintenance.playwright.js');
    const page = new MaintenancePage();

    const result = (await inspectMaintenance(page)) as {
      after: { status: string };
    };
    const settledWhenReturned = page.persistenceSettled;
    await page.settlement;

    expect(settledWhenReturned).toBe(true);
    expect(result.after.status).toBe('浏览器未授予持久保存；搜索仍可使用');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
  delete (window as Window & { __CU_WIKI_SEARCH__?: unknown }).__CU_WIKI_SEARCH__;
});

async function loadRunCodeScript(name: string): Promise<RunCodeScript> {
  const source = {
    'install-userscript.playwright.js': installUserscriptSource,
    'test-maintenance.playwright.js': testMaintenanceSource,
    'test-reconciliation.playwright.js': testReconciliationSource,
  }[name];
  if (!source) throw new Error(`Unknown run-code script: ${name}`);
  return Function(`return (${source}\n)`)() as RunCodeScript;
}

class InstallContext {
  readonly createdPages: InstallPage[] = [];
  readonly requestedUrls: string[] = [];
  readonly request = {
    get: async (url: string) => {
      this.requestedUrls.push(url);
      return {
        ok: () => true,
        status: () => 200,
        text: async () =>
          '// @version      0.2.0\nconst marker = "CU_WIKI_BUILD_ID:test-build";',
      };
    },
  };
  private readonly allPages: InstallPage[] = [];

  addInitial(url: string): InstallPage {
    const page = new InstallPage(this, url);
    this.allPages.push(page);
    return page;
  }

  pages(): InstallPage[] {
    return [...this.allPages];
  }

  async newPage(): Promise<InstallPage> {
    const page = new InstallPage(this, 'about:blank');
    this.allPages.push(page);
    this.createdPages.push(page);
    return page;
  }

  openAskPage(): void {
    const page = new InstallPage(this, 'chrome-extension://tampermonkey/ask.html');
    this.allPages.push(page);
    this.createdPages.push(page);
  }
}

class InstallPage {
  closed = false;
  readonly navigations: string[] = [];
  readonly readyChecks: Array<{ predicate: string; argument: unknown }> = [];
  readonly activationChecks: string[] = [];
  private activated: boolean;

  constructor(
    private readonly installContext: InstallContext,
    private address: string,
  ) {
    const action = new BrowserURL(address).searchParams.get('action');
    this.activated = action === 'edit' || action === 'submit';
  }

  context(): InstallContext {
    return this.installContext;
  }

  url(): string {
    return this.address;
  }

  async goto(url: string): Promise<void> {
    this.navigations.push(url);
    this.address = url;
    const action = new BrowserURL(url).searchParams.get('action');
    this.activated = action === 'edit' || action === 'submit';
    if (url.includes('cu-wiki-local-search.user.js')) this.installContext.openAskPage();
  }

  async close(): Promise<void> {
    this.closed = true;
  }

  isClosed(): boolean {
    return this.closed;
  }

  async waitForTimeout(_milliseconds: number): Promise<void> {}

  async waitForSelector(_selector: string): Promise<void> {}

  locator(_selector: string): InstallControls {
    return new InstallControls();
  }

  async bringToFront(): Promise<void> {}

  async reload(): Promise<void> {}

  async waitForFunction(
    predicate: (...args: never[]) => unknown,
    argument: unknown,
  ): Promise<void> {
    this.readyChecks.push({ predicate: predicate.toString(), argument });
  }

  async evaluate<T>(callback: (...args: never[]) => T): Promise<T> {
    const source = callback.toString();
    if (source.includes('wgAction') || source.includes("searchParams.get('action')")) {
      this.activationChecks.push(source);
      return this.activated as T;
    }
    if (source.includes('.engine')) return 'jieba-wasm' as T;
    if (source.includes('.scriptVersion')) return '0.2.0' as T;
    if (source.includes('.buildId')) return 'CU_WIKI_BUILD_ID:test-build' as T;
    return undefined as T;
  }
}

class InstallControls {
  async count(): Promise<number> {
    return 1;
  }

  nth(_index: number): InstallControl {
    return new InstallControl();
  }
}

class InstallControl {
  async getAttribute(name: string): Promise<string | null> {
    return name === 'value' ? '安装' : null;
  }

  async textContent(): Promise<string> {
    return '安装';
  }

  async evaluate(callback: (control: { click(): void }) => void): Promise<void> {
    callback({ click: () => undefined });
  }
}

interface ReconciliationPageOptions {
  advanceSequenceBeforeReject?: boolean;
  rejectAfterCommit?: boolean;
  rejectBeforeCommit?: boolean;
  replaceProbeBeforeDelete?: boolean;
  replaceProbeBeforeReject?: boolean;
  resolveWithoutCommit?: boolean;
}

class ReconciliationPage {
  forceSyncCalls = 0;
  cleanupRestores = 0;
  private cleanupPending = false;
  private probeReplacedBeforeDelete = false;
  private requestListener?: (request: { url(): string }) => void;

  private constructor(private readonly options: ReconciliationPageOptions) {}

  static async create(
    options: ReconciliationPageOptions = {},
  ): Promise<ReconciliationPage> {
    const database = new WikiSearchDatabase();
    await database.open();
    await database.transaction(
      'rw',
      database.pages,
      database.jobs,
      database.syncState,
      async () => {
        await Promise.all([
          database.pages.clear(),
          database.jobs.clear(),
          database.syncState.clear(),
        ]);
        await database.pages.put({
          id: 42,
          title: '地下水',
          normalizedTitle: '地下水',
          namespace: 0,
          namespaceName: '',
          revisionId: 420,
          isRedirect: true,
          deleted: false,
          localSeq: 10,
          seenInTitleSync: 100,
        });
        await database.syncState.bulkPut([
          { key: 'local-sequence', value: 10 },
          {
            key: 'reconciliation-sync',
            value: {
              status: 'complete',
              generation: 100,
              completedAt: 1_000,
            },
          },
        ]);
      },
    );
    database.close();
    const page = new ReconciliationPage(options);
    page.setDebugState('complete', 1_000);
    return page;
  }

  get requestListenerAttached(): boolean {
    return this.requestListener !== undefined;
  }

  async waitForFunction(): Promise<void> {}

  on(event: string, listener: (request: { url(): string }) => void): void {
    if (event === 'request') this.requestListener = listener;
  }

  off(event: string, listener: (request: { url(): string }) => void): void {
    if (event === 'request' && this.requestListener === listener) {
      this.requestListener = undefined;
    }
  }

  async evaluate<T>(callback: (...args: never[]) => T, argument?: unknown): Promise<T> {
    const source = callback.toString();
    if (source.includes('__CU_WIKI_SEARCH__.forceSync()')) {
      this.forceSyncCalls += 1;
      this.requestListener?.({
        url: () =>
          'https://casualtiesunknown.huijiwiki.com/api.php?action=query&generator=allpages&assert=user&gaplimit=500&prop=info&gapnamespace=0',
      });
      if (this.options.advanceSequenceBeforeReject) {
        await this.commitOtherFact();
        this.cleanupPending = true;
        throw new Error('模拟其他写者提交后的失败');
      }
      if (this.options.replaceProbeBeforeReject) {
        await this.commitNewerProbeFact();
        this.cleanupPending = true;
        throw new Error('模拟探针事实更新后的失败');
      }
      if (this.options.rejectBeforeCommit) {
        this.cleanupPending = true;
        throw new Error('模拟对账提交前失败');
      }
      if (this.options.resolveWithoutCommit) {
        this.cleanupPending = true;
        return undefined as T;
      }
      await this.commitReconciliation();
      if (this.options.rejectAfterCommit) {
        this.cleanupPending = true;
        throw new Error('模拟对账提交后的收尾失败');
      }
      return undefined as T;
    }

    if (
      this.options.replaceProbeBeforeDelete &&
      !this.probeReplacedBeforeDelete &&
      source.includes("objectStore('pages')") &&
      source.includes('.delete(') &&
      source.includes("'readwrite'")
    ) {
      this.probeReplacedBeforeDelete = true;
      await this.commitProbeAndReconciliation();
    }

    const beforeCleanup = this.cleanupPending ? await this.readProbePage() : undefined;
    try {
      return await (
        callback as unknown as (value?: unknown) => T | Promise<T>
      )(argument);
    } finally {
      if (this.cleanupPending) {
        const afterCleanup = await this.readProbePage();
        if (
          beforeCleanup?.localSeq !== 10 &&
          afterCleanup?.localSeq === 10
        ) {
          this.cleanupRestores += 1;
        }
      }
    }
  }

  async readProbePage(): Promise<
    { id: number; revisionId?: number; localSeq: number } | undefined
  > {
    const database = new WikiSearchDatabase();
    const page = await database.pages.get(42);
    database.close();
    return page;
  }

  async readLocalSequence(): Promise<number | undefined> {
    const database = new WikiSearchDatabase();
    const sequence = await database.syncState.get('local-sequence');
    database.close();
    return sequence?.value as number | undefined;
  }

  private async commitOtherFact(): Promise<void> {
    const database = new WikiSearchDatabase();
    await database.transaction('rw', database.pages, database.syncState, async () => {
      await database.pages.put({
        id: 99,
        title: '并发事实',
        normalizedTitle: '并发事实',
        namespace: 0,
        namespaceName: '',
        revisionId: 990,
        isRedirect: false,
        deleted: false,
        localSeq: 11,
        seenInTitleSync: 100,
      });
      await database.syncState.put({ key: 'local-sequence', value: 11 });
    });
    database.close();
  }

  private async commitNewerProbeFact(): Promise<void> {
    const database = new WikiSearchDatabase();
    await database.transaction('rw', database.pages, database.syncState, async () => {
      await database.pages.put({
        id: 42,
        title: '地下水（新事实）',
        normalizedTitle: '地下水（新事实）',
        namespace: 0,
        namespaceName: '',
        revisionId: 421,
        isRedirect: true,
        deleted: false,
        localSeq: 11,
        seenInTitleSync: 100,
      });
      await database.syncState.put({ key: 'local-sequence', value: 11 });
    });
    database.close();
  }

  private async commitProbeAndReconciliation(): Promise<void> {
    const database = new WikiSearchDatabase();
    await database.transaction('rw', database.pages, database.syncState, async () => {
      await database.pages.put({
        id: 42,
        title: '地下水（删除前并发事实）',
        normalizedTitle: '地下水（删除前并发事实）',
        namespace: 0,
        namespaceName: '',
        revisionId: 421,
        isRedirect: true,
        deleted: false,
        localSeq: 11,
        seenInTitleSync: 200,
      });
      await database.syncState.bulkPut([
        { key: 'local-sequence', value: 11 },
        {
          key: 'reconciliation-sync',
          value: {
            status: 'complete',
            generation: 200,
            completedAt: 2_000,
          },
        },
      ]);
    });
    database.close();
  }

  private async commitReconciliation(): Promise<void> {
    const database = new WikiSearchDatabase();
    await database.transaction('rw', database.pages, database.syncState, async () => {
      await database.pages.put({
        id: 42,
        title: '地下水',
        normalizedTitle: '地下水',
        namespace: 0,
        namespaceName: '',
        revisionId: 420,
        isRedirect: true,
        deleted: false,
        localSeq: 11,
        seenInTitleSync: 200,
      });
      await database.syncState.bulkPut([
        { key: 'local-sequence', value: 11 },
        {
          key: 'recent-changes-sync',
          value: { through: 'cursor', completedAt: 2_000, recentChanges: [] },
        },
        {
          key: 'reconciliation-sync',
          value: {
            status: 'complete',
            generation: 200,
            completedAt: 2_000,
            pagesFetched: 10,
          },
        },
      ]);
    });
    database.close();
    this.setDebugState('complete', 2_000);
  }

  private setDebugState(status: string, completedAt: number): void {
    (
      window as Window & {
        __CU_WIKI_SEARCH__?: Record<string, unknown>;
      }
    ).__CU_WIKI_SEARCH__ = {
      ready: true,
      engine: 'bootstrap',
      indexedPages: 10,
      indexedFiles: 0,
      indexedContentPages: 0,
      indexedLuaModules: 0,
      incrementalStatus: 'complete',
      reconciliationStatus: status,
      reconciliationCompletedAt: completedAt,
    };
  }
}

class MaintenancePage {
  persistenceSettled = false;
  readonly settlement: Promise<void>;

  constructor() {
    (window as Window & { __CU_WIKI_SEARCH__?: { ready: boolean } }).__CU_WIKI_SEARCH__ = {
      ready: true,
    };
    const host = document.createElement('div');
    host.id = 'cu-wiki-search-host';
    const root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <button class="toggle" aria-expanded="false"></button>
      <button class="maintenance-toggle"></button>
      <section class="maintenance" hidden></section>
      <pre class="maintenance-output">尚未读取诊断</pre>
      <button class="maintenance-action reconcile-now">立即全量对账（需要联网）</button>
      <div class="danger-confirmation" hidden></div>
      <input class="reset-data-rules" type="checkbox">
      <button class="maintenance-action request-persistence"></button>
      <span class="status">已就绪</span>
    `;
    document.body.append(host);
    const toggle = root.querySelector<HTMLButtonElement>('.toggle')!;
    toggle.addEventListener('click', () => toggle.setAttribute('aria-expanded', 'true'));
    root
      .querySelector<HTMLButtonElement>('.maintenance-toggle')!
      .addEventListener('click', () => {
        root.querySelector<HTMLElement>('.maintenance')!.hidden = false;
        root.querySelector<HTMLElement>('.maintenance-output')!.textContent = '页面 1';
      });
    let finish!: () => void;
    this.settlement = new Promise<void>((resolve) => {
      finish = resolve;
    });
    root
      .querySelector<HTMLButtonElement>('.request-persistence')!
      .addEventListener('click', () => {
        for (const button of root.querySelectorAll<HTMLButtonElement>('.maintenance-action')) {
          button.disabled = true;
        }
        root.querySelector<HTMLElement>('.status')!.textContent =
          '正在申请浏览器持久保存…';
        setTimeout(() => {
          root.querySelector<HTMLElement>('.status')!.textContent =
            '浏览器未授予持久保存；搜索仍可使用';
          for (const button of root.querySelectorAll<HTMLButtonElement>(
            '.maintenance-action',
          )) {
            button.disabled = false;
          }
          this.persistenceSettled = true;
          finish();
        }, 25);
      });
  }

  async evaluate<T, A>(callback: (argument: A) => T, argument?: A): Promise<Awaited<T>> {
    return await callback(argument as A);
  }

  async waitForFunction<A>(
    callback: (argument: A) => unknown,
    argument?: A,
  ): Promise<void> {
    const deadline = Date.now() + 1_000;
    while (Date.now() < deadline) {
      if (await callback(argument as A)) return;
      await new Promise((resolve) => setTimeout(resolve, 1));
    }
    throw new Error('waitForFunction timed out in maintenance test');
  }
}
