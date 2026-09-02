// SPDX-License-Identifier: MPL-2.0
import { cut, cut_for_search } from 'jieba-wasm/node';

import { Analyzer } from '../src/analyzer/analyzer';
import { ContentIndex } from '../src/search/content-index';
import { LuaModuleIndex } from '../src/search/lua-module-index';
import { TitleIndex } from '../src/search/title-index';
import type { PageRecord } from '../src/types';

const analyzer = new Analyzer({ cut, cutForSearch: cut_for_search });

interface LifecycleIndex {
  readonly size: number;
  rebuild(pages: PageRecord[]): void;
  rebuildAsync(pages: PageRecord[], batchSize?: number): Promise<void>;
  update(pages: PageRecord[]): void;
  exportSnapshot(): unknown;
  importSnapshot(payload: unknown): Promise<void>;
}

interface LifecycleScenario {
  create(): LifecycleIndex;
  initial: PageRecord[];
  updates: PageRecord[];
  signature(index: LifecycleIndex): unknown;
}

interface GenerationScenario {
  name: string;
  create(scheduler: { yield(): Promise<void> }): LifecycleIndex;
  older: PageRecord[];
  newer: PageRecord[];
  signature(index: LifecycleIndex): unknown;
}

describe('search index rebuild lifecycle', () => {
  it.each([
    titleScenario(),
    contentScenario(),
    luaScenario(),
  ])(
    'keeps $name result signatures identical across rebuild, restore, concurrent update, and tombstone paths',
    async ({ scenario, expected, tombstonedId }) => {
      const signatures = await lifecycleSignatures(scenario);

      for (const signature of signatures) expect(signature).toEqual(signatures[0]);
      expect(signatures[0]).toMatchObject(expected);
      expect((signatures[0] as { removedIds: number[] }).removedIds).not.toContain(
        tombstonedId,
      );
    },
  );

  it.each([
    {
      name: 'title',
      create: (scheduler: { yield(): Promise<void> }) =>
        new TitleIndex(analyzer, scheduler),
      older: [page(1, 'ancientomega')],
      newer: [page(1, 'freshsigma')],
      signature: (index: LifecycleIndex) => ({
        current: (index as TitleIndex).search('freshsigma').map(({ id }) => id),
        obsolete: (index as TitleIndex).search('ancientomega').map(({ id }) => id),
      }),
    },
    {
      name: 'content',
      create: (scheduler: { yield(): Promise<void> }) =>
        new ContentIndex(analyzer, scheduler),
      older: [page(1, '正文', 'ancientomega')],
      newer: [page(1, '正文', 'freshsigma')],
      signature: (index: LifecycleIndex) => ({
        current: (index as ContentIndex).search('freshsigma').map(({ id }) => id),
        obsolete: (index as ContentIndex).search('ancientomega').map(({ id }) => id),
      }),
    },
    {
      name: 'lua',
      create: (scheduler: { yield(): Promise<void> }) =>
        new LuaModuleIndex(analyzer, scheduler),
      older: [page(1, '模块:一', "return { label = 'ancientomega' }", 'Scribunto')],
      newer: [page(1, '模块:一', "return { label = 'freshsigma' }", 'Scribunto')],
      signature: (index: LifecycleIndex) => ({
        current: (index as LuaModuleIndex).search('freshsigma').map(({ id }) => id),
        obsolete: (index as LuaModuleIndex).search('ancientomega').map(({ id }) => id),
      }),
    },
  ] satisfies GenerationScenario[])(
    'does not let an older $name generation replace a newer rebuild',
    async (scenario) => {
      let releaseOlder!: () => void;
      const olderBlocked = new Promise<void>((resolve) => {
        releaseOlder = resolve;
      });
      let yields = 0;
      const index = scenario.create({
        yield: async () => {
          yields += 1;
          if (yields === 1) await olderBlocked;
        },
      });

      const older = index.rebuildAsync(scenario.older, 1);
      const newer = index.rebuildAsync(scenario.newer, 1);
      await newer;
      releaseOlder();
      await older;

      expect(scenario.signature(index)).toEqual({ current: [1], obsolete: [] });
    },
  );
});

