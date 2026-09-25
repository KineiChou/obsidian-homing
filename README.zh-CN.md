# Homing（归位）

[English](README.md)

Obsidian 插件：为收件箱里的每篇笔记推荐存放目录，并在写作时建议内部链接。移动笔记和插入链接都要经你确认。

需要 **Obsidian 1.11.4 及以上的桌面版**。

## 安装

在 Obsidian 中打开 **设置 → 第三方插件 → 浏览**，搜索 **Homing**，安装并启用。

手动安装：从[最新 Release](https://github.com/KineiChou/obsidian-homing/releases/latest) 下载 `main.js`、`manifest.json`、`styles.css`，放入 `<知识库>/.obsidian/plugins/homing/`，再在“第三方插件”中启用 Homing。

## 开始使用

1. 在 Homing 设置中选择收件箱文件夹和分析服务，关联自己的 API key，或连接本地模型。
2. 检查连接，然后开启归档建议。已有的收件箱笔记只在你选择时才会分析，分析前会显示预计请求数。
3. 打开一篇收件箱笔记，编辑器右上角的小胶囊会显示建议目录。点开后确认，或改选其他目录。归档后胶囊提供“撤销”和“下一篇”，不离开编辑器就能逐篇整理收件箱。
4. 想一次归档多篇，可以从状态栏打开“整理收件箱”，或在文件栏、Notebook Navigator 中右键笔记。
5. 写作时停顿一下，提到已有笔记的地方会出现淡色下划线；悬停即可链接、更换目标或忽略。输入 `[[?` 可以搜索要链接的笔记；执行“为当前文字查找链接”可一次添加多条链接，编辑器撤销一次即可全部恢复。

### 键盘操作

| 命令 | 作用 |
| --- | --- |
| **在光标处建立或取消链接…**（`homing:link-menu`） | 为光标处的建议或链接弹出操作列表 |
| **接受光标处的链接建议**（`homing:accept-link`） | 直接链接明确的建议 |
| **取消光标处的链接**（`homing:unlink`） | 把链接还原为显示文字 |

默认都不绑定快捷键，可在 **设置 → 快捷键** 中指定，或借助 [Vimrc Support](https://github.com/esm7/obsidian-vimrc-support) 映射到 Vim：

```vim
exmap hominglink obcommand homing:link-menu
nmap <Space>l :hominglink<CR>
exmap homingunlink obcommand homing:unlink
nmap <Space>u :homingunlink<CR>
```

## 服务、隐私与费用

服务账号或本地模型需要你自己提供。远程服务可能按请求收费；发送私人笔记前，请了解服务商的价格、条款和数据保留政策。

请求只发给你选择的服务：

| 服务 | 默认地址 |
| --- | --- |
| TypeSafe Jev | `https://api.typesafe.ai/v1/systemone` |
| OpenRouter | `https://openrouter.ai/api/v1/chat/completions` |
| OpenAI 兼容服务 | `https://api.openai.com/v1/chat/completions` |
| Anthropic | `https://api.anthropic.com/v1/messages` |
| Ollama | `http://127.0.0.1:11434/v1/chat/completions` |

- **OpenRouter**：关联 OpenRouter API key，填写完整模型 ID（默认 `openai/gpt-4.1-mini`），请选择支持[结构化输出](https://openrouter.ai/docs/guides/features/structured-outputs)的模型。
- **Ollama**：填写基础地址和已安装的模型 ID（默认 `qwen3:1.7b`）。本机端点无需密钥，远程端点需要。Homing 不会安装或启动模型。
- 兼容服务可以填写自定义基础地址。切换服务会清除当前选择的密钥。
- Homing 会请求模型按结构化格式回答。服务不支持时，这次请求会以普通 JSON 模式重试一次，多计一次请求。Homing 不会自行改用其他服务。

请求可能包含：

- **归档**：笔记标题、标签和正文（不含属性区），以及目录路径、用途和规则。长笔记默认在本机提取摘录（标题、开头和各节首段），也可改为发送全文。
- **目录画像**（可选，默认关闭）：候选目录中其他笔记的抽样标题和标签，不含正文。
- **链接**：明确的标题、别名匹配在本机完成，不发送任何内容。只有在你悬停有歧义的提示、在 `[[?` 中停顿、执行查找链接命令或开启后台判断时，才会发送提及文字、所在句子、源笔记路径，以及候选笔记的路径、标题、别名、标签和描述。关闭“按需判断有歧义的链接”后，悬停和 `[[?` 都不会发请求。
- **连接检查**：固定示例，不含知识库内容。

为了找出收件箱笔记、目录和链接目标，Homing 会在本机列出知识库的文件并读取 Markdown 元数据。这份列表只留在本机，请求中只有上面列出的内容。

Homing 不收集遥测。API key 保存在 Obsidian 的密钥存储中，设置里只记密钥名称。建议、设置和移动记录保存在插件数据目录里（路径、内容指纹和目录选择，不含笔记正文），知识库同步工具可能会同步这些数据。

归档和链接共用每日请求上限（默认 100 次），自动链接判断最多占用其中 30%。计数只在本机统计，不等于服务商的账单额度。

## 使用限制

- 仅支持一个收件箱、Markdown 笔记和桌面版。
- 链接建议以笔记标题和别名为起点，不能发现所有相关笔记。
- 建议可能出错，模型给出的概率也不是经过校准的置信度，确认前请检查目标目录或链接。
- 可能破坏链接的移动会被拒绝；撤销在重启 Obsidian 前有效。

## 许可证

Copyright 2026 KineiChou。以 [Apache License 2.0](LICENSE) 授权。

任何人都可以使用、修改和再发布 Homing（包括修改版）。再发布时须保留版权声明和署名 KineiChou 的 [NOTICE](NOTICE) 文件，附上许可证，并注明修改了哪些文件。

从源码构建与设计文档：[docs/development.md](docs/development.md)。
