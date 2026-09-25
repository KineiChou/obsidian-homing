# 开发与模块契约

`main` 保存通过验证的可交付版本，`dev` 集成下一版本；`feat/*` 从 `dev` 创建，完成后通过无快进合并保留边界。每个并行实现使用独立工作区，不共享待提交文件。提交与发布以当前任务授权和仓库规则为准。

接口先于实现：`src/*/types.ts` 是模块之间的契约。纯领域模块不依赖 Obsidian、DOM 或磁盘；宿主通过 port 注入。模型客户端只返回选择，不获得文件写入能力。UI 只能确认已展示的移动或插入计划。

## 接口实现约定

- `folders/catalog.ts` 导出 `MemoryFolderCatalog implements FolderCatalog`，无参构造。
- `storage/state-store.ts` 导出 `PluginStateStore implements StateStore`，构造参数 `PersistencePort`，可选 `now: () => Date` 用于本机日历预算。
- `filing/inbox-queue.ts` 导出 `StableInboxQueue implements InboxQueue`，构造参数 `InboxQueueDependencies`。
- `filing/move-service.ts` 导出 `ConfirmedMoveService implements MoveService`，构造参数 `MoveHost, MoveJournal`。
- `jev/client.ts` 导出 `JevClient implements DecisionClient`，构造参数 `HttpTransport, SecretProvider`。
- `jev/response-parser.ts` 导出 `parseChoiceResponse(value: unknown, batch: ChoiceBatch): ChoiceBatchResult`。
- `jev/scheduler.ts` 导出 `SharedDecisionScheduler implements DecisionScheduler`，构造参数 `DecisionClient, UsageStore, () => number`（当前每日上限），可选 `SchedulerOptions`。
- `filing/classifier.ts` 导出 `MixedDepthClassifier implements FolderClassifier`，构造参数 `DecisionScheduler`，可选配置 getter 返回 `longNoteStrategy` 与 `profiles`。
- `filing/note-excerpt.ts` 的 `prepareNote(note, strategy)` 返回 `{ note, excerpt? }`；源指纹始终对应完整原文。
- `folders/profiles.ts` 的 `MemoryFolderProfiles` 仅保存内存元数据，提供 `upsert/remove/clear/enrich/prefilter`；默认不将画像附入请求。
- `providers/client.ts` 的 `createDecisionClient(transport, secrets, settingsGetter)` 返回统一 `DecisionClient`，按 `provider/endpoint` 路由 Jev、OpenRouter、OpenAI-compatible、Anthropic 或显式 Ollama。OpenRouter 和 Ollama 使用按问题 ID 和候选生成的 JSON Schema；OpenRouter 还要求 `provider.require_parameters`，并识别 HTTP 200 内的服务错误。所有排名提供方仍由同一严格解析器检查完整、唯一的候选 ID 及首位一致性。
- `linking/recommender.ts` 导出 `JevLinkRecommender implements LinkRecommender`，构造参数 `DecisionScheduler`，内存缓存有界。
- `linking/metadata-index.ts` 导出 `MemoryMetadataIndex implements MetadataIndex`，无参构造，压缩前缀树可独立成领域内文件。
- `linking/mention-matcher.ts` 导出 `LocalMentionMatcher implements MentionMatcher`，构造参数 `MetadataIndex`。
- `linking/link-service.ts` 导出 `ConfirmedLinkService implements LinkService`，构造参数 `MetadataIndex, LinkHost`。

`RequestScope.isCurrent` 贯穿排队、批次、响应；逻辑超时不释放实际网络名额。确认计划严格校验源内容、目标和相关版本；已经得到的归档建议则可以在无关目录变化后保留并映射到新目录版本。归档与补链配置版本分开；额度、自动链接开关等无关设置不清空归档结果，仅排除路径变化重建元数据索引。

`InboxQueue.analyze(path, contentSource)` 将读取来源与调度优先级分开：打开笔记使用 `saved`，避免宿主已更新文件身份但编辑器仍保留上篇正文；手动分析默认 `editor`，保留未保存内容。请求入队即为 `analyzing`，包含等待网络名额的时间。切换进入时分析尚无队列项或处于 `waiting`、`failed`、`unassigned` 的笔记；`ready`、进行中及被忽略／移动中的项不重排。按活动路径变化识别一次进入，重复的同文件 `file-open` 事件不重试；`null` 表示离开文件，启动时恢复的活动笔记不触发分析。

## 持久化与恢复

`PersistedState.schemaVersion` 为 2，兼容读取 1；新增设置使用默认值，未知 schema 或损坏核心配置禁止写回。单条损坏建议降级为等待，加载过程不覆盖原文件。队列持久化只保存路径、忽略状态和可选最小建议：完整原文 SHA-256、目标路径或 null、前三个目标路径与分值、模型／提示版本、分类设置指纹、创建时间及摘录长度；不保存正文、会话 ID 或目录 ID。

