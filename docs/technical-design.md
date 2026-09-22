# Note Organizer 技术栈与接口设计

状态：待实现的技术方案，接口示例用于说明契约，不代表已有插件实现。官方接口核查于 2026-09-22。功能范围以 [产品需求](../PRD-note-organizer.md) 为准。

## 分类模型与整体边界

目录分类采用“混合深度的实际目标 → 组内提名 → 统一决选”。两阶段指模型调用顺序，不是先选叶子再向父目录回溯。父目录只要允许直接存放笔记，就与子目录一样是一个实际目标。容量允许时省去提名，直接比较全部目标。

插件运行在 Obsidian 桌面宿主内，本地负责监听、候选检索、校验和用户交互，TypeSafe 提供远程 Jev 推理。Node.js 用于开发构建和测试；最终用户运行插件不需要额外启动 Node 服务。

```mermaid
flowchart LR
    A[目录与文件事件] --> B[目录缓存与 inbox 队列]
    B --> C[目录分类服务]
    D[编辑器局部变化] --> E[标题与别名索引]
    E --> F[链接推荐服务]
    C --> G[共享请求调度与 Jev 客户端]
    F --> G
    G --> H[待确认建议]
    H --> I[用户确认与版本校验]
    I --> J[文件移动服务]
    I --> K[编辑器链接插入]
```

模型输出只指向本次提供的候选 ID。Jev 客户端不持有移动、写入笔记或修改编辑器的能力；文件变更由用户确认入口调用。

## 技术栈选择

| 层次 | 选择 | 作用与边界 |
| --- | --- | --- |
| 语言 | TypeScript，开启 `strict`、`noUncheckedIndexedAccess` | 空缓存、缺失目标、失效任务通过类型和运行时校验处理 |
| 开发环境 | Node.js 22.21.1、npm、`package-lock.json` | 与现有实验环境一致；依赖锁定后用 `npm ci` 复现 |
| 构建 | esbuild，入口 `src/main.ts`，CommonJS 输出，ES2021 目标 | 生成宿主可加载的 `main.js`；生产关闭内联源码映射 |
| 宿主 API | 官方 `obsidian` 类型与运行时 API | 目录、元数据、编辑器、设置、文件移动 |
| UI | `PluginSettingTab`、`Setting`、`ItemView`、选择弹窗、原生 DOM 与 CSS | 跟随 Obsidian 主题，界面状态只覆盖当前插件 |
| 编辑集成 | CodeMirror 6 的 view/state/language API | 捕获变化区间、复用语法树、识别输入法状态 |
| 分类服务 | Jev HTTP API，经 `requestUrl` 接入 | 单个提供方的薄客户端，校验 Choice 输出 |
| 索引 | 自有 TypeScript 压缩前缀树及有限元数据映射 | 标题／别名到现有笔记；只驻留内存 |
| 持久化 | `loadData/saveData`；本机开关用 vault 范围的 local storage | 设置、待办引用和有限移动记录；不存笔记正文或索引 |
| 凭据 | `SecretComponent` + `SecretStorage` | 配置保存密钥名称，发送请求时才取值 |
| 开发验证 | `tsc --noEmit`、ESLint 与 Obsidian 规则、Vitest、独立测试 vault | 纯逻辑与异步竞态做自动验证，宿主行为另做集成验证 |

