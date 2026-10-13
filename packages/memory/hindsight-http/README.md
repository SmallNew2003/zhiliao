---
description: "The hindsight HTTP memory provider: how a ctx.memory backend attaches to a local hindsight daemon, resolves per-workspace banks, and bounds server-side inference latency across recall, search, and retention."
kind: "package-reference"
---

# @deepseek-ai/dsh-memory-hindsight-http

English | [中文](README.zh.md)

## Summary

Use `dsh-memory-hindsight-http` to back `ctx.memory` with a hindsight daemon over HTTP. It resolves one memory bank per workspace, answers recall and search through hindsight's hybrid index, retains finished transcripts, and maps every transport and status failure onto `MemoryError`. Choose it when the deployment already runs a local hindsight daemon. Budget for latency: recall and search are answered by server-side inference, so a single call can exceed a minute and `recallTimeoutMs` defaults to two minutes. Callers on the agent hot path must catch `MEMORY_BACKEND_TIMEOUT` and continue.

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

A composition that wants hindsight-backed memory loads the `dsh-memory` service first, then mounts this provider. The plugin registers a `MemoryProvider` under the id `hindsight`, so a deployment with a single mounted backend can leave `provider` unset and let the seam auto-select.

### When to choose it

Choose this provider when a hindsight daemon is reachable over HTTP and you want its banks, its hybrid recall, and its fact extraction without writing a backend. Because the default `baseUrl` points at a daemon on the same machine, WorkBuddy and this Harness read and write the same memory store, so a fact learned in one toolchain is recallable in the other. You do not need it when memory should be process-local — the seam has no other shipped backend. Every operation requires a live daemon: with none, `available()` reports false and seam calls raise `MEMORY_PROVIDER_UNAVAILABLE`.

### Minimal configuration

```yaml
- name: '@deepseek-ai/dsh-memory'
- name: '@deepseek-ai/dsh-memory-hindsight-http'
```

