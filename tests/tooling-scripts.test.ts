// SPDX-License-Identifier: MPL-2.0
// @vitest-environment jsdom
import installUserscriptSource from '../scripts/install-userscript.playwright.js?raw';
import testMaintenanceSource from '../scripts/test-maintenance.playwright.js?raw';
import testReconciliationSource from '../scripts/test-reconciliation.playwright.js?raw';

type RunCodeScript = (page: unknown) => Promise<unknown>;
const BrowserURL = globalThis.URL;

describe('browser tooling scripts', () => {
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

  it('runs reconciliation after removing the probe page and completes the acceptance flow', async () => {
    const reconcile = await loadRunCodeScript('test-reconciliation.playwright.js');
    const page = new ReconciliationPage();

    await expect(reconcile(page)).resolves.toMatchObject({
      selected: { id: 42, title: '地下水', revisionId: 420 },
      requestEvidence: { allPagesRequests: 1 },
    });
    expect(page.forceSyncCalls).toBe(1);
    expect(page.cleanupRestores).toBe(0);
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
  readonly request = {
    get: async (_url: string) => ({
      ok: () => true,
      status: () => 200,
      text: async () =>
        '// @version      0.2.0\nconst marker = "CU_WIKI_BUILD_ID:test-build";',
    }),
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

class ReconciliationPage {
  forceSyncCalls = 0;
  cleanupRestores = 0;
  private requestListener?: (request: { url(): string }) => void;

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
    if (source.includes('const preferred = pages.find')) {
      return {
        debug: {
          engine: 'bootstrap',
          indexedPages: 10,
          indexedFiles: 0,
          indexedContentPages: 0,
          indexedLuaModules: 0,
          incrementalStatus: 'idle',
          reconciliationStatus: 'idle',
        },
        selected: {
          id: 42,
          title: '地下水',
          revisionId: 420,
          isRedirect: true,
          deleted: false,
          content: undefined,
        },
        selectedJobs: [],
        pageCount: 10,
      } as T;
    }
    if (source.includes("objectStore('pages').delete(pageId)")) {
      expect(argument).toBe(42);
      return undefined as T;
    }
    if (source.includes('__CU_WIKI_SEARCH__.forceSync()')) {
      this.forceSyncCalls += 1;
      this.requestListener?.({
        url: () =>
          'https://casualtiesunknown.huijiwiki.com/api.php?action=query&generator=allpages&assert=user&gaplimit=500&prop=info&gapnamespace=0',
      });
      return undefined as T;
    }
    if (source.includes('const [page, jobs, reconciliation, recent, sequence]')) {
      expect(argument).toBe(42);
      return {
        debug: {
          engine: 'bootstrap',
          indexedPages: 10,
          indexedFiles: 0,
          indexedContentPages: 0,
          indexedLuaModules: 0,
          incrementalStatus: 'complete',
          reconciliationStatus: 'complete',
        },
        page: {
          id: 42,
          title: '地下水',
          revisionId: 420,
          isRedirect: true,
          deleted: false,
        },
        selectedJobs: [],
        reconciliation: { status: 'complete', pagesFetched: 10 },
        recent: { through: 'cursor' },
        sequence: 11,
      } as T;
    }
    if (source.includes("transaction.objectStore('pages').put(backup.selected)")) {
      this.cleanupRestores += 1;
      return undefined as T;
    }
    throw new Error(`Unexpected reconciliation evaluate call: ${source.slice(0, 100)}`);
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
