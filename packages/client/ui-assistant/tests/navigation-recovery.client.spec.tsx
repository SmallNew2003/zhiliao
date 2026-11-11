// @vitest-environment jsdom
import { act, fireEvent, screen } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotTestRuntime } from '@deepseek-ai/dsh-client-test-runtime'
import type { PropsRenderSlots } from '@deepseek-ai/dsh-client-ui-slots'
import { apply as applyWorkspace, inject as injectWorkspace } from '@deepseek-ai/dsh-client-ui-workspace/client'
import { apply, inject } from '../src/client/index.ts'

function Navigation({ renderSlot }: PropsRenderSlots<'sidebar.workspaces'>) {
  return <nav>{renderSlot('sidebar.workspaces', { wide: true, expandSidebar: () => {} })}</nav>
}

it('restores ordinary rows from the navigation retry and keeps a newly classified execution hidden', async () => {
  const runtime = await SlotTestRuntime.create()
  try {
    runtime.releaseWorkspaceSource()
    runtime.ctx.provide('contextMenus', { register: () => () => {}, active: createSnapshotStore(null) })
    runtime.slots.provideRoot({ props: { useContextMenu: () => ({ getTriggerProps: () => ({}) }) } })
    runtime.ctx.provide('shortcuts', { register: () => () => {}, catalog: createSnapshotStore([]) })
    runtime.ctx.provide('uiConversation', {})
    runtime.ctx.provide('resources', { register: () => () => {} })
    runtime.ctx.provide('layout', { selectPanel: vi.fn(), beginNavigation: () => new AbortController().signal })
    const locale = new LocaleRuntime(runtime.ctx)
    runtime.ctx.provide('locale', locale)
    runtime.slots.installLocale(locale)
    locale.setLocale('en')
    const visibility = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({
      ok: true, value: { sessionIds: ['assistant-chat', 'new-execution'], executions: [], conversations: [] },
    })
    const tasks = vi.fn(async () => ({ ok: true, value: [] }))
    runtime.remote.provideNamespaces({
      directoryPicker: {},
      assistantTasks: {
        visibility, tasks,
        ensureAssistant: async () => ({ ok: true, value: { id: 'assistant', sessionId: 'assistant-chat', retiredSessionIds: [] } }),
      },
    })
    for (const [id, title] of [['ordinary', 'Budget planning'], ['new-execution', 'Worker output']] as const) {
      await runtime.sessions.add({ id, summary: { title, displayTitle: title, blank: false } })
    }
    await runtime.root.declare({ 'sidebar.workspaces': { kind: 'single', scope: 'root' } } as never, Navigation as never)
    await runtime.mount({ inject: [...injectWorkspace], apply: applyWorkspace })
    const feature = await runtime.mount({ apply, inject })
    runtime.renderRoot()
    fireEvent.click(screen.getByRole('button', { name: 'View options' }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'In one list' }))
    expect(screen.queryByText('Budget planning')).toBeNull()
    expect(screen.queryByText('Worker output')).toBeNull()
    const retry = await screen.findByRole('button', { name: 'Retry' })
    expect(screen.getByRole('status').textContent).toContain('Could not load the full session list.')
    expect(visibility).toHaveBeenCalledTimes(1)
    fireEvent.click(retry)
    expect(await screen.findByText('Budget planning')).toBeTruthy()
    expect(screen.queryByText('Worker output')).toBeNull()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(visibility).toHaveBeenCalledTimes(2)
    expect(tasks).toHaveBeenCalledTimes(1)

    visibility.mockRejectedValueOnce(new Error('offline again'))
    await act(async () => { runtime.remote.emit('assistant/changed', []) })
    expect(await screen.findByRole('button', { name: 'Retry' })).toBeTruthy()
    await feature.dispose()
    expect(screen.queryByRole('button', { name: 'Retry' })).toBeNull()
    expect(await screen.findByText('Worker output')).toBeTruthy()
  } finally { await runtime.dispose() }
})
