---
description: "Remote projection of the long-term memory a deployment retains: bank listing, per-bank statistics, the knowledge-page tree, knowledge-base search, page bodies, memory-unit paging, and the two writes a person performs, for the browser memory panel."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-memory-controller

English | [中文](README.zh.md)

## Summary

Clients call eight methods on the `memoryController` namespace to display and edit a deployment's long-term memory: `list` for the banks, `stats` for one bank's totals and distributions, `pages`, `search`, and `page` for its knowledge pages, `units` for one page of its memory units, and `remember` and `curate` for the two writes a person performs. Every method answers a structured status instead of throwing — memory off, misconfigured, unsupported by the provider, unreachable, or failed — and calls through the memory seam's browse surface, so the panel works against whichever provider is mounted rather than binding to one backend.

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

### Paging through a bank's memory units

`memoryController/units` returns one page of a bank's memory units — the individual facts the backend extracted, which the statistics and knowledge pages summarize but never list. Each unit carries its text and, when the backend reports them, its fact type, context, tags, and mention and update instants. The caller's `query` is a case-insensitive substring filter over unit text and context, and `factType` restricts to one backend classification; an empty filter is dropped rather than sent, and the page size is clamped into `[1, 100]` with a default of 20. The answer carries the backend's total for the current filter, so a client can page without counting. The listing is a scan on the daemon, not an inference call: it is the browsing aid, while the seam's own search remains the inference-priced lookup the agent uses.

### Writing memory

`memoryController/remember` records one finding: the text, stated so it still makes sense out of context, and an optional context the backend files it under. Retention is asynchronous on backends that extract facts by inference, so the answer reports acceptance and carries the backend's operation detail; the unit becomes listable once extraction finishes, and a client refreshes to show it. An empty finding is refused before any call, as `remembered: false` with a detail naming why.

`memoryController/curate` edits one existing unit: replacement text, context, or fact type, sent only when the caller passes them. A curation that changes nothing is refused the same way, as is one that would empty the text. A backend that refuses the fact type — hindsight declines the facts it derives — answers with the backend's own message as the outcome's detail, which the client shows verbatim.

### Unavailability is an answer, not an exception

Every method answers `available: false` with a `reason` and a `detail` instead of rejecting. The four reasons are:

| Reason | Meaning |
|---|---|
| `unavailable` | No usable provider is registered, so memory is switched off for this deployment. No socket is opened. |
| `misconfigured` | The Host pinned a provider id that is not registered, or several usable providers compete with none pinned. Both are fixed by configuring one provider id. |
| `unsupported` | The provider answered, but offers no browse surface, or not the section asked for — a backend that serves the agent path only. The fix is to point the deployment at a provider that browses. |
| `unreachable` | The daemon did not answer within the configured budget. |
| `failed` | The daemon answered an error, answered a non-JSON body, does not have the bank, or the transport failed. |

This matters because a rejected Remote call reaches a browser as an opaque transport failure with no way to say which backend condition happened, and *memory is not available in this build* and *the daemon is down* call for different user responses. `detail` carries the Host's or provider's own words, for the cases where the reason alone does not explain enough.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

### Design concept

The `memory` seam owns the browse surface for a person exactly as it owns recall, search, and retention for the agent: the surface's vocabulary — banks, statistics, knowledge pages, memory units, and the write outcomes — is declared once by the seam, and this controller projects it over Typert Remote. A controller that spoke to a daemon directly would bind the panel to one backend, which is what the seam exists to prevent; a controller that projected its own copy of the vocabulary would let the wire and the seam drift apart.

The surface is resolved per call through `ctx.memory.browse()`, so a provider that appears or disappears between calls is honoured, and the classification of a missing or misconfigured provider happens before any socket opens. A provider without a browse surface — or without one of the optional statistics and knowledge-page members — refuses with `MEMORY_CAPABILITY_UNSUPPORTED`, which projects onto the `unsupported` reason: a backend that serves the agent path only is a valid deployment, and the panel says so in place of the section rather than failing every read.

### Endpoint ownership

This package maps no endpoints. The daemon's URLs, their timeouts, and their response projections belong to the provider — the shipped one is [`dsh-memory-hindsight-http`](../../memory/hindsight-http/README.md) — so a second backend mounts without touching this controller. The wire ids a client passes back in are provider-owned and are branded at the seam boundary; `memories/recall` is deliberately not projected by any method here, because it runs inference server-side and answers in over a minute, which is unusable for an interactive page.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | `MemoryController`: the `memoryController` Remote service, the seam-browse delegation, and the seam-taxonomy projection |
| [`src/types.ts`](src/types.ts) | Wire vocabulary: the status envelope and per-method payloads, with the browse vocabulary re-exported from the seam |
| — | No runtime invariant companion is published; every answer is projected directly from the seam's surface. |

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


These limits define what this browse-and-write surface cannot do. They are current package constraints, not a task backlog.

- **Search covers knowledge pages, not memories** — `search` queries the curated knowledge index because the seam's memory search runs inference server-side and answers in over a minute; the unit listing's substring filter is the fact-level aid available through this Remote, and it scans rather than ranks.
- **No deletion and no history** — the writes record and curate; nothing here deletes a unit, triggers consolidation, or records what changed since the previous read. A backend that owns a delete endpoint would need a seam member before this Remote could project one.
- **Availability is a gate, not a diagnosis** — the controller reports that memory is unavailable, not which provider registered or why its backend is unhealthy; the provider's own logs hold that.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

The daemon's REST surface is read directly here rather than through a provider, so an endpoint rename on the daemon side surfaces as a `failed` answer rather than a compile error. The bank listing and statistics envelopes are read field by field for that reason; a shape change degrades a count to `0` instead of throwing. The knowledge-base search endpoint is the one whose latency profile matters — it is the only endpoint a page calls per keystroke, and unlike `memories/recall` it is an index lookup rather than an inference run.

</details>