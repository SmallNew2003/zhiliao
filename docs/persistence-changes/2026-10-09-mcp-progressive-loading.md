---
description: "Records a persistence type transition and its compatibility acknowledgement."
kind: persistence-change
---

# 2026-10-09-mcp-progressive-loading

English | [中文](2026-10-09-mcp-progressive-loading.zh.md)

## Summary

Adds durable MCP selections, direct-target diagnostics, exact auxiliary requests and outcomes, and request-bound MCP definitions, SDK text and instructions.

## Table of Contents

- [Declaration](#declaration)
- [Compatibility](#compatibility)
- [Verification](#verification)
- [Dev Note](#dev-note)

<a id="declaration"></a>
## Declaration

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
## Compatibility

Existing logs remain valid. New events use the released envelope without changing its structural version. Builds that do not know these required event types reject logs containing them; no downgrade or fallback is implied. Selection projections use only retained events and execution checks preserve recorded definition identities.

<a id="verification"></a>
## Verification

pnpm exec vitest run packages/mcp/mcp-discovery/tests/discovery.spec.ts packages/mcp/mcp-discovery/tests/lifecycle.spec.ts: 68 tests passed. Focused PTC production-loop in-history release test passed.

<a id="dev-note"></a>
## Dev Note

None.
