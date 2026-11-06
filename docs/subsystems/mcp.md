# MCP

English | [中文](mcp.zh.md)

## Summary

Model Context Protocol (MCP) connects the model to tools supplied by external servers. Shipped profiles expose a scoped capability catalog and load selected definitions and complete server instructions before request admission. Ordinary harness execution owns cancellation, permission checks, recorded results, and supported image output; shared tools discover and read activated resource servers. The official SDK negotiates modern or supported legacy protocol revisions. This reference covers the MCP package group's responsibilities, scope, and composition choices; the [client README](../../packages/mcp/mcp-client/README.md) owns server configuration.

## Table of Contents

- [Configuration](#configuration)
- [Responsibilities and scope](#responsibilities-and-scope)
- [Progressive discovery](#progressive-discovery)
- [Discovery types](#discovery-types)
- [Protocol and results](#protocol-and-results)
- [Resources and instructions](#resources-and-instructions)
- [Resource provider types](#resource-provider-types)
- [Limits](#limits)
- [Further reading](#further-reading)

-----

<a id="configuration"></a>
## Configuration

MCP servers are opt-in. Configure one `@deepseek-ai/dsh-mcp-client` entry per server in the intended Cordis scope. Every shipped profile supplies the [tool registry](tools.md) and mounts the shared resource service once; users configure only client entries. Callers with no visible configured server receive no MCP prompt text or tools in native or PTC mode.

| Choice | Configuration owner |
|---|---|
| Server identity, local process or HTTP endpoint, credentials, and process environment | [Client configuration](../../packages/mcp/mcp-client/README.md#use-this-package) |
| Tool and resource request timeout, startup failure policy, and reconnection | [Client configuration](../../packages/mcp/mcp-client/README.md#use-this-package) |
| Capability selection, representation budgets, and optional auxiliary model | The [discovery service](../../packages/mcp/mcp-discovery/README.md#use-this-package) is included in shipped profiles |
| Resource discovery and reading | The [MCP resource service](../../packages/mcp/mcp-resources/README.md#use-this-package) is included in shipped profiles; it has no configuration fields |
| Server instruction size limit | Client `maxInstructionBytes`; the composition supplies [system-prompt assembly](system-prompt.md) |
| Permission decisions and supported image output | [Tool execution](tools.md) and [attachments](attachment.md) |

Protocol negotiation follows the SDK's supported revisions; there is no product setting that forces a protocol revision. The [configuration catalog](../config-catalog.md#deepseek-aidsh-mcp-client) lists accepted client fields and defaults.

-----

<a id="responsibilities-and-scope"></a>
## Responsibilities and scope

The client is a per-server connection plugin and a consumer of the harness tool registry. It does not publish a shared `ctx.mcp` service. The external server implements MCP operations; the SDK owns protocol exchange; the client adapts discovered tools to harness execution. `ctx.mcpDiscovery` owns scoped catalogs, retained selections, and request identities; connection plugins register server sources before their tools.

`mcp-resources` owns the shared resource tools and selects providers in the caller's scope. Each MCP client supplies resource operations through its own connection. The first provider in a scope enables the local shared tools, and removing the last removes them; inherited providers remain visible. The service owns these tool registrations independently of any one client. Connection failures do not remove shared resource tools while a visible client entry remains active.

Configured `serverName` identifies a server in its registration scope. Two entries in that scope cannot reserve the same name; separate Agent scopes can reuse it. Public tool names include the configured server name, so equally named tools from different servers remain distinct. Registration effects own names and discovered tools; plugin disposal closes the connection and removes its contributions.

The [native Cua Driver provider](../../packages/experimental/computer-use-cua-driver-native/README.md) shares the client's exported result adapter without opening an MCP connection. Desktop provider selection belongs to the [computer-use subsystem](computer-use.md).

-----

<a id="progressive-discovery"></a>
## Progressive discovery

`discover_mcp_tools` searches short descriptors, loads exact public tool names or activates resource servers, and releases selections. Direct human input naming `mcp__<server>__<tool>` loads that definition before its first request; `mcp:<server>` identifies a discovery target without loading every tool. The optional auxiliary selector chooses from the same visible catalog using an explicit model route. Its unavailable, uncertain, and empty outcomes preserve the main model's discovery path. The [discovery package](../../packages/mcp/mcp-discovery/README.md) owns configuration, byte limits, and selection behavior.

`agent/prepare-step` completes selection before the [tool registry](tools.md) evaluates step-time activation. Native declarations and PTC SDK text contain admitted selections. Loading accepts complete schemas and literal server instructions atomically; exceeding any representation budget leaves the previous selection intact. Permissions continue to restrict scope visibility and execution.

`mcp/selection` records the complete retained selection. `mcp/selector-request` and `mcp/selector-result` retain auxiliary inputs and outcomes; `mcp/diagnostic` records direct targeting and admission diagnoses. `mcp/request-snapshot` binds exact MCP content to a started model request. Tool and resource calls must match that request's content identities; changed definitions or instructions return `MCP_STALE_DEFINITION`. Resume and fork reuse retained events after current permissions, definitions, and limits are checked. Temporary disconnection keeps metadata, while execution reports `MCP_DISCONNECTED`.

-----

<a id="discovery-types"></a>
## Discovery types

The [discovery types](../../packages/mcp/mcp-discovery/src/types.ts) retain selection and request facts; the [service entry](../../packages/mcp/mcp-discovery/src/index.ts) declares registration and search values.

| Types | Meaning |
|---|---|
| `McpDefinitionId`, `SelectedTool`, `SelectedServer` | Branded content identity and the exact selected tool or server instructions |
| `Selection`, `RequestSnapshot`, `DiscoveryState` | Complete retained selection, immutable started-request content, and Host-only replay state |
| `SelectorRequest`, `SelectorResult` | Explicit auxiliary route and bounded input, plus selected, none, uncertain, or failed outcome |
| `ServerSource` | Connection-owned instruction snapshot and readiness |
| `DiscoveryItem`, `SearchRequest`, `DiscoveryPage` | Short capability descriptor, catalog filters, and bounded continuation page |
| `LoadResult` | Atomic loading success or refusal with the prior valid selection preserved |

-----

<a id="protocol-and-results"></a>
## Protocol and results

Both stdio and Streamable HTTP use the official SDK's negotiation, discovery, protocol validation, and cancellation. Tool-list changes trigger discovery through legacy notifications or a modern subscription. A failed refresh retains the previous tool generation; connection recovery follows the [client lifecycle](../../packages/mcp/mcp-client/README.md#use-this-package).

The result adapter retains canonical MCP JSON for programmatic callers and prepares ordinary tool content. Supported images use the attachment system; unsupported rich content produces explicit text diagnostics. The tool registry remains authoritative for policy failures and replaced results. The [tool contracts](tools.md) own recording and final presentation; the [client result reference](../../packages/mcp/mcp-client/README.md#use-this-package) owns MCP-specific projection details.

-----

<a id="resources-and-instructions"></a>
## Resources and instructions

Resource calls require an explicit configured server name. Discovery includes caller-visible servers with no tools or instructions; activating one admits its complete instructions and resource access for a subsequent request without fetching content. The shared registry resolves the server in the calling Agent's scope, and discovery checks request activation before dispatch; unavailable or unactivated servers fail without a network request. The [resource package](../../packages/mcp/mcp-resources/README.md) owns pagination and content rendering; its generated tool schemas live in the [tool catalog](../tool-catalog.md#deepseek-aidsh-mcp-resources).

Resource providers remain connection-owned. Scope disposal removes registrations; the MCP client controls cancellation and recovery. Canonical results retain complete JSON for programmatic callers, while the text projection replaces binary blobs with descriptions. Returned text enters ordinary tool history; content is not fetched merely because a server connects.

With discovery composed, only activated server instructions join the logged system prompt. Instructions remain literal, server-attributed text and pass the client handshake limit and discovery admission limits. A replacement connection publishes instructions only after discovery succeeds; absent instructions add no section. A composition without discovery publishes the caller-visible resource directory and server instructions directly. The [system-prompt subsystem](system-prompt.md) owns assembly and recording.

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
- [Progressive discovery](../../packages/mcp/mcp-discovery/README.md) — selection, budgets, and optional auxiliary routing.
- [MCP resources](../../packages/mcp/mcp-resources/README.md) — shared tools and resource-provider semantics.
- [Resource visibility reference](../../packages/mcp/mcp-resources/README.md) — shared profile mounting and visibility from configured servers.
- [Third-party memory servers](../user/guide/mcp-memory.md) — product configuration guide.
- [Protocol negotiation reference](../../packages/mcp/mcp-client/README.md) — SDK ownership and compatibility decisions.

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
