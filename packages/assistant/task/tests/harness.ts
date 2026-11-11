/** Assistant task tests use real domain storage and explicit fake Session services. */
import { Context } from '@deepseek-ai/cordis'
import RemoteAccessService from '@deepseek-ai/dsh-api-remote-access'
import TypertRegistry from '@deepseek-ai/dsh-typert-registry'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import SessionStore, { SESSION_FORMAT_VERSION, SessionId, type SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import type { SessionPersistenceSnapshot } from '@deepseek-ai/dsh-session-persistence'
import { SessionPersistenceRevision } from '@deepseek-ai/dsh-session-persistence'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { vi } from 'vitest'
import { MemoryMediaPool, MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'
import AssistantTaskService, { type Config } from '../src/index.ts'

/** Build a stored Session view with a working directory. */
export function storedSession(sessionId: SessionId, cwd = '/tmp/project'): SessionPersistenceSnapshot {
  return {
    header: { version: SESSION_FORMAT_VERSION, id: sessionId, createdAt: 0, cwd, isSeeded: false },
    revision: SessionPersistenceRevision(`test:${sessionId}`),
  }
}

/** Create an isolated assistant task service with fake Session control and Workspace facts. */
export async function harness(options: {
  config?: Config
  pool?: MemoryMediaPool
  logs?: Map<SessionId, SessionEvent[]>
  configure?: (ctx: Context) => void
  sessions?: Map<string, SessionPersistenceSnapshot>
  workspaces?: Map<string, { id: string; path: string; title: string }>
} = {}) {
  const ctx = new Context()
  await ctx.plugin(TypertRegistry)
  await ctx.plugin(RemoteAccessService)
  await ctx.plugin(SessionStore)
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(Storage)
  const pool = options.pool ?? new MemoryMediaPool()
  const backend = new MemoryStorageBackend(pool)
  ctx.effect(() => ctx.storage.backend.register('fixture', backend))
  const facility = new DomainFacility(ctx, { backend: 'fixture' })
  ctx.effect(() => {
    const unmount = ctx.storage.mount('domain', facility)
    ctx.provide('storageDomain', facility)
    return async () => { await facility.closeAll(); unmount() }
  })
  const sessions = options.sessions ?? new Map<string, SessionPersistenceSnapshot>()
  const workspaces = options.workspaces ?? new Map<string, { id: string; path: string; title: string }>()
  const create = vi.fn(async (request: { sessionId?: SessionId; cwd?: string; agentPreset?: string }) => ({
    sessionId: request.sessionId ?? SessionId('created-session'),
    agentPreset: request.agentPreset,
  }))
  const prompt = vi.fn(async () => ({ accepted: true }))
  const cancel = vi.fn(() => ({ accepted: true }))
  const logs = options.logs ?? new Map<SessionId, SessionEvent[]>()
  const followup = vi.fn((session: ReturnType<typeof ctx.sessions.create>, message: Parameters<Agent['followup']>[0]) => {
    session.append('agent/inbox/spliced', { target: 'next-turn', start: 0, inserted: [message] })
  })
  const resolveAgent = vi.fn(async (id: SessionId) => {
    const session = ctx.sessions.get(id) ?? ctx.sessions.create(id, logs.has(id) ? { seed: logs.get(id)! } : {})
    return { agent: { id, session, followup(message: Parameters<Agent['followup']>[0]) { followup(session, message) } } }
  })
  ctx.provide('sessionController', { create, prompt, cancel, resolveAgent } as never)
  ctx.on('session/event', (session, event) => {
    const events = logs.get(session.id) ?? []
    events.push(event)
    logs.set(session.id, events)
  }, { global: true })
  ctx.on('session/flush', () => {}, { global: true })
  const disposePersistence = ctx.provide('sessionPersistence', {
    stat: vi.fn(async (id: SessionId) => sessions.get(id)),
    open: vi.fn(async (id: SessionId, access: string) => {
      if (access !== 'read') throw new Error('Recovery must not take Session ownership.')
      const snapshot = sessions.get(id)
      if (snapshot === undefined) throw new Error('Missing worker fixture.')
      return {
        header: snapshot.header, inheritedEventCount: 0,
        read: async () => ({ eventState: 'shared-frozen', events: logs.get(id) ?? [] }), close: async () => {},
      }
    }),
  } as never)
  ctx.provide('workspaceRegistry', {
    get: (id: string) => workspaces.get(id),
    list: () => [...workspaces.values()],
    archivedSessionIds: [],
  } as never)
  options.configure?.(ctx)
  await ctx.plugin(AssistantTaskService, options.config ?? {})
  return {
    ctx, service: ctx.assistantTasks, create, prompt, cancel, sessions, workspaces, disposePersistence, resolveAgent, followup, pool, logs,
  }
}
