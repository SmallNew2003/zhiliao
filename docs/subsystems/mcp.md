# MCP

English | [中文](mcp.zh.md)

## Summary

Model Context Protocol (MCP) lets the model use external tools and resources on demand. Connection plugins discover tools; shared discovery admits selected definitions and complete server instructions into later requests. Execution retains cancellation, permission checks, recorded results, and supported image output. The official SDK negotiates modern or supported legacy revisions. This reference defines MCP scope, selection, and provider semantics; the [client README](../../packages/mcp/mcp-client/README.md) owns connection configuration and [discovery README](../../packages/mcp/mcp-discovery/README.md) owns admission budgets.

## Table of Contents

- [Configuration](#configuration)
- [Responsibilities and scope](#responsibilities-and-scope)
- [Protocol and results](#protocol-and-results)
- [Progressive discovery and request identity](#progressive-discovery-and-request-identity)
- [Resources and instructions](#resources-and-instructions)
- [Discovery types](#discovery-types)
- [Durable selection types](#durable-selection-types)
- [Resource provider types](#resource-provider-types)
- [Limits](#limits)
- [Further reading](#further-reading)

-----

<a id="configuration"></a>
## Configuration

MCP servers are opt-in. Configure one `@deepseek-ai/dsh-mcp-client` entry per server in the intended Cordis scope. Shipped profiles supply the [tool registry](tools.md), shared discovery, and resources; users add only client entries. With no visible server, native and PTC receive no MCP tools or prompt text. In custom compositions, discovery requires `tools`, `systemPrompt`, and `sessionProjections`; client and resource services require `mcpDiscovery`.

| Choice | Configuration owner |
|---|---|
| Discovery catalog, definition and instruction budgets, and optional auxiliary selector | [Discovery configuration](../../packages/mcp/mcp-discovery/README.md#use-this-package); selector is off by default |
| Server identity, local process or HTTP endpoint, credentials, and process environment | [Client configuration](../../packages/mcp/mcp-client/README.md#use-this-package) |
| Tool and resource request timeout, startup failure policy, and reconnection | [Client configuration](../../packages/mcp/mcp-client/README.md#use-this-package) |
| Resource discovery and reading | The [MCP resource service](../../packages/mcp/mcp-resources/README.md#use-this-package) is included in shipped profiles; it has no configuration fields |
| Server instruction size limit | Client `maxInstructionBytes`; the composition supplies [system-prompt assembly](system-prompt.md) |
| Permission decisions and supported image output | [Tool execution](tools.md) and [attachments](attachment.md) |

Protocol negotiation follows the SDK's supported revisions; there is no product setting that forces a protocol revision. The [configuration catalog](../config-catalog.md#deepseek-aidsh-mcp-client) lists accepted client fields and defaults.

-----

<a id="responsibilities-and-scope"></a>
## Responsibilities and scope

The client is a per-server connection plugin that adapts discovered tools to ordinary harness execution and supplies connection state and instructions to `ctx.mcpDiscovery`. The external server implements MCP operations, and the SDK owns protocol exchange. `mcp-discovery` owns the permission-filtered catalog, deferred presentation, and request identities; it does not change tool authorization.

`mcp-resources` owns the shared resource tools and selects providers in the caller's scope. Each MCP client supplies resource operations through its own connection. The first provider in a scope enables the local shared tools, and removing the last removes them; inherited providers remain visible. The service owns these tool registrations independently of any one client. Connection failures do not remove shared resource tools while a visible client entry remains active.

Configured `serverName` identifies a server in its registration scope. Two entries in that scope cannot reserve the same name; separate Agent scopes can reuse it. Public tool names include the configured server name, so equally named tools from different servers remain distinct. Registration effects own names and discovered tools; plugin disposal closes the connection and removes its contributions.

The [native Cua Driver provider](../../packages/experimental/computer-use-cua-driver-native/README.md) shares the client's exported result adapter without opening an MCP connection. Desktop provider selection belongs to the [computer-use subsystem](computer-use.md).

-----

<a id="protocol-and-results"></a>
## Protocol and results

Both stdio and Streamable HTTP use the official SDK's negotiation, discovery, protocol validation, and cancellation. Tool-list changes trigger discovery through legacy notifications or a modern subscription. A failed refresh retains the previous tool generation; connection recovery follows the [client lifecycle](../../packages/mcp/mcp-client/README.md#use-this-package).

The result adapter retains canonical MCP JSON for programmatic callers and prepares ordinary tool content. Supported images use the attachment system; unsupported rich content produces explicit text diagnostics. The tool registry remains authoritative for policy failures and replaced results. The [tool contracts](tools.md) own recording and final presentation; the [client result reference](../../packages/mcp/mcp-client/README.md#use-this-package) owns MCP-specific projection details.

-----

<a id="progressive-discovery-and-request-identity"></a>
## Progressive discovery and request identity

`discover_mcp_tools` supports `search`, `load`, and `release`. Search filters by `query`, `server`, or exact `names` and uses the returned `nextOffset` for bounded continuation pages. Loading full public tool names also activates their servers; selecting only a server activates resource access. Load and release affect later requests without changing definitions in an already started request.

Native requests and PTC declarations share durable selection. Complete tool definitions and their required server instructions are admitted atomically; overflow preserves the previous valid selection without truncating schemas or instructions. Budgets measure UTF-8 bytes of MCP-owned contributions rather than the whole model request. [Discovery](../../packages/mcp/mcp-discovery/README.md) owns configuration and presentation details.

The selector is off by default. Enabling it requires an explicit independent provider, model, input and output budgets, token limit, and timeout; the service does not choose a paid model automatically. Direct human text can narrow selection with `mcp:<server>` or request exact loading with a full public `mcp__<server>__<tool>` name. Plugin messages and tool content are excluded as direct marker input. Markers grant no permission and do not bulk-load server tools; selector failure retains manual discovery access.

`mcp/selection` records selected tool and server identities; `mcp/request-snapshot` records definitions and instructions admitted to a started request. Selector requests and results are also logged. Calls compare current content with that request identity; changed schemas or instructions cause a stale-definition error before dispatch. An identical-content reconnect can reuse selection. Resume and fork reconstruct selection through durable projections and check it against current visible definitions.

-----

<a id="resources-and-instructions"></a>
## Resources and instructions

Resource calls require an explicit server name and its activation and instruction identity from a previously started main request. Discovery owns the unified catalog, including resource-only servers. The resource registry resolves names in the calling Agent scope; discovery rejects inactive or stale servers before network dispatch. Direct programmatic calls without an Agent skip only model activation checks. The [resource package](../../packages/mcp/mcp-resources/README.md) owns pagination and content rendering; schemas live in the [tool catalog](../tool-catalog.md#deepseek-aidsh-mcp-resources).

Resource providers remain connection-owned. Scope disposal removes registrations; the MCP client controls cancellation and recovery. Canonical results retain complete JSON for programmatic callers, while the text projection replaces binary blobs with descriptions. Returned text enters ordinary tool history; content is not fetched merely because a server connects.

The client validates received instruction size and retains complete literal, server-attributed text. Discovery admits it to the logged system prompt when the server is selected, subject to its own admission budgets. A connection updates instructions only after discovery succeeds; blank instructions add no text. The [system-prompt subsystem](system-prompt.md) owns assembly and recording.

-----

<a id="discovery-types"></a>
## Discovery types

Server providers contribute connection readiness and complete instructions. Search returns bounded descriptors, and loading returns an admitted selection or atomic refusal. Source owns these declarations.

```ts type-equiv
/** Live connection facts owned by the configured server plugin. */
interface ServerSource {
  /**
   * Read complete literal, attributed instructions from the last successful handshake.
   * @returns server prompt text.
   */
  instructions(): string
  /**
   * Report whether resource and tool requests currently have a live connection.
   * @returns connection readiness.
   */
  connected(): boolean
}
```

```ts type-equiv
/** Short discovery item; schemas remain deferred. */
interface DiscoveryItem { server: string; name?: string; description: string; connected: boolean }
```

```ts type-equiv
/** Caller filters; offset is an index in the current filtered catalog. */
interface SearchRequest { query?: string; server?: string; names?: readonly string[]; offset?: number }
```

```ts type-equiv
/** Bounded search page with a continuation offset when items remain. */
interface DiscoveryPage { items: DiscoveryItem[]; nextOffset: number | null; hint: string }
```

```ts type-equiv
/** Atomic admission outcome; a refused proposal retains the previous selection. */
type LoadResult = { ok: true; names: string[]; servers: string[] } | { ok: false; reason: string }
```

<a id="durable-selection-types"></a>
## Durable selection types

Selected content identities, started requests, and auxiliary selection records restore through Session projections. Historical requests retain their exact definitions, SDK, and instructions.

```ts type-equiv
/** Opaque identity of exact MCP definitions or server instructions. */
type McpDefinitionId = Branded<'McpDefinitionId'>
```

```ts type-equiv
/** Content identities retained for one selected capability. */
interface SelectedTool { name: string; server: string; identity: McpDefinitionId }
```

```ts type-equiv
/** Complete instructions identity for an activated server. */
interface SelectedServer { server: string; identity: McpDefinitionId }
```

```ts type-equiv
/** Whole loaded state after one committed operation. */
interface Selection { tools: SelectedTool[]; servers: SelectedServer[] }
```

```ts type-equiv
/** Exact MCP content belonging to one started main-model request. */
interface RequestSnapshot extends Selection {
  turn: number
  step: number
  schemas: ToolSchema[]
  sdk: string
  instructions: string
}
```

```ts type-equiv
/** Auxiliary routing and exact bounded text submitted to the selector. */
interface SelectorRequest { provider: string; model: string; maxTokens: number; system: string; input: string; phase: 'tools' | 'servers' }
```

```ts type-equiv
/** Selector outcome; failures never imply that MCP is unnecessary. */
interface SelectorResult { status: 'selected' | 'none' | 'uncertain' | 'failed'; names: string[]; servers: string[]; detail?: string }
```

```ts type-equiv
/** Host-only replay state. */
interface DiscoveryState { selection: Selection; request: RequestSnapshot | null }
```

-----

<a id="resource-provider-types"></a>
## Resource provider types

The connection provider receives one operation and the original tool execution, including its caller and cancellation signal.

```ts type-equiv
/** One supported resource operation, with server-owned cursors and URIs. */
type McpResourceRequest =
  | { method: 'resources/list' | 'resources/templates/list'; cursor?: string }
  | { method: 'resources/read'; uri: string }
```

```ts type-equiv
/** One configured server's resource access, owned by its MCP connection plugin. */
interface McpResourceProvider {
  /**
   * Run an operation against one live connection generation.
   * @param request - MCP resource method and parameters.
   * @param exec - caller identity and cancellation for this invocation.
   * @returns the protocol result as lossless JSON.
   */
  request(request: McpResourceRequest, exec: ToolExecution): Promise<JsonValue>
}
```

-----

<a id="limits"></a>
## Limits

MCP prompt templates, human-input elicitation, task-based execution, and resource subscriptions are unsupported. Resource tools require a caller-visible configured server; binary resources remain programmatic data with text descriptions for the model. Servers without a tools capability connect with an empty tool set. Connection and discovery timeouts follow the SDK; the client has no separate settings for them.

-----

<a id="further-reading"></a>
## Further reading

- [MCP package group](../../packages/mcp/README.md) — package entry points.
- [MCP resources](../../packages/mcp/mcp-resources/README.md) — shared tools and resource-provider semantics.
- [Resource visibility decision](../../.agents/notes/implemented/feature/2026-09-13-mcp-resources-in-profiles.md) — shared profile mounting and visibility from configured servers.
- [Third-party memory servers](../user/guide/mcp-memory.md) — product configuration guide.
- [Protocol negotiation decision](../../.agents/notes/implemented/feature/2026-09-12-mcp-sdk-protocol-negotiation.md) — SDK ownership and compatibility decisions.

<!-- BEGIN GENERATED cordis-surface (gen-cordis-catalog.ts) — do not edit between markers -->

<a id="cordis-surface"></a>

## Cordis API

Generated from source by `scripts/gen-cordis-catalog.ts` (verified fresh by `pnpm run verify-cordis-catalog` in doc-sync; regenerate with `pnpm run gen-cordis-catalog`) — the language sides differ only in locale-specific paired document paths. Signature blocks use a `ts cordis-catalog` fence and keep the original source JSDoc; dispatch modes are defined in the [primer](../cordis-primer.md#dispatch-modes), and the framework-inherited `ctx` API lives in [cordis-api/inherited.md](../cordis-api/inherited.md).

<a id="ctxmcpdiscovery--mcpdiscovery"></a>

### `ctx.mcpDiscovery` — `McpDiscovery`

Deferred MCP definitions share permission filtering and execution with ordinary tools.

```ts cordis-catalog
/**
 * Register a configured server in the caller's scope.
 * @param server - namespace.
 * @param source - connection facts.
 * @returns effect disposer.
 */
registerServer(server: string, source: ServerSource): () => void

/**
 * Register one deferred MCP definition without changing authorization.
 * @param server - owning namespace.
 * @param definition - original tool.
 * @returns effect disposer.
 */
registerTool(server: string, definition: ToolDefinition): () => void

/**
 * Search the permission-filtered catalog without loading schemas.
 * @param scope - caller identity.
 * @param request - bounded filters and pagination.
 * @returns complete byte-limited page.
 */
search(scope?: ScopeKey, request: SearchRequest = {}): DiscoveryPage

/**
 * Atomically add tool definitions and complete server instructions.
 * @param agent - durable owner.
 * @param names - exact public tool names.
 * @param servers - resource-only activation targets.
 * @param signal - cancellation before commit.
 * @returns admission or refusal.
 */
load(agent: Agent, names: readonly string[], servers: readonly string[] = [], signal?: AbortSignal): LoadResult

/**
 * Release selections for future requests; started snapshots stay fixed.
 * @param agent - owner.
 * @param names - names, or omission to release all.
 * @param servers - activated server names to release.
 * @returns remaining selection.
 */
release(agent: Agent, names?: readonly string[], servers: readonly string[] = []): LoadResult

/**
 * Guard model resource calls before network access. Programmatic calls without an Agent bypass activation only.
 * @param server - resource namespace.
 * @param exec - execution owner.
 */
assertServer(server: string, exec: ToolExecution): void
```

Types: [Agent](core.md) · [ScopeKey](scope.md) · [ToolDefinition](tools.md) · [ToolExecution](tools.md)

Source: [`packages/mcp/mcp-discovery/src/index.ts`](../../packages/mcp/mcp-discovery/src/index.ts)

<a id="ctxmcpresources--mcpresourceruntime"></a>

### `ctx.mcpResources` — `McpResourceRuntime`

Scoped resource access plus three tools shared by configured MCP servers.

```ts cordis-catalog
/**
 * Register one server and expose resource tools while that scope has providers.
 * @param server - configured server name, unique in this scope.
 * @param provider - connection-owned resource operations.
 * @returns the effect disposer for this exact registration.
 */
register(server: string, provider: McpResourceProvider): () => void
```

Source: [`packages/mcp/mcp-resources/src/index.ts`](../../packages/mcp/mcp-resources/src/index.ts)
<!-- END GENERATED cordis-surface -->