async function lifecycleSignatures(scenario: LifecycleScenario): Promise<unknown[]> {
  const finalPages = mergePages(scenario.initial, scenario.updates);

  const synchronous = scenario.create();
  synchronous.rebuild(finalPages);

  const asynchronous = scenario.create();
  await asynchronous.rebuildAsync(finalPages, 1);

  const updatingDuringRebuild = scenario.create();
  updatingDuringRebuild.rebuild(scenario.initial);
  const rebuilding = updatingDuringRebuild.rebuildAsync(scenario.initial, 1);
  updatingDuringRebuild.update(scenario.updates);
  await rebuilding;

  const snapshotSource = scenario.create();
  snapshotSource.rebuild(finalPages);
  const restored = scenario.create();
  await restored.importSnapshot(snapshotSource.exportSnapshot());

  const updatingDuringRestore = scenario.create();
  const initialSnapshot = scenario.create();
  initialSnapshot.rebuild(scenario.initial);
  const restoring = updatingDuringRestore.importSnapshot(initialSnapshot.exportSnapshot());
  updatingDuringRestore.update(scenario.updates);
  await restoring;

  const incrementallyTombstoned = scenario.create();
  incrementallyTombstoned.rebuild(scenario.initial);
  incrementallyTombstoned.update(scenario.updates);

  return [
    synchronous,
    asynchronous,
    updatingDuringRebuild,
    restored,
    updatingDuringRestore,
    incrementallyTombstoned,
  ].map(scenario.signature);
}

function titleScenario() {
  const scenario: LifecycleScenario = {
    create: () => new TitleIndex(analyzer),
    initial: [page(1, '旧标题标记'), page(2, '待删除标题标记')],
    updates: [page(1, '最终标题标记'), tombstone(page(2, '待删除标题标记'))],
    signature: (index) => ({
      size: index.size,
      current: (index as TitleIndex).search('最终标题'),
      removedIds: (index as TitleIndex).search('待删除标题').map(({ id }) => id),
    }),
  };
  return {
    name: 'title',
    scenario,
    expected: { size: 1, current: [{ id: 1, title: '最终标题标记' }] },
    tombstonedId: 2,
  };
}

function contentScenario() {
  const scenario: LifecycleScenario = {
    create: () => new ContentIndex(analyzer),
    initial: [
      page(1, '正文一', '旧正文标记'),
      page(2, '正文二', '待删除正文标记'),
    ],
    updates: [
      page(1, '正文一', '最终正文标记'),
      tombstone(page(2, '正文二', '待删除正文标记')),
    ],
    signature: (index) => ({
      size: index.size,
      current: (index as ContentIndex).search('最终正文'),
      removedIds: (index as ContentIndex).search('待删除正文').map(({ id }) => id),
    }),
  };
  return {
    name: 'content',
    scenario,
    expected: { size: 1, current: [{ id: 1, snippet: '最终正文标记' }] },
    tombstonedId: 2,
  };
}

function luaScenario() {
  const scenario: LifecycleScenario = {
    create: () => new LuaModuleIndex(analyzer),
    initial: [
      page(1, '模块:一', "return { label = '旧符号标记' }", 'Scribunto'),
      page(2, '模块:二', "return { label = '待删除符号标记' }", 'Scribunto'),
    ],
    updates: [
      page(1, '模块:一', "return { label = '最终符号标记' }", 'Scribunto'),
      tombstone(
        page(2, '模块:二', "return { label = '待删除符号标记' }", 'Scribunto'),
      ),
    ],
    signature: (index) => ({
      size: index.size,
      current: (index as LuaModuleIndex).search('最终符号'),
      removedIds: (index as LuaModuleIndex).search('待删除符号').map(({ id }) => id),
    }),
  };
  return {
    name: 'lua',
    scenario,
    expected: { size: 1, current: [{ id: 1 }] },
    tombstonedId: 2,
  };
}

function mergePages(initial: PageRecord[], updates: PageRecord[]): PageRecord[] {
  const pages = new Map(initial.map((page) => [page.id, page]));
  for (const update of updates) pages.set(update.id, update);
  return [...pages.values()];
}

function tombstone(value: PageRecord): PageRecord {
  return { ...value, deleted: true };
}

function page(
  id: number,
  title: string,
  content?: string,
  contentModel = 'wikitext',
): PageRecord {
  return {
    id,
    title,
    normalizedTitle: analyzer.normalize(title),
    namespace: contentModel === 'Scribunto' ? 828 : 0,
    namespaceName: contentModel === 'Scribunto' ? '模块' : '（主）',
    isRedirect: false,
    localSeq: id,
    seenInTitleSync: 1,
    content,
    contentModel,
  };
}
