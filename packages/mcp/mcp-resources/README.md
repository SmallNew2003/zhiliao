---
description: "Discover and read MCP resources on demand with shared tools, explicit server selection, and agent-scoped access."
kind: "package-reference"
---

# @deepseek-ai/dsh-mcp-resources

English | [中文](README.zh.md)

## Summary

`dsh-mcp-resources` lets the model discover and read documents from configured MCP servers on demand. Shipped profiles expose three shared tools when a server is configured in the caller scope. The model must first activate the server through [discovery](../mcp-discovery/README.md) and call resource tools after its instructions enter a later request. Each call requires an explicit server name. Resource text enters history; binary payloads remain programmatic values and appear as descriptions to the model.

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

Shipped profiles already mount this package once. Configure only the [MCP client](../mcp-client/README.md) entries for the servers you need.

### Server configuration

Use the [client configuration](../mcp-client/README.md#use-this-package) to add a server in the intended scope. This package has no configuration fields.

With no visible configured MCP server, a caller sees no MCP prompt text or resource tools in native or PTC mode. Configuring a server enables the three shared resource tools, including servers without tools or instructions. Connection failures do not remove shared tools while the client entry remains active; calls still require activation and can report connection errors.

### Discover and read

Search the bounded catalog with `discover_mcp_tools`, then activate the chosen server with `action: load` and `server`. Wait for the next model request to admit its complete instructions before calling `list_mcp_resources` or `list_mcp_resource_templates` with that same `server`. Without a cursor, the MCP SDK collects server pages; an explicit `cursor` requests that page, and a returned `nextCursor` passes through unchanged. Read a listed URI or expanded template using `read_mcp_resource` with the same server and an explicit `uri`.

Each operation resolves the server in the calling Agent scope and checks activation in the previously started main request. Missing arguments, unavailable servers, inactive selections, or stale instructions fail before network dispatch; load again and retry from the next request. Direct programmatic calls without an Agent skip only the model activation check. The connection owner handles cancellation, timeouts, and recovery; a failed request remains a failed call.

-----

<a id="understand-the-implementation"></a>
## Understand the implementation

<details>
<summary>Implementation internals — click to expand</summary>

The [base](../../bundle/base/README.md) and standalone [sdk-minimal](../../bundle/sdk-minimal/README.md) bundles each own this row:

```yaml
- id: mcp-resources
  name: '@deepseek-ai/dsh-mcp-resources'
```

The first provider in a scope registers shared tools, and removing the last unregisters local tools; inherited providers and tools remain visible. The resource service owns tool effects independently of any one provider and requires `tools` and `mcpDiscovery`. Its registry resolves the server; discovery checks recorded request activation and owns the unified presentation of names and instructions.

Canonical results retain complete JSON for programmatic callers. The pure text renderer adds server attribution and replaces string-valued `blob` fields with descriptions of their base64 length; URI, MIME type, and text remain in rendered JSON. The tool pipeline records results. [Discovery](../mcp-discovery/README.md) owns admission of server instructions and request identities.

| Source | Responsibility |
|---|---|
| [`src/index.ts`](src/index.ts) | Scoped provider selection and request activation checks |
| [`src/tools.ts`](src/tools.ts) | Shared resource operations and argument schemas |
| [`src/render.ts`](src/render.ts) | Attributed text projection without inline binary payloads |

No runtime invariant companion is published: resource-tool registration and dispatch use the same effect-owned providers. Discovery checks request activation at call time; registry-effect checks are not runtime invariants.

</details>

-----

<a id="further-exploration"></a>
## Further Exploration

These pages cover server configuration, execution, and the decisions behind resource access.

- [MCP client](../mcp-client/README.md) — server transports, instructions, and connection lifecycle.
- [Tools subsystem](../../../docs/subsystems/tools.md) — canonical values and model-visible results.
- [Resource visibility decision](../../../.agents/notes/implemented/feature/2026-09-13-mcp-resources-in-profiles.md) — shared profile mounting and visibility from configured servers.
- [Resources and instructions decision](../../../.agents/notes/implemented/feature/2026-09-12-mcp-resources-and-instructions.md) — scope, on-demand access, and excluded mechanisms.

-----

<a id="model-experience"></a>
## Model Experience

### Shared resource tools

#### What the model sees

The [generated tool schemas](../../../docs/tool-catalog.md#deepseek-aidsh-mcp-resources) define three shared tools for all caller-visible servers. With none, native schemas and PTC declarations are absent. Connecting, disconnecting, or retrying an active client leaves these shared definitions unchanged. [Discovery](../mcp-discovery/README.md#model-experience) supplies the bounded server catalog and admits complete instructions after activation; this package adds no server-name prompt.

#### Token effect

With no caller-visible configured servers, this package adds no tool or prompt tokens. Otherwise, three shared definitions contribute a fixed schema cost; discovery owns catalog and instruction costs. Listings and documents add content only when operations return them.

#### KV Cache effect

Adding the first caller-visible server or removing the last changes the next tool-schema or PTC declaration prefix. Intermediate server changes and connection failures leave these three definitions unchanged; discovery controls changes to catalog and instruction text.

### Resource results

#### What the model sees

A successful result starts with `MCP server: <server>`, followed by a newline and the returned JSON. Each string-valued `blob` becomes `[binary resource: <length> base64 characters; available to programmatic callers]`. Server-provided text, metadata, and continuation cursors remain visible.

#### Token effect

Rendered results add text to tool history. Binary descriptions replace the payload's base64 token cost; this package imposes no separate text-size limit.

#### KV Cache effect

Each result appends to history without rewriting earlier results. Later reads can return changed server content and append a different result; the package does not refresh previously recorded content.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

Resource access is explicit and on demand.

- A configured server without MCP `resources` capability still appears in the discovery catalog and keeps shared tools available. After activation, the SDK returns empty resource and template lists; unsupported reads fail.
- `tools.restrict()` checks names supplied by global or ancestor scopes when the filter is registered. Naming a resource tool absent from those scopes fails as an unknown tool. Resource tools registered in the caller's own scope are outside allow/deny masks.
- Resource subscriptions and update notifications are unsupported; call the list or read tools again to obtain current content.
- Binary resources are not projected as native images or audio. Programmatic callers retain their canonical base64 values.
- The caller must supply a server name. The shared tools do not aggregate different servers; pagination follows the MCP SDK.

<a id="dev-note"></a>
### Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
