# CU Wiki Search Companion 架构说明

本文面向项目维护者与自动化开发工具。目标是让读者只依赖仓库内的公开材料，就能理解系统边界、数据所有权、启动时序、同步协议和修改时必须保持的不变量。

## 1. 系统目标与核心约束

这是运行在 MediaWiki 编辑页中的站点专用 Tampermonkey userscript。核心目标是：在不阻塞编辑器启动的前提下，维护一份可恢复、可增量更新的本地搜索镜像，并提供五种彼此隔离的搜索体验。

架构优先级依次是：

1. 编辑器可用性：重型功能不能阻塞页面编辑。
2. 事实完整性：页面、revision、删除与移动结果必须可对账。
3. 离线可用：网络失败时保留已有本地搜索能力。
4. 多标签一致性：同一浏览器只允许一个同步写者，其他标签从 IndexedDB 刷新。
5. 派生可重建：索引、摘要和符号表损坏时，不触碰远端游标即可从本地事实恢复。
6. 搜索域隔离：标题、正文、Lua、Data 代码、文件资源不隐式混排。

以下不属于当前系统：服务端组件、编辑提交自动化、云备份、跨浏览器迁移、CSS/JavaScript 正文索引、Data JSON 查看器和轮询式逐页抓取。

## 2. 顶层组件

~~~mermaid
flowchart LR
  MW[MediaWiki 编辑页] --> Entry[src/main.ts]
  Entry --> UI[SearchPanel / Shadow DOM]
  Entry --> API[WikiApi]
  Entry --> DB[(Dexie / IndexedDB)]
  Entry --> Pref[GM Data 字段规则]

  API --> TitleSync[标题基线]
  API --> ContentSync[正文队列]
  API --> RC[RecentChanges]
  API --> Recon[全量对账]
  API --> FileSync[文件同步]
  API --> DataSync[Data REST 同步]

  TitleSync --> DB
  ContentSync --> DB
  RC --> DB
  Recon --> DB
  FileSync --> DB
  DataSync --> DB

  DB --> Cache[VersionedSearchIndexCache]
  Cache --> TitleIndex[TitleIndex]
  Cache --> ContentIndex[ContentIndex]
  Cache --> LuaIndex[LuaModuleIndex]
  DB --> FileIndex[LinearTitleIndex / files]
  DB --> DataIndex[DataCodeIndex]

  TitleIndex --> UI
  ContentIndex --> UI
  LuaIndex --> UI
  FileIndex --> UI
  DataIndex --> UI
~~~

src/main.ts 是组合根。它负责生命周期和依赖装配，不拥有具体的同步或索引协议。复杂协议分别封装在 sync/、search/、storage/ 与 maintenance/ 中。

## 3. 激活条件与启动时序

### 3.1 激活边界

入口只在 wgAction 或 URL action 为 edit / submit 时启动。阅读页不打开数据库、不注入面板，也不做后台同步。

页面 content model 决定主动作：

- wikitext 或未知模型：把 Wiki 链接插入 CodeMirror 5 或 textarea 当前选择处。
- 其他模型：不写编辑器，复制标题到剪贴板。

浏览器自动化只验证搜索与编辑器插入，不得点击页面的保存或提交操作。

### 3.2 冷启动

冷启动刻意只做轻量工作：

~~~mermaid
sequenceDiagram
  participant Page as 编辑页
  participant Main as main.ts
  participant DB as IndexedDB
  participant UI as SearchPanel
  participant BG as 后台协调器

  Page->>Main: userscript 激活
  Main->>DB: open + initializeVersionContract
  DB-->>Main: pages / dataCodes / sync states
  Main->>Main: bootstrap Analyzer
  Main->>Main: LinearTitleIndex + DataCodeIndex
  Main->>UI: ready，标题与 Data 可用
  Main->>BG: 页面 idle 后检查 RC 与 Data freshness
  Note over Main,DB: 不读快照，不加载 WASM，不建正文/Lua/文件索引
~~~

bootstrap analyzer 使用 OpenCC 归一和一个极轻的整串 segmenter。此时标题通过线性 compact substring 查询；Data 代码也可从已缓存记录恢复。

### 3.3 用户打开搜索后的增强启动

SearchPanel.open() 触发 ensureEnhancedSearchStarted()，单例 Promise 防止重复点击产生并发初始化：

