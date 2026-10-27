---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-10-context-window-selection

[English](2026-10-10-context-window-selection.md) | 中文

## 概述

在模型选择与请求头中记录可选的调用方上下文预算。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-10-context-window-selection
baseline: false
changes:
  - root: "event:model/selection"
    previous: "2026-09-11-initial"
    after: "6a23795908e0e7fbe0ca4bb41fc14122df66a6b2c59413c8d2523e907df03bdf"
    decision: same-version
  - root: "event:request/header"
    previous: "2026-09-11-initial"
    after: "bb4dd800fc872ab4ec0307393cd0c293f42331ed010d417c4767cdc5da5a47b3"
    decision: same-version
```

<a id="compatibility"></a>
## 兼容性

已有选择和请求头仍然有效。缺少 contextWindow 时继承适配器配置的容量；提供正整数时设置请求和压力压缩的有效预算。模型选择派生投影递增状态版本并从事件日志重建。保留已提交的 Session 代际文件。

<a id="verification"></a>
## 验证

运行时、模型选择、压缩和 Session 种子定向测试通过，共 379 个。新增 TypeScript 与 Python SDK 场景在重建的运行时中确认请求头与有效请求上下文均保留 640000 token 预算。

<a id="dev-note"></a>
## 开发备注

无。
