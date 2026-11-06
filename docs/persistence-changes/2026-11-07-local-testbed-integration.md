---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-07-local-testbed-integration

English | [中文](2026-11-07-local-testbed-integration.zh.md)

## Summary

Adds durable input edits and admission receipts, per-Session context-window overrides, MCP discovery decisions and snapshots, and source-attributed memory context.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing native events remain readable without new optional context-window fields. New input-edit and MCP event types are required records: readers that do not know them refuse the stored log before replay, rather than dropping decisions. The tool-memory source uses the existing snapshot form and sections; readers interpret that form independently of the extensible source kind, while plugins that require a particular kind continue to select their own kind. No previous source alternative is removed. The new reader narrowly recognizes ignorable plugin:user/message-edit and plugin:user/message-admit aliases, validates their messages and targets, and coalesces same-identity materialization without rewriting raw events. Frozen migrations are unchanged: old V3 logs with unmarked admission events or interrupted-turn coordinate shifts may still refuse and require explicit recovery; downgrade is not supported. Cached projections have increasing state versions and rebuild from logs when incompatible.

<a id="verification"></a>
## Verification

Session and Query regression suites: 28 files, 781 tests passed. Token meter: 139 tests passed. Session turn outline recovery, including native and plugin edit materialization and checkpoint suffix hydration, passed. Storage validation, memory lifecycle, and MCP discovery: 10 files, 239 tests passed. Agent-loop context-budget and API edit-message regressions, including returning to model defaults and current-principal attribution, passed. Host, Client, Web, and Desktop artifact build: 8 gates passed. Frozen migration generations were not edited.

<a id="dev-note"></a>
## Dev Note

None.
