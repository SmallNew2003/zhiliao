/** Deterministic MCP tool and literal instructions for progressive-loading snapshots. */
import { z } from 'zod'
import { McpServer } from '@modelcontextprotocol/server'
import { serveStdio } from '@modelcontextprotocol/server/stdio'

serveStdio(() => {
  const server = new McpServer(
    { name: 'snapshot-discovery', version: '1.0.0' },
    { instructions: 'MCP_TOOLBOX_INSTRUCTION: use exact keys; preserve {{braces}}.' },
  )
  server.registerTool('lookup', {
    description: 'Look up one fixture entry by its exact key.',
    inputSchema: z.object({ key: z.enum(['entry']) }),
    outputSchema: z.object({ key: z.string(), value: z.string() }),
  }, async ({ key }) => ({
    content: [{ type: 'text', text: `lookup:${key}=fixture-value` }],
    structuredContent: { key, value: 'fixture-value' },
  }))
  return server
})
