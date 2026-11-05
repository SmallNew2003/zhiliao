/** Assistant surface plugin: one entry for the global assistant and each project assistant. */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {
  AssistantConversationEntry,
  AssistantExecutionEntry,
  AssistantId,
  AssistantTaskId,
  AssistantTaskView,
  AssistantView,
} from '@deepseek-ai/dsh-assistant-task/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type {} from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { AssistantHeaderAction } from './AssistantHeaderAction.tsx'
import { AssistantIcon } from './AssistantIcon.tsx'
import { AssistantPage, type AssistantPageInjected } from './AssistantPage.tsx'
import { CreateTaskCard } from './CreateTaskCard.tsx'
import { en, zh, NS } from './locales.ts'

const PANEL_ID = 'assistant' as MainPanelId

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Assistant surface copy. */
    assistant: keyof typeof zh
  }
}

/** Required services for the assistant surface. */
export const inject = [
  'slots', 'locale', 'remote', 'remote.assistantTasks', 'uiWorkspace', 'workspaces', 'layout',
]

/** One assistant surface snapshot. */
export interface AssistantState {
  assistants: readonly AssistantView[]
  tasks: readonly AssistantTaskView[]
  /** Every assistant conversation Session with its owning assistant. */
  conversations: readonly AssistantConversationEntry[]
  /** Every task execution Session with its owning task. */
  executions: readonly AssistantExecutionEntry[]
  /** All assistant-owned Session ids that must stay out of ordinary user browsing. */
  hidden: readonly SessionId[]
  selected: AssistantId | null
  selectedWorkspace: WorkspaceId | null
  phase: 'loading' | 'ready' | 'error'
}

/** Read a Remote result, folding transport rejection into a missing value. */
async function read<Value>(
  call: () => Promise<{ readonly ok: true; readonly value: Value } | { readonly ok: false }>,
): Promise<Value | undefined> {
  try {
    const result = await call()
    return result.ok ? result.value : undefined
  } catch (_error: unknown) {
    return undefined
  }
}

