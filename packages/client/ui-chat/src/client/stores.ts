/** Per-Session Chat view store. */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'
import type { ChatStoreState, ProcessGroupViewEntry, TurnProcessViewEntry } from './contract/store.ts'

type ChatActions = {
  setTurnProcessOpen: (
    draft: ChatStoreState,
    turn: number,
    answerStep: number,
    open: boolean,
  ) => void
  setProcessGroupOpen: (draft: ChatStoreState, key: string, open: boolean | undefined) => void
}

/**
 * Resolve the manually expanded answer for one Turn.
 * @param state - Chat store snapshot.
 * @param turn - owning Turn.
 * @returns the Turn's stored entry, when present.
 */
export function storedTurnProcessEntry(
  state: Readonly<ChatStoreState>,
  turn: number,
): Readonly<TurnProcessViewEntry> | undefined {
  return state.turnProcesses.find(entry => entry.turn === turn)
}

/**
 * Create the Chat view store handle.
 * @returns a handle instantiated once per rendered Session scope.
 */
export function createChatStore(): EngineStoreHandle<ChatStoreState, ChatActions> {
  return defineStore({
    init: (): ChatStoreState => ({ turnProcesses: [], processGroups: [] }),
    actions: {
      setTurnProcessOpen: (draft, turn, answerStep, open) => {
        const index = draft.turnProcesses.findIndex(entry => entry.turn === turn)
        if (!open) {
          if (index >= 0) draft.turnProcesses.splice(index, 1)
          return
        }
        const next = { turn, answerStep } satisfies TurnProcessViewEntry
        if (index < 0) draft.turnProcesses.push(next)
        else draft.turnProcesses[index] = next
      },
      setProcessGroupOpen: (draft, key, open) => {
        const index = draft.processGroups.findIndex(entry => entry.key === key)
        if (open === undefined) {
          if (index >= 0) draft.processGroups.splice(index, 1)
          return
        }
        const next = { key, open } satisfies ProcessGroupViewEntry
        if (index < 0) draft.processGroups.push(next)
        else draft.processGroups[index] = next
      },
    },
  })
}
