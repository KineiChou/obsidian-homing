# 发布准备

当前为桌面开发预览。正式名称为 **Homing（归位）**，插件 ID `homing`（开发阶段曾用 `note-organizer`），作者 KineiChou，许可证 Apache-2.0（仓库根目录 `LICENSE` 与 `NOTICE`）。准备工作流不等于批准发布或提交社区市场。

## 当前验证范围

自动化检查覆盖领域逻辑、编辑器事务和宿主／HTTP／UI 替身。Jev 固定合成对照、真实本地 Ollama 协议和 Obsidian 1.13.7 的部分原生场景已有记录；最低版本与完整宿主矩阵仍未完成。具体证据以 [validation.md](validation.md) 为准，不将未完成的 issue 视为已验证。

对外发布前需要完成专用测试知识库中的宿主验收（链接更新、编辑器撤销、原生视图与重启恢复），并复核 README 的服务、费用和数据发送披露。真实笔记不得作为仓库夹具或上传为发布资产。

## 版本与工作流

`.github/workflows/release.yml` 在推送数字版本标签时执行。标签必须是 `x.y.z`，没有 `v` 前缀；`manifest.json`、`package.json`、锁文件版本必须与标签完全相同，`versions.json` 中相应版本须匹配 `manifest.minAppVersion`。

本地可先运行只读检查：

```sh
node scripts/verify-release.mjs 0.2.1
npm run check
```

示例版本仅演示格式，实际发布使用将要发布的版本。工作流固定 Node 22.21.1、npm 11.6.2，以 `npm ci --ignore-scripts` 安装锁定依赖，运行类型检查、lint、测试和构建。构建 job 只有 `contents: read` 权限；独立 release job 获得 `contents: write`，只下载构建产物，并用 `--verify-tag` 创建 **draft prerelease**，附件为 `main.js`、`manifest.json`、`styles.css`（社区市场只安装这三个文件）；`main.js` 顶部保留 esbuild 写入的署名与许可证注释，完整的 `LICENSE`／`NOTICE` 随源码仓库及 `npm run package` 的安装目录提供。它不生成标签，不自动公开草稿，也不覆盖已有 release。

实际推送标签会触发远程操作，必须另行取得发布授权。发布负责人检查草稿和资产后再决定何时公开，以及何时提交 Obsidian 社区审核。当前工作仅添加流程文件，没有推送标签或创建 release。GitHub Actions 的远程执行尚未验证。

参考：[GitHub 最小 token 权限](https://docs.github.com/en/actions/tutorials/authenticate-with-github_token)、[GitHub CLI release create](https://cli.github.com/manual/gh_release_create)、[Obsidian 发布文档](https://docs.obsidian.md/Plugins/Releasing/Release+your+plugin+with+GitHub+Actions)。

## 插件 ID 核查

2026-09-25 02:46 UTC 读取 [Obsidian 官方 community-plugins.json](https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/community-plugins.json)：8,026 条记录中，`id` 精确等于 `homing` 的为 **0**，名称包含 `homing` 或 `归位` 的为 **0**。读取文件 SHA-256：`0eca1879c2179bc9520179f691f58c26bff89c62ba4ccc1e88bd93b01645e16d`。

此前（2026-09-23 19:28 UTC，7,975 条）对旧 ID `note-organizer` 的核查结果同为 0。

这是该时间点的注册表核查，不是名称预留、商标判断或社区批准。提交社区审核前需要重新检查。插件 ID 一经发布不能更改，它决定设置目录 `.obsidian/plugins/homing/`；旧预览数据的一次性只读导入见 README。
