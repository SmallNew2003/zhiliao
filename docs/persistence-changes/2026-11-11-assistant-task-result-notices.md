---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-11-11-assistant-task-result-notices

English | [中文](2026-11-11-assistant-task-result-notices.zh.md)

## Summary

Introduces the assistant-task message source carrying the task and execution Session ids, notice form, and one-line summary. Assistant results use existing inbox and message events.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing sources, fields and event meanings remain readable. The assistant writes an identified notice through agent/inbox/spliced and ordinary user/message on admission. The released V4 inbox and Session history preserve its id, source and text. Chat uses the notice form and the unknown producer’s kind to display an injected notice. The declarations for developer/message, session/title-llm-request, user/message-admit and user/message-edit change through their shared message source type. The assistant emits no notices on those paths. Existing developer-role, human-edit and human-readmission checks continue to apply. The Session format remains V4. Separately, assistant storage domain version 2 reads version 1 without inferring a missing creator.

<a id="verification"></a>
## Verification

Five assistant and LiveShare test files pass 41 cases covering attributed inbox append and replay, uncertain receipts, read-only worker outcome recovery, failed storage reads, diagnostic redaction, one-line notice bounds, retirement and version 1 reads. Command: vitest run packages/assistant/task/tests packages/assistant/tool-task/tests packages/experimental/liveshare/tests/endpoint-classification.spec.ts. Independent checks executed the inbox fold, Session validator/history derivation and Chat context classification from released tag dsh-v0.2.0-rc.2 against an attributed assistant-task notice; id, source and text were preserved. Both the formal package self-reference consumer and the independent NodeNext consumer compiled against the emitted declarations.

<a id="dev-note"></a>
## Dev Note

None.
