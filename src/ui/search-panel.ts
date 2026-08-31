// SPDX-License-Identifier: MPL-2.0
import type { NamespaceInfo } from '../types';
import type { ContentSearchResult } from '../search/content-index';
import type { DataCodeSearchResult } from '../search/data-code-index';
import type {
  LuaModuleSearchResult,
  LuaSymbolKind,
} from '../search/lua-module-index';
import type { TitleSearchResult } from '../search/title-index';
import type {
  LocalDataDiagnostics,
  PersistenceRequestResult,
} from '../maintenance/local-data-maintenance';

const MIRROR_REFRESH_HELP =
  '重新同步本地数据（需要联网）：执行全量页面对账，刷新 Data 代码缓存，并修复或续传正文与 Lua 队列；不会清空本地镜像，也不会修改 wiki 页面。';
const FILE_REFRESH_HELP =
  '重新同步文件资源（需要联网）：重新枚举文件命名空间并更新本地文件缓存与索引；不会影响普通页面、正文、Data 代码或 Lua，也不会修改 wiki 页面。';

type SearchPanelResult =
  | TitleSearchResult
  | DataCodeSearchResult
  | ContentSearchResult
  | LuaModuleSearchResult;
type WikiPageSearchResult = TitleSearchResult | ContentSearchResult | LuaModuleSearchResult;

export interface SearchPanelCallbacks {
  prepareSearch(): void;
  prepareFiles(): void;
  search(query: string, namespace?: number): TitleSearchResult[];
  searchFiles(query: string): TitleSearchResult[];
  searchLua(query: string): LuaModuleSearchResult[];
  searchContent(query: string, namespace?: number): ContentSearchResult[];
  searchCodes(query: string): DataCodeSearchResult[];
  insert(result: WikiPageSearchResult, query: string): void;
  selectCode(result: DataCodeSearchResult): void;
  copy(result: WikiPageSearchResult, query: string): void;
  copyCode(result: DataCodeSearchResult): void;
  open(result: WikiPageSearchResult): void;
  openCode(result: DataCodeSearchResult): void;
  refresh(): void;
  refreshFiles(): void;
  saveDataCodeRules(source: string): Promise<void>;
  loadMaintenance?(): Promise<LocalDataDiagnostics>;
  rebuildSearchIndexes?(): Promise<void>;
  rebuildContentQueue?(): Promise<void>;
  reconcileNow?(): Promise<void>;
  clearSnapshots?(): Promise<void>;
  requestPersistence?(): Promise<PersistenceRequestResult>;
  resetLocalMirror?(resetDataRules: boolean): Promise<void>;
}

export class SearchPanel {
  private readonly host: HTMLDivElement;
  private readonly root: ShadowRoot;
  private readonly panel: HTMLElement;
  private readonly input: HTMLInputElement;
  private readonly modeSelect: HTMLSelectElement;
  private readonly namespaceSelect: HTMLSelectElement;
  private readonly resultList: HTMLUListElement;
  private readonly status: HTMLElement;
  private readonly toggle: HTMLButtonElement;
  private readonly configure: HTMLButtonElement;
  private readonly settings: HTMLElement;
  private readonly dataRules: HTMLTextAreaElement;
  private readonly maintenance: HTMLElement;
  private readonly maintenanceOutput: HTMLElement;
  private defaultDataRules = '';
  private results: SearchPanelResult[] = [];
  private selectedIndex = -1;
  private insertMode = true;
  private composing = false;
  private maintenanceBusy = false;
  private startupFailed = false;
  private searchTimer?: number;

