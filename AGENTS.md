# Homing（归位，原 Note Organizer）

- 使用中文与用户沟通，遵循已有产品设计和 `docs/development.md` 中的模块契约。
- `main` 是已验证交付，`dev` 是集成，具体实现使用 `feat/*`。远程仓库为 GitHub `KineiChou/obsidian-note-organizer`（public）：`main`、`dev` 通过验证后可推送，`feat/*` 与标签／Release 需用户另行同意；任务来源见 GitHub issues。
- 领域模块只依赖所属领域的接口，不导入 `obsidian` 或使用 Node 文件系统。
- 禁止模型响应直接驱动写入。移动和插入必须经过用户确认的计划 ID，执行时再次校验版本。
- 按原始 UTF-16 偏移写入编辑器。Jev 调用经过共享调度、预算和过期校验。
- 不记录凭据、正文、完整请求和用户文件。不使用真实知识库作为测试夹具。
- 并行 agent 只修改分配的模块；需要变更契约时先联系主 agent。每个 agent 使用自己的分支／工作区，不切换其他工作区分支。
- 主 agent 负责 UI 和最终单元、集成、构建验证。子 agent 完成模块后提交，并报告未覆盖的边界。
