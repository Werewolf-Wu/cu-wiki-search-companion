// SPDX-License-Identifier: MPL-2.0
async page => {
  await page.waitForFunction(() => window.__CU_WIKI_SEARCH__?.ready === true, {
    timeout: 30_000,
  });

  const before = await page.evaluate(async () => {
    const database = await openDatabase();
    const [pages, jobs] = await Promise.all([
      readAll(database, 'pages'),
      readAll(database, 'jobs'),
    ]);
    database.close();
    const preferred = pages.find(
      page =>
        page.title === '地下水' &&
        !page.deleted &&
        page.isRedirect &&
        typeof page.content !== 'string',
    );
    const fallback = pages.find(
      page =>
        !page.deleted && page.isRedirect && typeof page.content !== 'string',
    );
    const selected = preferred ?? fallback;
    if (!selected) throw new Error('没有可安全移除并由对账补回的无正文重定向页');
    return {
      debug: pickDebug(window.__CU_WIKI_SEARCH__),
      selected,
      selectedJobs: jobs.filter(job => job.pageId === selected.id),
      pageCount: pages.filter(page => !page.deleted).length,
    };

    function openDatabase() {
      return new Promise((resolve, reject) => {
        const request = indexedDB.open('cu-wiki-local-search');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }

    function readAll(database, storeName) {
      return new Promise((resolve, reject) => {
        const transaction = database.transaction(storeName, 'readonly');
        const request = transaction.objectStore(storeName).getAll();
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
    }

    function pickDebug(debug) {
      return {
        engine: debug?.engine,
        indexedPages: debug?.indexedPages,
        indexedFiles: debug?.indexedFiles,
        indexedContentPages: debug?.indexedContentPages,
        indexedLuaModules: debug?.indexedLuaModules,
        incrementalStatus: debug?.incrementalStatus,
        reconciliationStatus: debug?.reconciliationStatus,
      };
    }
  });

  if (
    before.debug.engine !== 'bootstrap' ||
    before.debug.indexedFiles !== 0 ||
    before.debug.indexedContentPages !== 0 ||
    before.debug.indexedLuaModules !== 0
  ) {
    throw new Error(`测试要求冷启动按需边界，当前状态：${JSON.stringify(before.debug)}`);
  }

  const apiRequests = [];
  const onRequest = request => {
    if (request.url().includes('/api.php?')) apiRequests.push(request.url());
  };
  page.on('request', onRequest);
  let completed = false;
  let reconciliationCommitted = false;
  try {
    await page.evaluate(async pageId => {
      const database = await openDatabase();
      await new Promise((resolve, reject) => {
        const transaction = database.transaction(['pages', 'jobs'], 'readwrite');
        transaction.objectStore('pages').delete(pageId);
        const jobsRequest = transaction.objectStore('jobs').getAll();
        jobsRequest.onsuccess = () => {
          for (const job of jobsRequest.result) {
            if (job.pageId === pageId && job.id !== undefined) {
              transaction.objectStore('jobs').delete(job.id);
            }
          }
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
      database.close();

      function openDatabase() {
        return new Promise((resolve, reject) => {
          const request = indexedDB.open('cu-wiki-local-search');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      }
    }, before.selected.id);

    await page.evaluate(() => window.__CU_WIKI_SEARCH__.forceSync());
    const after = await page.evaluate(async pageId => {
      const database = await openDatabase();
      const [page, jobs, reconciliation, recent, sequence] = await Promise.all([
        readOne(database, 'pages', pageId),
        readAll(database, 'jobs'),
        readOne(database, 'syncState', 'reconciliation-sync'),
        readOne(database, 'syncState', 'recent-changes-sync'),
        readOne(database, 'syncState', 'local-sequence'),
      ]);
      database.close();
      return {
        debug: pickDebug(window.__CU_WIKI_SEARCH__),
        page,
        selectedJobs: jobs.filter(job => job.pageId === pageId),
        reconciliation: reconciliation?.value,
        recent: recent?.value,
        sequence: sequence?.value,
      };

      function openDatabase() {
        return new Promise((resolve, reject) => {
          const request = indexedDB.open('cu-wiki-local-search');
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      }

      function readOne(database, storeName, key) {
        return new Promise((resolve, reject) => {
          const transaction = database.transaction(storeName, 'readonly');
          const request = transaction.objectStore(storeName).get(key);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      }

      function readAll(database, storeName) {
        return new Promise((resolve, reject) => {
          const transaction = database.transaction(storeName, 'readonly');
          const request = transaction.objectStore(storeName).getAll();
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error);
        });
      }

      function pickDebug(debug) {
        return {
          engine: debug?.engine,
          indexedPages: debug?.indexedPages,
          indexedFiles: debug?.indexedFiles,
          indexedContentPages: debug?.indexedContentPages,
          indexedLuaModules: debug?.indexedLuaModules,
          incrementalStatus: debug?.incrementalStatus,
          incrementalThrough: debug?.incrementalThrough,
          reconciliationStatus: debug?.reconciliationStatus,
          reconciliationCompletedAt: debug?.reconciliationCompletedAt,
        };
      }
    }, before.selected.id);
    reconciliationCommitted = after.reconciliation?.status === 'complete';

    if (!after.page || after.page.deleted) throw new Error('对账没有补回本地缺页');
    if (after.page.revisionId !== before.selected.revisionId) {
      throw new Error('补回页 revision 与实验前不一致');
    }
    if (after.reconciliation?.status !== 'complete') {
      throw new Error(`对账状态未完成：${JSON.stringify(after.reconciliation)}`);
    }
    if (after.selectedJobs.length !== 0) {
      throw new Error('重定向页不应生成正文 job');
    }
    if (
      after.debug.engine !== 'bootstrap' ||
      after.debug.indexedFiles !== 0 ||
      after.debug.indexedContentPages !== 0 ||
      after.debug.indexedLuaModules !== 0
    ) {
      throw new Error(`对账破坏了按需加载边界：${JSON.stringify(after.debug)}`);
    }

    const allPages = apiRequests.filter(
      value => queryParameter(value, 'generator') === 'allpages',
    );
    const recentChanges = apiRequests.filter(
      value => queryParameter(value, 'list') === 'recentchanges',
    );
    if (!allPages.length) throw new Error('没有观察到真实 allpages 对账请求');
    if (
      allPages.some(
        value =>
          queryParameter(value, 'assert') !== 'user' ||
          queryParameter(value, 'gaplimit') !== '500' ||
          queryParameter(value, 'prop') !== 'info',
      )
    ) {
      throw new Error('allpages 请求没有遵守普通账号参数基线');
    }

    completed = true;
    return {
      selected: {
        id: before.selected.id,
        title: before.selected.title,
        revisionId: before.selected.revisionId,
      },
      before: before.debug,
      after,
      requestEvidence: {
        totalApiRequests: apiRequests.length,
        allPagesRequests: allPages.length,
        fileAllPagesRequests: allPages.filter(
          value => queryParameter(value, 'gapnamespace') === '6',
        ).length,
        recentChangesRequests: recentChanges.length,
        namespaceOrder: allPages.map(value => Number(queryParameter(value, 'gapnamespace'))),
      },
    };

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
  } finally {
    page.off('request', onRequest);
    if (!completed && !reconciliationCommitted) {
      await page.evaluate(async backup => {
        const database = await openDatabase();
        await new Promise((resolve, reject) => {
          const transaction = database.transaction(['pages', 'jobs'], 'readwrite');
          transaction.objectStore('pages').put(backup.selected);
          for (const job of backup.selectedJobs) transaction.objectStore('jobs').put(job);
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
          transaction.onabort = () => reject(transaction.error);
        });
        database.close();

        function openDatabase() {
          return new Promise((resolve, reject) => {
            const request = indexedDB.open('cu-wiki-local-search');
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error);
          });
        }
      }, before);
    }
  }
}