  constructor(private readonly callbacks: SearchPanelCallbacks) {
    this.host = document.createElement('div');
    this.host.id = 'cu-wiki-search-host';
    this.root = this.host.attachShadow({ mode: 'open' });
    this.root.innerHTML = markup;
    document.documentElement.append(this.host);

    this.panel = this.requireElement<HTMLElement>('.panel');
    this.input = this.requireElement<HTMLInputElement>('.query');
    this.modeSelect = this.requireElement<HTMLSelectElement>('.mode');
    this.namespaceSelect = this.requireElement<HTMLSelectElement>('.namespace');
    this.resultList = this.requireElement<HTMLUListElement>('.results');
    this.status = this.requireElement<HTMLElement>('.status');
    this.toggle = this.requireElement<HTMLButtonElement>('.toggle');
    this.configure = this.requireElement<HTMLButtonElement>('.configure');
    this.settings = this.requireElement<HTMLElement>('.settings');
    this.dataRules = this.requireElement<HTMLTextAreaElement>('.data-rules');
    this.maintenance = this.requireElement<HTMLElement>('.maintenance');
    this.maintenanceOutput = this.requireElement<HTMLElement>('.maintenance-output');
    this.bindEvents();
    this.updateModePresentation();
  }

  setStatus(message: string, tone: 'normal' | 'error' | 'success' = 'normal'): void {
    this.status.textContent = message;
    this.status.dataset.tone = tone;
  }

  setNamespaces(namespaces: NamespaceInfo[]): void {
    const selected = this.namespaceSelect.value;
    this.namespaceSelect.replaceChildren(new Option('全部命名空间', ''));
    for (const namespace of namespaces.sort((left, right) => left.id - right.id)) {
      this.namespaceSelect.add(new Option(namespace.name || '（主）', String(namespace.id)));
    }
    if ([...this.namespaceSelect.options].some((option) => option.value === selected)) {
      this.namespaceSelect.value = selected;
    }
  }

  setInsertMode(enabled: boolean): void {
    this.insertMode = enabled;
    this.updateModePresentation();
  }

  setDataCodeRules(source: string, defaultSource: string): void {
    this.dataRules.value = source;
    this.defaultDataRules = defaultSource;
  }

  setStartupFailure(message: string, reload: () => void): void {
    this.startupFailed = true;
    this.setStatus(`本地搜索启动失败：${message}。可重新加载页面重试。`, 'error');
    const reloadButton = this.requireElement<HTMLButtonElement>('.reload-startup');
    reloadButton.hidden = false;
    reloadButton.onclick = reload;
  }

  open(): void {
    if (!this.startupFailed) {
      if (this.fileMode) this.callbacks.prepareFiles();
      else this.callbacks.prepareSearch();
    }
    this.panel.hidden = false;
    this.toggle.setAttribute('aria-expanded', 'true');
    this.input.focus();
    this.input.select();
  }

  close(): void {
    this.panel.hidden = true;
    this.toggle.setAttribute('aria-expanded', 'false');
  }

  refreshResults(): void {
    this.performSearch();
  }

