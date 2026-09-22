# 开发与模块契约

`main` 保存通过验证的可交付版本，`dev` 集成下一版本；`feat/*` 从 `dev` 创建，完成后通过无快进合并保留边界。每个并行实现使用独立工作区，不共享待提交文件。仓库当前仅在本机，不发布远程仓库。

接口先于实现：`src/*/types.ts` 是模块之间的契约。纯领域模块不依赖 Obsidian、DOM 或磁盘；宿主通过 port 注入。模型客户端只返回选择，不获得文件写入能力。UI 只能确认已展示的移动或插入计划。

## 接口实现约定

- `folders/catalog.ts` 导出 `MemoryFolderCatalog implements FolderCatalog`，无参构造。
- `storage/state-store.ts` 导出 `PluginStateStore implements StateStore`，构造参数 `PersistencePort`，可选 `now: () => Date` 用于本机日历预算。
- `filing/inbox-queue.ts` 导出 `StableInboxQueue implements InboxQueue`，构造参数 `InboxQueueDependencies`。
- `filing/move-service.ts` 导出 `ConfirmedMoveService implements MoveService`，构造参数 `MoveHost, MoveJournal`。
- `jev/client.ts` 导出 `JevClient implements DecisionClient`，构造参数 `HttpTransport, SecretProvider`。
- `jev/response-parser.ts` 导出 `parseChoiceResponse(value: unknown, batch: ChoiceBatch): ChoiceBatchResult`。
- `jev/scheduler.ts` 导出 `SharedDecisionScheduler implements DecisionScheduler`，构造参数 `DecisionClient, UsageStore, () => number`（当前每日上限），可选 `SchedulerOptions`。
- `filing/classifier.ts` 导出 `MixedDepthClassifier implements FolderClassifier`，构造参数 `DecisionScheduler`。
- `linking/recommender.ts` 导出 `JevLinkRecommender implements LinkRecommender`，构造参数 `DecisionScheduler`，内存缓存有界。
- `linking/metadata-index.ts` 导出 `MemoryMetadataIndex implements MetadataIndex`，无参构造，压缩前缀树可独立成领域内文件。
- `linking/mention-matcher.ts` 导出 `LocalMentionMatcher implements MentionMatcher`，构造参数 `MetadataIndex`。
- `linking/link-service.ts` 导出 `ConfirmedLinkService implements LinkService`，构造参数 `MetadataIndex, LinkHost`。

`RequestScope.isCurrent` 贯穿排队、批次、响应；逻辑超时不释放实际网络名额。任何源文件、目标、配置或编辑版本变化使旧计划失效。所有持久化更新串行，先持久化移动意图再移动；意图保存失败时禁止修改文件。

## 验证

Node 22.12+；使用 npm 11 验证 `npx --yes npm@11 ci --ignore-scripts`，再执行 `npm run check`。单元测试验证范围、匹配、候选校验和状态转换；集成测试使用内存 vault、延迟 HTTP 和编辑器替身验证完整确认、撤销、竞争与失败流程。真实 Obsidian 的链接更新、CM6 节点与撤销行为另用专用测试 vault 核对，不能把替身测试描述为真实宿主验证。

构建输出为根目录 `main.js`、`manifest.json`、`styles.css`。不提交凭据、用户笔记或 node_modules。

## UI 参考与当前取舍

- [QuickAdd](https://quickadd.obsidian.guide/docs/)：配置后通过命令快速执行。采用原生命令面板，不抢占用户热键，也不另造导航体系。
- [Templater 设置](https://silentvoid13.github.io/Templater/settings.html)：按能力和范围配置。常用开关直接可见，排除、目录用途和用量折叠；算法参数保留为工程常量。
- [Obsidian 设置指南](https://docs.obsidian.md/Plugins/User%20interface/Settings)：采用原生 Setting 与主题变量。当前最低版本使用命令式 display，不使用新版专属声明式 API。
- [原生反向链接](https://help.obsidian.md/plugins/backlinks)：只插入当前笔记的内部链接，反向关系交给宿主，不改写目标笔记。

面板只展示一个目标；更改时再打开选择器。确认卡片保持高度，背景结果不抢焦点、不切换当前笔记／收件箱模式；未确定位置的笔记放在建议之后的折叠组。浏览器验证使用生产 ReviewPanel 和模拟控制器；真实宿主仍见验证清单。

## 开发命令和交付

- `npm run check`：类型、Lint、领域测试、编辑器／UI／端口集成、生产构建。
- `npm run package`：构建后复制三个安装文件到 `dist/note-organizer/`。
- `node --expose-gc benchmarks/metadata-index.mjs`：20,000 篇、每篇两个词条的实际索引；末尾传 `2` 改为每篇三个词条。

自动化测试中 Obsidian 模块映射到测试端口；生产 esbuild 不使用该映射。真实 CM6 与标准 Markdown 解析器参与测试，但不能替代 Obsidian 私有语法和宿主撤销测试。精确依赖版本保存在锁文件。

真实 API 冒烟脚本为 `node scripts/jev-smoke.mjs`，从标准输入接收密钥，只发送固定合成案例。该脚本不会随 `npm test` 或 CI 自动联网，也不会持久化密钥。
