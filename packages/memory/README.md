---
description: "Package map for the long-term memory capability family: the memory service, its hindsight HTTP provider, and the session-lifecycle wiring that recalls, retains, and seeds a workspace's memory."
kind: "package-group"
---

# memory/ — long-term memory capability family

English | [中文](README.zh.md)

## Summary

The `memory/` packages give an agent a durable memory of a workspace: what was decided earlier, what conventions hold, and what the repository is about. Recall runs when a session opens, retention runs when a turn closes, and a cold bank is seeded from recent commits. A provider-neutral seam, a concrete provider, and a model-facing consumer keep the backing store swappable.

Recall is served by a hindsight daemon that runs inference to answer a query. A slow or absent daemon therefore costs a warning and an unserved turn, never a failed turn: every lifecycle listener degrades rather than propagating.

## Table of Contents

- [Packages](#packages)
- [How memory flows](#how-memory-flows)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

| Package | Role | ctx key |
|---|---|---|
| [`memory/`](memory/README.md) | Memory service: bank resolution plus recall, search, and retention through interchangeable providers | `ctx.memory` |
| [`hindsight-http/`](hindsight-http/README.md) | Provider backed by a hindsight HTTP daemon; resolves a bank per workspace | registers on `ctx.memory` |
| [`tool-memory/`](tool-memory/README.md) | Consumer: opening recall, turn retention, cold-bank seeding, and the `hindsight_search` / `hindsight_remember` tools | consumes `ctx.memory` |

<a id="how-memory-flows"></a>
## How memory flows

1. **Session opens.** `tool-memory` resolves the workspace's bank (`coding-agent::<checkout>`) and, if the bank is cold, seeds it from recent commit subjects. Both run detached so neither delays the first prompt.
2. **First request.** `agent/pre-step` recalls memories relevant to the opening prompt and appends them as a durable user-role message framed as background knowledge that may be stale.
3. **Turn closes.** `agent/turn-stopping` retains the finished exchange; the backend extracts facts asynchronously.
4. **Model asks.** `hindsight_search` looks up something the injected memory did not cover; `hindsight_remember` records a finding worth keeping deliberately.

Delegated subagent sessions carry no bank of their own: they inherit the parent's workspace but a different working set, and folding them into the parent's memory would interleave two conversations.

<a id="related-documentation"></a>
## Related documentation

- [Web client](../../docs/subsystems/web-client.md) — how the memory browser panel is mounted
- [Adding a package](../../docs/cookbook/adding-a-package.md) — the seam/provider/consumer split this group follows

<a id="dev-note"></a>
## Dev Note

This group publishes no `./invariant` companion: it holds no cross-cutting observation that could drift from another package's. The seam and provider are exercised against a scripted daemon, and the lifecycle wiring against emitted agent events.
