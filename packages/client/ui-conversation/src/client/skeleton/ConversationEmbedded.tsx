/** Header-free Conversation frame for a caller-owned retained Session. */
import type { ConversationEmbeddedProps } from '../contract/slots.ts'
import { conversationLayout } from '../contract/snapshot.ts'

/**
 * Render shared Conversation content in the caller's Session scope.
 * @param props - Session sources, Workspace policy, and registered Factory renderer.
 * @returns Shared transcript and Composer with embedded layout.
 */
export function ConversationEmbedded(props: ConversationEmbeddedProps) {
  const { sessionId, useSession, useSessions, useConversation, renderFactorySlot } = props
  const session = useSession(s => s)
  const conversation = useConversation(s => s)
  const summaryBlank = useSessions(s => s.byId[sessionId]?.blank)
  const { phase, hero } = conversationLayout(sessionId, session, conversation, summaryBlank)
  return renderFactorySlot('conversation.content', {
    variant: 'embedded', phase, hero, workspaceMode: props.workspaceMode ?? 'required',
  })
}
