---
kind: upgrade-guide
description: "MCP model tools and resources require explicit discovery and activation."
---

# Discover MCP capabilities before calling them

English | [中文](guide.zh.md)

## Change

The default profiles expose `discover_mcp_tools` instead of every connected MCP tool. Resource calls from an Agent require that server to be active. A previously visible tool can be unavailable until discovery admits its current definition; changed server instructions or definitions invalidate the selection. Programmatic resource requests without an Agent retain their activation exemption.

## Migration

1. Custom compositions that mount `dsh-mcp-client` and need progressive discovery must also mount `dsh-mcp-discovery`. Keep both packages in the profile resolver dependencies.
2. Update tool-calling instructions to use `discover_mcp_tools` to search and load exact tool names, or activate a resource server, before calling it. Discovery changes take effect on the next model request.
3. If a call reports `MCP_SERVER_INACTIVE`, activate the named server and retry. If it reports `MCP_STALE_DEFINITION`, discover and load the current definition again.
4. Confirm the next request contains the selected tool schema and that resource access succeeds only after activation. See the [MCP reference](../../../subsystems/mcp.md) and [persistence acknowledgement](../../../persistence-changes/2026-11-07-local-testbed-integration.md) for replay behavior.
