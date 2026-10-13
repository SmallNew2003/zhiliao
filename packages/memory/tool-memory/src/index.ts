/**
 * Session-lifecycle memory wiring for the DeepSeek Harness.
 *
 * Three hooks, all of which must never block or fail a turn:
 * - `agent/pre-step` — recall memories relevant to the opening prompt and append them as
 *   a durable, source-attributed user message.
 * - `agent/turn-stopping` — retain the finished turn's transcript into the session's bank.
 * - `agent/created` — seed a cold bank's workspace with recent commits and a read-only
 *   survey, so the first session is not amnesiac.
 *
 * Every listener follows the compaction package's discipline: call `next()` first, never
 * let an exception escape, and degrade to a warning. hindsight answers recall by running
 * inference, so a slow or unreachable backend must cost a log line, not a failed turn.
 *
 * @module @deepseek-ai/dsh-tool-memory
 */

import type { Context, LoggerService } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import type { MemoryBankId, MemoryUnit, TranscriptTurn } from '@deepseek-ai/dsh-memory'
import { MemoryError } from '@deepseek-ai/dsh-memory'
import type { MemoryRuntime } from '@deepseek-ai/dsh-memory'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { workspaceRootOf, isPrimarySession } from './workspace.ts'
import { renderRecall, describeSeeding } from './render.ts'
import type { Seeder } from './seed.ts'
import { createSeeder } from './seed.ts'
import { applyMemoryTools } from './tools.ts'

/** Cordis plugin name used by loader diagnostics. */
export const name = 'tool-memory'

/**
 * Only the memory seam is required. The tool registry is optional so the automatic
 * lifecycle wiring (opening recall, turn retention, cold-bank seeding) still works in a
 * composition that exposes no tool plane; a deployment without `tools` simply loses the
 * `hindsight_*` tools and keeps its memory.
 */
export const inject = ['memory']

/** Plugin config: recall budget, injection shape, retention, and cold-bank seeding. */
export interface Config {
  /** Inject recalled memories ahead of the first request of a session. */
  injectRecall?: boolean
  /** Retain each finished turn's transcript into the session's bank. */
  retainTranscripts?: boolean
  /** Maximum memories injected in one session opening. */
  recallLimit?: number
  /** Seed a cold bank with recent commits and a read-only survey. */
  seedColdBanks?: boolean
  /** How many recent commits seed a cold bank from. */
  seedCommitCount?: number
  /** Wall-clock budget for seeding one workspace; exceeded work is abandoned. */
  seedBudgetMs?: number
}

export const Config: z<Config> = z.object({
  injectRecall: z.boolean().default(true),
  retainTranscripts: z.boolean().default(true),
  recallLimit: z.number().default(6),
  seedColdBanks: z.boolean().default(true),
  seedCommitCount: z.number().default(30),
  seedBudgetMs: z.number().default(120_000),
})

/** Complete config after schemastery applies every field default. */
type ResolvedConfig = Required<Config>

/** Per-session state this plugin keeps while a session is live. */
interface LiveSession {
  /** The bank resolved for this session's workspace. */
  readonly bankId: MemoryBankId
  /** Turns retained so far, in order, ready to hand to the backend. */
  readonly retained: TranscriptTurn[]
  /** Whether the opening recall already ran, so it happens once per session. */
  recalled: boolean
}

/**
 * Wire long-term memory into the agent lifecycle: opening recall, turn retention, and
 * cold-bank seeding. Disabling every capability leaves the plugin inert but still
 * mounted, so a deployment can turn memory off without removing it from the composition.
 */
