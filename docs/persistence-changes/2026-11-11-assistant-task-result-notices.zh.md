---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-11-11-assistant-task-result-notices

[English](2026-11-11-assistant-task-result-notices.md) | 中文

## 概述

新增 assistant-task 消息来源，携带任务及执行 Session 标识、通知形式和单行摘要。助理结果沿用现有收件箱和消息事件。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-11-11-assistant-task-result-notices
baseline: false
changes:
  - root: "event:agent/inbox/spliced"
    previous: "2026-11-07-local-testbed-integration"
    after: "a9580cf91f193a2360dfdbb8fc12c6a654dbd95e5919048b4aa15d24b8fdffe4"
    decision: same-version
  - root: "event:developer/message"
    previous: "2026-11-07-local-testbed-integration"
    after: "164a90201cc87db4d24c07943b43f30abbffd240315f4f1f0309a16e6de85346"
    decision: same-version
  - root: "event:session/title-llm-request"
    previous: "2026-11-07-local-testbed-integration"
    after: "d2a90f1b500a6b053d2235cf484d4ac9192ce014dfbb351c2aadcbab8d32c2cf"
    decision: same-version
  - root: "event:user/message"
    previous: "2026-11-07-local-testbed-integration"
    after: "5a28999363dc6b4ed28b1e451f914e385285f83b6e25d62c76d39f30e903977e"
    decision: same-version
  - root: "event:user/message-admit"
    previous: "2026-11-07-local-testbed-integration"
    after: "c02345c4a6cad9cd3fceb47e19415bf308e9878b16fb5f4964f3bc3e17a5c2ec"
    decision: same-version
  - root: "event:user/message-edit"
    previous: "2026-11-07-local-testbed-integration"
    after: "61e72400ba9a6fcc3164e1a99b8ba26b5d1c437cf6f1054dce208a5a94f1a1d6"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

原有消息来源、字段和事件继续按原义读取。助理通知只写入现有的 agent/inbox/spliced，接纳后写入普通 user/message。发布的 V4 收件箱与 Session 历史保留该通知的消息标识、来源和文字，Chat 根据 notice 形式与未知 producer 的 kind 展示注入通知。developer/message、session/title-llm-request、user/message-admit、user/message-edit 的声明因共用消息来源类型而变化。助理不在这些事件上生产通知，现有 developer 角色和人类消息编辑、重新接纳检查继续生效。Session 格式保持 V4。独立的助理存储域版本 2 读取版本 1，不推测缺失的创建者。

<a id="verification"></a>
## 验证

助理与 LiveShare 的五个文件共 41 项测试通过，覆盖带归属的收件箱追加与回放、未知投递收据、只读恢复执行结果、存储读取失败、诊断脱敏、单行通知长度、已退役创建者和版本 1 读取。命令：vitest run packages/assistant/task/tests packages/assistant/tool-task/tests packages/experimental/liveshare/tests/endpoint-classification.spec.ts。 独立检查以带归属的 assistant-task 通知执行发布标签 dsh-v0.2.0-rc.2 的收件箱 fold、Session 校验与历史派生、Chat 上下文分类，消息标识、来源和文字均保留。正式包自引用消费者及独立 NodeNext 消费者均通过已发射声明的编译。

<a id="dev-note"></a>
## 开发备注

无。
