/**
 * Heuristic composition of the current retained surface, independent of route
 * image pricing and provider usage. Positional entries preserve system-prompt
 * classification across replacements without retaining historical messages.
 */

import { z } from 'zod'
import { canonicalHeader, isSurfaceEvent, SessionSeq } from '@deepseek-ai/dsh-session'
import type { ProjectionDefinition } from '@deepseek-ai/dsh-session-projection'
import { estimateMessage, estimateToolsTokens } from './estimate.ts'
import { commitSurfaceTokens, planSurfaceTokens } from './surface-fold.ts'
// Import for the `contextBreakdown` SessionProjectionStateMap key merge.
import type {} from './projection.ts'

declare module '@deepseek-ai/dsh-session-projection/types' {
  interface SessionProjectionStateMap {
    contextBreakdown: ContextBreakdownState
  }
}

const tokenCount = z.number().int().nonnegative()
const sessionSeq = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform(SessionSeq)

const breakdownSchema = z.object({
  systemTokens: tokenCount,
  toolsTokens: tokenCount,
  messageTokens: tokenCount,
}).strict()

const breakdownNodesSchema = z.array(z.object({
  seq: sessionSeq,
  heuristicTokens: tokenCount,
  system: z.boolean(),
}).strict())

/** Current prices and one pre-input snapshot for latest-input editing. */
const contextBreakdownStateSchema = z.object({
  nodes: breakdownNodesSchema,
  breakdown: breakdownSchema,
  latestInput: z.object({ seq: sessionSeq, nodes: breakdownNodesSchema, breakdown: breakdownSchema }).strict().optional(),
}).strict()
type ContextBreakdownState = z.infer<typeof contextBreakdownStateSchema>

/**
 * Context composition with the last nonempty surviving system in surface
 * order classified as system tokens; all other visible prices are messages.
 * Replacements use the measurement planner, not shadow-price claims. State
 * and surface transitions cost O(current retained surface), not O(log length).
 * Tools are priced from the latest request header. No route pricing applies.
 */
export const contextBreakdownProjectionDefinition = {
  key: 'contextBreakdown',
  stateVersion: 6,
  stateSchema: contextBreakdownStateSchema,
  init: (): ContextBreakdownState => ({
    nodes: [],
    breakdown: { systemTokens: 0, toolsTokens: 0, messageTokens: 0 },
  }),
  apply: (state, event) => {
    if (event.type === 'user/message-admit') {
      const tokens = estimateMessage(event.data.message)
      const node = state.nodes.find(item => item.seq === event.data.targetSeq)
      if (node === undefined) throw new Error('context breakdown: admitted input is not retained')
      return {
        ...state,
        nodes: state.nodes.map(item => item === node ? { ...item, heuristicTokens: tokens } : item),
        breakdown: { ...state.breakdown, messageTokens: state.breakdown.messageTokens + tokens - node.heuristicTokens },
      }
    }
    if (event.type === 'user/message-edit') {
      const previous = state.latestInput
      if (previous?.seq !== event.data.targetSeq) throw new Error('context breakdown: edit target is not the latest user input')
      const tokens = estimateMessage(event.data.message)
      return {
        nodes: [...previous.nodes, { seq: event.seq, heuristicTokens: tokens, system: false }],
        breakdown: { ...previous.breakdown, messageTokens: previous.breakdown.messageTokens + tokens },
        latestInput: { ...previous, seq: event.seq },
      }
    }
    if (event.type === 'request/header') {
      const toolsTokens = estimateToolsTokens(canonicalHeader(event.data.header))
      return toolsTokens === state.breakdown.toolsTokens
        ? state
        : { ...state, breakdown: { ...state.breakdown, toolsTokens } }
    }
    if (!isSurfaceEvent(event)) return state
    const plan = planSurfaceTokens(state.nodes, event)
    const nodes = [...state.nodes]
    commitSurfaceTokens(nodes, {
      ...plan,
      node: { seq: event.seq, heuristicTokens: plan.tokens, system: event.type === 'system/message' },
    })
    const systemTokens = nodes.findLast(node => node.system && node.heuristicTokens > 0)?.heuristicTokens ?? 0
    const messageTokens = state.breakdown.systemTokens + state.breakdown.messageTokens + plan.deltaTokens - systemTokens
    const breakdown = systemTokens === state.breakdown.systemTokens && messageTokens === state.breakdown.messageTokens
      ? state.breakdown
      : { systemTokens, toolsTokens: state.breakdown.toolsTokens, messageTokens }
    const latestInput = event.type === 'user/message' && event.data.source.kind === 'user'
      ? { seq: event.seq, nodes: state.nodes, breakdown: state.breakdown }
      : state.latestInput
    return { nodes, breakdown, ...latestInput === undefined ? {} : { latestInput } }
  },
  wire: {
    viewSchema: breakdownSchema,
    view: state => state.breakdown,
  },
} satisfies ProjectionDefinition<'contextBreakdown', ContextBreakdownState>
