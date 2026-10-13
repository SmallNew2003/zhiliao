---
description: "Read-only Remote projection of the long-term memory a deployment retains: bank listing, per-bank statistics, the knowledge-page tree, knowledge-base search, and page bodies, for the browser memory panel."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-memory-controller

English | [中文](README.zh.md)

## Summary

Clients call five read-only methods on the `memoryController` namespace to display what a deployment's long-term memory holds: `list` for the memory banks with their fact counts and last write, `stats` for one bank's totals and distributions, `pages` for a bank's knowledge pages, `search` for the knowledge index, and `page` for one page's body. Every method answers a structured status instead of throwing, so a browser can say *which* condition it hit — memory switched off, the deployment misconfigured, the daemon unreachable, or the request failed — rather than showing a generic transport error.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

-----

<a id="use-this-package"></a>
## Use this package

Mount this package beside the [memory seam](../../memory/memory/README.md) and a provider, then call the `memoryController` namespace from a client. The Remote is the only entry point: the service is Remote-only and deliberately declares no same-process Cordis `Context` merge. Its service key is `memoryController`, which is distinct from the seam's own `memory` key, so mounting this package never shadows the capability it reads.

### Reading the banks

`memoryController/list` returns each bank the daemon holds: its provider-owned id, published display name, fact count, and last-write instant when the backend reports one. The id contains `::` because hindsight keys banks as `<prefix>::<project>`; a client building any follow-up URL from it must percent-encode it. A row the backend omitted an id for is skipped rather than listed as an unopenable bank.

### Reading one bank's statistics

`memoryController/stats` takes a bank id and returns that bank's totals — nodes, links, documents — plus its node counts per fact type and its link counts per link type, both ranked largest first so the ordering does not depend on how the backend serialized them, and its pending and failed operation counts. An absent or non-numeric field reads as `0` rather than failing the call: a partial count on a page is more useful than no page. This is the block a client renders as the bank's composition, not a health verdict — pending and failed operations are what the backend reports, not what this package judges.

### Browsing and searching knowledge pages

`memoryController/pages` returns a bank's knowledge pages as one flat, depth-first list: each page's id, name, the prompt it was generated from, its last-refresh instant, and whether the backend marked it stale. A tree node without an id is skipped *with its subtree kept* — its children are addressed by their own ids, so dropping the parent loses no reachable page.

`memoryController/search` searches the **knowledge index**, not the seam's `search`. That distinction is the load-bearing one: the seam's search answers by running inference on the daemon and takes a minute or more, which a browser panel cannot wait for, so this controller queries the curated knowledge pages instead and returns the hits with the backend's own total match count. A hit with no id or no snippet is dropped, because a hit the page can neither open nor quote is not a hit. The caller's limit is clamped into `[1, 100]` and defaults to 20, so a client cannot ask the daemon for a whole bank.

`memoryController/page` takes a bank id and a page id and returns that page's name and Markdown body. A page the backend has no body for answers as an available read carrying no page, rather than as a failure: the request succeeded and there was nothing to show.

### Unavailability is an answer, not an exception

Every method answers `available: false` with a `reason` and a `detail` instead of rejecting. The four reasons are:

| Reason | Meaning |
|---|---|
| `unavailable` | No usable provider is registered, so memory is switched off for this deployment. No socket is opened. |
| `misconfigured` | The Host pinned a provider id that is not registered, or several usable providers compete with none pinned. Both are fixed by configuring one provider id. |
| `unreachable` | The daemon did not answer within the configured budget. |
| `failed` | The daemon answered an error, answered a non-JSON body, does not have the bank, or the transport failed. |

This matters because a rejected Remote call reaches a browser as an opaque transport failure with no way to say which backend condition happened, and *memory is not available in this build* and *the daemon is down* call for different user responses. `detail` carries the Host's or provider's own words, for the cases where the reason alone does not explain enough.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

The `memory` seam owns recall, search, and retention for the agent's hot path, and deliberately does not project banks, statistics, or knowledge pages, because nothing on the agent path needs them. This controller adds that browse surface for a human, so it reads the daemon's REST endpoints directly rather than widening the seam — a seam that grew a display-only projection would put UI vocabulary on the agent's critical dependency.