| Field | Default | Meaning |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:9077` | Daemon base URL; trailing slashes are stripped |
| `defaultBankSuffix` | `main` | Bank id suffix for a workspace with no resolvable project name |
| `metadataTimeoutMs` | `5000` | Timeout for cheap metadata endpoints such as health and bank listing |
| `recallTimeoutMs` | `120000` | Timeout for recall and search, which run inference server-side |
| `retainTimeoutMs` | `30000` | Timeout for retaining a transcript |
| `maxRetainChars` | `200000` | Maximum transcript characters sent in one retention request |

Every numeric field must be a positive finite number; a non-positive or infinite value is rejected at configuration time rather than silently becoming a 1 ms timer. Point `baseUrl` at a remote daemon and raise the timeouts there without touching code.

### Bank naming

Banks are named `coding-agent::<project-directory-name>`, where the project name is the last path segment of the workspace root. Sibling checkouts of the same repository therefore keep separate banks instead of merging into one, and a workspace whose path yields no usable segment falls back to `defaultBankSuffix`. Resolution is `GET /v1/default/banks` followed by a `PUT` that creates the bank when it is absent, so the first session in a new workspace is not a failure.

### Latency is the operational fact

hindsight answers recall and search by running inference, not by looking up an index. A single recall or search can take well over a minute on a cold daemon, which is why `recallTimeoutMs` defaults to 120 seconds while metadata and retention default to seconds. Callers must treat `MEMORY_BACKEND_TIMEOUT` as an expected outcome rather than an exception: the shipped consumer catches it, logs a warning, and runs the turn without the memory. Retention is cheaper than it looks because it is asynchronous — the call returns once the daemon accepted the items, and extraction continues server-side.

### Failures and recovery

Every failure surfaces as `MemoryError` with a routable code: `MEMORY_BACKEND_TIMEOUT` when the daemon did not answer within the class timeout, `MEMORY_BACKEND_ERROR` when it was unreachable, returned a non-2xx status, or answered with something that is not JSON, and `MEMORY_BANK_NOT_FOUND` on a 404. Availability is probed lazily and memoized: `available()` reports true while the first probe is still in flight and caches the result for the process lifetime, so a daemon that dies after a successful probe is discovered on the next call rather than by the probe. To recover, restart the daemon or repoint `baseUrl`; no code change is involved.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the provider; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The provider is built on three deliberate choices:

- **One REST surface, three capabilities.** The daemon's `/v1/default` endpoints cover everything needed: bank listing and creation for resolution, one hybrid recall endpoint for both recall and search, and document retention for finished sessions.
- **Recall and search are the same request.** hindsight exposes search as recall with a limit, so both capabilities share one code path and one timeout budget instead of pretending to be different operations.
- **Every call is bounded and classified.** No request is issued without a timeout, and no failure escapes as a raw transport error; each one is mapped onto the seam's taxonomy so a caller routes on a code rather than on an exception message.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: config schema and defaults, numeric validation, and registration of the provider into `ctx.memory` |
| [`src/provider.ts`](src/provider.ts) | The HTTP client and the `MemoryProvider` implementation: bank resolution, recall/search, retention, and error mapping |
| — | No runtime invariant companion is published; the provider holds no registry and publishes no observation stream beyond its own availability probe. |

### Data model

`HindsightProviderLimits` is the transport-and-behaviour contract the plugin hands the provider: where to talk, how long each class of request may take, and how much transcript one retention request may carry. Two projections shape the seam-facing results. Bank listing is read defensively — both a bare array and a `{ banks: [...] }` envelope are accepted, because only `bank_id` is read from each row. Recall rows are projected onto `MemoryUnit` by skipping any entry without string `id` and `text`, so a malformed backend response degrades to fewer units rather than to a thrown error.

### Request flow

`resolveBank()` derives the bank id from the workspace path, lists banks under the metadata timeout, and creates the bank with a `PUT` when it is missing. `recall()` and `search()` both call `recallUnits()`, which posts `{ query, limit }` to the bank's recall endpoint under `recallTimeoutMs` and returns `truncated: false` — the seam applies the caller's limit afterwards, so the provider does not second-guess the bound. `retain()` converts each transcript turn into one retain item, stops before `maxRetainChars` so a long session cannot produce an unbounded request, and posts with `async: true`.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the seam this provider registers into, to the defensive rules its latency forces on callers.

- [dsh-memory](../memory/README.md) — the seam contract: provider selection, the `MemoryError` taxonomy, and the result cap this provider defers to.
- [Capability seams](../../../docs/capability-seams.md) — how a swappable capability seam is positioned against core services and bundles.
- [Defensive patterns](../../../docs/defensive-patterns.md) — the rules behind catching a slow backend instead of failing a turn.
- [Generated configuration catalog](../../../docs/config-catalog.md) — every accepted config field across the Harness and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Recalled memory content

#### What the model sees

Through the consumer that mounts this provider, the units returned here become the text a model reads as recalled background knowledge. This provider decides what that text contains, because `MemoryUnit.text` is the daemon's own rendering of an extracted fact rather than a verbatim transcript, and each unit is projected with only its `id` and `text`. Recall and search return the same shape, so a model cannot tell from the payload which operation produced it.

#### Token effect

Data-dependent and not bounded by this package: unit text length is whatever the daemon's extraction produced, and the only cap is the caller's `limit`, which the seam applies after this provider returns. Retention is bounded instead, by `maxRetainChars` on the request side.

#### KV Cache effect

No direct effect: this provider registers no prompt section and no schema. Latency is the real cost — a recall that runs to `recallTimeoutMs` delays the turn without changing the reusable request prefix, and a timed-out recall simply contributes no injected content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the provider is incomplete on its own. They are current package constraints.

- **Availability depends on a daemon this package does not manage** — the daemon must already be running; nothing here starts, installs, or supervises it. When it is down, `available()` eventually reports false and seam calls raise `MEMORY_PROVIDER_UNAVAILABLE`, which callers on the hot path must degrade past.
- **Recall latency is high by design** — server-side inference means single calls can exceed a minute and a cold daemon is slower still. `recallTimeoutMs` defaults to 120 seconds, and exceeding it raises `MEMORY_BACKEND_TIMEOUT` rather than returning partial results; there is no streaming or partial-recall mode.
- **A successful health probe is cached for the process lifetime** — `available()` reports `true` while the first probe is in flight and memoizes the outcome, so a daemon that dies after one successful probe is discovered by the next real call, not by the probe.
- **Only a subset of hindsight's REST surface is used** — recall, retain, and the banks endpoints are implemented; mental models, entities, and knowledge-base endpoints are not. A richer management surface belongs to the controller layer rather than to this transport.
- **Search and recall cannot be tuned apart** — both post the same recall payload under the same timeout, so a deployment cannot give search a shorter budget than session-opening recall.
- **Bank ids are derived from the directory name only** — there is no Git-aware project detection, so two unrelated checkouts that share a directory name share a bank, and `defaultBankSuffix` only covers a path with no usable final segment.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above.

#### Future: richer hindsight endpoints

The provider stops at recall, retain, and banks. mental models, entities, and knowledge-base endpoints are deliberately left to a controller above this transport, so exposing them is a matter of widening the controller's vocabulary rather than of teaching this provider a new request shape.

#### Future: a cheaper availability signal

`available()` optimistically reports `true` and memoizes the first probe for the process lifetime, which keeps the hot path free of requests but also means a daemon outage is discovered late. A short TTL on the memoized result would trade a little hot-path cost for faster detection; nothing consumes that today.

</details>
