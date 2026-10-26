# Agent Note: Context breakdown splits the tool figure by origin

Status: implemented

English | [中文](2026-10-26-context-breakdown-tool-origin.zh.md)

## Problem

The composer's context-occupancy panel priced every tool schema into one row. An MCP server routinely contributes the largest tool block in a session — a browser or issue-tracker server can outprice every harness tool combined — so a user asking what is eating the context could not tell whose schemas those were. Splitting the row needs an origin per tool, and the model-visible request envelope carries none.

## Decision

`contextBreakdown` serves two tool figures, `systemToolsTokens` and `externalToolsTokens`, beside the unchanged `systemTokens` and `messageTokens`; `toolsTokens` stays the served total and is their sum. The ContextMeter panel renders four rows — system prompt, built-in tools, MCP tools, messages — and the MCP row renders only while its figure is positive.

Classification reads the public-name prefix. `ToolSchema` carries only `name`, `description`, and `parameters`, because `ToolRuntime.schemas()` projects exactly those three fields onto the wire and drops every other one, so no registration metadata survives into the request envelope; the `mcp__<server>__` namespace `publicToolName` constructs is the only origin marker left. That prefix constant lives beside `ToolSchema` in `dsh-llm`, which both `mcp-client` and `token-meter` already depend on, so the constructor and the classifier share one definition without a new dependency edge.

Each schema is priced on its own instead of as one envelope. The whole-envelope price charges one block overhead plus the array framing to whichever side absorbs the remainder, which left a pure-MCP session reporting harness-side tokens no harness tool produced. Per-schema pricing partitions the total exactly, and `measure()` keeps the whole-envelope price, so a single-tool envelope now prices one token lower in the composition than in the measurement anchor.

The split lives in the projection, not the client. The browser reads projections and session events, and neither carries the tool roster, so no client-side classification is possible. `stateVersion` moves 5 → 6 because the state fields changed; the projection cache discards a version-mismatched row and refolds from the log, and no session event or wire format generation changes.

## Alternatives considered

- **Persist an origin field on `ToolDefinition` in the `request/header` envelope.** The precise answer for third-party plugins, which register tools under arbitrary names and therefore price as the harness's own. Rejected for now: `request/header` is a durable session event, so the field needs a persistence-type acknowledgement, both SDK projections, and a migration story — a large cost for a display refinement. The row label records the limit by saying "MCP tools" rather than "third-party tools".
- **Split in the client from the replayed request-header events.** The web client folds the same log the host does. Rejected: the Chat snapshot builder retains no request-header state, and adding one to serve a four-row panel would duplicate the projection's job.
- **Price the envelope once and subtract one side from it.** Charges the array framing and block overhead to a single side, so a session whose tools are all MCP-bridged reports a nonzero harness figure. Rejected for the phantom value it invents.
- **Reprice `estimateToolsTokens` itself per schema.** Would have made the composition and the measurement anchor agree exactly. Rejected: `measure()` feeds compaction decisions and request budgets, so every pinned measurement would shift; the composition alone absorbs the one-token difference instead.

## Consequences

- The panel answers whose schemas those are whenever an MCP server is connected, and stays silent about MCP when none is.
- A tool a third-party plugin registers without a namespace still prices as the harness's own; both READMEs state this instead of implying the split covers every foreign tool.
- The composition's tool figure can differ from the measurement anchor's by the array framing — one token for a single-tool envelope — and both READMEs record the reason.
- `contextBreakdown` stateVersion 6 discards cached checkpoints written by earlier builds; each session's first cold read refolds.
