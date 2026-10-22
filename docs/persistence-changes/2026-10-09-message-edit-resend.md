---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-09-message-edit-resend

English | [中文](2026-10-09-message-edit-resend.zh.md)

## Summary

Adds latest user input editing and prepared-text admission events.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Required user/message-edit and user/message-admit vocabulary extends the current format without changing existing fields or surface operation variants. Existing logs remain valid; readers without these required types refuse newer logs. Raw events stay append-only and deterministic folding restores edited history.

<a id="verification"></a>
## Verification

Core edit/surface: 70 tests passed. API/offload/token focused suites: 160 tests passed. Query/reference/loop/prompt integration: 218 tests passed. UI owning packages: 401 tests passed.

<a id="dev-note"></a>
## Dev Note

None.
