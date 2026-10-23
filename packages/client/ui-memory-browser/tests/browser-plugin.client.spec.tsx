// @vitest-environment jsdom
import { Context, Service } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render } from '@testing-library/react'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { resolveSlotLabel } from '@deepseek-ai/dsh-client-ui-slots'
import { TestRemote, usePinnedBrowserLanguages } from '@deepseek-ai/dsh-client-test-runtime'
import { apply, inject, NS, PANEL_ID } from '../src/client/index.ts'
import { MemoryBrowserPage } from '../src/client/MemoryBrowserPage.tsx'
import { MemoryPanelIcon } from '../src/client/MemoryPanelIcon.tsx'
import { apply as hostApply } from '../src/index.ts'

usePinnedBrowserLanguages('zh-CN')
afterEach(cleanup)

async function bench() {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  ctx.provide('locale', locale)
  class LocaleHolder extends Service {
    constructor(serviceCtx: Context) {
      super(serviceCtx, 'localeHolder')
    }
  }
  new LocaleHolder(ctx)
  const list = vi.fn(() => Promise.resolve({ ok: true as const, value: { available: true, banks: [] } }))
  const remote = new TestRemote(ctx, {
    memoryController: {
      list,
      stats: vi.fn(() => Promise.resolve({ ok: true as const, value: { available: true, stats: null } })),
      pages: vi.fn(() => Promise.resolve({ ok: true as const, value: { available: true, pages: [] } })),
      search: vi.fn(() => Promise.resolve({ ok: true as const, value: { available: true, hits: [], total: 0 } })),
      page: vi.fn(() => Promise.resolve({ ok: true as const, value: { available: true } })),
    },
  })
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, list, remote }
}

function declare(slots: SlotRegistry): () => void {
  return slots.register({
    name: 'root',
    children: {
      'main': { kind: 'keyed', scope: 'root' },
      'sidebar.panellist': { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
}

describe('ui-memory-browser browser plugin', () => {
  it('keeps the host Loader entry inert', () => {
    expect(hostApply).not.toThrow()
  })

  it('declares only the services the panel and its Remote methods use', () => {
    expect(inject).toEqual(['slots', 'locale', 'remote', 'remote.memoryController'])
  })

  it('registers the sidebar entry and its panel, reading the Host only once rendered', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()

    const entry = b.slots.entries('main')[0]!
    expect(entry.component).toBe(MemoryBrowserPage)
    expect(entry.options).toMatchObject({ key: PANEL_ID })
    expect(entry.locale).toBe(NS)
    // The sidebar entry addresses the panel by the same id and speaks the dictionary.
    const icon = b.slots.entries('sidebar.panellist')[0]!
    expect(icon.component).toBe(MemoryPanelIcon)
    const unread = () => { throw new Error('The sidebar icon must not read application state') }
    const glyph = render(<MemoryPanelIcon size={18} active={false}
      usePanelInfo={unread} useSessions={unread} useSessionStatus={unread} useSessionRetainInfo={unread}
      useWorkspaces={unread} useResource={unread} />)
    expect(glyph.container.querySelector('svg')?.getAttribute('width')).toBe('18')
    expect(icon.options).toMatchObject({ id: PANEL_ID, order: 0 })
    expect(icon.locale).toBe(NS)
    expect(resolveSlotLabel(icon.options.label)).toBe('记忆')

    // A page never rendered holds no snapshot to refresh.
    b.ctx.emit('connection/reset')
    await Promise.resolve()
    expect(b.list).not.toHaveBeenCalled()
    const face = (entry.inject as unknown as () => { ensure: () => void })()
    face.ensure()
    await vi.waitFor(() => { expect(b.list).toHaveBeenCalledTimes(1) })
    // A reconnect re-reads, because the daemon may have restarted under this browser.
    b.ctx.emit('connection/reset')
    await vi.waitFor(() => { expect(b.list).toHaveBeenCalledTimes(2) })

    await fiber.dispose()
    expect(b.slots.entries('main')).toHaveLength(0)
    expect(b.slots.entries('sidebar.panellist')).toHaveLength(0)
    b.ctx.emit('connection/reset')
    await Promise.resolve()
    expect(b.list).toHaveBeenCalledTimes(2)
  })

  it('does not read before the panel first renders, even across a reconnect', async () => {
    const b = await bench()
    declare(b.slots)
    const fiber = b.ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    b.ctx.emit('connection/reset')
    await Promise.resolve()
    expect(b.list).not.toHaveBeenCalled()
    await fiber.dispose()
  })
})
