---
description: "Package map for the long-term memory capability family: the memory service, its hindsight HTTP provider, and the session-lifecycle wiring that recalls, retains, and seeds a workspace's memory."
kind: "package-group"
---

# memory/ — long-term memory capability family

English | [中文](README.zh.md)

## Summary

The `memory/` packages let an agent recall workspace decisions and retain useful conversation context. The memory service selects a provider; the Hindsight adapter connects it to an HTTP daemon. A separate consumer owns lifecycle enrichment and model-facing tools. Provider failures remain explicit, while lifecycle enrichment can degrade without failing the user's turn.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The service, provider, and lifecycle consumer can be composed independently.

| Package | Role | ctx key |
|---|---|---|
| [`memory/`](memory/README.md) | Memory service: bank resolution plus recall, search, and retention through interchangeable providers | `ctx.memory` |
| [`hindsight-http/`](hindsight-http/README.md) | Provider backed by a hindsight HTTP daemon; resolves a bank per workspace | registers on `ctx.memory` |
| [`tool-memory/`](tool-memory/README.md) | Consumer: opening recall, turn retention, cold-bank seeding, and the `hindsight_search` / `hindsight_remember` tools | consumes `ctx.memory` |

<a id="related-documentation"></a>
## Related documentation

- [Memory subsystem](../../docs/subsystems/memory.md) — bank identities, provider operations, and browser values.
- [Web client](../../docs/subsystems/web-client.md) — how the memory browser panel is mounted
- [Adding a package](../../docs/cookbook/adding-a-package.md) — the seam/provider/consumer split this group follows

<a id="dev-note"></a>
## Dev Note

None.
