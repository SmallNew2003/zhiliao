/**
 * Model-facing memory tools over the `ctx.memory` seam: `hindsight_search` for looking
 * things up and `hindsight_remember` for deliberately recording something worth keeping.
 *
 * These complement the automatic lifecycle wiring in `./index.ts`: recall already injects
 * a session's opening context and retention already captures each turn, so these tools
 * exist for the cases automation cannot cover — a targeted lookup mid-task, and a fact the
 * model is explicitly told to keep.
 *
 * @module @deepseek-ai/dsh-tool-memory/tools
 */

import type { Context } from '@deepseek-ai/cordis'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { MemoryBankId, MemoryUnit } from '@deepseek-ai/dsh-memory'
import { workspaceRootOf, isPrimarySession } from './workspace.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-memory'

/** Maximum units one search call returns. */
const SEARCH_MAX_RESULTS = 12

const SEARCH_DESCRIPTION =
  'Search this workspace\'s long-term memory for earlier decisions, conventions, and context. '
  + 'Use it when a question is about how something was settled previously, or when the injected '
  + 'memory looks too shallow to answer. Prefer this over guessing at a past decision. '
  + 'Results are background knowledge and may be stale; prefer code you can read over memory.'

const REMEMBER_DESCRIPTION =
  'Record a durable finding in this workspace\'s long-term memory: a decision and its rationale, '
  + 'a convention you confirmed, or a non-obvious fact. Do not use it for anything the repository '
  + 'already records (code, tests, docs, git history) or for the current turn\'s progress. '
  + 'Ordinary conclusions are captured automatically at the end of every turn.'

/** One recalled memory as both tools' output shape carries it. */
interface MemoryToolEntry {
  id: string
  text: string
}

/** The shape both tools return: units plus whether the seam truncated them. */
interface MemoryToolValue {
  memories: MemoryToolEntry[]
  truncated: boolean
}

/** Resolves the bank a tool call should use, or undefined when none applies. */
export type BankResolver = (sessionId: string) => MemoryBankId | undefined

/**
 * Register `hindsight_search` and `hindsight_remember` with `ctx.tools`.
 * @param ctx - a context carrying both the memory seam and the tool registry.
 * @param resolveBank - resolves a session's already-bound bank, or undefined when none.
 */
export function applyMemoryTools(ctx: Context, resolveBank: BankResolver): void {
  ctx.tools.register(defineTool({
    name: 'hindsight_search',
    description: SEARCH_DESCRIPTION,
    parameters: {
      query: {
        type: 'string',
        required: true,
        description: `What to look for. Max ${SEARCH_MAX_RESULTS} memories are returned.`,
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          memories: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                id: { type: 'string', required: true },
                text: { type: 'string', required: true },
              },
            },
          },
          truncated: { type: 'boolean', required: true },
        },
      },
      render: (_args, value: MemoryToolValue) => [{ type: 'text', text: renderSearch(value) }],
    },
    timeoutMs: 150_000,
    isConcurrencySafe: () => true,
    async execute(args, exec): Promise<MemoryToolValue> {
      const bank = bankFor(ctx, resolveBank, exec.agent)
      if (bank === undefined) return emptyValue()
      const result = await ctx.memory.search(
        { query: args.query, limit: SEARCH_MAX_RESULTS },
        bank,
        exec.signal,
      )
      return project(result.units, result.truncated)
    },
  }))

  ctx.tools.register(defineTool({
    name: 'hindsight_remember',
    description: REMEMBER_DESCRIPTION,
    parameters: {
      content: {
        type: 'string',
        required: true,
        description: 'The finding to keep, stated so it still makes sense out of context.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          remembered: { type: 'boolean', required: true },
          detail: { type: 'string', required: true },
        },
      },
      render: (_args, value: { remembered: boolean; detail: string }): { type: 'text'; text: string }[] => [
        { type: 'text', text: value.remembered ? 'Recorded in long-term memory.' : `Not recorded: ${value.detail}` },
      ],
    },
    timeoutMs: 60_000,
    async execute(args, exec): Promise<{ readonly remembered: boolean; readonly detail: string }> {
      const bank = bankFor(ctx, resolveBank, exec.agent)
      if (bank === undefined) return { remembered: false, detail: 'no memory bank for this workspace' }
      const result = await ctx.memory.retain(
        { turns: [{ turn: 0, prompt: args.content, response: 'Recorded as a durable finding.' }] },
        bank,
        exec.signal,
      )
      return { remembered: result.retained, detail: result.detail ?? '' }
    },
  }))
}

/**
 * The bank a tool call should read or write, or undefined when the call has no workspace
 * of its own. Delegated subagent calls are excluded so a subagent never reads or writes
 * the parent session's bank.
 */
function bankFor(
  ctx: Context,
  resolveBank: BankResolver,
  agent: Parameters<typeof isPrimarySession>[0] | undefined,
): MemoryBankId | undefined {
  if (agent === undefined) return undefined
  if (!isPrimarySession(agent)) return undefined
  if (workspaceRootOf(agent) === undefined) return undefined
  if (!ctx.memory.isAvailable()) return undefined
  // The lifecycle hooks already resolved this session's bank, so tools reuse it rather
  // than paying another round trip per call.
  return resolveBank(agent.session.header.id)
}

/** Project seam units onto the tool's stable output shape. */
function project(units: readonly MemoryUnit[], truncated: boolean): MemoryToolValue {
  return {
    memories: units.map(unit => ({ id: unit.id, text: unit.text })),
    truncated,
  }
}

/** The result a search returns when no bank applies. */
function emptyValue(): MemoryToolValue {
  return { memories: [], truncated: false }
}

/** Render a search result for the model, including the staleness caveat. */
function renderSearch(value: MemoryToolValue): string {
  if (value.memories.length === 0) {
    return 'No matching long-term memory for this workspace.'
  }
  const items = value.memories.map((memory, index) => `${index + 1}. ${memory.text.replace(/\s+/g, ' ').trim()}`).join('\n')
  const suffix = value.truncated ? '\n\n(results truncated)' : ''
  return `${items}${suffix}`
}
