---
description: "The long-term memory service (ctx.memory): how plugins and tool authors recall, search, and retain durable memory per workspace through interchangeable providers, with one selection policy and error vocabulary."
kind: "package-reference"
---

# @deepseek-ai/dsh-memory

English | [中文](README.zh.md)

## Summary

Use `dsh-memory` to add long-term memory to a composition without binding callers to one backend. It owns a provider registry, resolves a memory bank per workspace, and exposes recall, search, and retention under one selection policy and one error vocabulary. Choose it when a plugin must read or write durable memory across sessions. A backend must be mounted, because the seam itself performs no network access; the shipped `dsh-memory-hindsight-http` provider registers one for you. Callers on the agent hot path are expected to catch `MemoryError` and continue, because memory must never block a turn.

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

A composition that needs long-term memory loads the `dsh-memory` service and mounts at least one provider; plugin and tool authors then call `ctx.memory.resolveBank()`, `ctx.memory.recall()`, `ctx.memory.search()`, and `ctx.memory.retain()` directly. The service resolves the provider for each call, so callers never see provider ids unless they configured one.

### When to choose it

Choose the service when a plugin must remember something across sessions without hard-coding a store; a deployment that only wants hindsight-backed memory mounts the shipped `dsh-memory-hindsight-http` provider. You do not need it when the composition keeps no state beyond the current session. The service adds no network access of its own: without at least one usable provider, every call fails with a structured `MemoryError`.

### Minimal configuration

Load the service and let a single mounted provider auto-select, or pin a provider id with `provider`. The environment variable `$DSH_MEMORY_PROVIDER` feeds the same field and is not a separate priority chain.

```yaml
- name: '@deepseek-ai/dsh-memory'
- name: '@deepseek-ai/dsh-memory-hindsight-http'
```

| Field | Default | Meaning |
|---|---|---|
| `provider` | (unset) | Pinned provider id; unset auto-selects when exactly one is usable |

### Recalling, searching, and retaining

`resolveBank()` maps a workspace directory onto the bank that owns it, creating the bank when absent. `recall()` takes a session's opening prompt and returns the units worth injecting; `search()` takes a free-text query against one bank. Both cap their result to `request.limit`: the service truncates `units[]` and sets `truncated`, so an over-returning provider cannot leak more than the caller asked for. `retain()` hands a finished transcript to the backend and reports what it accepted.

```text
// Resolve the bank that owns this workspace, creating it when absent:
const bankId = await ctx.memory.resolveBank(workspaceRoot)

// Session opening: recall what matters, bounded by limit:
const recalled = await ctx.memory.recall({ prompt, limit: 6 }, bankId)

// Mid-task lookup against the same bank:
const found = await ctx.memory.search({ query: 'why is the retry cap 3?', limit: 8 }, bankId)

// End of session: keep the transcript.
const outcome = await ctx.memory.retain({ turns }, bankId)
```

Every call accepts an optional `AbortSignal` that is forwarded to the provider for cancellation. Callers that own a turn budget should pass one and still catch failures: a memory backend that is slow, unreachable, or misconfigured must cost a degraded turn, never a failed one.

### Provider selection

Each call resolves its provider at execution time, and registration or load order never matters. A configured provider id wins when it is registered and usable; without a configured id, the service runs the single usable provider or fails clearly:

| Situation | Outcome |
|---|---|
| configured id registered and usable | runs that provider |
| configured id not registered | `MEMORY_PROVIDER_CONFIGURED_MISSING` |
| configured id registered but unavailable | `MEMORY_PROVIDER_UNAVAILABLE` |
| no id, exactly one registered usable provider | runs it |
| no id, no usable provider | `MEMORY_PROVIDER_UNAVAILABLE` |
| no id, multiple usable providers | `MEMORY_PROVIDER_UNAVAILABLE`, message naming every candidate |

Registration is effect-based: a provider registers with the calling fiber and unregisters when it disposes, and a duplicate id is rejected at registration with `MEMORY_DUPLICATE_PROVIDER`. `isAvailable()` answers whether a usable provider is currently registered, so a hot-path caller can check once instead of paying for a failed call.

### Failures and recovery

Failures throw `MemoryError` with a stable, machine-routable code; the message adds detail such as the missing provider id or the ambiguous candidate set. `MEMORY_PROVIDER_UNAVAILABLE`, `MEMORY_PROVIDER_CONFIGURED_MISSING`, and `MEMORY_DUPLICATE_PROVIDER` are raised by this service; `MEMORY_BACKEND_ERROR`, `MEMORY_BACKEND_TIMEOUT`, and `MEMORY_BANK_NOT_FOUND` come from providers. To change which backend a call uses, reconfigure the pinned id, mount or unmount providers, or fix the provider's configuration so its availability check passes.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