  private bindEvents(): void {
    this.toggle.addEventListener('click', () => {
      if (this.panel.hidden) this.open();
      else this.close();
    });
    this.requireElement<HTMLButtonElement>('.close').addEventListener('click', () => this.close());
    this.requireElement<HTMLButtonElement>('.refresh').addEventListener('click', () => {
      if (this.startupFailed) return;
      if (this.fileMode) this.callbacks.refreshFiles();
      else this.callbacks.refresh();
    });
    this.configure.addEventListener('click', () => {
      this.settings.hidden = !this.settings.hidden;
      if (!this.settings.hidden) this.dataRules.focus();
    });
    this.requireElement<HTMLButtonElement>('.maintenance-toggle').addEventListener(
      'click',
      () => {
        this.maintenance.hidden = !this.maintenance.hidden;
        this.settings.hidden = true;
        if (!this.maintenance.hidden) void this.loadMaintenance();
      },
    );
    this.requireElement<HTMLButtonElement>('.save-rules').addEventListener('click', () => {
      void this.saveDataRules(this.dataRules.value);
    });
    this.requireElement<HTMLButtonElement>('.reset-rules').addEventListener('click', () => {
      this.dataRules.value = this.defaultDataRules;
      void this.saveDataRules(this.defaultDataRules);
    });
    this.bindMaintenanceAction('.rebuild-indexes', '正在从本地页面重建搜索索引…', () =>
      this.callbacks.rebuildSearchIndexes?.(),
    );
    this.bindMaintenanceAction('.rebuild-content-queue', '正在修复正文队列…', () =>
      this.callbacks.rebuildContentQueue?.(),
    );
    this.bindMaintenanceAction('.reconcile-now', '正在进行联网全量对账…', () =>
      this.callbacks.reconcileNow?.(),
    );
    this.bindMaintenanceAction('.clear-snapshots', '正在清除索引快照…', () =>
      this.callbacks.clearSnapshots?.(),
    );
    this.requireElement<HTMLButtonElement>('.request-persistence').addEventListener(
      'click',
      () => {
        void this.runMaintenanceAction(
          '正在申请浏览器持久保存…',
          async () => {
            const request = this.callbacks.requestPersistence?.();
            if (!request) throw new Error('持久保存操作当前不可用');
            await this.finishPersistenceRequest(request);
          },
          false,
        );
      },
    );
    this.requireElement<HTMLButtonElement>('.reveal-danger').addEventListener('click', () => {
      this.requireElement<HTMLElement>('.danger-confirmation').hidden = false;
    });
    this.requireElement<HTMLButtonElement>('.reset-local').addEventListener('click', () => {
      const resetRules = this.requireElement<HTMLInputElement>('.reset-data-rules').checked;
      void this.runMaintenanceAction('正在清空本地镜像…', () =>
        this.callbacks.resetLocalMirror?.(resetRules),
      );
    });

    this.input.addEventListener('compositionstart', () => {
      this.composing = true;
    });
    this.input.addEventListener('compositionend', () => {
      this.composing = false;
      this.scheduleSearch(0);
    });
    this.input.addEventListener('input', () => {
      if (!this.composing) this.scheduleSearch(120);
    });
    this.namespaceSelect.addEventListener('change', () => this.performSearch());
    this.modeSelect.addEventListener('change', () => {
      if (!this.startupFailed) {
        if (this.fileMode) this.callbacks.prepareFiles();
        else this.callbacks.prepareSearch();
      }
      this.updateModePresentation();
      this.performSearch();
    });
    this.input.addEventListener('keydown', (event) => this.handleKeydown(event));

    window.addEventListener('keydown', (event) => {
      if (event.altKey && event.key.toLocaleLowerCase() === 'k') {
        event.preventDefault();
        if (this.panel.hidden) this.open();
        else this.close();
      }
    });
  }

  private scheduleSearch(delay: number): void {
    if (this.searchTimer !== undefined) window.clearTimeout(this.searchTimer);
    this.searchTimer = window.setTimeout(() => this.performSearch(), delay);
  }

  private performSearch(): void {
    if (this.fileMode) {
      this.results = this.callbacks.searchFiles(this.input.value);
    } else if (this.codeMode) {
      this.results = this.callbacks.searchCodes(this.input.value);
    } else if (this.luaMode) {
      this.results = this.callbacks.searchLua(this.input.value);
    } else {
      const namespaceValue = this.namespaceSelect.value;
      const namespace = namespaceValue ? Number(namespaceValue) : undefined;
      this.results = this.contentMode
        ? this.callbacks.searchContent(this.input.value, namespace)
        : this.callbacks.search(this.input.value, namespace);
    }
    this.selectedIndex = this.results.length ? 0 : -1;
    this.renderResults();
  }