1. 从 Tampermonkey resource 获取 jieba glue 与 WASM。
2. glue 以 blob module 动态导入，WASM 直接以字节初始化。
3. 加载失败时退化为 Intl.Segmenter，搜索仍继续。
4. 恢复或本地重建标题快照，并与 bootstrap 线性索引组合，避免 MiniSearch 漏掉直接中缀结果。
5. 完成初始标题同步后，再并行恢复正文与 Lua 快照。
6. 恢复完成后修复或续传正文 jobs；完整缓存不会重复请求 revisions。

标题、正文和 Lua 快照绝不能在面板尚未打开时读取。文件表也只在首次切换到“文件资源”模式时读取。

## 4. 数据所有权：事实与派生

理解本项目最重要的规则是区分“可搜索事实”和“可丢弃派生物”。

| 类别 | 数据 | 所有权与恢复方式 |
| --- | --- | --- |
| 页面事实 | pages 的标题、namespace、revision、content model、正文、删除标记 | 由 Action API 同步与对账维护；不能因索引变化清除 |
| 文件事实 | fileResources | namespace 6 专用；不进入普通页面索引 |
| Data 代码事实缓存 | dataCodes | 由 Data REST 接口与字段规则生成；可单独刷新 |
| 工作事实 | jobs | 正文下载队列；可从 pages 修复 |
| 同步契约 | syncState 中的游标、generation、版本和调度状态 | 与事实事务一起提交；索引升级不得重置 |
| 用户偏好 | Tampermonkey preference 中的 Data 字段规则 | 完整重置默认保留 |
| 派生索引 | 内存中的 MiniSearch / 线性索引 | 可从事实重建 |
| 索引快照 | indexSnapshots | 可删除；校验失败时自动本地重建 |

### 4.1 Dexie schema v3

数据库名为 cu-wiki-local-search，当前 schema 固定为 v3：

| 表 | 主键 | 重要索引 | 用途 |
| --- | --- | --- | --- |
| pages | id | title、namespace、localSeq、isRedirect、deleted | 非文件页面事实及正文 |
| fileResources | id | title、normalizedTitle | 文件命名空间事实 |
| jobs | 自增 id | type、pageId、status | 可恢复的正文同步队列 |
| syncState | key | — | 游标、版本、generation、调度状态 |
| indexSnapshots | key | throughLocalSeq | title/content/lua 固定快照 |
| dataCodes | source | code、chineseName、dataType | Data 代码映射缓存 |

新增普通记录字段不等于修改 IndexedDB schema。只有表、主键或索引布局变化才应提升 Dexie schema 版本。

### 4.2 主要 syncState key

| key | 含义 |
| --- | --- |
| local-sequence | 所有可搜索事实写入共享的单调序列 |
| cache-version-contract | 页面事实、job、analyzer、抽取器、索引及库版本 |
| title-sync | 初始 allpages 基线及 continuation |
| file-resource-sync | namespace 6 独立基线 |
| data-code-sync | Data 缓存时间、规则副本和格式版本 |
| recent-changes-sync | RC through、重叠去重标记和文件变化序列 |
| reconciliation-sync | 周期全量对账状态、generation 和起始栅栏 |
| incremental-sync-schedule | 多标签共享的 lastSuccessAt / nextDueAt |

状态 key 是持久化协议的一部分。重命名或改变结构时必须通过版本契约或显式迁移处理。

## 5. localSeq 变更日志契约

localSeq 是本地派生索引的增量重放依据，不是远端 revision，也不是“每张表连续”的行号。

必须推进全局序列的变化：

- 页面新增、改名、namespace、redirect、revision 或 content model 变化。
- 页面 tombstone。
- 正文首次写入，或正文/content model 的实际可搜索内容变化。
- 文件新增、变化或删除。

不得推进序列的变化：

- job 在 pending、running、done、failed 间变化，但页面事实未变。
- 重复写入完全相同的正文。
- 只更新同步进度而没有事实变化。

页面事实写入、页面自身 localSeq 与 syncState 的 local-sequence 必须在同一个 Dexie 事务提交。事务失败时两者都不能前进。

文件早期版本曾把 PageRecord.localSeq 用作远端 revision，因此文件并发栅栏使用 writerSeq。文件变化仍占用全局序列，但 title/content/lua 重放只查询 pages.localSeq；由文件产生的序列空号是合法状态，不能据此判定快照损坏。

## 6. 同步架构

### 6.1 网络适配器

WikiApi 封装同源 /api.php 查询：

