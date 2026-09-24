# Ollama 本地固定示例验收

2026-09-24，基于 `85384bd` 开发预览进行真实本地模型验收。环境为 macOS 26.6.2、Apple M4 Pro、Node.js 22.21.1，Ollama 0.34.4 使用 Metal。未使用用户知识库、服务凭据或云推理。

结论：显式 Ollama 提供方的受限 JSON Schema 与生产严格解析器能够完成真实本地请求；`qwen3:1.7b` 四例均通过结构校验，其中三例选择正确。无匹配食谱误选机器学习目录，说明模型质量仍有限，不能将这次验收写成全部用例通过或准确率保证。脚本对该结果返回退出码 **1**，保留失败。

## 实际结果

先以原 OpenAI-compatible 提供方的 `json_object` 请求测试 `qwen3:0.6b`：四例均返回 HTTP 200，但出现错误问题 ID、数字 ranking 或遗漏候选，全部被生产解析器拒绝。再次只将响应格式换为官方支持的 JSON Schema 后，三例通过；食谱例的 `choice=unassigned` 与 `ranking[0]=f1` 矛盾，仍被拒绝。诊断时另外重复过一次原 JSON 模式，结果仍为四例拒绝。

随后加入显式 `provider: 'ollama'`，使用同一套受限 schema，通过生产 `createDecisionClient` 对 `qwen3:1.7b` 运行一次：

| 固定合成案例 | 预期 | 实际 | 生产解析 | 延迟 |
| --- | --- | --- | --- | ---: |
| 注意力模型笔记归档 | f1 机器学习 | f1 | 通过 | 18,166 ms |
| 食谱，无匹配目录 | unassigned | f1 | 通过，但语义错误 | 3,130 ms |
| Transformer 音频编码消歧 | n1 序列模型 | n1 | 通过 | 2,206 ms |
| Transformer 220V→12V 消歧 | n2 变压器 | n2 | 通过 | 2,524 ms |

四次返回输入 token 分别为 234、232、232、246。首次延迟含模型冷加载；没有设置温度、种子或思考控制，不承诺重复结果完全一致。没有继续扩大模型或反复采样直到通过。

schema 约束完整问题 ID、答案字段、choice 候选枚举、ranking 候选枚举与长度。客户端仍独立拒绝重复／缺失／范围外 ID、错误问题和 choice 与首位不一致；没有自动修正模型结果。默认模型设为本次通过协议校验的 `qwen3:1.7b`，不是推荐质量保证。现有 Jev、Anthropic 和通用 OpenAI-compatible 请求格式不变。

## 模型与来源