export function apply(ctx: Context, config: Config): void {
  const resolved = config as ResolvedConfig
  const logger = ctx.logger
  const live = new Map<string, LiveSession>()

  // Tools and lifecycle hooks share one memo: whichever resolves a session's bank first
  // publishes it for the other, so a search never pays a second resolution round trip.
  const resolveBank = (sessionId: string): MemoryBankId | undefined => live.get(sessionId)?.bankId

  // The tool registry is optional: `ctx.inject` runs the callback as soon as `tools`
  // appears and never runs it in a composition that has no tool plane.
  ctx.inject(['tools'], (toolCtx) => {
    applyMemoryTools(toolCtx, resolveBank)
  })
  const seeder: Seeder | undefined = resolved.seedColdBanks
    ? createSeeder({ commitCount: resolved.seedCommitCount, budgetMs: resolved.seedBudgetMs })
    : undefined

  /** Resolve (and memoise) the bank for a session's workspace. */
  const bind = async (agent: Agent, signal: AbortSignal): Promise<LiveSession | undefined> => {
    const existing = live.get(agent.session.header.id)
    if (existing !== undefined) return existing
    if (!isPrimarySession(agent)) return undefined
    const root = workspaceRootOf(agent)
    if (root === undefined) return undefined
    if (!ctx.memory.isAvailable()) return undefined
    try {
      const bankId = await ctx.memory.resolveBank(root, signal)
      const created: LiveSession = { bankId, retained: [], recalled: false }
      live.set(agent.session.header.id, created)
      return created
    } catch (error: unknown) {
      logger.warn(`memory: could not resolve a bank for ${root}: ${describeError(error)}`)
      return undefined
    }
  }

  // Bank binding is its own listener, independent of seeding: with seeding off there
  // would otherwise be no `agent/created` hook at all, and recall plus retention would
  // silently never resolve a bank.
  ctx.on('agent/created', ({ agent, signal }): undefined => {
    // Resolution is a round trip to the backend, and `agent/created` is serial and
    // awaited; blocking session start on it would delay the first prompt. So the work
    // runs detached and every consumer treats "no bank yet" as "no memory this turn".
    const lifetime = signal ?? new AbortController().signal
    void bind(agent, lifetime).catch((error: unknown) => {
      logger.warn(`memory: bank binding failed: ${describeError(error)}`)
    })
    return undefined
  })

  if (seeder !== undefined) {
    // Seeding is slow and never worth blocking session start on, so this listener
    // returns immediately and the work runs detached.
    ctx.on('agent/created', ({ agent, signal }): undefined => {
      const lifetime = signal ?? new AbortController().signal
      void (async () => {
        // `bind` already rejects a session with no workspace of its own, so a live
        // session here always has a root to seed from.
        const session = await bind(agent, lifetime)
        if (session === undefined || lifetime.aborted) return
        const root = workspaceRootOf(agent)
        /* v8 ignore next -- unreachable: bind returns undefined without a workspace root */
        if (root === undefined) return
        try {
          const outcome = await seeder.seed(ctx.memory, session.bankId, root, lifetime, logger)
          if (outcome !== undefined) {
            logger.debug(`memory: ${describeSeeding(outcome)}`)
          }
        } catch (error: unknown) {
          // Seeding is best-effort enrichment: a cold bank that never seeds is still
          // usable, so this must never surface as a turn failure.
          /* v8 ignore next 2 -- the seeder handles its own failures; this guards its contract */
          logger.warn(`memory: seeding ${session.bankId} failed: ${describeError(error)}`)
        }
      })()
      return undefined
    })
  }

  if (resolved.injectRecall) {
    ctx.on('agent/pre-step', async (
      { agent, turn, signal },
      next,
    ): Promise<PreStepDecision> => {
      const decision = await next()
      if (decision.kind === 'reject' || signal.aborted) return decision
      const session = live.get(agent.session.header.id)
      if (session === undefined || session.recalled) return decision
      // Only the opening request carries a user prompt worth recalling against; later
      // steps of the same turn are already working from that prompt.
      if (decision.messages.length === 0) return decision
      const prompt = lastPromptOf(decision.messages)
      if (prompt === undefined) return decision
      session.recalled = true
      const recalled = await recallSafely(ctx.memory, session.bankId, prompt, resolved.recallLimit, signal, logger)
      // Recall awaits the backend, so the turn may have been cancelled meanwhile; the
      // narrowed `signal.aborted` above cannot account for that.
      if (recalled === undefined || isAborted(signal)) return decision
      const text = renderRecall(recalled)
      if (text === undefined) return decision
      logger.debug(`memory: injected ${recalled.length} memories into ${agent.session.header.id} (turn ${turn})`)
      return {
        ...decision,
        messages: [
          ...decision.messages,
          createUserMessage({
            content: [{ type: 'text', text }],
            source: { kind: 'plugin', plugin: name, form: 'snapshot', sections: [{ name, text }] },
          }),
        ],
      }
    }, { prepend: true })
  }

  if (resolved.retainTranscripts) {
    ctx.on('agent/turn-stopping', async ({ agent, turn, signal }): Promise<void> => {
      const session = live.get(agent.session.header.id)
      if (session === undefined || signal.aborted) return
      const exchange = exchangeOf(agent, turn)
      if (exchange !== undefined) session.retained.push(exchange)
      // Retain the whole session each turn rather than a delta: hindsight extracts facts
      // asynchronously and deduplicates server-side, so a repeat is cheaper than a lost turn.
      if (session.retained.length === 0) return
      try {
        await ctx.memory.retain({ turns: [...session.retained] }, session.bankId, signal)
      } catch (error: unknown) {
        logger.warn(`memory: retaining ${session.bankId} turn ${turn} failed: ${describeError(error)}`)
      }
    })
  }

  // Session teardown is an emit, so this is bookkeeping only: nothing is awaited here and
  // no backend call is made, because the turn already retained everything worth keeping.
  ctx.on('agent/disposed', ({ agent }): void => {
    live.delete(agent.session.header.id)
  })

  // Unmounting the plugin must not leave in-flight memory work writing against a torn-down
  // composition; this is the one place a disposer can await that shutdown.
  ctx.effect(() => (): void => {
    live.clear()
  }, 'tool-memory: dispose')
}