- 自动添加 action=query、format=json、formatversion=2 与 maxlag=5。
- 使用当前页面的 same-origin credentials，不保存或读取凭据。
- HTTP 错误和 MediaWiki maxlag 按指数退避重试。
- 服务器提供 Retry-After 时优先遵守秒数或 HTTP-date。
- 权限错误在上层转换为 login-required，已有本地搜索保持可用。

Data 代码使用站点的 /api/rest_v1/namespace/data，与页面事实流分开。

### 6.2 初始标题基线

syncTitles()：

1. 读取 siteinfo namespace。
2. 排除负 namespace 与文件 namespace 6。
3. 对每个 namespace 使用 generator=allpages + prop=info，500 页一批，完整消费 gapcontinue。
4. 每批在事务中比较旧事实，仅对有效变化分配新序列。
5. 用 generation 标记本轮见过的页面。
6. 全部 namespace 成功后，未被见到的旧页面写为 tombstone，再把状态置为 complete。

失败状态保留 continuation，可从最后提交批次继续。旧响应的 revision 低于本地事实时不得覆盖较新的页面。

### 6.3 正文队列

prepareContentJobs() 从活动、非 redirect 且 content model 为 wikitext、BSON 或 Scribunto 的页面生成 wikitext-content jobs。名称保留是持久化兼容要求，虽然当前范围已不只 wikitext。

syncContent() 每批最多 50 页：

1. pending jobs 先标为 running。
2. 一次 revisions 请求获取 main slot 的 id、content model 与 content。
3. 校验响应 revision 不得落后于页面、已缓存正文或 job 目标版本。
4. 在 pages + jobs + syncState 单事务中写正文并推进 localSeq。
5. 提交后才通知内存索引更新与其他标签刷新。
6. 批次异常时把遗留 running jobs 恢复为 pending，以便重试。

单条页面响应缺失时，该条 job 保持 failed 并显示在维护诊断中；整批请求抛错时，本批 running jobs 会统一恢复为 pending。重建正文队列只修复 jobs，不下载正文。

### 6.4 RecentChanges 增量同步

syncRecentChanges() 需要完整标题基线：

1. 以已提交 through 向前回退 5 分钟建立重叠窗口。
2. 先向服务器取得冻结的结束时间。
3. 完整消费 RC continuation，不排除 bot 或 log 类型。
4. 结合已保留 rcid 标记去重，并按 pageid/title 合并候选。
5. 对候选批量读取 page info；需要时同时读取最新正文。
6. edit、new、log、move、delete 统一转换为当前页面事实或 tombstone。
7. 页面、文件、jobs、Data 失效标记、localSeq 与 RC 游标在同一事务提交。

RC 游标只能随事实提交。不能先推进游标再写页面，否则刷新或失败会永久漏掉变化。

### 6.5 周期全量对账

RC 不是永久完整日志，因此 reconcileWikiMirror() 约每 24 小时、检测到 RC 缺口或用户手动要求时运行：

- 枚举当前全部 namespace 的 pageid + lastrevid + contentmodel。
- 如果文件基线已存在，也对账 namespace 6。
- 记录 startLocalSeq 作为并发栅栏；对账期间被较新写者更新的页面不允许被旧批次覆盖。
- generation 收尾只 tombstone 在本轮未见且未越过栅栏的旧事实。
- 同时修复正文 jobs、文件事实、Data 缓存失效状态。
- 完成时把 RC 基线推进到对账开始的服务器时间，随后立即做一次 RC catch-up。

对账可以从 running/failed 状态的 continuation 续传。派生索引版本变化不得重置 RC 或对账游标。

### 6.6 文件与 Data

文件资源：

- 仅首次进入文件模式时恢复 fileResources 并同步。
- gapnamespace=6、500 页一批，成功完成后清理 stale 项。
- 使用轻量 LinearTitleIndex，无索引快照。
- 不进入普通 pages、标题或正文结果。

Data 代码：

- 默认最多缓存 24 小时，500 条一页，设有 20 页安全上限。
- 字段规则决定 REST projection 和可搜索标量值。
- 缓存兼容性同时检查规则文本与 Data index format。
- 规则保存在 GM preference，data-code-sync 只保存副本用于缓存判断。

## 7. 多标签协调

每个可见标签都可以提出同步请求，但真正写入由两层机制约束：