构建形式与官方模板一致；`obsidian`、CodeMirror 和宿主提供的 Lezer 模块列为 external，由宿主提供实例，避免打包第二套编辑器运行时。具体 npm 版本在脚手架阶段锁定，类型包新于最低宿主版本时仍须核对所用成员的兼容性。[官方构建示例](https://github.com/obsidianmd/obsidian-sample-plugin/blob/master/esbuild.config.mjs)、[开发依赖示例](https://github.com/obsidianmd/obsidian-sample-plugin/blob/master/package.json)

设计基线为 `minAppVersion: 1.11.4`、`isDesktopOnly: true`，编辑扩展针对 CM6 源码模式与实时预览。原生密钥接口决定当前最低版本；这仍是需要实测的兼容性承诺。[官方 API 类型](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)

Vitest 只作开发依赖，其工具链不进入插件包；当前指南要求 Node 至少 22.12.0，上述环境满足该条件。[Vitest 指南](https://vitest.dev/guide/)

## 模块与代码组织

```text
src/
  main.ts                         # 注册生命周期并连接模块
  settings.ts                     # 配置结构、默认值与迁移
  folders/catalog.ts              # 实际归档目标及快照版本
  filing/inbox-queue.ts            # 稳定等待、去重、待办状态
  filing/classifier.ts             # 全量比较或提名后决选
  linking/metadata-index.ts        # 有界元数据与词条到目标关联
  linking/mention-matcher.ts       # 原文范围匹配与候选过滤
  linking/recommender.ts           # 链接问题构造与结果转译
  obsidian/vault-events.ts         # 宿主事件到目录／笔记更新
  obsidian/editor-extension.ts     # 编辑会话、脏区间、局部语法
  obsidian/move-service.ts         # 确认移动、恢复核对与撤销
  obsidian/link-writer.ts          # 生成链接、校验并插入
  jev/client.ts                    # HTTP 与凭据读取
  jev/response-parser.ts           # unknown 到已验证响应
  jev/scheduler.ts                 # 在途名额、预算、重试与失效
  storage/state-store.ts           # 持久化写入串行化
  ui/settings-tab.ts
  ui/review-view.ts
  ui/target-picker.ts
```

上述是职责划分，不要求一开始创建空模块。按功能落地文件；类型放在所属领域，只有跨模块使用的契约才导出。算法与问题构造使用普通数据对象，不依赖 `App`、`TFile` 或 DOM；宿主对象留在接入与写入模块，通过构造参数注入少量协作者即可。

`main.ts` 不实现分类、全文解析或文件移动。UI 发出明确的分析、准备预览和确认命令，通过订阅获得状态；不直接调用 Jev 或绕过变更校验。

## Obsidian 接入点

| 用途 | API 或事件 | 处理要点 |
| --- | --- | --- |
| 初始化 | `workspace.onLayoutReady`、`Plugin.registerEvent` | 就绪后订阅事件；既有 inbox 走单独入口；卸载自动释放订阅 |
| 目录发现 | `vault.getAllFolders(false)` | 读取宿主已有目录集合；完整路径区分同名目录 |
| 文件变化 | `vault.on('create'/'modify'/'rename'/'delete')` | 只更新受影响范围；整体目录改名要处理子树 |
| 链接元数据 | `getMarkdownFiles()`、`metadataCache.getFileCache()` | 分批建索引；空缓存等待后续事件 |
| 元数据就绪 | `metadataCache.on('changed'/'resolve')` | 有限字段变化才更新相应索引；改名另处理 |
| 当前正文 | 活动编辑器内容；后台笔记使用 Vault 读取接口 | 归档稳定后取快照；编辑推荐只读局部未保存文本 |
| 编辑扩展 | `registerEditorExtension`、`editorInfoField` | 从所在编辑器获取文件和 Editor，避免依赖未公开的 `.cm` 属性 |
| 移动 | `fileManager.renameFile` | 遵循宿主链接设置，确认前检查目标与内容 |
| 生成链接 | `fileManager.generateMarkdownLink` | 传入目标、源路径和显示文字，遵循用户链接格式 |
| 插入链接 | `Editor.transaction` | 只替换已确认范围，使用编辑器撤销历史 |

宿主 API 的使用以官方类型为准；元数据与文件路径事件承担不同职责，不能用一个事件覆盖两者。[官方 API](https://github.com/obsidianmd/obsidian-api/blob/master/obsidian.d.ts)

## 数据契约

目录 ID 与笔记 ID 是当前插件会话中的标识。路径不是稳定身份，改名后要更新映射；重启后从持久化路径与内容指纹重新核对，不能复用上次会话的数字 ID。目录快照包含所有当前允许的实际目标，关闭直接归档的容器在构造快照时过滤。

```typescript
type NoteId = number;
type FolderId = string;

interface SourceVersion {
  readonly noteId: NoteId;
  readonly path: string;
  readonly revision: number;
  readonly contentHash: string;
}

interface NoteSnapshot {
  readonly source: SourceVersion;
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
}

interface FolderTarget {
  readonly id: FolderId;
  readonly path: string;
  readonly directPurpose: string;
  readonly effectiveRules: readonly string[];
}

interface FolderSnapshot {
  readonly revision: number;
  readonly targets: readonly FolderTarget[];
}

interface DecisionContext {
  readonly taskId: string;
  readonly settingsRevision: number;
  readonly promptRevision: number;
  readonly modelId: string;
}

interface FilingProposal {
  readonly id: string;
  readonly source: SourceVersion;
  readonly foldersRevision: number;
  readonly context: DecisionContext;
  readonly selected: FolderId | null;
  readonly ranked: readonly {
    readonly targetId: FolderId;
    readonly probability: number;
  }[];
}

interface FolderClassifier {
  propose(
    note: NoteSnapshot,
    folders: FolderSnapshot,
    context: DecisionContext
  ): Promise<FilingProposal>;
}
```

`selected: null` 表示模型放弃，不表示网络失败。失败走明确的错误结果，不伪造成功建议。原始 Choice 概率包含放弃项；上面的 `ranked` 仅是展示用的真实目录排序，不要求这些概率之和等于 1。

原文件完整文本只在本次归档任务内存中短暂保留；`contentHash` 覆盖包括 frontmatter 在内的完整内容，建议使用 SHA-256，仅在稳定分析和确认阶段计算。发给模型的 `body` 移除 frontmatter，额外属性从同一文本快照中按发送名单提取；归档不能用可能滞后的元数据缓存拼出另一版本的属性，也不能把未知属性随正文一起透传。变化计数用于快速失效，不能代替确认时的内容检查。标识与 TypeScript 类型也不能代替路径存在性和候选白名单校验。

### 链接建议的契约

```typescript
interface TextAnchor {
  readonly editorSessionId: string;
  readonly noteId: NoteId;
  readonly sourcePath: string;
  readonly documentRevision: number;
  readonly from: number;
  readonly to: number;
  readonly originalText: string;
  readonly contextFrom: number;
  readonly contextText: string;
}

interface LinkTarget {
  readonly noteId: NoteId;
  readonly path: string;
  readonly title: string;
  readonly aliases: readonly string[];
  readonly tags: readonly string[];
  readonly description: string;
  readonly revision: number;
}

interface LinkInput {
  readonly anchor: TextAnchor;
  readonly catalogueEpoch: number;
  readonly candidates: readonly LinkTarget[];
}

interface LinkProposal {
  readonly id: string;
  readonly input: LinkInput;
  readonly context: DecisionContext;
  readonly selected: NoteId | null;
}

interface LinkRecommender {
  propose(
    inputs: readonly LinkInput[],
    context: DecisionContext
  ): Promise<readonly LinkProposal[]>;
}
```

`from/to` 是原编辑器文档的 UTF-16 绝对偏移，`to` 不包含在范围内，不能用归一化字符串的下标替换。会话区分同一文件的多个编辑窗格；侧栏点击后仍操作绑定的源会话，不能临时寻找“当前活动编辑器”而写错窗格。

首版采取保守策略：源文档任何正文变化即使该会话旧建议失效。变化区间映射只用于下一次局部分析，不用于强行保留已失效的插入指令。目标改名、删除、描述变化，词典成员变化及配置变化也使相关建议失效。

## Jev 客户端与调度接口

客户端只实现当前需要的 Choice 子集。问题 ID、选项 ID 在本地映射到业务对象；完整路径与用途放在选项描述里。核心接口如下，`unknown` 是接入边界，必须先做运行时校验。

```typescript
type JsonValue = null | boolean | number | string
  | readonly JsonValue[] | { readonly [key: string]: JsonValue };

interface ChoiceQuestion {
  readonly id: string;
  readonly instructions: string;
  readonly options: readonly {
    readonly id: string;
    readonly description: string | { readonly [key: string]: JsonValue };
  }[];
}

interface ChoiceBatch {
  readonly modelId: string;
  readonly state: JsonValue;
  readonly questions: readonly ChoiceQuestion[];
}

interface ChoiceBatchResult {
  readonly modelId: string;
  readonly answers: Readonly<Record<string, {
    readonly selected: string;
    readonly probabilities: Readonly<Record<string, number>>;
    readonly confidence: number;
  }>>;
  readonly inputTokens: number | null;
}

interface DecisionClient {
  evaluate(batch: ChoiceBatch): Promise<ChoiceBatchResult>;
}
```

`ChoiceBatch` 是内部 DTO，客户端转换为 API 的 `state/model/questions` 结构，不直接把这个对象发给服务端。响应通过窄范围校验函数转译：问题集合、选项集合、返回类型、数值有限性、概率范围与总和、实际模型版本和用量类型都要检查。`inputTokens: null` 表示用量未知，不记为免费。HTTP 与 Choice 细节见 [Jev 接入设计](jev-integration.md)。[TypeSafe API](https://docs.typesafe.ai/api)

共享调度器使用一个实际在途 HTTP 名额；已排队的同一编辑会话只保留最新任务。用户手动操作与编辑推荐优先，归档在批次之间让出调度权；正在传输的请求不会被抢占。自动请求开始间隔至少 5 秒，日常预算与重试预算一起计数。每个目录分类任务可含多个批次，不能把“一个任务”计成“一次请求”。

`requestUrl({ throw: false, ... })` 返回后统一处理状态。401／403 停止自动重试；422 作为请求不合法处理；429、529 与可重试服务错误按上限退避并尊重 `Retry-After`。错误界面展示可采取的操作，不输出可能含正文的原始错误体。[requestUrl](https://docs.obsidian.md/Reference/TypeScript%20API/requestUrl)

公开 `RequestUrlParam` 没有取消或超时参数。因此任务取消和等待超时只改变应用状态：丢弃结果、取消尚未发送的批次，实际在途名额直到原请求 settle 才释放。长期挂起时保持网络暂停，不用无限重发绕过名额，也不承诺卸载插件能取消已经发送的请求。这一约束需进入假定时器与延迟响应测试。

## 两条事件流程

### inbox 归档

1. Vault 事件检查边界与扩展名，符合范围的笔记进入队列；已有 inbox 内容由单独命令加入。
2. 内容稳定约 10 秒，且笔记未处于活动编辑状态时读取当前正文；手动分析活动笔记则使用编辑器中的最新文本。
3. 记录源指纹、目录快照和配置版本，分类器选择全量比较或分组提名／统一决选。
4. 任一版本变化使整个任务失效。结果进入安静的建议列表，默认只展示一个推荐；人工改选可使用全部有效目标，不局限于模型提名集合。
5. UI 根据源与所选目标生成具体移动预览，确认调用只携带该预览 ID。源内容或路径变化、目标变化后，旧预览不可继续执行。
6. 移动服务重新校验、持久化操作意图、调用 `renameFile`，随后写入结果与撤销记录。任一阶段不明确时进入待核对，不自动重复移动。

### 编辑时推荐链接

1. 用 `ViewPlugin` 接收 `docChanged` 与 `changes.iterChangedRanges`，递增会话版本、使旧建议失效、映射并合并最多 8 个脏区间。
2. 输入法 composition 结束且停顿约 1 秒后，通过 `state.doc.sliceString()` 读取最多 1,200 UTF-16 单元的局部窗口，补边也计入预算。
3. 用已有语法树检查允许区域。解析尚未覆盖窗口时延后或跳过；Obsidian 的自定义节点在目标版本中验证，不能只靠标准 Markdown 节点名推断安全。未知结构保守跳过。
4. 压缩前缀树匹配标题／别名，由词条直接取得目标；最多分析 3 处提及，每处默认 8 个候选、上限 20。没有候选则不请求模型。
5. 先查内存缓存，再由 Jev 选择目标或放弃。新输入、文件切换或目标变化后丢弃过期结果。
6. 用户确认时检查会话、文档版本、原文、语法区域、目标与重复链接；生成链接并验证能解析到预期目标。预览格式发生变化则先刷新预览。
7. 用一次 `Editor.transaction` 替换原文范围；正常撤销恢复文本。首版不通过后台整文件写入实现补链。

变化集合提供局部范围，而非要求复制全文；其使用方式可由 CodeMirror 的公开实现核对。[ViewUpdate](https://github.com/codemirror/view/blob/main/src/extension.ts)。编辑写入遵循宿主 Editor API，实际撤销分组还需在目标版本集成验证。[Editor](https://docs.obsidian.md/Plugins/Editor/Editor)

所有编辑窗格共享一个知识库索引，各自维护编辑会话。`ViewPlugin.destroy` 清除计时器、解除会话绑定并使建议失效；插件卸载停止调度和增量工作，释放事件、UI 订阅与缓存。

## 变更接口与失败状态

变更服务遵循“准备可展示计划 → 用户确认计划 ID → 执行前再次校验”。计划只在当前会话有效，不接受模型直接返回的文件路径或编辑指令。

| 命令 | 输入 | 输出与约束 |
| --- | --- | --- |
| `prepareMove` | 源笔记身份、当前允许的目标目录 ID | 带源指纹、最终文件路径与快照版本的只读预览 |
| `confirmMove` | UI 当前展示的计划 ID | 已完成、失效、同名冲突、失败或需核对 |
| `undoMove` | 已完成移动记录 ID | 只反向移动当前文件；保留最新正文并重新检查冲突 |
| `prepareLink` | 建议 ID、候选目标 ID | 锚点、完整目标和实际替换文本组成的预览 |
| `confirmLink` | UI 当前展示的计划 ID | 已插入、失效、目标消失或格式无法安全表达 |

同一源笔记的移动串行执行，重复确认不能执行两次。保存意图失败则不移动；文件已移动但完成记录写入失败时标记待核对，不能把它当作未移动重试。不同文件之间的移动和链接更新不是插件拥有的数据库事务，不能宣称与外部编辑器或同步进程之间存在原子锁；发布前验证冲突与中断行为。

## 存储与配置

`data.json` 分为 `schemaVersion`、`settings`、`filingQueue`、`moveJournal`。仅保存必要字段：inbox 路径与子目录开关、排除范围、目录用途、功能开关、密钥名称、固定模型标识、预算、待办路径及状态、源指纹与移动路径。完整正文、请求包、词条索引、编辑建议、会话忽略记录与候选摘录只在内存中。用户看见的开关与内部配置一一对应到明确功能；“启用归档建议”同时完成本机运行授权，不再要求额外打开第二个总开关。

配置加载先校验再迁移；损坏文件不直接用默认配置覆盖。单一状态存储模块串行执行 `saveData`，合并普通设置与队列更新。移动意图与结果单独立即保存并等待完成，不被普通防抖延后。编辑按键和链接查询不调用 `saveData`。

本机是否承担自动分析由 `app.loadLocalStorage/saveLocalStorage` 保存的 vault 范围开关控制，首次默认关闭，避免另一设备仅同步插件配置就自动开始调用。这不构成跨设备锁，首版仍按单设备运行设计。

本机每日额度也放在 vault 范围的 local storage，由共享调度器通过状态存储模块串行更新。发送前先保守占用额度，实际响应补充用量；意外退出后不能确认是否发出的占用记录保留为未知，不当作免费请求。每次实际网络尝试只涉及少量计数写入，键入和本地检索不写入。全局“完全不处理”范围优先于两个功能的各自范围，源文件被排除时不构造请求，目标被排除时不进入候选。

重启恢复待办路径与操作记录，未完成移动先核对；编辑会话与插入计划全部失效，未保存的模型建议也不复用。待办中需要重新分析的条目明确显示状态，由用户重试，避免恢复时重复批量调用。已完成的撤销记录设置容量限制，未核对意图不参与普通清理。

凭据从 `SecretComponent` 选择，设置只记录名称，`app.secretStorage.getSecret(name)` 在请求前取值；缺失时显示配置入口。这是 Obsidian 的 vault 范围密钥存储，不额外宣称操作系统钥匙串加密或插件间权限隔离。[密钥指南](https://docs.obsidian.md/plugins/guides/secret-storage)

## 界面实现

- 设置页：首次只需 inbox 与凭据，同页说明发送范围后启用归档建议。日常展示归档和写作建议开关；范围、用途与用量折叠。写作建议默认手动查找，用户单独开启自动准备。分组大小、候选数与分数阈值作为工程参数，不进入常规设置。
- 侧栏 `ItemView`：用户主动打开；“当前笔记”与“收件箱”两个范围只显示一个。每条一个推荐、一个主要确认动作、更换目标和更多菜单；关闭即稍后，成功原位反馈，列表不因新结果自动重排或抢焦点。
- 目标选择：目录使用支持完整路径搜索的选择弹窗；文件目标使用候选列表。人工选择遵循对应功能的范围限制。
- 状态栏：单一“整理”入口，有可用建议时用中性圆点提示，默认不显示累积数字。连接或预算阻碍只更新入口状态，细节主动查看；没有新建议时不显示后台转圈。支持命令面板和用户自定快捷键，不自动劫持 Enter／Tab。
- DOM 使用文本节点或宿主安全渲染能力；路径和笔记内容不经 `innerHTML` 拼接。样式使用插件类名前缀和 Obsidian CSS 变量，组件使用自身文档对象以兼容弹出窗口。

详细显隐、默认值、忽略和异常反馈以 [低打扰交互](interaction-design.md) 为准。上下文仍显示旧结果时不得原位换成新目标并保留可点击的旧确认动作，计划版本与 UI 焦点必须一起处理。

## 资源预算与发布验证

首版在宿主主线程分片构建与更新索引：每批最多约 250 篇且约 4 ms 后让出执行权。先遵守既定的窗口、词条、命中数和内存上限；实测超预算再判断是否需要 Worker，不预先复制一套索引到第二线程。详细预算与合成实验见 [轻量索引](link-indexing.md)。

构建后交付 `main.js`、`manifest.json`、`styles.css`，版本与最低宿主版本由 manifest 和 versions 文件维护。源码在独立仓库开发，测试构建只放入专用 vault；正常构建步骤不写入真实知识库。[官方插件模板](https://github.com/obsidianmd/obsidian-sample-plugin)

拟定开发命令为 `dev`、`build`、`typecheck`、`lint`、`test`。当前文档仓库尚未创建这些脚本。验证只覆盖与实际改动相关的风险：

- 纯逻辑：目录边界、提名覆盖、非法模型选项、别名重叠、UTF-16 原文位置、索引增删与容量边界。
- 异步：假定时器验证防抖、输入法延迟、旧响应、真实在途名额、分组失败、重试计费与保存次序。
- 宿主：中文输入法、分屏／弹出窗格、源模式／实时预览、重命名、同名冲突、链接格式、正常撤销、插件卸载和中断恢复。
- 质量：在用户允许发送的人工标注样本上评估分类与链接召回；合成匹配性能或 mock 请求不能证明 Jev 的真实判断质量。

新接口与依赖只在完成上述相关验证后形成已实现的兼容性承诺。