/**
 * Register the assistant main panel, sidebar entry, task separation source, and
 * Host change subscriptions.
 * @param ctx - Browser services used by the surface.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-assistant: dictionaries')
  const t = ctx.locale.bind(NS)
  const state = createSnapshotStore<AssistantState>({
    assistants: [],
    tasks: [],
    conversations: [],
    executions: [],
    hidden: [],
    selected: null,
    selectedWorkspace: null,
    phase: 'loading',
  })
  let refreshEpoch = 0
  const hiddenSessions = {
    getSnapshot: () => state.getSnapshot().hidden,
    subscribe: (listener: () => void) => state.subscribe(listener),
  }

  const refresh = async (): Promise<void> => {
    const epoch = ++refreshEpoch
    const assistants = await read(() => ctx.remote.assistantTasks.assistants({}))
    if (assistants === undefined && epoch === refreshEpoch) {
      state.update((draft) => { draft.phase = 'error' })
      return
    }
    const selected = state.getSnapshot().selected
    const selectedWorkspace = state.getSnapshot().selectedWorkspace
    const tasks = await read(() => ctx.remote.assistantTasks.tasks(selectedWorkspace === null ? {} : { workspaceId: selectedWorkspace }))
    const visibility = await read(() => ctx.remote.assistantTasks.visibility())
    if (epoch !== refreshEpoch) return
    state.update((draft) => {
      draft.assistants = assistants ?? []
      draft.tasks = tasks ?? []
      draft.conversations = visibility?.conversations ?? []
      draft.executions = visibility?.executions ?? []
      draft.hidden = visibility?.sessionIds ?? []
      draft.phase = tasks === undefined ? 'error' : 'ready'
      draft.selected = selected
      draft.selectedWorkspace = selectedWorkspace
    })
  }

  const ensureGlobal = async (): Promise<void> => {
    state.update((draft) => { draft.phase = 'loading' })
    const assistant = await read(() => ctx.remote.assistantTasks.ensureAssistant({ kind: 'global' }))
    if (assistant === undefined) {
      state.update((draft) => { draft.phase = 'error' })
      return
    }
    state.update((draft) => {
      draft.selected = assistant.id
      draft.selectedWorkspace = null
    })
    await refresh()
  }

  const selectGlobal = (): void => {
    const global = state.getSnapshot().assistants.find(assistant => assistant.kind === 'global')
    state.update((draft) => {
      draft.selected = global?.id ?? null
      draft.selectedWorkspace = null
    })
    void refresh()
  }

  const selectProject = async (workspaceId: WorkspaceId): Promise<void> => {
    state.update((draft) => {
      draft.selectedWorkspace = workspaceId
      draft.phase = 'loading'
    })
    const assistant = await read(() => ctx.remote.assistantTasks.ensureAssistant({ kind: 'project', workspaceId }))
    if (assistant === undefined) {
      state.update((draft) => { draft.phase = 'error' })
      return
    }
    state.update((draft) => { draft.selected = assistant.id })
    await refresh()
  }

  const cancelTask = async (id: AssistantTaskId): Promise<void> => {
    const result = await read(() => ctx.remote.assistantTasks.cancelTask({ id }))
    if (result === undefined) {
      state.update((draft) => { draft.phase = 'error' })
      return
    }
    await refresh()
  }

  const openTask = (sessionId: SessionId): void => {
    ctx.uiWorkspace.openSession(sessionId)
  }

  const openAssistant = (sessionId: SessionId): void => {
    ctx.uiWorkspace.openSession(sessionId)
  }

  const returnToAssistant = (sessionId: SessionId): void => {
    const snapshot = state.getSnapshot()
    const execution = snapshot.executions.find(entry => entry.sessionId === sessionId)
    const conversation = snapshot.conversations.find(entry => entry.sessionId === sessionId)
    const assistantId = execution?.assistantId ?? conversation?.assistantId
    const workspaceId = execution?.workspaceId ?? conversation?.workspaceId
    if (assistantId !== undefined) {
      state.update((draft) => {
        draft.selected = assistantId
        draft.selectedWorkspace = workspaceId ?? null
      })
      void refresh()
    }
    ctx.layout.selectPanel(PANEL_ID)
  }

  const injected = (): AssistantPageInjected => ({
    hooks: {
      state,
      workspaces: ctx.workspaces.list,
    },
    selectGlobal,
    selectProject: (workspaceId) => { void selectProject(brandString<WorkspaceId>(workspaceId)) },
    refresh: () => { void refresh() },
    cancelTask: (id) => { void cancelTask(brandString<AssistantTaskId>(id)) },
    openTask: (sessionId) => { openTask(brandString<SessionId>(sessionId)) },
    openAssistant: (sessionId) => { openAssistant(brandString<SessionId>(sessionId)) },
  })

  ctx.effect(() => ctx.uiWorkspace.registerHiddenSessionSource(hiddenSessions), 'ui-assistant: separated Sessions')
  ctx.effect(() => ctx.remote.$on('assistant-task/changed', () => { void refresh() }), 'ui-assistant: task changes')
  ctx.effect(() => ctx.remote.$on('assistant/changed', () => { void refresh() }), 'ui-assistant: assistant changes')
  void ensureGlobal()
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: injected,
  }, AssistantPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 5,
    locale: NS,
    label: () => t('panel'),
  }, AssistantIcon))
  ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
    name: 'conversation.session.header.actions',
    id: 'assistant-session',
    // After the assistant preset label (-10) and beside background tasks (20).
    order: 15,
    locale: NS,
    inject: () => ({
      hooks: { state },
      returnToAssistant: (sessionId: string) => { returnToAssistant(brandString<SessionId>(sessionId)) },
    }),
  }, AssistantHeaderAction))
  ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
    name: 'tool.call.toolview',
    key: 'create_task',
    locale: NS,
    inject: () => ({
      openTask: (sessionId: string) => { openTask(brandString<SessionId>(sessionId)) },
    }),
  }, CreateTaskCard))
}