1. Web Lock cu-wiki-local-search:incremental-sync:v1 提供浏览器级互斥。
2. incremental-sync-schedule 在 IndexedDB 中共享下次到期时间，默认间隔 5 分钟并增加最多 1 分钟 jitter。

标题、正文、Data、文件同步、手动对账与维护重建共用同一写入缝隙。没有 Web Locks 时，周期和显式写入都返回 lock-unavailable，不在当前标签绕过互斥；已有本地镜像仍可只读搜索。

BroadcastChannel cu-wiki-local-search:changes:v1 只做失效通知：

- committed / reconciled / content-committed：可见标签按 localSeq 刷新已加载索引。
- files-committed：文件模式已加载时刷新文件缓存。
- reset：其他标签关闭数据库并 reload，避免旧在途写入在数据库删除后复活。

通知不能替代事务、游标或 Web Lock。隐藏标签只记录“存储已失效”，恢复可见时再读取；通知也绝不能导致冷加载 jieba 或正文、Lua、文件索引。

## 8. 分析器与搜索索引

### 8.1 统一归一化

增强标题、正文和 Lua 索引共用完整 Analyzer：

- Unicode NFKC。
- OpenCC 繁体转简体。
- 小写化与空白压缩。
- jieba 文档/查询分词。
- CJK unigram + bigram，兼顾单字查询与词典外片段。
- 拉丁 run、点/下划线/camelCase 分段与至少 4 字符 run 的 3-gram，支持代码中缀。

jieba 不可用时使用 Intl.Segmenter。实际 analyzer engine 进入三类快照 compatibility key，防止不同分词结果误用旧快照。Data 代码和文件索引始终使用冷启动的 fallbackAnalyzer；它们依赖归一化、compact substring 与轻量线性扫描，不等待 jieba，也不创建快照。

### 8.2 五种搜索后端

| 模式 | 后端 | 输入事实 | 特殊行为 |
| --- | --- | --- | --- |
| 标题 | CombinedTitleIndex | pages | MiniSearch + 线性中缀兜底；支持 namespace |
| 正文 | ContentIndex | pages.content | wikitext/BSON 抽取；保留摘要文本 |
| Lua | LuaModuleIndex | Scribunto content | 结构化符号类型与优先级 |
| Data 代码 | DataCodeIndex | dataCodes | 中文名、代码、配置字段值独立评分 |
| 文件 | LinearTitleIndex | fileResources | 按需、小规模、物理隔离 |

MiniSearch 查询优先 AND，完全无结果时才退化为 OR。标题允许受控 fuzzy；正文/Lua 不启用 MiniSearch fuzzy，避免大型代码词典导致延迟失控。页面类结果以 page id 作为稳定末级排序键，保证序列化恢复前后并列项顺序一致；Data 代码结果没有 page id，按 score 后再按 code 排序。

### 8.3 内容抽取

- wikitext：去除注释、ref、模板/链接标记等高噪结构，保留面向搜索的文本和语言变体。
- BSON：正文内容按 JSON 解析后递归收集对象键和标量值；数组继续递归；不提供每页自定义路径。content model 名称必须是 bson，普通 json 模型不在当前 eligibility 中。
- Scribunto：tokenize 源码并抽取函数定义、返回表键、字符串、require / mw.loadData 依赖。Lua 结果不进入普通正文。

修改抽取器语义必须提升对应 extractor version，并更新快照兼容测试。

## 9. 版本契约

CURRENT_VERSION_CONTRACT 当前包含：

- database schema 3。
- page facts 1、content job format 1。
- analyzer pipeline 2（CJK unigram + bigram）。
- wikitext/BSON/Lua extractor 各 1。
- title/content/Lua index 各 1。
- Data code format 2。
- MiniSearch 7.2.0、jieba 2.4.0。

规则：

- 缺少契约的既有 schema-v3 数据被视为已知 legacy v1，只登记契约，不清库、不联网。
- analyzer、抽取器或索引版本变化只使相关派生快照过期。
- 页面事实或 job 格式较旧只能通过显式本地迁移升级。
- 本地事实版本高于当前代码时，进入只读不兼容模式：保留搜索、诊断和完整重置，停止后台写入。
- RC、对账游标与页面事实不得因为派生版本变化而重置。

## 10. VersionedSearchIndexCache

VersionedSearchIndexCache 是 title/content/lua 三类快照的唯一入口：

