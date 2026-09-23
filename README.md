# Note Organizer

Obsidian 桌面插件：为收件箱笔记推荐已有目录，并在写作时推荐内部链接。每次移动和插入均需确认。

当前版本 **0.1.2 开发预览**。已实现模块、原生侧栏与设置、自动化测试及安装包构建。真实 Jev 连接、固定示例和多目录分组请求已通过；Obsidian 宿主与真实语料推荐质量仍待验证，验证范围见 [验证记录](docs/validation.md)。

## 使用

需要 Obsidian **1.11.4+ 桌面版**。将 `dist/note-organizer` 中的 `main.js`、`manifest.json`、`styles.css` 放入测试知识库的 `.obsidian/plugins/note-organizer/`，然后在社区插件中启用。

1. 在插件设置中选择或创建收件箱，选择由 Obsidian 保存的 Jev 密钥。
2. 点击“启用归档建议”。固定示例连接成功后，自动处理新进入收件箱的笔记；已有笔记通过面板中的“分析已有笔记”启动。
3. 需要整理时点击状态栏“整理”。默认一个推荐位置，可改选，确认才移动；同一插件会话内可撤销。
4. 链接推荐通过“为当前文字查找链接”命令使用，也可单独开启“写作时准备链接建议”。确认后保留文字并插入链接，使用编辑器撤销。

归档的分组提名与最终决选都发送当前笔记标题、去除属性区的完整正文、最多 8 个标签及候选目录信息。超出发送预算会提示错误，不会退化为仅发送标题。链接请求发送当前允许的局部文字与候选元数据，可能含尚未保存内容。两者共享每日请求上限，默认本机 100 次；配置只保存密钥名称。

## 开发

Node.js 22.12+，依赖使用 npm 11 干净安装验证。

```sh
npx --yes npm@11 ci --ignore-scripts
npm run check
npm run package
```

`npm run package` 输出可安装目录 `dist/note-organizer/`。构建命令不自动安装到知识库，不发布远程仓库。开发监视使用 `npm run dev`；实际索引基准使用 `node --expose-gc benchmarks/metadata-index.mjs`。

`main` 保存通过当前验证的预览版本，`dev` 集成，`feat/*` 保留各模块开发分支。接口定义先于实现提交；入口见 [开发与模块契约](docs/development.md)。

## 当前边界

- 单个收件箱、Markdown、已有目标目录；支持混合深度分类，超出单题容量时组内提名后统一决选。
- 链接只匹配文件名和 aliases，不扫描全库正文，不做 embedding 或语义同义词召回；自动候选查询只访问内存。
- 为避免移动后断链，无法确认引用保持有效时拒绝移动；显式旧路径引用可能因此阻止归档。
- 重启后旧移动记录进入人工核对，不自动再次移动，也不提供跨会话自动撤销。
- 候选正文补充、覆盖受限提示、更广的手动检索和多设备协调尚未实现。

## 设计文档

- [产品需求](PRD-note-organizer.md)
- [技术栈、模块和接口](docs/technical-design.md)
- [低打扰交互与设置](docs/interaction-design.md)
- [目录分类算法](docs/folder-classification.md)
- [Jev 接入](docs/jev-integration.md)
- [双链补齐](docs/link-suggestions.md)与[轻量索引方案比较](docs/link-indexing.md)

工作名称为 Note Organizer；公开发布名称与许可证尚未确定。
