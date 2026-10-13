---
description: "The MCP package group: connect external Model Context Protocol servers, call their tools, and read their resources."
kind: "package-group"
---

# MCP — Model Context Protocol

English | [中文](README.zh.md)

## Summary

`mcp/` lets the model load external Model Context Protocol (MCP) tools on demand and read server resources. Configure only `mcp-client` entries; shipped profiles mount shared discovery and resource services. Discovery presents a bounded catalog before admitting selected tool definitions and server instructions into model requests. With no visible configured server, MCP adds no tools or prompt text. Package READMEs own configuration and limitations.

## Table of Contents

- [Packages](#packages)
- [Related documentation](#related-documentation)
- [Dev Note](#dev-note)

-----

<a id="packages"></a>
## Packages

The client owns each configured connection; discovery manages model-facing selection, and resources supplies shared list and read tools.

| Package | What it provides |
|---|---|
| [`mcp-discovery/`](mcp-discovery/README.md) | Search and load tools on demand, activate resource servers, and manage request budgets and selection |
| [`mcp-client/`](mcp-client/README.md) | Connect one MCP server, discover its tools and instructions, and provide its resource operations |
| [`mcp-resources/`](mcp-resources/README.md) | Discover and read resources through shared tools with explicit server selection |

-----

<a id="related-documentation"></a>
## Related documentation

Try the worked example configurations to see the plugin in action, then read the Agent Note for the behavior decisions behind it.

- [MCP client plugin Agent Note](../../.agents/notes/implemented/feature/2026-07-07-mcp-client-plugin.md) — the bridge's design: server-qualified naming, discovery, execution, and environment scrubbing.
- [Resources and instructions Agent Note](../../.agents/notes/implemented/feature/2026-09-12-mcp-resources-and-instructions.md) — on-demand resource access and scoped server guidance.
- [Third-party memory MCP guide](../../docs/user/guide/mcp-memory.md) — runnable overlay rows and setup instructions.
- [Tools subsystem reference](../../docs/subsystems/tools.md) — the `ToolRuntime` that receives the registered tools.

<a id="dev-note"></a>
## Dev Note

<details>
<summary>Working context for maintainers — click to expand</summary>

None.

</details>