  private renderResults(): void {
    this.resultList.replaceChildren();
    if (!this.input.value.trim()) {
      this.resultList.append(
        this.messageItem(
          this.codeMode
            ? '输入已配置字段的值查找代码'
            : this.fileMode
              ? '输入文件名、片段或扩展名开始搜索'
            : this.luaMode
              ? '输入函数名、返回键、字符串或依赖目标'
            : this.contentMode
              ? '输入正文关键词开始搜索'
              : '输入标题关键词开始搜索',
        ),
      );
      return;
    }
    if (!this.results.length) {
      this.resultList.append(
        this.messageItem(
          this.codeMode
            ? '没有找到对应代码名'
            : this.fileMode
              ? '没有找到匹配文件'
            : this.luaMode
              ? '没有找到匹配 Lua 模块'
            : this.contentMode
              ? '没有找到匹配正文'
              : '没有找到匹配标题',
        ),
      );
      return;
    }

    this.results.forEach((result, index) => {
      const item = document.createElement('li');
      item.className = 'result';
      item.dataset.selected = String(index === this.selectedIndex);

      const insertButton = document.createElement('button');
      insertButton.className = 'insert';
      insertButton.type = 'button';
      const title = document.createElement('span');
      title.className = 'result-title';
      const namespace = document.createElement('span');
      namespace.className = 'result-namespace';
      insertButton.append(title, namespace);
      insertButton.addEventListener('click', () => this.insert(result));

      const actions = document.createElement('span');
      actions.className = 'actions';
      if (isDataCodeResult(result)) {
        insertButton.title = '复制代码名';
        title.textContent = result.chineseName;
        namespace.textContent = `${result.code} · ${result.dataType}`;
        actions.append(
          this.actionButton('复制', '复制代码名', () => this.callbacks.copyCode(result)),
          this.actionButton('↗', '打开 Data 页面', () => this.callbacks.openCode(result)),
        );
      } else if (isLuaResult(result)) {
        insertButton.title = '在新标签页打开模块';
        title.textContent = result.title;
        namespace.textContent = result.matches
          .map((match) => `${luaKindLabel(match.kind)} · ${match.value}`)
          .join(' · ');
        actions.append(
          this.actionButton('↗', '在新标签页打开模块', () => this.callbacks.open(result)),
        );
      } else {
        insertButton.title = this.insertMode ? '插入维基链接' : '复制页面标题';
        title.textContent = result.title;
        namespace.textContent = isContentResult(result)
          ? `${result.namespaceName || '主命名空间'} · ${result.snippet}`
          : result.namespaceName || '主命名空间';
        actions.append(
          this.actionButton('复制', '复制维基链接', () =>
            this.callbacks.copy(result, this.input.value),
          ),
          this.actionButton('↗', '在新标签页打开', () => this.callbacks.open(result)),
        );
      }
      item.append(insertButton, actions);
      item.addEventListener('mouseenter', () => {
        this.selectedIndex = index;
        this.updateSelection();
      });
      this.resultList.append(item);
    });
  }

