# Upstream proposal: progressive MCP tool discovery and loading

English | [中文](upstream-discussion.zh.md)

> Draft for a GitHub Discussion on deepseek-ai/deepseek-harness. Category: pick **Ideas** (fall back to **General** or **Q&A** if Ideas does not exist). Posting requires a signed-in browser session; the local `gh` token for SmallNew2003 is currently invalid.

## Suggested title

MCP tool definitions enter the main-model context before any task needs them — proposal: progressive discovery and loading

## Body

### Problem

When DSH connects to several MCP servers, every tool's complete description, parameter schema, and PTC SDK interface enters the main model's context on the first and every later request, whether or not the current task uses those tools. As servers and tools accumulate, unused definitions crowd out working context and make tool selection noisier, while the full payload is resent on every turn.

### Proposal

Keep complete MCP metadata at runtime, but let only what the task needs reach the model:

1. **Budgeted discovery catalog.** Connected servers and their tools appear as a compact catalog (names plus short descriptors) inside a configurable UTF-8 budget. No full definitions are sent for unselected tools.
2. **On-demand loading.** The main model searches the catalog (by server, names, or free-text query, with result count and byte limits) and loads only the tools it picks. Native definitions and PTC SDK interfaces render from the same presentation decision, so both modes behave identically. Execution continues through the existing registry, argument validation, approval, cancellation, and result-recording pipeline.
3. **Optional auxiliary-model preselection (default off).** With an explicitly configured provider/model, an auxiliary call receives only bounded recent task context plus the short catalog — never full parameter schemas — and the selected tools are already present in the first main request. Uncertainty, "no MCP needed", and failures are recorded distinctly and never fall back to loading everything.
4. **Explicit targeting.** A full public tool name in a user message loads directly when the budget allows, even with preselection off or failed. Naming a server narrows candidates without loading that server's full tool set.
5. **On-demand server instructions and resources.** Server instructions load atomically with the tools that need them; resource-only servers activate through the catalog. Admission is atomic with hard budgets: an oversized item or cumulative proposal is rejected whole, never truncated into an invalid tool.
6. **Request-bound correctness.** A tool call executes against the definitions its own request declared; a same-name definition that changes mid-flight returns a stale-definition diagnostic instead of executing new content. Selections are durable session events, so recovery, fork, and compaction rebuild exactly what the model saw.

Everything model-visible stays reconstructable from the session log, including the auxiliary model's actual input, route, and selection results.

**Relation to `deferLoading`.** `ToolSchema.deferLoading` marks a schema so a provider can receive its definition later. This proposal answers the complementary question upstream of that marker: which definitions a scope's model sees at all, decided per agent scope by a catalog plus admission, with the deferred marker then carried on the wire for the tools that do load. The two compose; neither replaces the other.

### Evidence

We implemented this end to end in a downstream fork and verified it locally (all keyless):

- 890 targeted behavior tests, 22 keyless MCP protocol tests
- 10 recorded-session snapshots updated, plus TypeScript and Python SDK expected outputs
- hygiene, lint, typecheck, export JSDoc, tool/Cordis/dependency catalogs, doc graphs, and bilingual pairing gates

A second branch ports the same feature onto current master (dsh 0.2.1-rc.2) and passes 539 unit tests, the 22 keyless protocol tests, a clean typecheck and lint, and the documentation gates; the only red gates there are the recorded MCP snapshots, whose v3-era fixtures carry the new session events and need re-recording against the current format, and sandbox-dependent snapshots that cannot run in an unprivileged environment.

Honest limits: no paid real-model evaluation ran, so recall, cost, and end-to-end latency are unmeasured; external browser/computer live E2E was skipped for lack of an installed executable.

### Reference implementation

Since external pull requests are not accepted, the implementation is available for inspection in our public fork `SmallNew2003/zhiliao`:

- branch `feat/mcp-progressive-loading` — the original feature on the 0.1.6-alpha.2 era
- branch `port/mcp-progressive-loading-upstream` — the same feature rebased onto current master, with the upstream API drift resolved (new package `packages/mcp/mcp-discovery`, plus small hooks in `core/tools`, `core/system-prompt`, and the agent-loop assemble path)

### Ask

- Is progressive MCP tool loading a direction the team wants for DSH?
- If the core changes (tool presentation decision, assemble-context input, session events) are the blocker for shipping this as a community plugin under the `dsh-plugin` topic, which extension points would you expose first?

We are happy to rebase onto current master, split the change into reviewable pieces, and adapt it to whatever extension points you prefer.
