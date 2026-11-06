/** Editing seats for standalone user-message component tests. */
import type { ComponentProps } from 'react'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { bindSnapshotSelector, sessionSnapshot } from '@deepseek-ai/dsh-client-test-runtime'
import { EMPTY_CHAT_SNAPSHOT } from '../src/client/contract/snapshot.ts'
import { createChatStore } from '../src/client/stores.ts'
import type { UserMessageNodeView } from '../src/client/chat/MessageItem.tsx'

/**
 * Create isolated Session and viewing state for one component fixture.
 * @returns the Session reader, viewing store, and editing operation used by the message seat.
 */
export function userMessageEditingFixture(): Pick<ComponentProps<typeof UserMessageNodeView>, 'useSession' | 'useChat' | 'editMessage' | 'useStore' | 'actions'> {
  const view = createChatStore().create()
  const session = sessionSnapshot('user-message-fixture' as SessionId)
  return {
    useSession: selector => selector(session),
    useChat: selector => selector(EMPTY_CHAT_SNAPSHOT),
    useStore: bindSnapshotSelector(view.store), actions: view.actions,
    editMessage: async () => ({ ok: true, value: { accepted: true } }),
  }
}