  private handleKeydown(event: KeyboardEvent): void {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.close();
      return;
    }
    if (!this.results.length || this.composing) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      this.selectedIndex = (this.selectedIndex + 1) % this.results.length;
      this.updateSelection();
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      this.selectedIndex = (this.selectedIndex - 1 + this.results.length) % this.results.length;
      this.updateSelection();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const result = this.results[this.selectedIndex];
      if (result) this.insert(result);
    }
  }

  private insert(result: SearchPanelResult): void {
    if (isDataCodeResult(result)) this.callbacks.selectCode(result);
    else if (isLuaResult(result)) this.callbacks.open(result);
    else this.callbacks.insert(result, this.input.value);
    this.close();
  }

  private updateModePresentation(): void {
    const heading = this.requireElement<HTMLElement>('.heading');
    const refresh = this.requireElement<HTMLButtonElement>('.refresh');
    const refreshHelp = this.fileMode ? FILE_REFRESH_HELP : MIRROR_REFRESH_HELP;
    refresh.title = refreshHelp;
    refresh.setAttribute('aria-label', refreshHelp);
    if (this.codeMode) {
      heading.textContent = '查找 Data 代码名';
      this.input.placeholder = '输入已配置字段的值，例如：手枪';
      this.namespaceSelect.hidden = true;
    } else if (this.fileMode) {
      heading.textContent = '查找文件资源';
      this.input.placeholder = '文件名、片段或扩展名';
      this.namespaceSelect.hidden = true;
    } else if (this.luaMode) {
      heading.textContent = '查找 Lua 模块';
      this.input.placeholder = '函数名、返回键、字符串或 require 目标';
      this.namespaceSelect.hidden = true;
    } else if (this.contentMode) {
      heading.textContent = '搜索页面正文';
      this.input.placeholder = '输入正文关键词';
      this.namespaceSelect.hidden = false;
    } else {
      heading.textContent = this.insertMode ? '插入维基链接' : '搜索并复制标题';
      this.input.placeholder = '标题、片段或英文中缀';
      this.namespaceSelect.hidden = false;
    }
    this.configure.hidden = !this.codeMode;
    if (!this.codeMode) this.settings.hidden = true;
  }

  private get codeMode(): boolean {
    return this.modeSelect.value === 'data-code';
  }

  private get contentMode(): boolean {
    return this.modeSelect.value === 'content';
  }

  private get fileMode(): boolean {
    return this.modeSelect.value === 'files';
  }

  private get luaMode(): boolean {
    return this.modeSelect.value === 'lua';
  }

  private updateSelection(): void {
    const items = [...this.resultList.querySelectorAll<HTMLElement>('.result')];
    items.forEach((item, index) => {
      item.dataset.selected = String(index === this.selectedIndex);
    });
    items[this.selectedIndex]?.scrollIntoView({ block: 'nearest' });
  }

  private messageItem(message: string): HTMLLIElement {
    const item = document.createElement('li');
    item.className = 'message';
    item.textContent = message;
    return item;
  }

  private actionButton(label: string, title: string, action: () => void): HTMLButtonElement {
    const button = document.createElement('button');
    button.className = 'action';
    button.type = 'button';
    button.textContent = label;
    button.title = title;
    button.addEventListener('click', (event) => {
      event.stopPropagation();
      action();
    });
    return button;
  }

  private async saveDataRules(source: string): Promise<void> {
    try {
      this.setStatus('正在按配置刷新 Data 代码缓存…');
      await this.callbacks.saveDataCodeRules(source);
      this.settings.hidden = true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.setStatus(`Data 代码检索配置无效或刷新失败：${message}`, 'error');
    }
  }

  private bindMaintenanceAction(
    selector: string,
    progressMessage: string,
    action: () => Promise<void> | undefined,
  ): void {
    this.requireElement<HTMLButtonElement>(selector).addEventListener('click', () => {
      void this.runMaintenanceAction(progressMessage, action);
    });
  }

  private async runMaintenanceAction(
    progressMessage: string,
    action: () => Promise<void> | undefined,
    announceCompletion = true,
  ): Promise<void> {
    if (this.maintenanceBusy) return;
    this.maintenanceBusy = true;
    this.setMaintenanceDisabled(true);
    this.setStatus(progressMessage);
    try {
      const request = action();
      if (!request) throw new Error('维护操作当前不可用');
      await request;
      if (announceCompletion) this.setStatus('本地维护操作完成', 'success');
      await this.loadMaintenance();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failure = `本地维护操作失败：${message}`;
      this.maintenanceOutput.textContent = failure;
      this.setStatus(failure, 'error');
    } finally {
      this.maintenanceBusy = false;
      this.setMaintenanceDisabled(false);
    }
  }

  private setMaintenanceDisabled(disabled: boolean): void {
    for (const button of this.root.querySelectorAll<HTMLButtonElement>(
      '.maintenance-action',
    )) {
      button.disabled = disabled;
    }
  }

  private async loadMaintenance(): Promise<void> {
    if (!this.callbacks.loadMaintenance) {
      this.maintenanceOutput.textContent = '维护诊断尚未接入';
      return;
    }
    this.maintenanceOutput.textContent = '正在读取本地诊断…';
    try {
      const diagnostics = await this.callbacks.loadMaintenance();
      this.maintenanceOutput.textContent = formatDiagnostics(diagnostics);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.maintenanceOutput.textContent = `诊断读取失败：${message}`;
    }
  }

  private async finishPersistenceRequest(
    request: Promise<PersistenceRequestResult>,
  ): Promise<void> {
    const result = await request;
    if (result.status === 'granted') {
      this.setStatus('浏览器已允许持久保存本地镜像', 'success');
    } else if (result.status === 'denied') {
      this.setStatus('浏览器未授予持久保存；搜索与维护仍可正常使用', 'error');
    } else if (result.status === 'unsupported') {
      this.setStatus('当前浏览器不支持申请持久保存；其余功能不受影响', 'error');
    } else {
      this.setStatus(`申请持久保存失败：${result.message}`, 'error');
    }
    await this.loadMaintenance();
  }

  private requireElement<T extends Element>(selector: string): T {
    const element = this.root.querySelector<T>(selector);
    if (!element) throw new Error(`Search panel is missing ${selector}`);
    return element;
  }
}

