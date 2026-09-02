// SPDX-License-Identifier: MPL-2.0
async page => {
  page = page.context().pages().find(candidate =>
    /[?&]action=(?:edit|submit)(?:[&#]|$)/.test(candidate.url()),
  );
  if (!page) throw new Error('找不到已激活的维基编辑页（action=edit/submit）');

  const debug = await page.evaluate(() => window.__CU_WIKI_SEARCH__);
  if (!debug || debug.indexedContentPages < 1_500) {
    throw new Error('正文索引尚未恢复到 P2b 全量状态');
  }

  const queries = [
    'sleepQuality',
    'blastResistance',
    'scarf',
    'worldFluid',
    'criticalExpression',
    'assets',
    'entries',
    'aliases',
    'groundwater',
    'health',
    'wearableArmor',
    'footstep',
  ];
  await page.evaluate((values) => {
    for (const query of values) window.__CU_WIKI_SEARCH__.searchContent(query);
  }, queries);
  const durations = await page.evaluate((values) => {
    return values.map((query) => {
      const startedAt = performance.now();
      const resultCount = window.__CU_WIKI_SEARCH__.searchContent(query).length;
      return { query, resultCount, milliseconds: performance.now() - startedAt };
    });
  }, queries);
  const sorted = durations.map(({ milliseconds }) => milliseconds).sort((a, b) => a - b);
  const report = {
    documentCount: debug.indexedContentPages,
    p50Ms: sorted[Math.floor(sorted.length * 0.5)],
    p95Ms: sorted[Math.floor(sorted.length * 0.95)],
    maxMs: sorted.at(-1),
    durations,
  };
  if ((report.p95Ms ?? Infinity) > 150) {
    throw new Error(`正文英文键查询 p95 超过 150ms：${JSON.stringify(report)}`);
  }
  return report;
}
