---
description: "记录持久化类型更改及其兼容性确认。"
kind: persistence-change
---

# 2026-10-09-mcp-progressive-loading

[English](2026-10-09-mcp-progressive-loading.md) | 中文

## 概述

新增持久化 MCP 选择、直接指定诊断、辅助请求确切输入及结果，以及绑定主请求的 MCP 定义、SDK 文字和服务器说明。

## 目录

- [声明](#declaration)
- [兼容性](#compatibility)
- [验证](#verification)
- [开发备注](#dev-note)

<a id="declaration"></a>
## 声明

```yaml persistence-change
schemaVersion: 1
id: 2026-10-09-mcp-progressive-loading
baseline: false
changes:
  - root: "event:mcp/diagnostic"
    previous: null
    after: "fd799362bcd5609155c506e902eded2d8eb7a225b27e29633453d888b2cb996d"
    decision: same-version
  - root: "event:mcp/request-snapshot"
    previous: null
    after: "54a21b94ddd4a57fa7a4c8ccc04601d1104bbd00e178b43cbf953a47e185f0d1"
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
```

<a id="compatibility"></a>
## 兼容性

现有日志继续有效。新事件沿用已发布的事件封装，不改变结构版本。不认识这些必读事件类型的旧构建会拒绝含有它们的日志；不意味着支持降级或回退。选择投影只消费保留事件，执行检查保留日志记录的定义标识。

<a id="verification"></a>
## 验证

pnpm exec vitest run packages/mcp/mcp-discovery/tests/discovery.spec.ts packages/mcp/mcp-discovery/tests/lifecycle.spec.ts：68 个测试通过。PTC 真实循环中的 in-history 释放专项测试通过。

<a id="dev-note"></a>
## 开发备注

无。