官方资料：[macOS 运行条件](https://docs.ollama.com/macos)、[OpenAI 兼容接口](https://docs.ollama.com/api/openai-compatibility)、[结构化输出](https://docs.ollama.com/capabilities/structured-outputs)、[模型目录与关闭云功能](https://docs.ollama.com/faq)。模型来自官方 [qwen3:0.6b](https://ollama.com/library/qwen3:0.6b) 与 [qwen3:1.7b](https://ollama.com/library/qwen3:1.7b)，使用 Q4_K_M。

| 对象 | 固定校验值 |
| --- | --- |
| [Ollama v0.34.4 官方运行时](https://github.com/ollama/ollama/releases/tag/v0.34.4)，darwin tgz SHA-256 | `e9c8fddaab5f48f47f2c4ae3d23d0732f5182417125353faeed2188e34a22799` |
| qwen3:0.6b manifest SHA-256 | `7df6b6e09427a769808717c0a93cadc4ae99ed4eb8bf5ca557c90846becea435` |
| qwen3:1.7b manifest SHA-256 | `8f68893c685c3ddff2aa3fffce2aa60a30bb2da65ca488b61fff134a4d1730e7` |

模型总大小分别为 522,653,767 和 1,359,293,444 bytes；各 blob 已与官方 manifest 中的 SHA-256、大小校验一致。运行时、模型、源码与构建缓存保留在 `/private/tmp/organizer-ollama-acceptance/`，不纳入仓库。

## 复现

脚本不会随 `npm test` 自动运行。已有自行配置的 Ollama 时，可在专用回环地址准备上述模型，运行：

```sh
node scripts/ollama-smoke.mjs http://127.0.0.1:11579/v1 qwen3:1.7b 1
```

它只接受显式回环 HTTP 地址和固定 manifest 的两个本地模型，不拉取模型、不读取密钥，拒绝重定向。输出只含运行时／模型校验信息、所选 ID、预期 ID、输入 token、耗时与通过计数；不输出请求正文。其 HTTP 传输直接调用生产提供方与严格解析器。

本次为避免改变用户配置，没有启动 Ollama.app、安装服务或修改 `HOME`。官方 CLI `serve` 会在用户目录创建密钥，官方 `/api/pull` 在缺少该密钥时返回 500。因此使用官方源码的薄启动入口直接调用未改动的 `server.Serve`，并从官方公共 registry 下载、校验模型 blobs。以下是相同隔离方式的准备命令（从仓库目录执行；需要 Go 和网络）：

```sh
acceptance_repo="$PWD"
acceptance_root=/private/tmp/organizer-ollama-acceptance
mkdir -p "$acceptance_root/runtime"
curl -fL https://github.com/ollama/ollama/releases/download/v0.34.4/ollama-darwin.tgz -o "$acceptance_root/ollama-darwin.tgz"
curl -fL https://github.com/ollama/ollama/releases/download/v0.34.4/sha256sum.txt -o "$acceptance_root/sha256sum.txt"
shasum -a 256 "$acceptance_root/ollama-darwin.tgz"
# 对照上表及官方 sha256sum.txt，匹配后才解压。
tar -xzf "$acceptance_root/ollama-darwin.tgz" -C "$acceptance_root/runtime"
curl -fL https://github.com/ollama/ollama/archive/refs/tags/v0.34.4.tar.gz -o "$acceptance_root/source.tar.gz"
tar -xzf "$acceptance_root/source.tar.gz" -C "$acceptance_root"
mkdir -p "$acceptance_root/ollama-0.34.4/acceptance-launcher"
cp scripts/ollama-server.go "$acceptance_root/ollama-0.34.4/acceptance-launcher/main.go"
cd "$acceptance_root/ollama-0.34.4"
GOCACHE="$acceptance_root/go-cache" GOMODCACHE="$acceptance_root/go-modules" GOPATH="$acceptance_root/go-path" \
  go build -ldflags '-X github.com/ollama/ollama/version.Version=0.34.4' \
  -o "$acceptance_root/runtime/acceptance-server" ./acceptance-launcher
cd "$acceptance_repo"
node scripts/ollama-download-model.mjs "$acceptance_root/models" qwen3:1.7b
```

模型准备脚本固定官方 manifest 的哈希，逐 blob 验证，已验证文件可复用；标签内容变化时拒绝继续，需重新核对来源。启动命令在独立终端前台运行：

```sh
OLLAMA_HOST=127.0.0.1:11579 \
OLLAMA_MODELS=/private/tmp/organizer-ollama-acceptance/models \
OLLAMA_NO_CLOUD=1 OLLAMA_NOHISTORY=1 OLLAMA_DEBUG_LOG_REQUESTS=0 \
OLLAMA_NUM_PARALLEL=1 OLLAMA_CONTEXT_LENGTH=4096 \
/private/tmp/organizer-ollama-acceptance/runtime/acceptance-server
```

跑完 smoke 后在服务终端按 Ctrl+C 停止。固定示例阶段结束后已停止服务；原生连接验收可临时重启同一端点，完成后同样停止。未创建 `~/.ollama`。这次验证覆盖本地模型协议与固定合成判断，不覆盖大候选集、长上下文、所有 Ollama 模型，或真实语料推荐质量。宿主 UI 的本地端点流程另见 [验证记录](validation.md)。