function isDataCodeResult(result: SearchPanelResult): result is DataCodeSearchResult {
  return 'kind' in result && result.kind === 'data-code';
}

function isContentResult(result: SearchPanelResult): result is ContentSearchResult {
  return 'kind' in result && result.kind === 'content';
}

function isLuaResult(result: SearchPanelResult): result is LuaModuleSearchResult {
  return 'kind' in result && result.kind === 'lua';
}

function luaKindLabel(kind: LuaSymbolKind): string {
  switch (kind) {
    case 'function':
      return '函数';
    case 'return-key':
      return '返回键';
    case 'dependency':
      return '依赖';
    case 'string':
      return '字符串';
  }
}

function formatDiagnostics(diagnostics: LocalDataDiagnostics): string {
  const snapshotLabels = diagnostics.snapshots
    .map(
      (snapshot) =>
        `${snapshot.kind}: ${snapshot.status}` +
        (snapshot.payloadBytes === undefined
          ? ''
          : ` / ${formatBytes(snapshot.payloadBytes)} / seq ${snapshot.throughLocalSeq ?? 0}`) +
        (snapshot.restoreMs === undefined ? '' : ` / 恢复 ${Math.round(snapshot.restoreMs)}ms`),
    )
    .join('\n');
  const storage = diagnostics.storage;
  return [
    `页面 ${diagnostics.counts.pages} · 文件 ${diagnostics.counts.files} · Data 代码 ${diagnostics.counts.dataCodes}`,
    `正文源 ${diagnostics.counts.contentSources} · Lua 源 ${diagnostics.counts.luaSources}`,
    `正文队列 done ${diagnostics.jobs.done} / pending ${diagnostics.jobs.pending} / running ${diagnostics.jobs.running} / failed ${diagnostics.jobs.failed}`,
    `RC ${diagnostics.recentChanges?.through ?? '未完成'} · 全量对账 ${diagnostics.reconciliation?.status ?? '未开始'}`,
    `事实版本 ${diagnostics.versionContract ? `schema ${diagnostics.versionContract.databaseSchema} / pages ${diagnostics.versionContract.pageFacts}` : '未登记'}`,
    snapshotLabels,
    `IndexedDB ${formatBytes(storage.usage)} / ${formatBytes(storage.quota)} · 持久化 ${storage.persisted === true ? '已授予' : storage.persisted === false ? '未授予' : '未知'}`,
  ].join('\n');
}

