// SPDX-License-Identifier: MPL-2.0
async page => {
  const result = await page.evaluate(async () => {
    const api = async (params) => {
      const query = new URLSearchParams({
        action: 'query',
        format: 'json',
        formatversion: '2',
        maxlag: '5',
        ...params,
      });
      const response = await fetch(`/api.php?${query}`);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    };

    const listedPages = [];
    let apcontinue;
    do {
      const listed = await api({
        list: 'allpages',
        apnamespace: '828',
        aplimit: '500',
        approp: 'ids|title',
        ...(apcontinue ? { apcontinue } : {}),
      });
      listedPages.push(...(listed.query?.allpages ?? []));
      apcontinue = listed.continue?.apcontinue;
    } while (apcontinue);
    const rows = [];

    for (let offset = 0; offset < listedPages.length; offset += 50) {
      const pageids = listedPages
        .slice(offset, offset + 50)
        .map((item) => item.pageid)
        .join('|');
      const data = await api({
        prop: 'revisions',
        pageids,
        rvprop: 'ids|content',
        rvslots: 'main',
      });
      for (const item of data.query?.pages ?? []) {
        const revision = item.revisions?.[0];
        const slot = revision?.slots?.main;
        rows.push({
          id: item.pageid,
          title: item.title,
          revisionId: revision?.revid,
          model: slot?.contentmodel,
          source: slot?.content ?? '',
        });
      }
      await new Promise((resolve) => setTimeout(resolve, 150));
    }

    const luaRows = rows.filter((row) => row.model === 'Scribunto');
    const pagesMatching = (pattern) =>
      luaRows.filter((row) => pattern.test(row.source)).length;
    const functionDeclarations = [];
    const assignedFunctions = [];
    const dependencies = [];
    const returnedIdentifiers = [];
    const literalKeySamples = [];
    for (const row of luaRows) {
      for (const match of row.source.matchAll(
        /(?:^|\n)\s*(?:local\s+)?function\s+([A-Za-z_][\w.:]*)\s*\(/g,
      )) {
        functionDeclarations.push({ title: row.title, name: match[1] });
      }
      for (const match of row.source.matchAll(
        /(?:^|\n)\s*([A-Za-z_][\w.:]*)\s*=\s*function\s*\(/g,
      )) {
        assignedFunctions.push({ title: row.title, name: match[1] });
      }
      for (const match of row.source.matchAll(
        /\b(require|mw\.loadData|mw\.loadJsonData)\s*\(\s*(['"])(.*?)\2\s*\)/g,
      )) {
        dependencies.push({ title: row.title, call: match[1], target: match[3] });
      }
      for (const match of row.source.matchAll(/\breturn\s+([A-Za-z_][\w.]*)/g)) {
        returnedIdentifiers.push({ title: row.title, name: match[1] });
      }
      for (const match of row.source.matchAll(
        /(?:^|[,{;]\s*)([A-Za-z_][\w]*)\s*=/g,
      )) {
        if (literalKeySamples.length < 80) {
          literalKeySamples.push({ title: row.title, key: match[1] });
        }
      }
    }

    return {
      enumerated: listedPages.length,
      fetched: rows.length,
      unique: new Set(rows.map((row) => row.id)).size,
      batches: Math.ceil(listedPages.length / 50),
      models: Object.fromEntries(
        [...new Set(rows.map((row) => row.model))].map((model) => [
          model,
          rows.filter((row) => row.model === model).length,
        ]),
      ),
      totalChars: rows.reduce((total, row) => total + row.source.length, 0),
      luaChars: luaRows.reduce((total, row) => total + row.source.length, 0),
      empty: rows.filter((row) => !row.source.trim()).length,
      largest: [...luaRows]
        .sort((left, right) => right.source.length - left.source.length)
        .slice(0, 15)
        .map((row) => ({
          title: row.title,
          chars: row.source.length,
          lines: row.source.split('\n').length,
        })),
      syntaxPages: {
        functionDeclaration: pagesMatching(
          /(?:^|\n)\s*(?:local\s+)?function\s+[A-Za-z_]/,
        ),
        assignedFunction: pagesMatching(
          /(?:^|\n)\s*[A-Za-z_][\w.:]*\s*=\s*function\s*\(/,
        ),
        returnLiteral: pagesMatching(/\breturn\s*\{/),
        returnIdentifier: pagesMatching(/\breturn\s+[A-Za-z_][\w.]*/),
        require: pagesMatching(/\brequire\s*\(/),
        loadData: pagesMatching(/\bmw\.loadData\s*\(/),
        loadJsonData: pagesMatching(/\bmw\.loadJsonData\s*\(/),
        longBracketString: pagesMatching(/\[(=*)\[/),
        chinese: pagesMatching(/[\u3400-\u9fff]/),
      },
      functionDeclarationCount: functionDeclarations.length,
      assignedFunctionCount: assignedFunctions.length,
      dependencyCount: dependencies.length,
      functionSamples: functionDeclarations.slice(0, 60),
      assignedSamples: assignedFunctions.slice(0, 40),
      dependencySamples: dependencies.slice(0, 80),
      returnedIdentifierSamples: returnedIdentifiers.slice(0, 60),
      literalKeySamples,
      titleSamples: luaRows.slice(0, 40).map((row) => row.title),
      aboutTitles: rows
        .filter((row) => /about/i.test(row.title))
        .map((row) => ({ title: row.title, model: row.model })),
    };
  });

  return result;
}
