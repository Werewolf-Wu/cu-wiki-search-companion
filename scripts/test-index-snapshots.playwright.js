// SPDX-License-Identifier: MPL-2.0
async page => {
  const contentRequestUrls = [];
  const onRequest = request => {
    const value = request.url();
    if (
      value.includes('/api.php?') &&
      queryParameter(value, 'prop') === 'revisions' &&
      queryParameter(value, 'rvprop') === 'ids|content'
    ) {
      contentRequestUrls.push(value);
    }
  };
  page.on('request', onRequest);

  try {
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    await waitForColdReady();
    await page.waitForTimeout(15_000);
    const cold = await readDebug();
    if (
      cold.engine !== 'bootstrap' ||
      cold.indexedContentPages !== 0 ||
      cold.indexedLuaModules !== 0 ||
      cold.snapshots.some(snapshot => snapshot.status !== 'not-started')
    ) {
      throw new Error(`15 秒冷启动边界不符合预期：${JSON.stringify(cold)}`);
    }

    let baselineJobs = await readContentJobCounts();
    if (baselineJobs.pending || baselineJobs.running || baselineJobs.failed) {
      await openSearch();
      await activateMode('content');
      await page.waitForFunction(
        async () => {
          const request = indexedDB.open('cu-wiki-local-search');
          const database = await new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
          const jobs = await new Promise((resolve, reject) => {
            const getAll = database.transaction('jobs', 'readonly')
              .objectStore('jobs')
              .getAll();
            getAll.onsuccess = () => resolve(getAll.result);
            getAll.onerror = () => reject(getAll.error);
          });
          database.close();
          return jobs
            .filter(job => job.type === 'wikitext-content')
            .every(job => job.status === 'done');
        },
        undefined,
        { timeout: 360_000 },
      );
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
      await waitForColdReady();
      baselineJobs = await readContentJobCounts();
    }
    if (baselineJobs.pending || baselineJobs.running || baselineJobs.failed) {
      throw new Error(`无法建立稳定正文缓存基线：${JSON.stringify(baselineJobs)}`);
    }

    const firstRequestOffset = contentRequestUrls.length;
    await openSearch();
    await prepareAllSearchModes('首次本地构建并发布快照', 600_000);
    await activateFileMode();
    const expectedResults = await readSearchSignature();
    for (const [kind, results] of Object.entries(expectedResults)) {
      if (results.length === 0) throw new Error(`验收查询没有 ${kind} 命中`);
    }
    const firstBuild = await readDebug();
    const firstBuildRequests = contentRequestUrls.length - firstRequestOffset;
    if (firstBuildRequests !== 0) {
      throw new Error(
        `稳定正文缓存首次构建仍发出 ${firstBuildRequests} 个 revisions 请求：` +
          JSON.stringify(contentRequestUrls.slice(firstRequestOffset)),
      );
    }

    const restoreRuns = [];
    for (let run = 0; run < 3; run += 1) {
      await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
      await waitForColdReady();
      const requestOffset = contentRequestUrls.length;
      await openSearch();
      await prepareAllSearchModes(`第 ${run + 1} 次快照恢复`);
      await activateFileMode();
      const debug = await readDebug();
      const signature = await readSearchSignature();
      if (JSON.stringify(signature) !== JSON.stringify(expectedResults)) {
        throw new Error(
          `第 ${run + 1} 次快照恢复结果不一致：${JSON.stringify({ expectedResults, signature })}`,
        );
      }
      const revisionRequests = contentRequestUrls.length - requestOffset;
      if (revisionRequests !== 0) {
        throw new Error(`第 ${run + 1} 次恢复发出 ${revisionRequests} 个 revisions 请求`);
      }
      restoreRuns.push({
        run: run + 1,
        jiebaToContentMs: derivedReadyMs(debug) - debug.jiebaReadyMs,
        snapshots: debug.snapshots,
        signature,
      });
    }

    await page.evaluate(() => {
      const root = document.querySelector('#cu-wiki-search-host')?.shadowRoot;
      if (!root) throw new Error('搜索面板未挂载');
      const maintenance = root.querySelector('.maintenance');
      if (maintenance?.hidden) root.querySelector('.maintenance-toggle')?.click();
      root.querySelector('.clear-snapshots')?.click();
    });
    await page.waitForFunction(async () => {
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open('cu-wiki-local-search');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const count = await new Promise((resolve, reject) => {
        const request = database.transaction('indexSnapshots', 'readonly')
          .objectStore('indexSnapshots')
          .count();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      database.close();
      return count === 0;
    });

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    await waitForColdReady();
    const rebuildRequestOffset = contentRequestUrls.length;
    await openSearch();
    await prepareAllSearchModes('清除快照后的本地全量重建');
    const rebuilt = await readDebug();
    const rebuildMs = derivedReadyMs(rebuilt) - rebuilt.jiebaReadyMs;
    const rebuildRequests = contentRequestUrls.length - rebuildRequestOffset;
    if (rebuildRequests !== 0) {
      throw new Error(`清快照后的本地重建发出 ${rebuildRequests} 个 revisions 请求`);
    }

    const restoreDurations = restoreRuns
      .map(({ jiebaToContentMs }) => jiebaToContentMs)
      .sort((left, right) => left - right);
    const medianRestoreMs = restoreDurations[Math.floor(restoreDurations.length / 2)];
    if (medianRestoreMs > 10_000) {
      throw new Error(`快照恢复中位数超过 10 秒：${medianRestoreMs}ms`);
    }
    if (medianRestoreMs > rebuildMs * 0.7) {
      throw new Error(
        `快照恢复未比本地重建快至少 30%：${JSON.stringify({ medianRestoreMs, rebuildMs })}`,
      );
    }

    return {
      cold,
      firstBuild: {
        jiebaToContentMs: derivedReadyMs(firstBuild) - firstBuild.jiebaReadyMs,
        snapshots: firstBuild.snapshots,
        revisionsRequests: firstBuildRequests,
      },
      restoreRuns,
      medianRestoreMs,
      clearSnapshotRebuild: {
        milliseconds: rebuildMs,
        revisionsRequests: rebuildRequests,
        snapshots: rebuilt.snapshots,
      },
      expectedResults,
    };
  } finally {
    page.off('request', onRequest);
  }

  async function waitForColdReady() {
    await page.waitForFunction(
      () => window.__CU_WIKI_SEARCH__?.ready === true,
      undefined,
      { timeout: 60_000 },
    );
  }

  async function openSearch() {
    await page.evaluate(() => {
      const toggle = document
        .querySelector('#cu-wiki-search-host')
        ?.shadowRoot?.querySelector('.toggle');
      if (!(toggle instanceof HTMLButtonElement)) throw new Error('找不到本地搜索按钮');
      if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
    });
  }

  async function prepareAllSearchModes(description, timeout = 360_000) {
    try {
      await activateMode('content');
      await page.waitForFunction(
        () => window.__CU_WIKI_SEARCH__?.indexedContentPages >= 1_500,
        undefined,
        { timeout },
      );
      await activateMode('lua');
      await page.waitForFunction(
        () => {
          const debug = window.__CU_WIKI_SEARCH__;
          return (
            debug?.indexedContentPages >= 1_500 &&
            debug?.indexedLuaModules >= 120 &&
            Number.isFinite(debug.contentIndexReadyMs) &&
            Number.isFinite(debug.luaIndexReadyMs) &&
            debug?.snapshots?.length === 3 &&
            debug.snapshots.every(snapshot => snapshot.status === 'available')
          );
        },
        undefined,
        { timeout },
      );
    } catch (error) {
      throw new Error(`${description}未完成：${error instanceof Error ? error.message : String(error)}`);
    }
  }

  async function activateMode(value) {
    await page.evaluate((modeValue) => {
      const mode = document
        .querySelector('#cu-wiki-search-host')
        ?.shadowRoot?.querySelector('.mode');
      if (!(mode instanceof HTMLSelectElement)) throw new Error('找不到搜索模式选择器');
      mode.value = modeValue;
      mode.dispatchEvent(new Event('change'));
    }, value);
  }

  async function activateFileMode() {
    await page.evaluate(() => {
      const root = document.querySelector('#cu-wiki-search-host')?.shadowRoot;
      const mode = root?.querySelector('.mode');
      if (!(mode instanceof HTMLSelectElement)) throw new Error('找不到搜索模式选择器');
      mode.value = 'files';
      mode.dispatchEvent(new Event('change'));
    });
    await page.waitForFunction(
      () => window.__CU_WIKI_SEARCH__?.indexedFiles >= 1_500,
      undefined,
      { timeout: 60_000 },
    );
  }

  async function readDebug() {
    return page.evaluate(() => ({
      engine: window.__CU_WIKI_SEARCH__?.engine,
      indexedPages: window.__CU_WIKI_SEARCH__?.indexedPages,
      indexedFiles: window.__CU_WIKI_SEARCH__?.indexedFiles,
      indexedDataCodes: window.__CU_WIKI_SEARCH__?.indexedDataCodes,
      indexedContentPages: window.__CU_WIKI_SEARCH__?.indexedContentPages,
      indexedLuaModules: window.__CU_WIKI_SEARCH__?.indexedLuaModules,
      jiebaReadyMs: window.__CU_WIKI_SEARCH__?.jiebaReadyMs,
      contentIndexReadyMs: window.__CU_WIKI_SEARCH__?.contentIndexReadyMs,
      luaIndexReadyMs: window.__CU_WIKI_SEARCH__?.luaIndexReadyMs,
      contentReadyMs: window.__CU_WIKI_SEARCH__?.contentReadyMs,
      snapshots: window.__CU_WIKI_SEARCH__?.snapshots ?? [],
    }));
  }

  async function readContentJobCounts() {
    return page.evaluate(async () => {
      const request = indexedDB.open('cu-wiki-local-search');
      const database = await new Promise((resolve, reject) => {
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const jobs = await new Promise((resolve, reject) => {
        const getAll = database.transaction('jobs', 'readonly')
          .objectStore('jobs')
          .getAll();
        getAll.onsuccess = () => resolve(getAll.result);
        getAll.onerror = () => reject(getAll.error);
      });
      database.close();
      const contentJobs = jobs.filter(job => job.type === 'wikitext-content');
      return Object.fromEntries(
        ['done', 'pending', 'running', 'failed'].map(status => [
          status,
          contentJobs.filter(job => job.status === status).length,
        ]),
      );
    });
  }

  async function readSearchSignature() {
    return page.evaluate(() => {
      const debug = window.__CU_WIKI_SEARCH__;
      return {
        title: debug.search('砖块').slice(0, 5).map(result => result.title),
        brickContent: debug.searchContent('砖块').slice(0, 5).map(result => ({
          title: result.title,
          snippet: result.snippet,
        })),
        sleepContent: debug.searchContent('sleepQuality').slice(0, 5).map(result => ({
          title: result.title,
          snippet: result.snippet,
        })),
        lua: debug.searchLua('_meta').slice(0, 5).map(result => ({
          title: result.title,
          matches: result.matches,
        })),
        data: debug.searchCodes('砖块').slice(0, 5).map(result => ({
          code: result.code,
          source: result.source,
        })),
        files: debug.searchFiles('morphine').slice(0, 5).map(result => result.title),
      };
    });
  }

  function derivedReadyMs(debug) {
    const value = Math.max(debug.contentIndexReadyMs, debug.luaIndexReadyMs);
    if (!Number.isFinite(value) || !Number.isFinite(debug.jiebaReadyMs)) {
      throw new Error(`派生索引计时缺失：${JSON.stringify(debug)}`);
    }
    return value;
  }

  function queryParameter(value, name) {
    const query = value.includes('?') ? value.slice(value.indexOf('?') + 1) : '';
    for (const part of query.split('&')) {
      const separator = part.indexOf('=');
      const rawName = separator < 0 ? part : part.slice(0, separator);
      if (decodeURIComponent(rawName) !== name) continue;
      const rawValue = separator < 0 ? '' : part.slice(separator + 1);
      return decodeURIComponent(rawValue.replaceAll('+', ' '));
    }
    return undefined;
  }
}
