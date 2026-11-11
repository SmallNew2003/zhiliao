/** Target-neutral Conversation state assembled from one Session event window. */
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { SessionSnapshot } from '@deepseek-ai/dsh-api-session-controller/client'
import type { ConversationViewSnapshotStore } from './conversation.ts'

/** Latest registered target snapshots and their shell-level activity. */
export interface ConversationSnapshot {
  readonly views: ConversationViewSnapshotStore
  readonly activeTargets: ReadonlySet<string>
}

/** Empty Conversation value used before a Session binding is available. */
export const EMPTY_CONVERSATION_SNAPSHOT: ConversationSnapshot = {
  views: { get: () => undefined, grouped: () => undefined },
  activeTargets: new Set(),
}

/** Shell phase derived from Session lifecycle and registered target activity. */
export type ConversationPhase = 'blank' | 'engaging' | 'active'

/**
 * Resolve the shell phase without adding Conversation data to the Session snapshot.
 * @param session - current Session lifecycle state.
 * @param conversation - current target-neutral Conversation state.
 * @returns the phase used by the header, View ring, and composer layout.
 */
export function conversationPhase(
  session: SessionSnapshot,
  conversation: ConversationSnapshot,
): ConversationPhase {
  const active = conversation.activeTargets.size > 0
    || (!session.blank && !session.awaitingFirstTurn)
    || session.running
  return active ? 'active' : session.promptAttempted ? 'engaging' : 'blank'
}

/**
 * Resolve shared Composer layout while a Session opens or its first turn begins.
 * @param sessionId - Selected Session identity, absent before selection.
 * @param session - Session lifecycle state, absent before its source is ready.
 * @param conversation - Target activity for the retained Session.
 * @param summaryBlank - List evidence that no history needs to load.
 * @returns Stable layout phase and whether the hero Composer is visible.
 */
export function conversationLayout(
  sessionId: SessionId | undefined,
  session: SessionSnapshot | undefined,
  conversation: ConversationSnapshot | undefined,
  summaryBlank: boolean | undefined,
): { phase: 'settling' | 'hero' | 'active'; hero: boolean } {
  const shellPhase = session === undefined || conversation === undefined
    ? 'blank'
    : conversationPhase(session, conversation)
  // Known-blank summaries need no history; continuable children still await parent availability.
  const parentPending = session?.subagent?.address.mode === 'continuable'
    && session.subagent.parentAvailable === undefined
  const settling = sessionId !== undefined && (
    (shellPhase === 'blank' && session?.openState === 'loading' && summaryBlank !== true)
    || parentPending
  )
  const hero = sessionId === undefined
    || (shellPhase === 'blank' && (session?.openState === 'open' || summaryBlank === true))
  return { phase: settling ? 'settling' : hero ? 'hero' : 'active', hero }
}
