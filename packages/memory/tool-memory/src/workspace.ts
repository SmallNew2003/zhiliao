/**
 * Workspace and session-shape helpers for the memory lifecycle hooks.
 *
 * Memory is bound to a *workspace*, not to a session, so a resumed session keeps writing
 * to the bank it started with. Delegated (subagent) sessions are excluded: they inherit
 * their parent's cwd but carry a different working set, and folding their turns into the
 * parent's bank would interleave two conversations into one memory.
 *
 * @module @deepseek-ai/dsh-tool-memory/workspace
 */

import type { Agent } from '@deepseek-ai/dsh-agent'

/**
 * The workspace directory a session's memory belongs to, or undefined when the session
 * has no directory of its own.
 *
 * @param agent - the agent whose workspace root should be read.
 * @returns the absolute `cwd` frozen into the session header, or undefined.
 */
export function workspaceRootOf(agent: Agent): string | undefined {
  return agent.session.header.cwd
}

/**
 * Whether a session is a primary (user-facing) session rather than a delegated one.
 *
 * @param agent - the agent whose session shape should be classified.
 * @returns true when the session owns its transcript and should write memory.
 */
export function isPrimarySession(agent: Agent): boolean {
  const { origin, delegationDepth } = agent.session.header
  return origin !== 'subagent' && (delegationDepth ?? 0) === 0
}
