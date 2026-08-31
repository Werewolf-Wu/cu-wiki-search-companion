// SPDX-License-Identifier: MPL-2.0
async page => {
  const environment = globalThis.process?.env ?? {};
  const wikiOrigin = environment.CU_WIKI_ORIGIN ??
    'https://casualtiesunknown.huijiwiki.com';
  const rows = [];
  for (const candidate of page.context().pages()) {
    const url = candidate.url();
    const row = { url, title: await candidate.title().catch(() => '') };
    if (url.startsWith(`${wikiOrigin}/`)) {
      row.runtime = await candidate.evaluate(() => ({
        action: window.mw?.config?.get('wgAction'),
        contentModel: window.mw?.config?.get('wgPageContentModel'),
        hasHost: Boolean(document.querySelector('#cu-wiki-search-host')),
        debug: window.__CU_WIKI_SEARCH__ ?? null,
      })).catch(error => ({ evaluationError: String(error) }));
    }
    rows.push(row);
  }
  return rows;
}
