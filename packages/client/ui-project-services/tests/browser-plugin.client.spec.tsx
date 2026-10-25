// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { TestRemote, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import type { ApiServiceFeedFrameView, ApiServiceInventoryView } from '@deepseek-ai/dsh-api-project-services-controller/types'
import { apply, inject, NS, PANEL_ID } from '../src/client/index.ts'
import { ProjectServicesPanel } from '../src/client/ProjectServicesPanel.tsx'
import { ProjectServicesPanelIcon } from '../src/client/ProjectServicesPanelIcon.tsx'
import type { ProjectServicesPanelInjected } from '../src/client/contract/slots.ts'
import { apply as hostApply } from '../src/index.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

function inventory(): ApiServiceInventoryView {
  return {
    project: { id: 'proj-1', path: '/repos/my-project' },
    checkouts: [{ id: 'main', path: '/repos/my-project', availability: 'present' }],
    items: [],
    groups: [],
    providers: [],
    revision: '1',
  }
}

function frame(): ApiServiceFeedFrameView {
  return { kind: 'baseline', snapshot: inventory() }
}

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  const follow = vi.fn((_request: unknown, signal?: AbortSignal) => ({
    [Symbol.asyncIterator]: async function* () {
      await new Promise<void>((resolve) => {
        signal?.addEventListener('abort', () => { resolve() }, { once: true })
      })
      yield frame()
    },
  }))
  const remote = new TestRemote(ctx, {
    projectServices: {
      follow,
      list: vi.fn(() => Promise.resolve({ ok: true as const, value: inventory() })),
      logs: vi.fn(() => Promise.resolve({ ok: true as const, value: { chunks: [], truncated: false, gap: false } })),
      control: vi.fn(() => Promise.resolve({ ok: true as const, value: undefined })),
    },
  })
  const slots = ctx.get('slots') as SlotRegistry
  slots.register({
    name: 'root',
    children: {
      'main': { kind: 'keyed', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  return { ctx, slots, locale, follow, remote }
}

describe('ui-project-services browser plugin', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares only the services the panel, its sidebar row, and the Remote reads use', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.projectServices'])
  })

  it('registers the panel page and the sidebar row that opens it', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    // The page occupies the layout's keyed `main` seat under its own panel id.
    const page = b.slots.entries('main')[0]!
    expect(page.component).toBe(ProjectServicesPanel)
    expect(page.options).toMatchObject({ key: PANEL_ID })
    expect(page.locale).toBe(NS)
    // The sidebar row addresses the page by the same id and speaks the dictionary.
    const row = b.slots.entries('sidebar.panellist')[0]!
    expect(row.component).toBe(ProjectServicesPanelIcon)
    expect(row.options).toMatchObject({ id: PANEL_ID, order: 30 })
    expect(row.locale).toBe(NS)
    expect(resolveSlotLabel(row.options.label)).toBe('项目服务')

    const face = (page.inject as unknown as () => ProjectServicesPanelInjected)()
    expect(face.hooks.panel.getSnapshot()).toMatchObject({ inventory: undefined, selectedCheckoutId: undefined })

    await fiber.dispose()
    expect(b.slots.entries('main')).toHaveLength(0)
    expect(b.slots.entries('sidebar.panellist')).toHaveLength(0)
  })

  it('streams the inventory only while a hook observes the panel, and stops with the plugin', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const page = b.slots.entries('main')[0]!
    const face = (page.inject as unknown as () => ProjectServicesPanelInjected)()
    expect(b.follow).not.toHaveBeenCalled()

    const unsubscribe = face.hooks.panel.subscribe(() => {})
    await Promise.resolve()
    expect(b.follow).toHaveBeenCalledTimes(1)

    // A connection reset reopens the stream while the panel is still mounted.
    b.ctx.emit('connection/reset')
    await Promise.resolve()
    expect(b.follow).toHaveBeenCalledTimes(2)

    unsubscribe()
    await Promise.resolve()
    expect(b.follow.mock.calls[1]?.[1]?.aborted).toBe(true)

    // The plugin's own teardown releases the source even with a live observer.
    const second = face.hooks.panel.subscribe(() => {})
    await Promise.resolve()
    await fiber.dispose()
    await Promise.resolve()
    expect(b.follow.mock.calls[2]?.[1]?.aborted).toBe(true)
    second()
  })

  it('renders the sidebar row icon at the requested size without reading application state', async () => {
    const b = await bench()
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const row = b.slots.entries('sidebar.panellist')[0]!

    const unread = (): never => { throw new Error('The sidebar icon must not read application state') }
    const glyph = render(<ProjectServicesPanelIcon size={18} active={false}
      usePanelInfo={unread} useSessions={unread} useSessionStatus={unread} useSessionRetainInfo={unread}
      useWorkspaces={unread} useResource={unread} />)
    expect(glyph.container.querySelector('svg')?.getAttribute('width')).toBe('18')
    expect(row.component).toBe(ProjectServicesPanelIcon)
    await fiber.dispose()
  })
})