This section explains the design decisions behind the service; the observable behavior is fully covered in [Use this package](#use-this-package).

### Design philosophy

The package is built on one deliberate separation:

- **The contract is the product.** A provider implements `MemoryProvider`; everything a caller can rely on — bank identity, result capping, selection, the error taxonomy — belongs to the seam, so swapping backends cannot change observable behavior.
- **Selection is never order-dependent.** The service either pins a provider id or auto-selects when exactly one usable provider is registered, and it resolves at execution time rather than at registration.
- **The seam owns the result bound.** `limit` is enforced here after the provider returns, so an over-returning backend is corrected rather than trusted.
- **Failure is loud, degradation is the caller's.** The service never swallows an error; a caller on the agent hot path decides whether an absent memory is a warning or a failure.

### Source map

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Plugin entry: the `MemoryRuntime` service, the provider registry, execution-time selection, and `capUnits` |
| [`src/types.ts`](src/types.ts) | Vocabulary: the `MemoryProvider` contract, request/result shapes, branded identifiers, and the `MemoryError` taxonomy |
| — | No runtime invariant companion is published; the provider map is private and selection and result caps are enforced on each call; the seam publishes no independent registry or recall/result observation stream. |

### Data model

The provider contract and the request/result types define the normalized vocabulary callers build on, and the exhaustive fields and JSDoc live in [`src/types.ts`](src/types.ts). Three deliberate choices shape them. `MemoryBankId`, `MemoryId`, and `KnowledgePageId` are branded strings, so a bank can never be passed where a memory id belongs; the cast helpers exist because a provider, not a caller, owns the representation. `MemoryUnit.text` is documented as already formatted for model consumption, which keeps rendering policy out of the seam's consumers. `MemoryError` extends `Error` with a closed `code` union, so a caller can route on a small stable set rather than parse messages.

### Selection flow

At call time the service resolves the provider — configured id first, then the unique usable provider — and throws the matching `MemoryError` when no clear winner exists. Recall and search results then pass through `capUnits`, which truncates `units[]` to `request.limit` and flags `truncated`. `resolveBank()` is asynchronous because resolving a bank may require the backend to list or create it; every other method delegates to the selected provider unchanged.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

Read these pages when the package-level contract is not enough. They move from the shipped backend to the shared seam vocabulary and the design rules this package follows.

- [dsh-memory-hindsight-http](../hindsight-http/README.md) — the shipped hindsight-backed provider, including why its recall timeout is two minutes.
- [dsh-web](../../web/web/README.md) — the sibling search/fetch seam, useful as the reference for provider selection and the result-cap pattern.
- [Capability seams](../../../docs/capability-seams.md) — how a swappable capability seam is positioned against core services and bundles.
- [Defensive patterns](../../../docs/defensive-patterns.md) — the rules behind degrading a lifecycle listener instead of failing a turn.
- [Generated configuration catalog](../../../docs/config-catalog.md) — every accepted config field across the Harness and its source declaration.

-----

<a id="model-experience"></a>
## Model Experience

### Recalled units and memory results

#### What the model sees

Nothing from this package directly: the seam registers no tool, no prompt section, and no result renderer. What a model sees is produced by `dsh-tool-memory`, which consumes this seam — an opening recall injected as a source-attributed user message, plus `hindsight_search` and `hindsight_remember` results. This package still decides part of what the model reads, because `MemoryUnit.text` is defined as already formatted for model consumption, so a provider chooses the wording before any consumer renders it.

#### Token effect

Recalled units are data-dependent and are resent until compaction. `capUnits` bounds the unit count against `request.limit` and is the only size control this package applies; `MemoryUnit.bankId` appears only on results that span banks.

#### KV Cache effect

No direct effect: this package contributes no prompt section and no schema. A consumer that injects a durable message changes the request prefix, so recall injection invalidates reuse from the first injected token, while tool results append after the reusable prefix.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>


These limits define when the service is incomplete on its own. They are current package constraints.

- **Several selection failures share one code** — a configured-but-unavailable provider, no usable provider, and several usable providers all raise `MEMORY_PROVIDER_UNAVAILABLE`; only the message separates them, so a caller that must react differently has to read text. There is no distinct ambiguity code.
- **No observation surface** — there is no provider-change event and no capability-status query; availability is observable only through `isAvailable()` or by running a call and routing the thrown code.
- **`MEMORY_BANK_NOT_FOUND` is declared but never raised here** — the code exists in the taxonomy for providers to use, and the shipped hindsight provider raises it on a daemon 404, but this service never produces it.
- **`MemoryRetainRequest.bankId` is inert on this path** — `retain()` receives the bank as its own argument and passes the request through, so the optional field in the request shape is never read.
- **`KnowledgePageId` has no consumer here** — the branded type and `knowledgePageId()` are exported vocabulary reserved for a curated knowledge-page surface that this package does not implement.
- **Requests carry only a query and a limit** — recency windows, memory-kind filters, and cross-bank queries are deferred until a backend can honour them.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

This Dev Note is working context for maintainers: open questions and undecided directions. It is explicitly non-authoritative — shipped behavior, limits, and rationale live in the sections above.

#### Future: separating ambiguity from absence

Today three distinct operator mistakes — a pinned id that is down, nothing mounted, and too much mounted — collapse into `MEMORY_PROVIDER_UNAVAILABLE`. A dedicated ambiguity code would let a composition fail at startup with a precise message instead of at first call. The closed `MemoryErrorCode` union makes that an additive, compile-enforced change.

#### Future: richer request vocabulary

`MemorySearchRequest` and `MemoryRecallRequest` carry a query and a limit only. Filters that a real backend can honour — recency, memory kind, per-bank scoping — wait on a provider that can serve them honestly rather than being accepted and ignored.

</details>
