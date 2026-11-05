import { Context, Service } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import type {
  AssistantId, AssistantTaskId, AssistantTaskView, AssistantView,
} from '@deepseek-ai/dsh-assistant-task/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel, type StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as applyLocale, inject as localeInject } from '@deepseek-ai/dsh-client-locale/client'
import { apply, inject } from '../src/client/index.ts'
import type { AssistantPageInjected } from '../src/client/AssistantPage.tsx'
import type { AssistantHeaderInjected } from '../src/client/AssistantHeaderAction.tsx'

const Empty = () => null
const sid = (id: string) => id as SessionId
const createdAt = '2026-11-04T00:00:00.000Z'

const globalAssistant: AssistantView = {
  id: 'assistant-global-1' as AssistantId,
  kind: 'global',
  sessionId: sid('assistant-session'),
  retiredSessionIds: [],
  createdAt,
  updatedAt: createdAt,
}

const task: AssistantTaskView = {
  id: 'task-1' as AssistantTaskId,
  assistantId: globalAssistant.id,
  title: 'Review the deployment',
  status: 'running',
  sessionId: sid('task-session'),
  sessionAvailable: true,
  createdAt,
  updatedAt: createdAt,
}

interface RemoteInput {
  readonly assistantTasks: object
  readonly $on: (event: string, listener: () => void) => () => void
}

class RemoteStub extends Service {
  constructor(ctx: Context, readonly input: RemoteInput) {
    super(ctx, 'remote')
  }

  $on(event: string, listener: () => void): () => void {
    return this.input.$on(event, listener)
  }
}

interface HiddenSource {
  getSnapshot(): readonly SessionId[]
  subscribe(listener: () => void): () => void
}

interface ContextFixture {
  readonly ctx: Context
  readonly openSession: ReturnType<typeof vi.fn>
  readonly selectPanel: ReturnType<typeof vi.fn>
  readonly hiddenSource: () => HiddenSource | undefined
}

async function baseContext(remote: RemoteInput = {
  assistantTasks: {
    assistants: vi.fn(async () => ({ ok: true, value: [globalAssistant] })),
    tasks: vi.fn(async () => ({ ok: true, value: [task] })),
    visibility: vi.fn(async () => ({
      ok: true,
      value: {
        sessionIds: [globalAssistant.sessionId, task.sessionId],
        conversations: [{ sessionId: globalAssistant.sessionId, assistantId: globalAssistant.id, retired: false }],
        executions: [{
          sessionId: task.sessionId,
          taskId: task.id,
          assistantId: globalAssistant.id,
        }],
      },
    })),
    ensureAssistant: vi.fn(async () => ({ ok: true, value: globalAssistant })),
    cancelTask: vi.fn(async () => ({ ok: true, value: task })),
  },
  $on: () => () => {},
}): Promise<ContextFixture> {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  new RemoteStub(ctx, remote)
  await ctx.plugin({ apply(provider: Context) {
    provider.provide('remote.assistantTasks', remote.assistantTasks as never)
  } }).await()
  const openSession = vi.fn()
  let hiddenSource: HiddenSource | undefined
  const registerHiddenSessionSource = vi.fn((source: HiddenSource) => {
    hiddenSource = source
    return () => { hiddenSource = undefined }
  })
  ctx.provide('uiWorkspace', { openSession, registerHiddenSessionSource } as never)
  const workspaces: WorkspaceSnapshot = {
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  }
  ctx.provide('workspaces', { list: { getSnapshot: () => workspaces, subscribe: () => () => {} } } as never)
  const selectPanel = vi.fn()
  ctx.provide('layout', { selectPanel } as never)
  ctx.provide('connection', { api: { settings: {} }, isLoopback: false } as never)
  ctx.provide('settingsScope', { bind: () => stubSettingsScope().scope } as never)
  await ctx.plugin({ inject: localeInject, apply: applyLocale }).await()
  return { ctx, openSession, selectPanel, hiddenSource: () => hiddenSource }
}

/** Read the object one slot entry's `inject` callback returned. */
function injectedFace(entry: StoredEntry, ...args: never[]): object {
  const face = entry.inject?.(...args)
  if (face === undefined) throw new Error('slot entry injected no face')
  return face
}

function declareSeats(ctx: Context): void {
  ctx.slots.register({
    name: 'root',
    children: {
      main: { kind: 'keyed', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
      'conversation.session.header.actions': { kind: 'list', scope: 'session' },
      'tool.call.toolview': { kind: 'keyed', scope: 'session' },
    },
  } as never, Empty)
}

describe('ui-assistant browser half', () => {
  it('opens the assistant conversation and separates assistant-owned Sessions', async () => {
    const { ctx, openSession, hiddenSource } = await baseContext()
    declareSeats(ctx)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const panel = ctx.slots.entries('sidebar.panellist')[0]!
    expect(panel.options.id).toBe('assistant')
    ctx.locale.setLocale('en')
    expect(resolveSlotLabel(panel.options.label)).toBe('Assistant')
    ctx.locale.setLocale('zh')
    expect(resolveSlotLabel(panel.options.label)).toBe('助理')

    const page = injectedFace(ctx.slots.entries('main')[0]!, undefined as never) as AssistantPageInjected
    const stop = page.hooks.state.subscribe(() => {})
    await vi.waitFor(() => {
      expect(page.hooks.state.getSnapshot().phase).toBe('ready')
      expect(page.hooks.state.getSnapshot().assistants).toEqual([globalAssistant])
    })
    expect(hiddenSource()?.getSnapshot()).toEqual(expect.arrayContaining([globalAssistant.sessionId, task.sessionId]))
    page.openAssistant(globalAssistant.sessionId)
    expect(openSession).toHaveBeenCalledExactlyOnceWith(globalAssistant.sessionId)
    stop()
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('returns from a task Session to the owning assistant', async () => {
    const { ctx, selectPanel } = await baseContext()
    declareSeats(ctx)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const header = injectedFace(ctx.slots.entries('conversation.session.header.actions')[0]!) as AssistantHeaderInjected
    const stop = header.hooks.state.subscribe(() => {})
    await vi.waitFor(() => {
      expect(header.hooks.state.getSnapshot().executions).toHaveLength(1)
    })
    expect(header.hooks.state.getSnapshot().conversations).toContainEqual({
      sessionId: globalAssistant.sessionId,
      assistantId: globalAssistant.id,
      retired: false,
    })
    header.returnToAssistant(task.sessionId)
    const state = header.hooks.state.getSnapshot()
    expect(state.selected).toBe(globalAssistant.id)
    expect(state.selectedWorkspace).toBeNull()
    expect(selectPanel).toHaveBeenCalledExactlyOnceWith('assistant')
    stop()
    await fiber.dispose()
    await ctx.fiber.dispose()
  })

  it('releases the separation source when the plugin is disposed', async () => {
    const { ctx, hiddenSource } = await baseContext()
    declareSeats(ctx)
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(hiddenSource()).toBeDefined()
    await fiber.dispose()
    expect(hiddenSource()).toBeUndefined()
    await ctx.fiber.dispose()
  })
})
