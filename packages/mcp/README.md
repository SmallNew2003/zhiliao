---
description: "The MCP package group: connect external Model Context Protocol servers, call their tools, and read their resources."
kind: "package-group"
---

# MCP — Model Context Protocol

English | [中文](README.zh.md)

## Summary

The `mcp/` group lets the model discover external Model Context Protocol (MCP) capabilities, load selected tools, and read server resources. Configure `mcp-client` entries; shipped profiles provide progressive discovery and shared resource tools. MCP tools and prompt text appear only for callers with a configured server in scope. Connections supply server instructions, and discovery controls their request admission. Package READMEs own configuration and limitations.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The client owns each configured connection; discovery selects definitions and instructions, while the resource package supplies shared resource tools.

| Package | What it provides |
|---|---|
| [`mcp-client/`](mcp-client/README.md) | Connect one MCP server, expose its tools and instructions, and provide its resource operations |
| [`mcp-discovery/`](mcp-discovery/README.md) | Scoped capability discovery, bounded loading, and request-bound execution identities |
| [`mcp-resources/`](mcp-resources/README.md) | Discover and read resources through shared tools with explicit server selection |

-----

<a id="related-documentation"></a>
## Related documentation

Try the worked example configurations to see the plugin in action, then read the Agent Note for the behavior decisions behind it.

- [historical MCP client plugin Agent Note](../../.agents/notes/archived/feature/2026-07-07-mcp-client-plugin.md) — the bridge's design: server-qualified naming, discovery, execution, and environment scrubbing.
- [Resources and instructions reference](mcp-resources/README.md) — on-demand resource access and scoped server guidance.
- [Third-party memory MCP guide](../../docs/user/guide/mcp-memory.md) — runnable overlay rows and setup instructions.
- [Tools subsystem reference](../../docs/subsystems/tools.md) — the `ToolRuntime` that receives the registered tools.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
