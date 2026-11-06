---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-07-local-testbed-integration

[English](2026-11-07-local-testbed-integration.md) | 中文

## 概述

增加持久化输入编辑与准入回执、Session 上下文窗口覆盖、MCP 发现决策与请求快照，以及带来源的记忆上下文。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-07-local-testbed-integration
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "2a2f5ba18706d8a3429665570c59a963408e8815d592c14dae5e644a4cb99894"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "55c331bebecc38d772a3db9ebabd7ee6beab9d7c8e4b8b8d996f3336ebbf8ec6"
    decision: same-version
  - root: "event:mcp/diagnostic"
    previous: null
    after: "fd799362bcd5609155c506e902eded2d8eb7a225b27e29633453d888b2cb996d"
    decision: same-version
  - root: "event:mcp/request-snapshot"
    previous: null
    after: "c69c18c3311c512820339fcdcfe1e59679d13a11c8885360d31b958dfb8c5c4c"
    decision: same-version
  - root: "event:mcp/selection"
    previous: null
    after: "1771168491be719a2635410d0307d1d96c838c47d1f088345f0999c801bce309"
    decision: same-version
  - root: "event:mcp/selector-request"
    previous: null
    after: "155628d1a76c7cf23e9abaf44a8636623e1f613c1b070aac4d079f6b87d8ea2f"
    decision: same-version
  - root: "event:mcp/selector-result"
    previous: null
    after: "5944401746ca522fc3073ddbbc85ec0951073da07be0d5a3b9616c3f301d4cfe"
    decision: same-version
  - root: "event:model/selection"
    previous: "2026-09-11-initial"
    after: "6a23795908e0e7fbe0ca4bb41fc14122df66a6b2c59413c8d2523e907df03bdf"
    decision: same-version
  - root: "event:request/header"
    previous: "2026-09-16-session-format-v4"
    after: "6b0f8273b310b61007d9ffa854378c8f4f0641ae1489f26b3499224106439aac"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "74668d5e0eff413628b2e366da97a243d86b3fc0506a77f0c747262252de9d5a"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-10-13-liveshare-share-viewer-principal"
    after: "5ecf2b8e116b2e293a933b9c88b6709ac9cc218b1c6a69a447db57fd858897fc"
    decision: same-version
  - root: "event:user/message-admit"
    previous: null
    after: "9cfabf0b3875608a53f7aa47048ac9a0f5ab5772530d7998303313466eda7ffa"
    decision: same-version
  - root: "event:user/message-edit"
    previous: null
    after: "334a4ba65f55fad50e83131c0e9c39ba19144ad60c336f5f5e641d8e45adde39"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有原生事件在缺少新增可选上下文窗口字段时仍可读取。新的输入编辑与 MCP 事件是必读记录：不认识事件类型的旧读取器在回放前拒绝日志，不会丢弃这些决策。tool-memory 来源沿用现有 snapshot form 与 sections；读取器按 form 解释上下文，不依赖可扩展的来源 kind，需要特定 kind 的插件仍只选择自己的来源。没有删除原有来源分支。新读取器仅识别带 ignorable 标记的 plugin:user/message-edit 与 plugin:user/message-admit 别名，校验消息与目标，并合并相同身份的物化消息，不改写原始事件。冻结迁移保持不变：含未标记准入事件或中断轮次坐标偏移的旧 V3 日志仍可能拒绝恢复，需要明确的恢复步骤；不支持降级。投影缓存递增状态版本，不兼容时从日志重建。

<a id="verification"></a>
## 验证

Session 与 Query 回归共 28 文件、781 项通过；Token meter 共 139 项通过；包含 native/plugin 编辑物化及 checkpoint 后缀恢复的轮次大纲回归通过。存储校验、记忆生命周期与 MCP 发现共 10 文件、239 项通过。Agent-loop 上下文预算与 API 消息编辑回归通过，覆盖恢复模型默认值及当前操作者归属。Host、Client、Web、Desktop 产物构建共 8 个门禁通过。没有编辑冻结迁移代。

<a id="dev-note"></a>
## 开发备注

无。
