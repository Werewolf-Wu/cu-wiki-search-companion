// SPDX-License-Identifier: MPL-2.0
async page => {
  const databaseName = 'cu-wiki-local-search';
  const contentJobType = 'wikitext-content';
  const contentRequestPattern = '**/api.php?**';
  const startedAt = Date.now();
  const events = [];
  let phase = 'interrupt';
  let sentRateLimit = false;
  let firstPassedSignature;
  let stalled = false;
  let releaseStalledRequest;
  const stalledRequestGate = new Promise((resolve) => {
    releaseStalledRequest = resolve;
  });

  const readDebug = () => page.evaluate(() => window.__CU_WIKI_SEARCH__);
  const clickToggle = () =>
    page.evaluate(() => {
      const toggle = document
        .querySelector('#cu-wiki-search-host')
        ?.shadowRoot?.querySelector('.toggle');
      if (!(toggle instanceof HTMLButtonElement)) throw new Error('找不到“本地搜索”按钮');
      toggle.click();
    });
  const waitFor = async (predicate, description, timeoutMs = 360_000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await page.waitForTimeout(200);
    }
    throw new Error(`等待超时：${description}`);
  };
  const readTargetState = (targetIds) =>
    page.evaluate(
      async ({ databaseName: name, contentJobType: jobType, targetIds: ids }) => {
        const requestToPromise = (request) =>
          new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
        const database = await new Promise((resolve, reject) => {
          const request = indexedDB.open(name);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const transaction = database.transaction(['pages', 'jobs'], 'readonly');
        const pages = await Promise.all(
          ids.map((id) => requestToPromise(transaction.objectStore('pages').get(id))),
        );
        const allJobs = await requestToPromise(transaction.objectStore('jobs').getAll());
        database.close();
        const selected = new Set(ids);
        const jobs = allJobs.filter(
          (job) => job.type === jobType && selected.has(job.pageId),
        );
        return {
          upToDate: pages.filter(
            (record) =>
              record &&
              typeof record.content === 'string' &&
              record.contentRevisionId === record.revisionId,
          ).length,
          mismatched: pages.filter(
            (record) => record && record.contentRevisionId !== record.revisionId,
          ).length,
          statuses: Object.fromEntries(
            ['pending', 'running', 'done', 'failed'].map((status) => [
              status,
              jobs.filter((job) => job.status === status).length,
            ]),
          ),
        };
      },
      { databaseName, contentJobType, targetIds },
    );

  await page.waitForFunction(() => window.__CU_WIKI_SEARCH__?.ready === true);
  const coldBefore = await readDebug();
  if (
    coldBefore.engine !== 'bootstrap' ||
    coldBefore.indexedContentPages !== 0 ||
    coldBefore.indexedLuaModules !== 0
  ) {
    throw new Error(`测试必须从冷启动状态开始：${JSON.stringify(coldBefore)}`);
  }

  let preparation;
  let routeInstalled = false;
  let completed = false;
  try {
    preparation = await page.evaluate(
    async ({ databaseName: name, count }) => {
      const requestToPromise = (request) =>
        new Promise((resolve, reject) => {
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      const database = await new Promise((resolve, reject) => {
        const request = indexedDB.open(name);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      const readTransaction = database.transaction(['pages', 'jobs'], 'readonly');
      const [allPages, allJobs] = await Promise.all([
        requestToPromise(readTransaction.objectStore('pages').getAll()),
        requestToPromise(readTransaction.objectStore('jobs').getAll()),
      ]);
      const searchable = allPages
        .filter(
          (record) =>
            !record.deleted &&
            !record.isRedirect &&
            ['wikitext', 'bson', 'scribunto'].includes(
              String(record.contentModel).toLocaleLowerCase(),
            ),
        )
        .sort((left, right) => left.id - right.id);
      const markedTargets = searchable.filter((record) => record.contentRevisionId === -1);
      const baselineMismatches = searchable.filter(
        (record) =>
          record.contentRevisionId !== -1 &&
          (typeof record.content !== 'string' ||
            record.contentRevisionId !== record.revisionId),
      );
      if (baselineMismatches.length) {
        database.close();
        throw new Error(`基线已有 ${baselineMismatches.length} 条正文缓存失配`);
      }
      if (markedTargets.length !== 0 && markedTargets.length !== count) {
        database.close();
        throw new Error(`前次测试留下了 ${markedTargets.length} 条标记，预期为 ${count} 条`);
      }
      const targets = markedTargets.length === count ? markedTargets : searchable.slice(0, count);
      if (targets.length !== count) {
        database.close();
        throw new Error(`只有 ${targets.length} 条可用正文，无法准备 ${count} 条`);
      }
      if (markedTargets.length === 0) {
        const writeTransaction = database.transaction('pages', 'readwrite');
        const store = writeTransaction.objectStore('pages');
        await Promise.all(
          targets.map((record) => {
            record.contentRevisionId = -1;
            return requestToPromise(store.put(record));
          }),
        );
      }
      const targetIds = new Set(targets.map((record) => record.id));
      const jobsByPageId = new Map(
        allJobs
          .filter((job) => job.type === 'wikitext-content' && targetIds.has(job.pageId))
          .map((job) => [job.pageId, job]),
      );
      database.close();
      return {
        targetIds: targets.map((record) => record.id),
        backupPages: targets.map((record) => ({
          ...record,
          contentRevisionId: record.revisionId,
        })),
        backupJobs: targets.map((record) => ({
          ...jobsByPageId.get(record.id),
          type: 'wikitext-content',
          pageId: record.id,
          status: 'done',
          targetRevisionId: record.revisionId,
          error: undefined,
          updatedAt: Date.now(),
        })),
        firstTitle: targets[0]?.title,
        lastTitle: targets.at(-1)?.title,
        searchableCount: searchable.length,
      };
    },
    { databaseName, count: 51 },
  );
  const targetIds = preparation.targetIds;
  const targetSet = new Set(targetIds);

    await page.context().route(contentRequestPattern, async (route) => {
    const requestUrl = route.request().url();
    const query = requestUrl.split('?', 2)[1] ?? '';
    const parameter = (name) => {
      const encoded = query
        .split('&')
        .map((part) => part.split('=', 2))
        .find(([key]) => decodeURIComponent(key) === name)?.[1];
      return encoded === undefined ? null : decodeURIComponent(encoded.replaceAll('+', ' '));
    };
    const isContentRequest =
      requestUrl.includes('/api.php?') &&
      parameter('prop') === 'revisions' &&
      parameter('rvprop') === 'ids|content';
    if (!isContentRequest) {
      await route.continue();
      return;
    }

    const ids = (parameter('pageids') ?? '').split('|').filter(Boolean).map(Number);
    const targetedIds = ids.filter((id) => targetSet.has(id));
    events.push({ phase, action: 'request', atMs: Date.now() - startedAt, ids, targetedIds });

    if (phase === 'cache') {
      await route.continue();
      return;
    }
    if (phase !== 'interrupt' || targetedIds.length === 0) {
      await route.continue();
      return;
    }

    const signature = ids.join('|');
    if (!sentRateLimit) {
      sentRateLimit = true;
      events.push({ phase, action: 'fulfill-429', atMs: Date.now() - startedAt, ids });
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        headers: { 'Retry-After': '0.05' },
        body: JSON.stringify({ error: 'playwright rate-limit probe' }),
      });
      return;
    }
    if (firstPassedSignature === undefined) {
      firstPassedSignature = signature;
      events.push({ phase, action: 'pass-first-batch', atMs: Date.now() - startedAt, ids });
      await route.continue();
      return;
    }
    if (signature !== firstPassedSignature && !stalled) {
      stalled = true;
      events.push({ phase, action: 'stall-second-batch', atMs: Date.now() - startedAt, ids });
      await stalledRequestGate;
      try {
        await route.abort('aborted');
      } catch {
        // Reload already canceled this request.
      }
      return;
    }
    await route.continue();
    });
    routeInstalled = true;
    await clickToggle();
    await waitFor(() => Promise.resolve(stalled), '第二批正文请求进入等待状态');
    const interruptedState = await readTargetState(targetIds);
    if (
      interruptedState.upToDate !== 50 ||
      interruptedState.mismatched !== 1 ||
      interruptedState.statuses.done !== 50 ||
      interruptedState.statuses.running !== 1
    ) {
      throw new Error(`刷新前队列状态不符合预期：${JSON.stringify(interruptedState)}`);
    }

    const first429 = events.find((event) => event.action === 'fulfill-429');
    const firstPass = events.find((event) => event.action === 'pass-first-batch');
    const observedRetryDelayMs =
      first429 && firstPass ? firstPass.atMs - first429.atMs : undefined;
    if (observedRetryDelayMs === undefined || observedRetryDelayMs < 40) {
      throw new Error(`浏览器未观察到 Retry-After 退避：${observedRetryDelayMs}ms`);
    }

    phase = 'reloading';
    const reloadPromise = page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForTimeout(100);
    releaseStalledRequest();
    await reloadPromise;
    phase = 'resume';
    await page.waitForFunction(() => window.__CU_WIKI_SEARCH__?.ready === true);
    const coldAfterInterruption = await readDebug();
    await clickToggle();
    await waitFor(async () => {
      const state = await readTargetState(targetIds);
      return state.upToDate === 51 && state.statuses.done === 51;
    }, '刷新后续传剩余正文');
    await waitFor(async () => {
      const debug = await readDebug();
      return debug.indexedContentPages >= 1_500 && debug.indexedLuaModules >= 120;
    }, '恢复全量正文与 Lua 内存索引');
    const resumedState = await readTargetState(targetIds);
    const resumeRequests = events.filter(
      (event) => event.phase === 'resume' && event.action === 'request',
    );
    if (resumeRequests.length !== 1 || resumeRequests[0].targetedIds.length !== 1) {
      throw new Error(`刷新后并非只续传剩余一页：${JSON.stringify(resumeRequests)}`);
    }

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction(() => window.__CU_WIKI_SEARCH__?.ready === true);
    const coldBeforeCacheCheck = await readDebug();
    phase = 'cache';
    const cacheEventStart = events.length;
    await clickToggle();
    await waitFor(async () => {
      const debug = await readDebug();
      return debug.indexedContentPages >= 1_500 && debug.indexedLuaModules >= 120;
    }, '从完整缓存恢复正文索引');
    await page.waitForTimeout(1_000);
    const cacheRequests = events
      .slice(cacheEventStart)
      .filter((event) => event.phase === 'cache' && event.action === 'request');
    if (cacheRequests.length !== 0) {
      throw new Error(`完整正文缓存仍发出了 ${cacheRequests.length} 个 revisions 请求`);
    }

    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30_000 });
    await page.waitForFunction(() => window.__CU_WIKI_SEARCH__?.ready === true);
    const finalDebug = await readDebug();
    const panelExpanded = await page.evaluate(
      () =>
        document
          .querySelector('#cu-wiki-search-host')
          ?.shadowRoot?.querySelector('.toggle')
          ?.getAttribute('aria-expanded') ?? null,
    );
    if (
      finalDebug.engine !== 'bootstrap' ||
      finalDebug.indexedContentPages !== 0 ||
      finalDebug.indexedLuaModules !== 0 ||
      panelExpanded !== 'false'
    ) {
      throw new Error(
        `最终冷启动状态不符合预期：${JSON.stringify({ finalDebug, panelExpanded })}`,
      );
    }

    completed = true;
    return {
      coldBefore,
      preparation,
      observedRetryDelayMs,
      interruptedState,
      coldAfterInterruption,
      resumeRequests,
      resumedState,
      coldBeforeCacheCheck,
      cacheContentRequestCount: cacheRequests.length,
      finalDebug,
      panelExpanded,
      events,
    };
  } finally {
    phase = 'cleanup';
    releaseStalledRequest();
    if (routeInstalled) await page.context().unroute(contentRequestPattern);
    if (!completed && preparation) {
      await page.evaluate(async ({ databaseName: name, backup }) => {
        const requestToPromise = (request) =>
          new Promise((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
        const database = await new Promise((resolve, reject) => {
          const request = indexedDB.open(name);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
        const transaction = database.transaction(['pages', 'jobs'], 'readwrite');
        const pagesStore = transaction.objectStore('pages');
        const jobsStore = transaction.objectStore('jobs');
        const safePageIds = [];
        for (const original of backup.backupPages) {
          const current = await requestToPromise(pagesStore.get(original.id));
          if (
            current &&
            current.revisionId === original.revisionId &&
            current.localSeq === original.localSeq
          ) {
            await requestToPromise(pagesStore.put(original));
            safePageIds.push(original.id);
          }
        }
        const safeIds = new Set(safePageIds);
        const jobs = await requestToPromise(jobsStore.getAll());
        for (const job of jobs) {
          if (safeIds.has(job.pageId) && job.id !== undefined) {
            await requestToPromise(jobsStore.delete(job.id));
          }
        }
        for (const job of backup.backupJobs) {
          if (safeIds.has(job.pageId)) await requestToPromise(jobsStore.put(job));
        }
        await new Promise((resolve, reject) => {
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        });
        database.close();
      }, { databaseName, backup: preparation });
    }
  }
}
