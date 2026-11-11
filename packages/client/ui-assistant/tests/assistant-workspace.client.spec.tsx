// @vitest-environment jsdom
import { act, fireEvent, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { apply as applyResources, inject as injectResources } from '@deepseek-ai/dsh-client-resources/client'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import { RemoteError, SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { PartialArguments } from '@deepseek-ai/dsh-util-values'
import type { AssistantId, AssistantTaskId, AssistantTaskView, AssistantView } from '@deepseek-ai/dsh-assistant-task/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { WorkspaceId } from '@deepseek-ai/dsh-api-workspace-controller/client'
import { apply, inject } from '../src/client/index.ts'

const date = '2026-11-11T12:00:00Z'
const assistant = (id: string, project = false): AssistantView => ({
  id: id as AssistantId, kind: project ? 'project' : 'global',
  ...(project ? { workspaceId: id as WorkspaceId } : {}),
  sessionId: (id + '-chat') as SessionId, retiredSessionIds: [], createdAt: date, updatedAt: date,
})
const global = assistant('global')
const task = (id: number): AssistantTaskView => ({
  id: String(id) as AssistantTaskId, assistantId: global.id, title: 'Review ' + String(id),
  status: 'running', sessionAvailable: true, sessionId: ('run-' + String(id)) as SessionId,
  createdAt: date, updatedAt: date,
})
const ok = <T,>(value: T) => ({ ok: true as const, value })
let runtime: SlotTestRuntime
afterEach(async () => { await runtime.dispose() })

async function bench(rows = [task(1)], options: {
  catalog?: string[]
  visibilityOffline?: boolean
  observeHidden?: (ids: readonly SessionId[]) => void
} = {}) {
  runtime = await SlotTestRuntime.create()
  const locale = new LocaleRuntime(runtime.ctx)
  runtime.ctx.provide('locale', locale)
  runtime.slots.installLocale(locale)
  locale.setLocale('en')
  const openSession = vi.fn()
  const releaseHidden = vi.fn()
  const registerHiddenSessionSource = vi.fn((source: {
    getSnapshot(): readonly SessionId[]
    subscribe(listener: () => void): () => void
  }) => {
    const stop = source.subscribe(() => { options.observeHidden?.(source.getSnapshot()) })
    return () => { stop(); releaseHidden() }
  })
  runtime.ctx.provide('uiWorkspace', { openSession, registerHiddenSessionSource } as never)
  runtime.ctx.provide('layout', { selectPanel: vi.fn() } as never)
  const api = {
    assistants: vi.fn(async () => ok([global])),
    ensureAssistant: vi.fn(async ({ workspaceId }: { workspaceId?: string }): Promise<RemoteResult<AssistantView>> =>
      ok(workspaceId ? assistant(workspaceId, true) : global)),
    tasks: vi.fn(async ({ offset = 0, limit = 50 }: { offset?: number; limit?: number }) => ok(rows.slice(offset, offset + limit))),
    visibility: vi.fn(async () => ok({ sessionIds: [global.sessionId], executions: [], conversations: [] })),
    task: vi.fn(async (): Promise<RemoteResult<AssistantTaskView>> => ok(rows[0]!)),
    cancelTask: vi.fn(async () => ok(rows[0]!)),
  }
  runtime.remote.provideNamespaces({ assistantTasks: api })
  if (options.visibilityOffline) api.visibility.mockRejectedValueOnce(new Error('offline'))
  await runtime.mount({ apply: applyResources, inject: injectResources })
  for (const id of options.catalog ?? [global.sessionId, 'A-chat', 'B-chat']) await runtime.sessions.add({ id })
  await runtime.workspaces.update((draft) => {
    draft.items = ['A', 'B'].map(id => ({ workspaceId: id as WorkspaceId, title: id, path: '/' + id, sessionIds: [], createdAt: date, updatedAt: date }))
  })
  await runtime.declare({ main: { kind: 'keyed', scope: 'root' }, 'tool.call.toolview': { kind: 'keyed', scope: 'session' } })
  runtime.slots.registerFactory({ name: 'conversation.embedded', scope: 'session' },
    ({ sessionId, workspaceMode }) => <textarea aria-label={sessionId} readOnly={workspaceMode !== 'optional'} />)
  const feature = await runtime.mount({ apply, inject })
  runtime.renderSlot('main', {}, { entryKey: 'assistant' })
  return { api, feature, openSession, releaseHidden, hidden: registerHiddenSessionSource.mock.calls[0]![0] }
}

describe('Assistant workspace', () => {
  it('keeps the editable scoped chat beside tasks and releases it when a new project is selected', async () => {
    const { api, openSession } = await bench()
    expect((await screen.findByRole<HTMLTextAreaElement>('textbox', { name: global.sessionId })).readOnly).toBe(false)
    const slow = Promise.withResolvers<ReturnType<typeof ok<AssistantView>>>()
    api.ensureAssistant.mockImplementationOnce(() => slow.promise)
    const choose = (id: string) => {
      fireEvent.click(screen.getByRole('button', { name: /Choose an assistant/ }))
      fireEvent.click(screen.getByRole('menuitem', { name: id }))
    }
    choose('A')
    expect(screen.queryByRole('textbox')).toBeNull()
    choose('B')
    expect(await screen.findByRole('textbox', { name: 'B-chat' })).toBeTruthy()
    await act(async () => { slow.resolve(ok(assistant('A', true))) })
    expect(screen.getByRole('textbox', { name: 'B-chat' })).toBeTruthy()
    expect(openSession).not.toHaveBeenCalled()
  })

  it('retains task rows and separated Sessions on read failures and distinguishes a failed cancel', async () => {
    const { api, hidden } = await bench()
    expect(await screen.findByText('Review 1')).toBeTruthy()
    api.cancelTask.mockRejectedValueOnce(new Error('disconnected'))
    fireEvent.click(screen.getByRole('button', { name: 'Cancel task' }))
    expect(await screen.findByText('The task could not be cancelled')).toBeTruthy()
    expect(screen.queryByText('Assistant tasks could not be loaded')).toBeNull()
    api.tasks.mockRejectedValueOnce(new Error('disconnected'))
    api.visibility.mockRejectedValueOnce(new Error('disconnected'))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByText('Assistant tasks could not be loaded')).toBeTruthy()
    expect(screen.getByText('Review 1')).toBeTruthy()
    expect(hidden.getSnapshot()).toContain(global.sessionId)
  })

  it('loads earlier pages and keeps those results after a change', async () => {
    const rows = Array.from({ length: 51 }, (_, i) => ({ ...task(i), status: 'done' as const, resultSummary: 'Result ' + String(i) }))
    await bench(rows)
    fireEvent.click(await screen.findByRole('button', { name: 'Load earlier tasks' }))
    expect(await screen.findByText('Result 50')).toBeTruthy()
    await act(async () => { runtime.remote.emit('assistant-task/changed', [rows[0]!.id]) })
    expect(screen.getByText('Result 50')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Load earlier tasks' })).toBeNull()
  })

  it('keeps newer results when a previous list read settles late, including after disposal', async () => {
    const { api, hidden, feature } = await bench()
    expect(await screen.findByText('Review 1')).toBeTruthy()
    const staleRows = Promise.withResolvers<ReturnType<typeof ok<AssistantTaskView[]>>>()
    api.tasks.mockImplementationOnce(() => staleRows.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    api.tasks.mockResolvedValueOnce(ok([task(2)]))
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    expect(await screen.findByText('Review 2')).toBeTruthy()
    await act(async () => { staleRows.resolve(ok([task(3)])) })
    expect(screen.queryByText('Review 3')).toBeNull()
    const visibility = Promise.withResolvers<Awaited<ReturnType<typeof api.visibility>>>()
    api.visibility.mockImplementationOnce(() => visibility.promise)
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
    await feature.dispose()
    await act(async () => { visibility.resolve(ok({ sessionIds: [], conversations: [], executions: [] })) })
    expect(hidden.getSnapshot()).toContain(global.sessionId)
  })

  it('keeps cancellation pending until the Host settles and offers retry after a failed stop', async () => {
    const row: AssistantTaskView = { ...task(9), status: 'cancelling' }
    const rows = [row]
    const { api } = await bench(rows)
    expect(await screen.findByText('Cancelling')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Cancel task' })).toBeNull()
    rows[0] = { ...row, failure: { code: 'cancel_failed', message: 'drain failed' } }
    await act(async () => { runtime.remote.emit('assistant-task/changed', [row.id]) })
    expect(screen.getByText('Could not confirm that execution stopped')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Retry cancellation' }))
    expect(api.cancelTask).toHaveBeenCalledWith({ id: row.id })
  })

  it('waits for the selected catalog entry, releases the exact reference and ignores late entries', async () => {
    const { feature } = await bench([], { catalog: [] })
    expect(screen.queryByRole('textbox')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: /Choose an assistant/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'B' }))
    await runtime.sessions.add({ id: global.sessionId })
    expect(runtime.sessions.retainInfo(global.sessionId).getSnapshot().referenceCount).toBe(0)
    const id = assistant('B', true).sessionId
    await runtime.sessions.add({ id })
    expect(await screen.findByRole('textbox', { name: id })).toBeTruthy()
    expect(runtime.sessions.retainInfo(id).getSnapshot().referenceCount).toBe(1)
    await feature.dispose()
    expect(runtime.sessions.retainInfo(id).getSnapshot().referenceCount).toBe(0)
  })

  it('allows retry after the Session directory arrives but the first opening fails', async () => {
    const { feature } = await bench([], { catalog: [] })
    const open = vi.fn().mockRejectedValueOnce(new Error('initial opening failed')).mockResolvedValueOnce(undefined)
    await runtime.sessions.add({ id: global.sessionId, initialOpen: open })
    const chat = screen.getByRole('region', { name: 'Assistant conversation' })
    fireEvent.click(await within(chat).findByRole('button', { name: 'Retry' }))
    expect(await within(chat).findByRole('textbox', { name: global.sessionId })).toBeTruthy()
    expect(open).toHaveBeenCalledTimes(2)
    await feature.dispose()
    expect(runtime.sessions.retainInfo(global.sessionId).getSnapshot().referenceCount).toBe(0)
  })

  it('preserves the open project composer and its draft on temporary revalidation failure and retracts on denial', async () => {
    const { api } = await bench()
    fireEvent.click(screen.getByRole('button', { name: /Choose an assistant/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'B' }))
    const input = await screen.findByRole<HTMLTextAreaElement>('textbox', { name: 'B-chat' })
    input.focus()
    fireEvent.change(input, { target: { value: 'unfinished draft' } })
    api.ensureAssistant.mockRejectedValueOnce(new Error('offline'))
    await act(async () => { runtime.remote.emit('assistant/changed', []) })
    expect(document.activeElement).toBe(input)
    expect(input.value).toBe('unfinished draft')
    const chat = screen.getByRole('region', { name: 'Assistant conversation' })
    fireEvent.click(within(chat).getByRole('button', { name: 'Retry' }))
    await runtime.flush()
    expect(within(chat).getByRole('textbox')).toBe(input)
    const denial = Promise.withResolvers<RemoteResult<AssistantView>>()
    api.ensureAssistant.mockImplementationOnce(() => denial.promise)
    await act(async () => { runtime.remote.emit('assistant/changed', []) })
    const pendingTasks = Promise.withResolvers<ReturnType<typeof ok<AssistantTaskView[]>>>()
    api.tasks.mockImplementationOnce(() => pendingTasks.promise)
    await act(async () => { runtime.remote.emit('assistant-task/changed', [task(1).id]) })
    await act(async () => {
      denial.resolve({ ok: false, error: new RemoteError('remote-access/denied', 'denied', {
        action: 'assistantTasks/ensureAssistant', reason: 'no-allow',
      }) })
    })
    expect(screen.queryByRole('textbox')).toBeNull()
    await act(async () => { pendingTasks.resolve(ok([task(1)])) })
    expect(screen.queryByText('Review 1')).toBeNull()
  })

  it('loads the complete reordered history when extending the window during a refresh', async () => {
    const rows = Array.from({ length: 51 }, (_, i) => task(i))
    const { api } = await bench(rows)
    rows.unshift(rows.pop()!)
    const slow = Promise.withResolvers<ReturnType<typeof ok<AssistantTaskView[]>>>()
    api.tasks.mockImplementationOnce(() => slow.promise)
    await act(async () => { runtime.remote.emit('assistant-task/changed', [rows[0]!.id]) })
    fireEvent.click(screen.getByRole('button', { name: 'Load earlier tasks' }))
    await act(async () => { slow.resolve(ok(rows.slice(0, 50))) })
    expect(await screen.findByText('Review 50')).toBeTruthy()
    expect(screen.getAllByRole('article')).toHaveLength(51)
    expect(screen.queryByRole('button', { name: 'Load earlier tasks' })).toBeNull()
  })

  it('isolates unclassified catalog arrivals and known executions through visibility outages', async () => {
    const rows = [task(1)]
    const { api, feature, hidden, releaseHidden } = await bench(rows, { catalog: [global.sessionId, 'ordinary'], visibilityOffline: true })
    expect(hidden.getSnapshot()).toEqual(expect.arrayContaining([global.sessionId, 'ordinary', 'run-1']))
    expect(hidden.getSnapshot()).toBe(hidden.getSnapshot())
    expect(screen.getByRole('button', { name: 'Retry' })).toBeTruthy()
    api.visibility.mockRejectedValueOnce(new Error('still offline'))
    await runtime.sessions.add({ id: 'late-ordinary' })
    expect(hidden.getSnapshot()).toContain('late-ordinary')
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await runtime.flush()
    expect(hidden.getSnapshot()).not.toContain('ordinary')
    expect(hidden.getSnapshot()).not.toContain('late-ordinary')
    api.visibility.mockRejectedValueOnce(new Error('offline again'))
    rows.unshift(task(2))
    await act(async () => { runtime.remote.emit('assistant-task/changed', [rows[0]!.id]) })
    api.visibility.mockRejectedValueOnce(new Error('still offline'))
    await runtime.sessions.add({ id: 'unknown' })
    expect(hidden.getSnapshot()).toEqual(expect.arrayContaining(['run-1', 'run-2', 'unknown']))
    expect(hidden.getSnapshot()).not.toContain('ordinary')
    await feature.dispose()
    expect(releaseHidden).toHaveBeenCalledTimes(1)
  })

  it('classifies arrivals after a ready catalog and coalesces arrivals during the read before releasing ordinary Sessions', async () => {
    const observeHidden = vi.fn<(ids: readonly SessionId[]) => void>()
    const { api, hidden, feature } = await bench([], { catalog: [global.sessionId, 'ordinary'], observeHidden })
    expect(hidden.getSnapshot()).not.toContain('ordinary')
    const baselineReads = api.visibility.mock.calls.length
    type Visibility = Awaited<ReturnType<typeof api.visibility>>
    const first = Promise.withResolvers<Visibility>()
    const follow = Promise.withResolvers<Visibility>()
    api.visibility.mockImplementationOnce(() => first.promise).mockImplementationOnce(() => follow.promise)
    await runtime.sessions.add({ id: 'new-execution' })
    expect(hidden.getSnapshot()).toContain('new-execution')
    expect(api.visibility).toHaveBeenCalledTimes(baselineReads + 1)
    await runtime.sessions.add({ id: 'during-ordinary' })
    await runtime.sessions.add({ id: 'during-execution' })
    expect(api.visibility).toHaveBeenCalledTimes(baselineReads + 1)
    expect(hidden.getSnapshot()).toEqual(expect.arrayContaining(['new-execution', 'during-ordinary', 'during-execution']))
    expect(hidden.getSnapshot()).not.toContain('ordinary')
    const classified = (ids: string[]): Visibility => ok({ sessionIds: ids as SessionId[], executions: [], conversations: [] })
    observeHidden.mockClear()
    await act(async () => { first.resolve(classified([global.sessionId, 'new-execution'])) })
    expect(observeHidden).toHaveBeenCalled()
    for (const [published] of observeHidden.mock.calls) {
      expect(published).toEqual(expect.arrayContaining(['during-ordinary', 'during-execution']))
      expect(published).not.toContain('ordinary')
    }
    expect(api.visibility).toHaveBeenCalledTimes(baselineReads + 2)
    expect(hidden.getSnapshot()).toEqual(expect.arrayContaining(['new-execution', 'during-ordinary', 'during-execution']))
    expect(hidden.getSnapshot()).not.toContain('ordinary')
    await act(async () => { follow.resolve(classified([global.sessionId, 'new-execution', 'during-execution'])) })
    expect(hidden.getSnapshot()).not.toContain('during-ordinary')
    expect(hidden.getSnapshot()).toEqual(expect.arrayContaining(['new-execution', 'during-execution']))
    await runtime.sessions.updateSummary(global.sessionId, { title: 'renamed' })
    await act(async () => {
      const catalog = runtime.sessions.list.getSnapshot()
      runtime.sessions.list.set({ ...catalog, ids: [...catalog.ids].reverse() })
    })
    expect(api.visibility).toHaveBeenCalledTimes(baselineReads + 2)
    await feature.dispose()
    await runtime.sessions.add({ id: 'after-disposal' })
    expect(api.visibility).toHaveBeenCalledTimes(baselineReads + 2)
  })

  it('resolves a historical creation card outside the list and updates it on its task event', async () => {
    const { api, openSession } = await bench([])
    api.task.mockResolvedValue(ok(task(77)))
    const reference = runtime.sessions.retain(global.sessionId, { source: 'mainView' })
    try {
      runtime.renderSlot('tool.call.toolview', {
        phase: 'result', toolName: 'create_task', callId: 'call', useDisclosure: vi.fn(), openFile: vi.fn(), loadImage: vi.fn(),
        block: { kind: 'tool-result', seq: 2, time: 0, callTime: 0, callId: 'call', name: 'create_task', args: PartialArguments.EMPTY,
          call: null, isError: false, subCalls: [], content: [{ type: 'text', text: JSON.stringify({ taskId: '77', sessionId: 'run-77' }) }] },
      }, { entryKey: 'create_task', session: reference })
      expect(await screen.findByText('Running')).toBeTruthy()
      api.task.mockResolvedValue(ok({ ...task(77), status: 'done', resultSummary: 'Ready for release' } satisfies AssistantTaskView))
      await act(async () => { runtime.remote.emit('assistant-task/changed', ['77']) })
      const summary = await screen.findByText('Ready for release')
      const card = summary.closest('article')!
      expect(within(card).getByText('Done')).toBeTruthy()
      fireEvent.click(within(card).getByRole('button', { name: 'Open task' }))
      expect(openSession).toHaveBeenCalledWith('run-77')
      api.task.mockRejectedValueOnce(new Error('offline'))
      await act(async () => { runtime.remote.emit('assistant-task/changed', ['77']) })
      expect(screen.getByText('Ready for release')).toBeTruthy()
      const retry = screen.getByRole('button', { name: 'Retry' })
      fireEvent.click(retry)
      await runtime.flush()
      expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
      for (const error of [
        new RemoteError('remote-access/denied', 'denied', { action: 'assistantTasks/task', reason: 'no-allow' }),
        new RemoteError('assistant/task-error', 'missing', { code: 'task_not_found' }),
      ] as const) {
        api.task.mockResolvedValueOnce({ ok: false, error })
        await act(async () => { runtime.remote.emit('assistant-task/changed', ['77']) })
        expect(screen.queryByText('Ready for release')).toBeNull()
        expect(screen.queryByRole('button', { name: 'Open task' })).toBeNull()
        await act(async () => { runtime.remote.emit('assistant-task/changed', ['77']) })
        expect(screen.getByText('Ready for release')).toBeTruthy()
      }
    } finally { await runtime.dispose(); reference.release() }
  })
})