Availability is read through `ctx.memory.isAvailable()` before each request, because that is the cheap synchronous answer: a deployment with memory switched off costs no socket. `isAvailable()` never throws, so a misconfigured provider id is simply *not available* here rather than a second failure to classify; the misconfigured reason is reachable only when a provider's own request path raises it.

### Endpoint mapping

| Method | Daemon endpoint |
|---|---|
| `list` | `GET /v1/default/banks` |
| `stats` | `GET /v1/default/banks/{bank}/stats` |
| `pages` | `GET /v1/default/banks/{bank}/knowledge-base/tree` |
| `search` | `GET /v1/default/banks/{bank}/knowledge-base/search?q=&limit=` |
| `page` | `GET /v1/default/banks/{bank}/knowledge-base/pages/{page}` |

Every path segment is percent-encoded, because the bank id contains `::` and the page id may contain anything. `memories/recall` is deliberately not called from any method here: it runs inference server-side and answers in over a minute, which is unusable for an interactive page.

### Transport

Each request is a bounded `GET` under `AbortSignal.timeout`. A timeout, an unreachable socket, a `404`, a non-2xx status, and a non-JSON body each become a classified `MemoryError` at the request boundary, which `answer()` then projects onto the wire reason. Reads tolerate a bare array or a `{ field: [...] }` envelope, so a backend that drops the envelope still answers.

### Configuration

`baseUrl` (default `http://127.0.0.1:9077`) and `timeoutMs` (default `10000`) are the whole config surface. The default budget is the provider's *cheap-metadata* budget, not its inference budget, because every endpoint used here is a metadata read. A trailing slash on `baseUrl` is stripped, so `http://host:9077/` and `http://host:9077` behave alike.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `MemoryController`: the `memoryController` Remote service, the daemon transport, and the seam-taxonomy projection |
| [`src/types.ts`](src/types.ts) | Public payload types: `MemoryBankSummary`, `MemoryBankStats`, `MemoryKnowledgePage`, `MemoryKnowledgeHit`, `MemoryAnswer` |
| — | No runtime invariant companion is published; every answer is projected directly from the daemon's response. |

Typert generates the Host and Client Remote artifacts exposed by `./typert` and `./remote`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these when the browse contract is not enough: the capability being projected, the daemon behind it, and the surface that renders it.

- [Memory capability seam](../../memory/memory/README.md) — the `ctx.memory` provider registry whose availability this controller gates on.
- [hindsight HTTP provider](../../memory/hindsight-http/README.md) — the provider that registers the daemon this controller reads.
- [Memory browser](../../client/ui-memory-browser/README.md) — the browser-side panel that renders these answers.
- [Remote assembly](../../api/remotes/README.md) — how clients consume `memoryController.*` without importing the Host implementation.

-----

<a id="model-experience"></a>
## Model Experience

None, as the host-side read-only memory projection registers nothing model-facing.

#### KV Cache effect

None; this package neither assembles nor sends a provider request.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define what a read-only browse surface cannot do. They are current package constraints, not a task backlog.

- **Search covers knowledge pages, not memories** — `search` queries the curated knowledge index because the seam's memory search runs inference server-side and answers in over a minute; a fact-level search is therefore not available through this Remote.
- **Raw memories are not projected** — the daemon's memory rows carry provider-internal context this package does not map, so the surface shows banks, statistics, and knowledge pages rather than individual memory units.
- **No writes and no history** — nothing here retains, edits, consolidates, or deletes, and a snapshot carries no record of what changed since the previous read.
- **Availability is a gate, not a diagnosis** — the controller reports that memory is unavailable, not which provider registered or why its backend is unhealthy; the provider's own logs hold that.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The daemon's REST surface is read directly here rather than through a provider, so an endpoint rename on the daemon side surfaces as a `failed` answer rather than a compile error. The bank listing and statistics envelopes are read field by field for that reason; a shape change degrades a count to `0` instead of throwing. The knowledge-base search endpoint is the one whose latency profile matters — it is the only endpoint a page calls per keystroke, and unlike `memories/recall` it is an index lookup rather than an inference run.

</details>