- restoreOrRebuild(kind, analyzer)：校验并恢复，失败则本地重建。
- refresh(handle)：重放 handle 序列之后的 pages。
- publish(handle)：生成并原子保存候选。
- schedulePublish(handle)：约 5 秒防抖，三类顺序写入。
- inspect()：返回维护 UI 使用的状态。
- clear()：取消本标签定时器，删除三份快照并抑制本会话自动再发布。

### 10.1 固定 key 与 payload

正常使用最多三份快照：

| key | payload |
| --- | --- |
| search-index:title | MiniSearch JSON |
| search-index:content | MiniSearch JSON + extractedById 摘要源 |
| search-index:lua | MiniSearch JSON + 可序列化 prepared symbols |

同类新快照覆盖旧记录，不保留历史版本。每个 handle 独立维护 throughLocalSeq，不能共享一个“恢复游标”。

### 10.2 恢复协议

快照、当前全局序列和 (snapshotSeq, currentSeq] pages 在同一个只读事务中读取。恢复校验：

- 稳定 key 和 kind。
- snapshot format version。
- 精确 compatibility key。
- throughLocalSeq 是安全整数且不高于当前序列。
- UTF-8 payload 字节数。
- SHA-256。
- JSON 对象结构。
- MiniSearch 文档数与附属 map/symbol 数量。

通过后异步载入 MiniSearch，再按 localSeq 重放新增、修改、正文变化和 tombstone。corrupt 快照会被删除并从当前 pages 全量重建；compatibility key 不匹配的 outdated 快照只会被忽略并本地重建，之后由新兼容版本发布覆盖。两种恢复路径都没有 Wiki API 依赖。

### 10.3 发布协议

发布先冻结候选序列、文档数和 JSON，再检查：

- 单类 payload 不超过 64 MiB。
- 估算剩余配额至少为 payload 的 1.2 倍。
- 写事务中的当前全局序列仍等于候选序列。
- 同 compatibility key 下，已有快照序列不得高于或等于候选。

序列在构建期间变化时拒绝旧候选，刷新 handle 后重新防抖。搜索不依赖发布成功；容量或配额不足只显示提示。

## 11. UI、编辑器与维护

SearchPanel 挂在开放 Shadow DOM 中，隔离站点 CSS。快捷键为 Alt+K；中文 IME composition 期间不触发搜索，普通输入 120ms 防抖。

结果主动作按类型区分：

- 页面标题与文件：插入以查询词为显示文本的 Wiki 链接。
- 页面正文：插入以页面标题为显示文本的 Wiki 链接，通常简化为普通页面链接。
- Lua：打开对应模块页，行内显示命中符号类型。
- Data：复制代码名，另可打开来源页。
- 文件：作为页面链接插入、复制或打开。

“重新同步本地数据”按顺序执行联网全量对账、Data 刷新与正文/Lua 队列续传；它不清空本地镜像，也不修改 Wiki 页面。文件按钮只处理文件命名空间。

维护入口按需读取：事实计数、jobs 状态、RC/对账状态、版本契约、快照状态、大小、序列、耗时、IndexedDB usage/quota 和持久化状态。

| 操作 | 网络 | 删除事实 | 说明 |
| --- | --- | --- | --- |
| 重建搜索索引 | 否 | 否 | 从 pages 重建三类索引并发布快照 |
| 重建正文队列 | 否 | 否 | 只调用 prepareContentJobs(false) |
| 立即全量对账 | 是 | 否 | 复用 reconciliation + RC catch-up |
| 清除索引快照 | 否 | 否 | 内存索引继续可用，本会话不自动重建 |
| 申请持久保存 | 否 | 否 | 用户点击栈内调用 Storage API，拒绝不影响功能 |
| 清空本地镜像 | 下次使用时需要 | 是 | 行内二次确认；默认保留 Data 规则 |

完整重置先广播 reset，再关闭并删除整个专用 IndexedDB，最后 reload。不得用原生阻断式 confirm()；不得在真实用户数据库上做常规自动化重置验收。

## 12. 故障语义

系统遵循“旧数据优先于空白失败”：

- 网络或登录失败：显示错误，保留现有索引和本地事实。
- jieba 失败：降级 Intl.Segmenter。
- 快照损坏：删除单类快照并本地重建；版本过旧：忽略旧记录并本地重建，待发布时覆盖；两者都不联网。
- 正文批次失败：running jobs 回 pending；已提交批次保留。
- 对账后 catch-up 失败：对账事实不回滚，RC 稍后重试。
- Storage API 不支持、拒绝或抛错：只显示行内提示。
- 未来事实版本：停止所有后台写入，不自动降级或清库。

