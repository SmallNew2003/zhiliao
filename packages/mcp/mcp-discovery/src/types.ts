/**
 * Durable MCP loading and selector facts.
 * @module @deepseek-ai/dsh-mcp-discovery/types
 */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type { ToolSchema } from '@deepseek-ai/dsh-llm/types'

/** Opaque identity of exact MCP definitions or server instructions. */
export type McpDefinitionId = Branded<'McpDefinitionId'>
/** Content identities retained for one selected capability. */
export interface SelectedTool { name: string; server: string; identity: McpDefinitionId }
/** Complete instructions identity for an activated server. */
export interface SelectedServer { server: string; identity: McpDefinitionId }
/** Whole loaded state after one committed operation. */
export interface Selection { tools: SelectedTool[]; servers: SelectedServer[] }
/** Exact MCP content belonging to one started main-model request. */
export interface RequestSnapshot extends Selection {
  turn: number
  step: number
  schemas: ToolSchema[]
  sdk: string
  instructions: string
}
/** Auxiliary routing and exact bounded text submitted to the selector. */
export interface SelectorRequest { provider: string; model: string; maxTokens: number; system: string; input: string; phase: 'tools' | 'servers' }
/** Selector outcome; failures never imply that MCP is unnecessary. */
export interface SelectorResult { status: 'selected' | 'none' | 'uncertain' | 'failed'; names: string[]; servers: string[]; detail?: string }
/** Host-only replay state. */
export interface DiscoveryState { selection: Selection; request: RequestSnapshot | null }

declare module '@deepseek-ai/dsh-session/types' {
  interface SessionEventMap {
    /** Whole loaded state committed after load, release, replacement, or invalidation. */
    'mcp/selection': Selection & { reason: 'load' | 'release' | 'invalidate' | 'replace' }
    /** Direct targeting or admission diagnosis; it does not imply an auxiliary call. */
    'mcp/diagnostic': { reason: string }
    /** Exact auxiliary request, recorded before dispatch. */
    'mcp/selector-request': SelectorRequest
    /** Validated auxiliary outcome, including unavailable or invalid responses. */
    'mcp/selector-result': SelectorResult
    /** Immutable assembly bound to the assistant attempt that produces calls. */
    'mcp/request-snapshot': RequestSnapshot
  }
}
declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap { mcpDiscovery: DiscoveryState }
}
