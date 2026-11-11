/** Scoped reads, selection and cancellation for the Assistant workspace. */
import type { Context } from '@deepseek-ai/cordis'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type {
  AssistantConversationEntry, AssistantExecutionEntry, AssistantTaskId, AssistantTaskView, AssistantView,
} from '@deepseek-ai/dsh-assistant-task/client'
import { createSnapshotStore, type ObservableSnapshot, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { entityUnavailable, remoteRead } from './remote-read.ts'
import type { SessionId } from '@deepseek-ai/dsh-session/types'

/** Visible selection, task history and Session separation published to the client. */
export interface AssistantState {
  selected: AssistantView | null
  selectedWorkspace: WorkspaceId | null
  selectionFailed: boolean
  tasks: readonly AssistantTaskView[]
  phase: 'loading' | 'ready' | 'error'
  hasMore: boolean
  loadingMore: boolean
  cancel: Readonly<Record<string, 'pending' | 'error'>>
  conversations: readonly AssistantConversationEntry[]
  executions: readonly AssistantExecutionEntry[]
  hidden: readonly SessionId[]
  visibility: 'initial' | 'checking' | 'ready' | 'error'
}

/** Client state and operations owned by one Assistant access grant. */
interface AssistantWorkspace {
  readonly state: SnapshotStore<AssistantState>
  readonly hiddenSessions: ObservableSnapshot<readonly SessionId[]>
  readonly remember: (ids: readonly SessionId[]) => void
  readonly select: (workspaceId: WorkspaceId | null) => Promise<void>
  readonly refresh: () => void
  /** Extend the history by one Host page when more is true. */
  readonly refreshTasks: (more?: boolean) => Promise<void>
  readonly refreshVisibility: () => Promise<void>
  readonly cancelTask: (id: AssistantTaskId) => Promise<void>
  readonly dispose: () => void
}

/**
 * Own asynchronous state for one active Assistant access grant.
 * @param ctx - Client services providing authorized assistant reads.
 * @returns the observable state, operations and disposer that invalidates in-flight work.
 */
export function createAssistantWorkspace(ctx: Context): AssistantWorkspace {
  const api = ctx.remote.assistantTasks
  const catalogSource = ctx.sessions.list
  const state = createSnapshotStore<AssistantState>({
    selected: null, selectedWorkspace: null, selectionFailed: false,
    tasks: [], phase: 'loading', hasMore: false, loadingMore: false, cancel: {},
    conversations: [], executions: [], hidden: [], visibility: 'initial',
  })
  let selectionEpoch = 0
  let taskEpoch = 0
  let visibilityEpoch = 0
  let confirmedCatalog: ReadonlySet<SessionId> | undefined
  let requestedCatalog: ReadonlySet<SessionId> | undefined
  let duringVisibility: Set<SessionId> | undefined
  let loadedPages = 0
  let requestedPages = 1
  let disposed = false
  const staleTaskRead = (epoch: number): boolean => disposed || epoch !== taskEpoch

  function remember(ids: readonly SessionId[]): void {
    if (disposed || !ids.length) return
    for (const id of ids) duringVisibility?.add(id)
    const known = new Set(state.getSnapshot().hidden)
    const size = known.size
    for (const id of ids) known.add(id)
    if (known.size !== size) state.update((draft) => { draft.hidden = [...known] })
  }

  let hiddenCache: {
    catalog: readonly SessionId[]
    known: readonly SessionId[]
    confirmed: ReadonlySet<SessionId> | undefined
    value: readonly SessionId[]
  } | undefined
  const hiddenSessions = {
    getSnapshot(): readonly SessionId[] {
      const snapshot = state.getSnapshot()
      if (disposed) {
        hiddenCache = undefined
        return snapshot.hidden
      }
      const catalog = catalogSource.getSnapshot().ids
      if (hiddenCache?.catalog === catalog && hiddenCache.known === snapshot.hidden && hiddenCache.confirmed === confirmedCatalog) {
        return hiddenCache.value
      }
      const unclassified = catalog.filter(id => !confirmedCatalog?.has(id))
      const value = unclassified.length ? [...new Set([...snapshot.hidden, ...unclassified])] : snapshot.hidden
      hiddenCache = { catalog, known: snapshot.hidden, confirmed: confirmedCatalog, value }
      return value
    },
    subscribe(listener: () => void): () => void {
      let observed = catalogSource.getSnapshot().ids
      const stopCatalog = catalogSource.subscribe(() => {
        const ids = catalogSource.getSnapshot().ids
        if (ids === observed) return
        observed = ids
        listener()
        checkCatalogArrivals()
      })
      const stopState = state.subscribe(listener)
      return () => { stopState(); stopCatalog() }
    },
  }

  function checkCatalogArrivals(): void {
    if (disposed || duringVisibility !== undefined) return
    if (catalogSource.getSnapshot().ids.some(id => !requestedCatalog?.has(id))) void refreshVisibility()
  }

  async function refreshVisibility(): Promise<void> {
    const epoch = ++visibilityEpoch
    const catalog = new Set(catalogSource.getSnapshot().ids)
    requestedCatalog = catalog
    const concurrent = new Set<SessionId>()
    duringVisibility = concurrent
    state.update((draft) => { draft.visibility = confirmedCatalog === undefined ? 'initial' : 'checking' })
    const result = await remoteRead(() => api.visibility())
    if (disposed || epoch !== visibilityEpoch) return
    duringVisibility = undefined
    if (result.ok) confirmedCatalog = catalog
    state.update((draft) => {
      draft.visibility = result.ok ? 'ready' : 'error'
      if (!result.ok) return
      draft.conversations = result.value.conversations
      draft.executions = result.value.executions
      draft.hidden = [...new Set([...result.value.sessionIds, ...concurrent])]
    })
    checkCatalogArrivals()
  }

  async function refreshTasks(more = false): Promise<void> {
    const snapshot = state.getSnapshot()
    if (snapshot.selected === null || (more && (snapshot.loadingMore || !snapshot.hasMore))) return
    const epoch = ++taskEpoch
    const scope = snapshot.selectedWorkspace === null ? {} : { workspaceId: snapshot.selectedWorkspace }
    if (more) requestedPages = loadedPages + 1
    const pages = requestedPages
    state.update((draft) => { draft.loadingMore = more || draft.loadingMore })
    // Offsets follow the Host's configured page size. Re-read the loaded window
    // because a status change can move a task to the front of the list.
    const tasks = new Map<AssistantTaskId, AssistantTaskView>()
    let offset = 0
    let hasMore = false
    for (let page = 0; page < pages; page++) {
      const result = await remoteRead(() => api.tasks({ ...scope, offset }))
      if (staleTaskRead(epoch)) return
      if (!result.ok) {
        taskReadFailed(entityUnavailable(result.error))
        return
      }
      const rows = result.value
      remember(rows.map(row => row.sessionId))
      for (const row of rows) tasks.set(row.id, row)
      offset += rows.length
      if (rows.length === 0) break
      if (page + 1 === pages) {
        const next = await remoteRead(() => api.tasks({ ...scope, offset, limit: 1 }))
        if (staleTaskRead(epoch)) return
        if (!next.ok) {
          taskReadFailed(entityUnavailable(next.error))
          return
        }
        hasMore = next.value.length > 0
        remember(next.value.map(row => row.sessionId))
      }
    }
    loadedPages = pages
    state.update((draft) => {
      draft.tasks = [...tasks.values()]
      draft.phase = 'ready'
      draft.hasMore = hasMore
      draft.loadingMore = false
    })
  }

  function taskReadFailed(unavailable: boolean): void {
    state.update((draft) => {
      draft.phase = 'error'
      draft.loadingMore = false
      if (unavailable) { draft.tasks = []; draft.hasMore = false }
    })
  }

  async function select(workspaceId: WorkspaceId | null): Promise<void> {
    const previous = state.getSnapshot().selectedWorkspace
    const epoch = ++selectionEpoch
    taskEpoch++
    if (workspaceId !== previous) {
      loadedPages = 0
      requestedPages = 1
    }
    state.update((draft) => {
      draft.selectedWorkspace = workspaceId
      draft.selectionFailed = false
      if (workspaceId !== previous) {
        draft.selected = null
        draft.tasks = []
        draft.hasMore = false
      }
      if (draft.selected === null) draft.phase = 'loading'
      draft.loadingMore = false
    })
    const result = await remoteRead(() => api.ensureAssistant(workspaceId === null
      ? { kind: 'global' } : { kind: 'project', workspaceId }))
    if (disposed || epoch !== selectionEpoch) return
    if (!result.ok) {
      const unavailable = entityUnavailable(result.error)
      if (unavailable) taskEpoch++
      state.update((draft) => {
        draft.selectionFailed = true
        if (unavailable) {
          draft.selected = null
          draft.tasks = []
          draft.hasMore = false
        }
      })
      return
    }
    const assistant = result.value
    remember([assistant.sessionId, ...assistant.retiredSessionIds])
    state.update((draft) => { draft.selected = assistant })
    await refreshTasks()
  }

  function refresh(): void {
    void refreshVisibility()
    const snapshot = state.getSnapshot()
    if (snapshot.selected === null || snapshot.selectionFailed) void select(snapshot.selectedWorkspace)
    else void refreshTasks()
  }

  async function cancelTask(id: AssistantTaskId): Promise<void> {
    if (state.getSnapshot().cancel[id] === 'pending') return
    state.update((draft) => { draft.cancel = { ...draft.cancel, [id]: 'pending' } })
    const result = await remoteRead(() => api.cancelTask({ id }))
    if (disposed) return
    state.update((draft) => {
      const { [id]: _pending, ...remaining } = draft.cancel
      draft.cancel = !result.ok ? { ...remaining, [id]: 'error' } : remaining
    })
    if (result.ok) await refreshTasks()
  }

  return {
    state, hiddenSessions, remember, select, refresh, refreshTasks, refreshVisibility, cancelTask,
    dispose() { disposed = true },
  }
}