恢复或验收脚本若临时修改 IndexedDB，必须在 try/finally 中撤销 route 和测试标记；只有确认 revision/localSeq 未被真实同步推进时才能恢复旧备份。

## 13. 测试策略

自动化分层：

- 纯逻辑：Analyzer、抽取器、编辑器格式、Data 规则。
- fake-indexeddb：同步事务、游标、快照、跨实例旧候选保护、完整重置。
- jsdom：SearchPanel 路由、提示、维护入口、行内二次确认和 preference 语义。
- Playwright 辅助脚本：真实 userscript 安装、冷启动、快照签名、维护 UI、对账与故障恢复。

修改后的最低验证：

    npm test
    npm run build
    git diff --check

涉及真实浏览器脚本时，还应做 JavaScript 语法检查和 shell bash -n。只有改动对应网络或数据库协议时才重跑会修改真实缓存的专用验收；普通开发优先使用 fake-indexeddb/jsdom。

关键回归必须覆盖：

- facts + localSeq + cursor 的原子性。
- RC continuation、重叠与 rcid 去重。
- 对账栅栏不会覆盖更新事实。
- snapshot 恢复与全量重建结果完全一致。
- 空序列号不会触发损坏回退。
- 旧标签不能以较低序列覆盖较新快照。
- 冷启动不读重型派生数据。
- 搜索域之间没有结果泄漏。

## 14. 修改导航

| 需求 | 首要修改点 | 必须联动检查 |
| --- | --- | --- |
| 调整分词或归一 | analyzer/ | compatibility key、三类索引测试、快照失效 |
| 调整正文语义 | content/extract-* | extractor version、content/lua 快照、摘要/符号测试 |
| 调整搜索排序 | 对应 search/*-index.ts | 重建/恢复签名一致、page id 稳定排序 |
| 新页面事实字段 | types.ts 与 sync 写入点 | pageChanged、localSeq、对账、RC、快照重放 |
| 改正文 eligibility | content sync、RC、reconciliation | jobs 修复、ContentIndex/LuaIndex 隔离 |
| 改持久化结构 | storage/database.ts | Dexie schema 与显式迁移 |
| 改版本语义 | version-contract.ts | legacy/future 测试、游标保留 |
| 改维护操作 | local-data-maintenance.ts | SearchPanel 文案、离线或删除边界、reset 广播 |
| 新 UI 模式 | SearchPanel + main callbacks | 搜索域隔离、冷启动、键盘/IME |
| 新同步入口 | 独立 sync 深模块 | Web Lock、事务游标、重试、BroadcastChannel |

不要把新协议直接堆进 main.ts。优先建立可独立测试的深模块，让组合根只负责生命周期和 UI 状态。

## 15. 当前边界与未来候选

现有快照恢复已显著快于本地全量重建，没有引入 Worker 的性能依据。下一步应由真实使用痛点驱动，可独立考虑：

- 拼音与首字母标题召回。
- 领域词典管理。
- 多标签同步进度展示。
- 模板专用插入/复制动作。
- 独立 Data JSON 查看器。

以下仍不是默认路线：Data/文件快照、CSS/JavaScript 正文、更多轮询器、索引导入导出、云备份和跨浏览器同步。若重新立项，先定义隐私、格式版本、容量、冲突和迁移协议，再实现 UI。

## 16. 维护检查清单

维护者或自动化开发工具开始修改前应确认：

1. 当前需求属于事实层、同步层、派生层、UI 层中的哪一层。
2. 是否会改变可搜索页面事实；若会，localSeq 是否与事实原子提交。
3. 是否影响版本契约或某一类快照 compatibility key。
4. 是否会让编辑页冷启动加载 jieba、快照、正文、Lua 或文件；默认答案必须是否。
5. 是否新增网络请求；错误、登录失效、重试、普通账号上限和 continuation 是否定义。
6. 是否破坏五种搜索域的物理隔离。
7. 多标签是否仍只有一个写者，其他标签是否只刷新已加载索引。
8. 失败后旧本地数据是否仍可搜索。
9. 是否可以用 fake-indexeddb/jsdom 完成验证，避免破坏真实用户缓存。
10. 自动化测试、类型检查、构建和 diff 检查是否全部通过。

只要这些不变量保持成立，模块可以独立演进，而不会把本地镜像、同步游标与搜索派生重新耦合在一起。