/**
 * Read a signal's aborted flag through a call the type checker cannot narrow away.
 * After an `await`, a previously-checked `signal.aborted` no longer reflects reality, so
 * re-reading it through a function keeps the check honest instead of erased.
 * @param signal - the signal to re-read.
 * @returns whether the signal is aborted at the moment of the call.
 */
function isAborted(signal: AbortSignal): boolean {
  return signal.aborted
}

/** Recall through the seam, converting any failure into a warning plus an absent result. */
async function recallSafely(
  memory: MemoryRuntime,
  bankId: MemoryBankId,
  prompt: string,
  limit: number,
  signal: AbortSignal,
  logger: LoggerService,
): Promise<readonly MemoryUnit[] | undefined> {
  try {
    const result = await memory.recall({ prompt, limit }, bankId, signal)
    return result.units
  } catch (error: unknown) {
    // Timeouts are expected here, not exceptional: the backend reasons before answering.
    logger.warn(`memory: recall against ${bankId} failed: ${describeError(error)}`)
    return undefined
  }
}

/** The last user prompt in a proposed request batch, or undefined when there is none. */
function lastPromptOf(messages: readonly { readonly role: string; readonly content: unknown }[]): string | undefined {
  for (const message of messages.toReversed()) {
    if (message.role !== 'user') continue
    return textOf(message.content)
  }
  return undefined
}

/** Extract plain text from a message content union, ignoring non-text blocks. */
function textOf(content: unknown): string | undefined {
  if (typeof content === 'string') return content.trim().length === 0 ? undefined : content.trim()
  if (!Array.isArray(content)) return undefined
  const parts: string[] = []
  for (const block of content as { type?: unknown; text?: unknown }[]) {
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
  }
  const joined = parts.join('\n').trim()
  return joined.length === 0 ? undefined : joined
}

/**
 * The prompt/response pair for a finished turn, read from the session's live message
 * surface. Returns undefined for a turn that produced nothing worth retaining.
 */
function exchangeOf(agent: Agent, turn: number): TranscriptTurn | undefined {
  const messages = agent.session.deriveMessages()
  let prompt: string | undefined
  const responses: string[] = []
  for (const message of messages) {
    const text = textOf((message as { content: unknown }).content)
    if (text === undefined) continue
    if (message.role === 'user') {
      prompt = text
      responses.length = 0
    } else if (message.role === 'assistant' && prompt !== undefined) {
      responses.push(text)
    }
  }
  if (prompt === undefined) return undefined
  const response = responses.join('\n').trim()
  return {
    turn,
    prompt,
    ...response.length === 0 ? {} : { response },
  }
}

/** Human-facing description of a thrown value, safe for a log line. */
function describeError(error: unknown): string {
  if (error instanceof MemoryError) return `${error.code}: ${error.message}`
  if (error instanceof Error) return error.message
  return String(error)
}
