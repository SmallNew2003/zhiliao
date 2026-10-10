---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-09-message-edit-resend

[English](2026-10-09-message-edit-resend.md) | 中文

## 概述

新增最近用户输入编辑及准备文字接纳事件。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-09-message-edit-resend
baseline: false
changes:
  - root: "event:user/message-admit"
    previous: null
    after: "7de7e84235b2b4ebe3d135d4cb58774a063d7146f2ff10376d2e6f4586e86331"
    decision: same-version
  - root: "event:user/message-edit"
    previous: null
    after: "3a51924d76534ecc7e7c464b5b873653b8493b89b3d3760bd0c227f6bdbf83e9"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

必需的 user/message-edit 与 user/message-admit 词汇扩展当前格式，不修改已有字段或表层操作变体。已有日志仍有效；不认识这些必需类型的读取器拒绝更新日志。原始事件保持仅追加，编辑历史由确定性的折叠恢复。

<a id="verification"></a>
## 验证

核心编辑与表层：70 个测试通过。API、图片卸载与计量聚焦测试：160 个测试通过。查询、引用、循环与提示词集成：218 个测试通过。UI 所属包：401 个测试通过。

<a id="dev-note"></a>
## 开发备注

无。