`InboxQueueDependencies.encodeProposal/restoreProposal` 由 controller 注入。启动先初始化目录，再创建队列并恢复建议，避免目录初始化触发空队列写回。异步 `restore()` 校验原文、设置指纹、模型和有效目标，并绑定当前会话身份；恢复期间的编辑、移除或重新分析使旧恢复结果失效。恢复和历史库存展示不联网，也不自动排队。`invalidate(preserve)` 保留仍有效的建议；失效建议和已有分析任务在自动归档允许时重新稳定等待，历史 waiting 库存不因目录变化或启用开关而上传。队列一次只向调度器提交一篇笔记，预算耗尽回到 waiting。

移动意图必须先持久化，再写文件，最后保存结果。上一会话的 done 转为不可撤销的 archived；intent 通过两端路径和内容指纹确认已完成或未执行时归档，无法确定才进入 review。`acknowledge(recordId)` 将人工核对的 review 归档。完成历史最多保留 100 条，未解决 intent/review 不参与裁剪；撤销仅授权给当前服务实例成功完成的记录，不复用持久化 noteId。

## 调度、预估与宿主端口

`UsageStore.reserve(limit, { automaticLinkLimit }?)` 在本机保存预留；自动补链的子额度为 `floor(dailyRequestLimit * 0.3)`。旧用量缺失 `automaticLinkRequests` 时补 0；自动补链重试也占子额度。子额度耗尽不暂停共享调度器，归档和手动补链仍可使用总额度。

`previewAnalysis(paths?)` 只读文件元数据和目录描述，按修改时间倒序列出可分析笔记并粗估正常请求范围；模拟字节分组与打包，摘录策略为状态预留最多 12 KB，全文策略参考文件大小。启用画像且目录超过 254 时，上界另计一次短名单拒绝后的回退请求。预估不含重试，也不保证实际请求数或费用。默认批量范围排除 ready；显式勾选可重新分析 ready。`analyzeInbox(paths)` 只处理用户选定的有效路径，排除 ignored、analyzing 和 moving。`readPreview(path)` 只读所选笔记，最多返回 20,000 UTF-16 单元且不截断代理对。`createDestination(path)` 先按当前目录规则验证，再显式创建目录。

`EditorBridge.changed` 映射未受影响锚点；自动查询使用 `snapshot({ dirtyOnly: true })`。`confirmLinks(plans)` 返回 `LinkConfirmation`，同一编辑会话内通过一次事务提交，撤销抑制由链接服务登记。语义结果缓存不含文档 revision 或绝对锚点偏移；确认计划仍校验当前原文与版本。

## 验证

Node 22.12+；使用 npm 11 验证 `npx --yes npm@11 ci --ignore-scripts`，再执行 `npm run check`。单元测试验证范围、匹配、候选校验和状态转换；集成测试使用内存 vault、延迟 HTTP 和编辑器替身验证完整确认、撤销、竞争与失败流程。真实宿主使用独立合成测试 vault 核对，不能把替身测试描述为真实宿主验证；已完成的场景与剩余边界见下文及验证记录。

构建输出为根目录 `main.js`、`manifest.json`、`styles.css`。不提交凭据、用户笔记或 node_modules。

## UI 入口与端口

主要交互位于编辑器内，不使用侧栏或整理标签页；旧 `note-organizer-inbox`／`note-organizer-review` 视图注册为 `RetiredReviewView`，恢复时自动关闭。`filingPills(controller, host)` 通过 `PillSurface` 接入 `MarkdownView.contentEl` 并绝对定位，因此源码、实时预览和阅读模式共享同一胶囊，面板打开后才调用 `prepareMove`；同一路径共享手选目标，目标绑定建议 ID，文件对象变化才清除撤销状态。`linkHints(controller, host)` 用 Decoration 显示下划线或行尾标记，编辑后 `QUIET_MS` 内隐藏，控制器事件在微任务中以 StateEffect 刷新，悬停卡片挂在 `document.body`。`InboxModal` 在批量确认时固定目标与 `SourceVersion`，逐篇准备后与确认快照比较，再执行计划；无建议笔记的手选目标先准备以捕获源版本，处理期间禁用改选并忽略旧选择器回调。`AnalysisModal` 在发送前确认待分析路径，`LinkSuggestionsModal` 固定源会话并批量确认链接。`registerExplorerIntegration` 注册原生 `file-menu`／`files-menu` 与 Notebook Navigator 1.2+ 菜单 API，并在检测到原生文件栏内部条目表时写入 `data-note-organizer` 标记。控制器为界面提供 `scanLinks()`、`verifyLink()`、`linkProposalFor()`、`searchLinkTargets()` 等链接接口（见 [双链匹配设计](link-matching.md) §9）以及 `nextInboxNote()` 与 `attachmentCount()`；`LinkQuerySuggest` 注册为 `EditorSuggest` 处理 `[[?`；`EditorSessions.sessionFor(view)` 让补链提示找到所属编辑会话。

