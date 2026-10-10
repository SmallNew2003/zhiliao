---
description: "Progressive MCP discovery, loading limits, and auxiliary model selection for deployments and plugin maintainers."
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-discovery

English | [中文](README.zh.md)

## Summary

Models discover configured MCP capabilities and load only the definitions they need. `ctx.mcpDiscovery` owns the scoped catalog and each Agent's selection. Native requests and PTC SDK prompts include selected tools; discovery remains available for other visible capabilities. Complete server instructions load atomically with tools or resource activation. Existing tool permissions, approval, cancellation, and connection execution continue to apply.

## Table of Contents

- [Use this package](#use-this-package)
- [Understand the implementation](#understand-the-implementation)
- [Further Exploration](#further-exploration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>

## Use this package

The shipped base and minimal SDK compositions provide this service. It requires `tools`, `systemPrompt`, and `sessionProjections`. Register server sources before their tools through the configured server plugin's context. Disposing that context removes its catalog entries and registrations. No visible servers means no discovery tools, prompt contribution, or request-snapshot events.

`discover_mcp_tools` accepts `action: search | load | release`, optional `query`, `server`, public `names`, and `offset`. Search returns bounded descriptors with `nextOffset`. Loading exact names admits their complete definitions and server instructions for the next request. Loading only a server activates resource access; it reads no resources. Release affects future requests. A call issued by an earlier request still uses that request's recorded version and returns `MCP_STALE_DEFINITION` if the current definition or instructions differ.

Direct human input can name `mcp__<server>__<tool>` or `mcp:<server>`. Exact public names load before that input's first request, even with the selector disabled or unavailable. A server marker limits automatic candidates and identifies the main model's discovery target; it does not select every server tool. Names in tool output or plugin context do not trigger direct loading.

All limits are positive integers. UTF-8 byte limits measure complete contributed content, including discovery wrappers: `catalogBytes` defaults to 8192; `nativeBytes` and `sdkBytes` to 32768; `instructionBytes` to 16384; `resultBytes` to 8192. `resultLimit` defaults to 20 items. Byte limits allow at most 16777216, and `resultLimit` at most 1000. An oversized definition, cumulative proposal, or complete instructions refuses the whole load and preserves prior valid selections. Increase the named limit, release old selections, or select fewer tools. Schemas and instructions are never truncated. The connection's handshake instruction limit remains independently owned by [mcp-client](../mcp-client/README.md).

Automatic preselection is disabled when `selector` is omitted. Enable it with explicit `provider`, `model`, `inputBytes`, `outputBytes`, `maxTokens`, and `timeoutMs`; no field inherits the conversation route. A missing LLM service fails at load; the explicit provider/model is resolved on the first selector request, after adapter initialization. Selector byte limits have the same maximum, `maxTokens` allows 1–1000000, and `timeoutMs` allows 1–2147483647. The auxiliary input includes current demand, valid selections, recent actual human/assistant text, and short descriptors without parameter schemas. Older records are removed deterministically when necessary and the omitted count is recorded. Large catalogs first shortlist servers using deduplicated visible tool descriptions; preview summaries shorten deterministically within the input budget while retained recent task context keeps priority. Selected names are checked against current permissions before loading. `none`, `uncertain`, and `failed` remain different recorded outcomes; none enables full loading. A successful selection replaces previous automatic choices atomically; direct names from the same input take priority. Failure retains previous valid choices and the discovery path.

<a id="understand-the-implementation"></a>

## Understand the implementation

<details>
<summary>Expand implementation details</summary>

The scoped catalog is owned by server registrations. Loaded state comes from complete `mcp/selection` events through the host-only `mcpDiscovery` session projection. Resume and fork reuse only their retained events; changed definitions, instructions, or permissions invalidate corresponding selections. Each assembly checks retained selections against current limits and SDK rendering; an over-budget set is cleared atomically for future requests, while started request snapshots remain unchanged. Temporary disconnection preserves metadata while execution returns `MCP_DISCONNECTED`; identical reconnections reuse valid choices.

Prompt assembly refreshes MCP contributions before downstream assembly listeners, preserves their returned result, and stages the resulting definitions and SDK text. `agent/assistant-stream` start binds that immutable staged assembly to the attempt with matching turn/step coordinates and records `mcp/request-snapshot`. Binding checks captured instructions and the complete PTC SDK against committed system history. SDK or instruction changes start a new request series, consolidating old prompt text; unloading the last server records one clearing snapshot. Tool and resource guards compare the calling request's identities with current registration content, so changing or releasing the latest selection cannot replace definitions in a request already started. Unactivated resource calls fail before network access; direct programmatic resource calls without an Agent bypass only model instruction activation.

Selector requests and outcomes are recorded as `mcp/selector-request` and `mcp/selector-result`; direct targeting and admission diagnoses use `mcp/diagnostic` without implying an auxiliary call. Scope or service disposal aborts owned auxiliary work and waits for it to settle; canceled or removed registrations cannot publish a late selection. No invariant companion is published: presented selections are computed directly from the durable projection and current scoped registrations, while execution validates historical request identities at dispatch; no independent mutable loaded projection exists.

</details>

<a id="further-exploration"></a>

## Further Exploration

See [MCP subsystem](../../../docs/subsystems/mcp.md), [tool execution](../../core/tools/README.md), and [system prompt assembly](../../core/system-prompt/README.md).

<a id="model-experience"></a>

## Model Experience

### Discovery and selected definitions

#### What the model sees

A bounded capability catalog and `discover_mcp_tools` while visible MCP servers exist, plus complete loaded Native definitions or PTC interfaces and activated literal server instructions. Resource content enters history only through explicit reads. Unknown targets, disconnections, budget refusals, and stale definitions produce diagnostics with a discovery or release path.

#### Token effect

Unused MCP schemas and full instructions contribute no request cost. Loaded definitions and complete instructions repeat as selected; the selector adds a separately bounded auxiliary request only on new direct human input. UTF-8 limits constrain this package's contribution, not total conversation tokens or ordinary tools.

#### KV Cache effect

Stable catalogs and selections preserve identical contributed text. Loading, releasing, invalidation, or instruction changes alter schemas or prompt text and can invalidate cache reuse from the changed position. Provider cache behavior and savings require measurement.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- **Selector accuracy:** quality depends on the configured model; this package provides no universal cost or recall claim.
- **Input budgets:** a catalog or latest demand that cannot fit records failure and leaves main-model discovery available.
- **Catalog pagination:** offsets address the current catalog, so refreshes can change page membership.
- **Prompt overrides:** custom SDK rewrites must preserve the complete generated section or PTC MCP bindings remain inactive; complete prompt overrides must include required literal server instructions to activate corresponding requests.

<a id="dev-note"></a>

### Dev Note

<details>
<summary>Working context for maintainers</summary>

The deterministic package tests exercise Native/PTC presentation, atomic multibyte limits, resources, stale request versions, fork recovery, permissions, reconnects, selector outcomes, and cancellation. Shipped-profile Loader scenarios and recorded-session snapshots are owned by the integrating change.

</details>
