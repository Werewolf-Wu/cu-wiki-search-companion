# CU Wiki Search Companion

一个面向[未知伤亡中文维基](https://casualtiesunknown.huijiwiki.com/)编辑页的本地优先 Tampermonkey 搜索工具。它把可搜索的页面事实保存在浏览器 IndexedDB 中，在用户需要时建立标题、正文和 Lua 索引，并把选中的页面链接插入编辑器或复制到剪贴板。

项目是站点专用 userscript，不是通用 MediaWiki 搜索服务。它只在目标站点的 edit / submit 页面激活，所有同步请求都从当前页面发往同源 API，不包含账号凭据，也不会代替用户保存或提交 Wiki 编辑。

## 功能

- 页面标题：中文、英文片段、前缀和命名空间筛选。
- 页面正文：检索 wikitext 与 BSON（内容格式为 JSON）的可见文本、键和值，并返回摘要。
- Lua 模块：独立检索函数名、返回表键、字符串和依赖目标，不混入普通正文结果。
- Data 代码：按可配置字段从结构化 Data 文档查找顶层代码名。
- 文件资源：文件命名空间使用独立缓存和按需线性索引，不污染普通页面结果。
- 编辑器操作：支持 CodeMirror 5 与普通 textarea；非 wikitext 页面退化为复制标题。
- 离线优先：本地镜像可在网络失败或登录失效时继续搜索。
- 本地维护：诊断、索引重建、正文队列修复、全量对账、快照清理、持久存储申请和完整重置。

## 运行模型

脚本刻意把轻量冷启动与增强搜索分开：

1. 编辑页加载时只打开 IndexedDB，恢复页面标题和 Data 代码，建立轻量线性标题索引。
2. 用户打开搜索面板后才加载 jieba-wasm，恢复或重建 MiniSearch 索引。
3. 标题、正文和 Lua 各自拥有一份版本化快照；Data 与文件索引足够小，不做快照。
4. 页面事实变化以全局 localSeq 排序，已加载索引只重放自己尚未应用的页面变化。
5. 多标签通过 Web Locks 协调唯一写者，通过 BroadcastChannel 通知其他标签刷新本地内存索引。

完整的数据模型、同步状态机、快照协议与扩展约束见 [ARCHITECTURE.md](ARCHITECTURE.md)。

## 构建与测试

要求 Node.js ^20.19.0 或 >=22.12.0，以及 npm。

    npm ci
    npm test
    npm run build

构建产物位于 dist/：

- cu-wiki-local-search.user.js：可安装 userscript。
- cu-wiki-local-search.meta.js：更新元数据。
- THIRD_PARTY_NOTICES.md：打包依赖的许可证清单。

dist/ 是可重建产物，不进入 Git。安装时可在 Tampermonkey 中打开构建后的 .user.js 文件，或使用仓库中的本地安装辅助脚本。

## Nightly 构建

GitHub Actions 在每次 push 后执行测试、类型检查和生产构建，并上传带提交号的短期 artifact。main 验证成功后还会更新唯一的滚动 nightly prerelease：同名 tag 与 assets 始终指向最新通过验证的提交，不会为每次 push 新建一条 Release。

Nightly 是自动化开发构建，不代表稳定版本。Release 附带 SHA-256 校验和；正式版本仍应使用独立版本号与人工发布说明。

## 已验证状态

当前 P1–P4 功能已完成：标题、Data 代码、文件、正文、Lua、增量同步、周期全量对账、版本契约、索引快照与本地维护均已接入。

最近一次发布前验证基线：

- 17 个测试文件、81 项自动化测试通过。
- TypeScript 严格检查和 Vite 生产构建通过。
- 三类快照连续恢复的查询结果与本地全量重建一致，完整正文缓存不会重复请求 revisions。
- 在一次真实浏览器样本中，正文与 Lua 快照恢复阶段中位约 2.7 秒；清除快照后的纯本地重建约 11.3 秒。该数字只用于回归趋势，不是跨设备性能承诺。
- 冷启动等待 15 秒仍保持轻量模式，不读取快照、不加载 jieba，也不建立正文、Lua 或文件索引。

尚未完成的权限类验证是普通账号的完整端到端回归。实现始终使用普通用户安全上限设计，已有本地与浏览器测试不能替代不同账号权限下的最终验证。

## 隐私与安全边界

- 仓库不包含真实浏览器 profile、Cookie、token、运行时账号或 bot ID，也不包含原始 Wiki 用户页抓取；署名中的 GitHub 作者身份是明确保留的项目归属信息。
- userscript 不收集遥测，不上传本地镜像，不实现导入、导出、云备份或跨浏览器迁移。
- 页面、正文、文件、同步游标和索引快照存储在站点源下的专用 IndexedDB。
- Data 字段规则存储在 Tampermonkey preference；完整重置默认保留规则，只有显式勾选才删除。
- “重新同步本地数据”和“立即全量对账”会联网读取 Wiki；索引重建、队列修复和清除快照只操作本地数据。
- 完整重置只删除浏览器内的本地镜像，不修改 Wiki 页面。

## 项目结构

    src/
      analyzer/      中文归一、jieba 加载与降级分词
      content/       wikitext、BSON（JSON 内容）、Lua 抽取器
      data/          Data 字段规则解析与值提取
      maintenance/   本地诊断、重建、持久化与重置
      search/        五类搜索后端与三类版本化快照
      storage/       Dexie schema、版本契约与 GM preference
      sync/          API、初始同步、正文队列、RC、对账与多标签协调
      ui/            Shadow DOM 搜索面板
    tests/           fake-indexeddb/jsdom/纯逻辑测试
    scripts/         可选的真实浏览器安装、检查与验收工具
    .github/         push 构建与滚动 nightly 工作流

## 明确不做

- CSS/JavaScript 源码正文搜索。
- 把 Lua、文件或 Data 结果混入普通标题/正文排序。
- 编辑页冷启动时预加载 jieba 或重型索引。
- 服务端搜索、Node 常驻服务或逐页轮询。
- 没有实际性能证据时引入 Worker 或替换 MiniSearch。
- 默认实现本地数据导出、云同步或跨浏览器迁移。

未来功能应从真实用例出发，优先考虑拼音/首字母、领域词典、模板插入或更完整的多标签进度体验。任何新同步路径都必须保持“远端事实、本地派生、事务游标、可离线重建”的边界。

## License

本项目采用 [Mozilla Public License 2.0](LICENSE)。MPL-2.0 是文件级弱 copyleft：若分发对本项目受 MPL 覆盖文件的修改版，需要按 MPL 提供这些文件的源码；它仍允许本项目与其他许可证或闭源文件组成更大的作品。构建产物同时标注本仓库作为对应源码地址，并随 nightly 提供许可证及第三方依赖许可清单。
