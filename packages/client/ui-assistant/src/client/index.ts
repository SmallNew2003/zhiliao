/** Assistant surface plugin for scoped conversations and task history. */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-remote-access/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { AssistantTaskId } from '@deepseek-ai/dsh-assistant-task/client'
import { brandString } from '@deepseek-ai/dsh-brand'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { AssistantHeaderAction } from './AssistantHeaderAction.tsx'
import { SessionListNotice } from './SessionListNotice.tsx'
import { AssistantIcon } from './AssistantIcon.tsx'
import { AssistantPage, AssistantConversation, type AssistantPageInjected } from './AssistantPage.tsx'
import { CreateTaskCard, type CreateTaskCardInjected } from './CreateTaskCard.tsx'
import { de, en, es, fr, ja, pt, ru, zh, NS } from './locales.ts'
import { createAssistantWorkspace } from './state.ts'
import { createTaskResources } from './task-resource.ts'

export type { AssistantState } from './state.ts'

const PANEL_ID = 'assistant' as MainPanelId

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** Assistant conversation retained while its panel is visible. */
    assistantPanel: unknown
  }
}

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Assistant surface copy. */
    assistant: keyof typeof zh
  }
  interface SlotMap {
    /** Conversation of the assistant selected in the parent panel. */
    'assistant.conversation': { kind: 'single'; scope: 'session' }
  }
}

/** Required services for Assistant navigation, live reads and scoped conversation. */
export const inject = [
  'slots', 'locale', 'remoteAccess', 'remote', 'remote.assistantTasks', 'resources', 'sessions', 'uiWorkspace', 'workspaces', 'layout',
]

/**
 * Register the workspace, task cards and Session separation while the user has access.
 * @param ctx - Client services used by the surface.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en, ja, es, fr, de, ru, pt }), 'ui-assistant: dictionaries')
  const t = ctx.locale.bind(NS)

  ctx.remoteAccess.whenAccess('assistantTasks/assistants', function* () {
    const workspace = createAssistantWorkspace(ctx)
    const { state } = workspace
    yield () => { workspace.dispose() }
    yield ctx.uiWorkspace.registerHiddenSessionSource(workspace.hiddenSessions)
    const details = createTaskResources(ctx, (row) => { workspace.remember([row.sessionId]) })
    yield ctx.resources.register(details.provider)
    const openTask = (id: string): void => { ctx.uiWorkspace.openSession(brandString<SessionId>(id)) }
    const cancelTask = (id: AssistantTaskId): void => { void workspace.cancelTask(id) }
    const page: AssistantPageInjected = {
      hooks: { state },
      select: (id) => { void workspace.select(id) },
      refresh: workspace.refresh,
      loadMore: () => { void workspace.refreshTasks(true) },
      cancelTask, openTask,
      refreshCatalog: () => ctx.sessions.refresh(),
      retain: id => ctx.sessions.retain(id, { source: 'assistantPanel' }),
    }
    const card: CreateTaskCardInjected = {
      hooks: { state },
      openTask, cancelTask,
      retryTask: details.refresh,
    }

    yield ctx.remote.$on('assistant-task/changed', (id) => {
      details.refresh(id)
      void workspace.refreshVisibility()
      void workspace.refreshTasks()
    })
    yield ctx.remote.$on('assistant/changed', () => {
      void workspace.refreshVisibility()
      void workspace.select(state.getSnapshot().selectedWorkspace)
    })
    workspace.refresh()
    yield ctx.slots.inject('main', () => ctx.slots.register({
      name: 'main', key: PANEL_ID, locale: NS,
      children: { 'assistant.conversation': { kind: 'single', scope: 'session' } },
      inject: () => page,
    }, AssistantPage))
    yield ctx.slots.inject('assistant.conversation', () => ctx.slots.register({
      name: 'assistant.conversation',
    }, AssistantConversation))
    yield ctx.slots.inject('sidebar.workspaces.feedback', () => ctx.slots.register({
      name: 'sidebar.workspaces.feedback', id: 'assistant-session-list', locale: NS,
      inject: () => ({ hooks: { state }, retry: () => { void workspace.refreshVisibility() } }),
    }, SessionListNotice))
    yield ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
      name: 'sidebar.panellist', id: PANEL_ID, order: 5, locale: NS, label: () => t('panel'),
    }, AssistantIcon))
    yield ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({
      name: 'conversation.session.header.actions', id: 'assistant-session', order: 15, locale: NS,
      inject: () => ({
        hooks: { state },
        returnToAssistant: (id: string) => {
          const { executions, conversations } = state.getSnapshot()
          const execution = executions.find(row => row.sessionId === id)
          const owner = conversations.find(row => execution === undefined
            ? row.sessionId === id : row.assistantId === execution.assistantId)
          if (owner !== undefined) void workspace.select(owner.workspaceId ?? null)
          ctx.layout.selectPanel(PANEL_ID)
        },
      }),
    }, AssistantHeaderAction))
    yield ctx.slots.inject('tool.call.toolview', () => ctx.slots.register({
      name: 'tool.call.toolview', key: 'create_task', locale: NS, inject: () => card,
    }, CreateTaskCard))
  })
}