控制器返回的 `LinkMention.verdictKey` 绑定源路径、句子、句内位置、候选身份与版本及模型配置。悬停请求和确认前都重新校验当前提及；UI 按该键保存判断状态，正文变化关闭旧卡片，失败可在重新打开后重试。`verifyLinkQuery` 要求调用方提供实时 `isCurrent()`；查询关闭、正文或设置变化会取消待发请求并拒绝晚到响应。`linkMarkdown` 接收完整 `LinkTarget` 并核对身份、版本与路径，防止旧路径被新文件占用后插错目标。所有查询、发送和插入均执行源笔记范围限制。

胶囊准备失败只更新当前面板的错误，不通过重新渲染触发新准备；撤销失败仍保留可重试入口。切换文件时清理计划、忙碌状态和反馈；异步移动／撤销回调同时校验文件对象与本次显示上下文，切走再切回也不能显示旧反馈。同一对象因移动而改名仍保留完成状态。链接卡片在焦点变化时保留操作节点；DOM 检查兼容其他窗口，延迟光标提示再次核对焦点。Notebook Navigator 菜单按 API 对象身份重绑，卸载后迟到的布局回调不得注册菜单或胶囊；卸载同时关闭 `LinkQuerySuggest`，取消其延迟请求。

胶囊归档成功后提供撤销与同窗格的下一篇，两者有 400 ms 防连击；分值接近时可显示两个改选目录，不展示模型概率。计划准备均有异步代次检查，重渲染按签名跳过并恢复操作焦点。任何入口都不能凭模型响应直接写入；实际交互以 [交互文档](interaction-design.md) 为准。

`EditorSession.snapshot()` 只读取，不清除脏区间。协调器仅在当前快照成功返回建议或确认没有候选时调用 `acknowledgeAnalysis(snapshot)`；调用校验会话与文档版本，只清除已分析窗口。失败、过期响应、预算拒绝和超时保留待分析范围，确认预览读取不得消费自动分析任务。

## 卸载与实例交接

协调器在宿主 App 上以 `Symbol.for` 保存实例交接屏障，跨插件 bundle 重载保持有效。新 `initialize()` 在读取插件数据前等待旧实例排空已接受的本地工作。`dispose()` 立即停止新增任务，并返回等待初始化／恢复、已确认移动、设置更新、`InboxQueue.flush()` 和状态存储队列完成的 Promise；每个初始化等待点后检查卸载状态，卸载后不再注册宿主事件或编辑器扩展。

屏障不等待无法中止的网络传输。卸载后晚到的响应不再结算旧实例用量，已预留请求保持 unknown；已经开始的额度写入仍由存储队列排空。新实例可正常启动，旧响应不会用过期用量快照覆盖新实例。运行中实例的逻辑超时仍不释放实际网络名额。

## 宿主验证边界

`MoveHost.referencesSafe` 返回 true、false 或具体拒绝原因。只有运行时类型保护后的 `vault.getConfig('alwaysUpdateLinks') === true` 才允许依赖宿主改写路径引用；配置未知时使用保守检查。移动后按先前记录的链接类别和序号复核入链与出链解析，最多等待约 1 秒；失败保留文件现状并进入 review，不自动反向写回。

Obsidian 1.13.7 合成库已验证目录选择不冻结、带入出链移动及两条链接更新／撤销、顶部提示条移动／撤销，以及本地模拟 HTTP 后两条补链的单次原生 Undo。该证据仅覆盖这些场景：最低支持版本 1.11.4、全部私有语法、同步／外部并发编辑、不同服务在真实语料中的推荐质量未据此验证。真实 Ollama 固定合成示例和原生连接已经单独验收，协议有效不代表语义判断全部正确。详细宿主证据由 [验证记录](validation.md) 维护，工程端口不扩大自动写入权限。

## 开发命令和交付

- `npm run check`：类型、Lint、领域测试、编辑器／UI／端口集成、生产构建。
- `npm run package`：构建后复制三个安装文件及 `LICENSE`、`NOTICE` 到 `dist/homing/`。
- `node --expose-gc benchmarks/metadata-index.mjs`：20,000 篇、每篇两个词条的实际索引；末尾传 `2` 改为每篇三个词条。

自动化测试中 Obsidian 模块映射到测试端口；生产 esbuild 不使用该映射。真实 CM6 与标准 Markdown 解析器参与测试，但不能替代 Obsidian 私有语法和宿主撤销测试。精确依赖版本保存在锁文件。

真实 API 冒烟脚本为 `node scripts/jev-smoke.mjs`，从标准输入接收密钥，只发送固定合成案例。该脚本不会随 `npm test` 或 CI 自动联网，也不会持久化密钥。
