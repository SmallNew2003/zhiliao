---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-10-context-window-selection

English | [中文](2026-10-10-context-window-selection.zh.md)

## Summary

Records an optional caller-selected context budget in model selections and request headers.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing selections and request headers remain valid. An absent contextWindow inherits the configured adapter capacity; a present positive integer sets the effective request and pressure-compaction budget. The derived model-selection projection advances its state version and rebuilds from the event log. Committed Session generations are preserved.

<a id="verification"></a>
## Verification

Focused runtime, model-selection, compaction and Session seed tests passed (379 tests). New TypeScript and Python SDK scenarios confirm that request headers and effective request context both retain a 640000-token budget against the rebuilt runtime.

<a id="dev-note"></a>
## Dev Note

None.
