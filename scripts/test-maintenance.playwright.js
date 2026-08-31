// SPDX-License-Identifier: MPL-2.0
async page => {
  await page.waitForFunction(
    () => window.__CU_WIKI_SEARCH__?.ready === true,
    undefined,
    { timeout: 60_000 },
  );

  await page.evaluate(() => {
    const root = document.querySelector('#cu-wiki-search-host')?.shadowRoot;
    const toggle = root?.querySelector('.toggle');
    if (!(toggle instanceof HTMLButtonElement)) throw new Error('找不到本地搜索按钮');
    if (toggle.getAttribute('aria-expanded') !== 'true') toggle.click();
    const maintenance = root.querySelector('.maintenance');
    if (maintenance?.hidden) root.querySelector('.maintenance-toggle')?.click();
  });
  await page.waitForFunction(() => {
    const root = document.querySelector('#cu-wiki-search-host')?.shadowRoot;
    return root?.querySelector('.maintenance-output')?.textContent?.includes('页面 ');
  });

  const before = await readState();
  if (!before.networkLabel.includes('需要联网')) {
    throw new Error(`全量对账缺少联网标识：${before.networkLabel}`);
  }
  if (!before.dangerHidden || before.resetRulesChecked) {
    throw new Error(`危险区默认状态不正确：${JSON.stringify(before)}`);
  }

  await page.evaluate(() => {
    const root = document.querySelector('#cu-wiki-search-host')?.shadowRoot;
    const persistence = root?.querySelector('.request-persistence');
    if (!(persistence instanceof HTMLButtonElement)) throw new Error('找不到持久保存按钮');
    persistence.click();
  });
  await page.waitForFunction(() => {
    const root = document.querySelector('#cu-wiki-search-host')?.shadowRoot;
    const persistence = root?.querySelector('.request-persistence');
    const status = root?.querySelector('.status')?.textContent ?? '';
    return (
      persistence instanceof HTMLButtonElement &&
      !persistence.disabled &&
      /已允许持久保存|未授予持久保存|不支持申请持久保存|申请持久保存失败/.test(status)
    );
  }, undefined, { timeout: 60_000 });

  const after = await readState();
  if (
    !/已允许持久保存|未授予持久保存|不支持申请持久保存|申请持久保存失败/.test(
      after.status,
    )
  ) {
    throw new Error(`持久保存没有进入明确终态：${after.status}`);
  }
  return { before, after };

  async function readState() {
    return page.evaluate(() => {
      const root = document.querySelector('#cu-wiki-search-host')?.shadowRoot;
      const danger = root?.querySelector('.danger-confirmation');
      const resetRules = root?.querySelector('.reset-data-rules');
      return {
        diagnostics: root?.querySelector('.maintenance-output')?.textContent ?? '',
        networkLabel: root?.querySelector('.reconcile-now')?.textContent ?? '',
        dangerHidden: danger instanceof HTMLElement ? danger.hidden : false,
        resetRulesChecked:
          resetRules instanceof HTMLInputElement ? resetRules.checked : true,
        status: root?.querySelector('.status')?.textContent ?? '',
      };
    });
  }
}