function formatBytes(value: number | undefined): string {
  if (value === undefined) return '未知';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MiB`;
}

const markup = `
  <style>
    :host { all: initial; color-scheme: light; }
    * { box-sizing: border-box; }
    button, input, select { font: inherit; }
    .toggle {
      position: fixed; right: 22px; bottom: 22px; z-index: 2147483646;
      border: 0; border-radius: 999px; padding: 10px 16px;
      background: #173f35; color: #fff; box-shadow: 0 8px 24px #102a2360;
      cursor: pointer; font: 600 14px/20px system-ui, sans-serif;
    }
    .toggle:hover { background: #21584a; transform: translateY(-1px); }
    .panel {
      position: fixed; right: 22px; bottom: 72px; z-index: 2147483647;
      width: min(430px, calc(100vw - 28px)); overflow: hidden;
      border: 1px solid #d8dedb; border-radius: 14px; background: #fbfcfb;
      box-shadow: 0 18px 54px #102a2340; color: #18231f;
      font: 14px/1.4 system-ui, -apple-system, "Segoe UI", sans-serif;
    }
    .panel[hidden] { display: none; }
    .header { display: flex; align-items: center; padding: 12px 14px 8px; gap: 8px; }
    .heading { flex: 1; font-weight: 700; letter-spacing: .02em; }
    .icon { border: 0; background: transparent; color: #53635d; cursor: pointer; padding: 4px 7px; border-radius: 6px; }
    .icon:hover { background: #e9efec; color: #173f35; }
    .icon[hidden] { display: none; }
    .controls { display: grid; grid-template-columns: 1fr 112px 124px; gap: 8px; padding: 0 14px 10px; }
    .query, .mode, .namespace {
      min-width: 0; height: 38px; border: 1px solid #bcc8c3; border-radius: 8px;
      background: #fff; color: #18231f; outline: none;
    }
    .query { padding: 0 11px; }
    .mode, .namespace { padding: 0 7px; }
    .mode[hidden], .namespace[hidden] { display: none; }
    .query:focus, .mode:focus, .namespace:focus { border-color: #29715e; box-shadow: 0 0 0 3px #29715e22; }
    .settings { margin: 0 14px 10px; padding: 10px; border: 1px solid #d8dedb; border-radius: 9px; background: #f4f7f5; }
    .settings[hidden] { display: none; }
    .settings-label { display: block; margin-bottom: 6px; font-weight: 650; }
    .settings-help { display: block; margin: 6px 0; color: #65736e; font-size: 11px; }
    .data-rules { width: 100%; min-height: 180px; resize: vertical; border: 1px solid #bcc8c3; border-radius: 7px; padding: 8px; background: #fff; color: #18231f; font: 11px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace; }
    .settings-actions { display: flex; justify-content: flex-end; gap: 7px; }
    .settings-action { border: 1px solid #b9cbc5; border-radius: 6px; padding: 5px 9px; background: #fff; color: #24483e; cursor: pointer; }
    .save-rules { border-color: #29715e; background: #29715e; color: #fff; }
    .maintenance { margin: 0 14px 10px; padding: 10px; border: 1px solid #d8dedb; border-radius: 9px; background: #f4f7f5; max-height: min(58vh, 520px); overflow: auto; }
    .maintenance[hidden], .danger-confirmation[hidden] { display: none; }
    .maintenance-title { margin: 0 0 7px; font-size: 13px; }
    .maintenance-output { margin: 0 0 9px; white-space: pre-wrap; color: #52635d; font: 11px/1.55 ui-monospace, SFMono-Regular, Consolas, monospace; }
    .maintenance-actions { display: grid; gap: 6px; }
    .maintenance-action { border: 1px solid #b9cbc5; border-radius: 7px; padding: 7px 9px; background: #fff; color: #24483e; cursor: pointer; text-align: left; }
    .network-note { color: #8a5a18; font-size: 11px; }
    .danger-zone { margin-top: 10px; padding-top: 9px; border-top: 1px solid #e2c9c5; }
    .danger { border-color: #c98c82; color: #8a2f25; }
    .danger-copy { display: block; margin: 7px 0; color: #7c433d; font-size: 11px; }
    .reset-rules-option { display: block; margin: 7px 0; font-size: 11px; }
    .results { list-style: none; padding: 0 8px; margin: 0; max-height: min(52vh, 430px); overflow: auto; }
    .result { display: grid; grid-template-columns: 1fr auto; align-items: center; border-radius: 9px; }
    .result[data-selected="true"] { background: #e7f0ed; }
    .insert { display: flex; flex-direction: column; align-items: flex-start; gap: 2px; min-width: 0; border: 0; padding: 9px 8px; background: transparent; color: inherit; cursor: pointer; text-align: left; }
    .result-title { max-width: 100%; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-weight: 600; }
    .result-namespace { font-size: 11px; color: #718079; }
    .actions { display: flex; gap: 3px; padding-right: 6px; }
    .action { border: 1px solid transparent; border-radius: 6px; background: transparent; color: #41665b; cursor: pointer; padding: 4px 6px; font-size: 12px; }
    .action:hover { border-color: #b9cbc5; background: #fff; }
    .message { padding: 28px 12px; color: #718079; text-align: center; }
    .footer { display: flex; gap: 8px; align-items: center; min-height: 36px; padding: 8px 14px 10px; border-top: 1px solid #e5e9e7; color: #65736e; font-size: 11px; }
    .status { flex: 1; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .status[data-tone="error"] { color: #a1382e; }
    .status[data-tone="success"] { color: #246b48; }
    kbd { border: 1px solid #cfd7d3; border-bottom-width: 2px; border-radius: 4px; background: #fff; padding: 1px 4px; font: 10px/1.2 system-ui, sans-serif; }
    @media (max-width: 520px) {
      .panel { right: 14px; bottom: 68px; }
      .toggle { right: 14px; bottom: 14px; }
      .controls { grid-template-columns: 1fr; }
    }
  </style>
  <button class="toggle" type="button" aria-expanded="false">本地搜索</button>
  <section class="panel" hidden aria-label="未知伤亡维基本地搜索">
    <header class="header">
      <span class="heading">插入维基链接</span>
      <button class="icon reload-startup" type="button" title="重新加载页面" hidden>重新加载</button>
      <button class="icon configure" type="button" title="配置 Data 代码检索字段" hidden>⚙</button>
      <button class="icon maintenance-toggle" type="button" title="本地数据与维护">▤</button>
      <button class="icon refresh" type="button" title="重新同步本地数据">↻</button>
      <button class="icon close" type="button" title="关闭">✕</button>
    </header>
    <div class="controls">
      <input class="query" type="search" autocomplete="off" placeholder="标题、片段或英文中缀" aria-label="搜索标题">
      <select class="mode" aria-label="搜索类型">
        <option value="title">页面标题</option>
        <option value="content">页面正文</option>
        <option value="data-code">Data 代码</option>
        <option value="lua">Lua 模块</option>
        <option value="files">文件资源</option>
      </select>
      <select class="namespace" aria-label="筛选命名空间"><option value="">全部命名空间</option></select>
    </div>
    <section class="settings" hidden>
      <label class="settings-label" for="cu-data-rules">Data 代码检索字段</label>
      <textarea class="data-rules" id="cu-data-rules" spellcheck="false" aria-label="Data 代码检索字段"></textarea>
      <span class="settings-help">每行“类型 = 路径”；所选路径的标量值用于查找顶层 id 代码名。支持 []、*、**；保存后刷新 Data 代码缓存，不影响页面正文。</span>
      <div class="settings-actions">
        <button class="settings-action reset-rules" type="button">恢复默认</button>
        <button class="settings-action save-rules" type="button">保存并刷新</button>
      </div>
    </section>
    <section class="maintenance" hidden aria-label="本地数据与维护">
      <h2 class="maintenance-title">本地数据与维护</h2>
      <pre class="maintenance-output">尚未读取诊断</pre>
      <div class="maintenance-actions">
        <button class="maintenance-action rebuild-indexes" type="button">重建搜索索引</button>
        <button class="maintenance-action rebuild-content-queue" type="button">重建正文队列</button>
        <button class="maintenance-action reconcile-now" type="button">立即全量对账 <span class="network-note">（需要联网）</span></button>
        <button class="maintenance-action clear-snapshots" type="button">清除索引快照</button>
        <button class="maintenance-action request-persistence" type="button">申请持久保存</button>
      </div>
      <div class="danger-zone">
        <button class="maintenance-action danger reveal-danger" type="button">高级危险操作</button>
        <div class="danger-confirmation" hidden>
          <span class="danger-copy">清空页面、正文、文件、Data 缓存、队列、同步游标和快照；不会修改 wiki 页面。下次搜索需要重新联网同步。</span>
          <label class="reset-rules-option"><input class="reset-data-rules" type="checkbox"> 同时恢复默认 Data 字段规则</label>
          <button class="maintenance-action danger reset-local" type="button">确认清空本地镜像</button>
        </div>
      </div>
    </section>
    <ul class="results"><li class="message">输入标题关键词开始搜索</li></ul>
    <footer class="footer"><span class="status">正在启动…</span><span><kbd>Alt</kbd> + <kbd>K</kbd></span></footer>
  </section>
`;
