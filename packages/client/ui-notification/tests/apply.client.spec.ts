/**
 * Browser-half wiring over the real SlotRegistry: dictionary registration,
 * the settings row and the global announcement bridge, the mirrored
 * preferences reaching the row, and fiber teardown removing both entries.
 */

import { Context } from '@deepseek-ai/cordis'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { SlotRegistry } from '@deepseek-ai/dsh-client-ui-renderer/client'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { TestRemote } from '@deepseek-ai/dsh-client-test-runtime'
import { apply as settingsApply, inject as settingsInject } from '@deepseek-ai/dsh-client-ui-settings/client'
import { apply, inject } from '../src/client/index.ts'
import { SETTINGS_NS } from '../src/client/runtime.ts'
import { NotificationRow } from '../src/client/NotificationRow.tsx'
import { NotificationBridge } from '../src/client/NotificationBridge.tsx'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { NOTIFICATION_SETTINGS_NAMESPACE, NotificationSettingsSchema } from '../src/notification-settings.ts'
import { createNotificationRowStore } from '../src/client/settings-store.ts'

const ITEM_SLOT = 'settings.general.item'
const OVERLAY_SLOT = 'shell.overlay'

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers() })

const sessionId = (value: string): SessionId => value as SessionId

/** Optional collaborator shape the runtime calls on a notification click. */
interface WorkspaceStub {
  openSession(sessionId: SessionId): void
}

async function bench(options: { revision?: number | undefined; workspace?: WorkspaceStub } = {}) {
  const ctx = new Context()
  await ctx.plugin(SlotRegistry).await()
  const locale = new LocaleRuntime(ctx)
  locale.setLocale('zh')
  ctx.provide('locale', locale)
  const section: Record<string, unknown> = { enabled: true, turnComplete: true, awaitingInput: false, error: true }
  const namespace = () => ({
    ns: NOTIFICATION_SETTINGS_NAMESPACE,
    schema: NotificationSettingsSchema.toJSON(),
    value: { ...section },
    applies: 'live' as const,
    secrets: [],
    // Only an explicit `revision: undefined` models a wire that supplied none.
    revision: ('revision' in options ? options.revision : 0) as number,
  })
  const describeSettings = vi.fn(() => Promise.resolve({
    ok: true as const,
    value: { writable: true, hasDocument: true, namespaces: [namespace()] },
  }))
  const mutate = vi.fn((_ns: string, ops: { path: string[]; value: unknown }[]) => {
    const op = ops[0]!
    section[op.path[0]!] = op.value
    return Promise.resolve({ ok: true as const, value: namespace() })
  })
  const events = new TestRemote(ctx, { settings: { describe: describeSettings, mutate } })
  events.$host = { home: undefined, isLoopback: true }
  await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
  ctx.provide('sessions', { list: { getSnapshot: () => ({ byId: {} }) } })
  if (options.workspace !== undefined) ctx.provide('uiWorkspace', options.workspace)
  ;(ctx.get('slots') as SlotRegistry).register({
    name: 'root',
    children: {
      [ITEM_SLOT]: { kind: 'list', scope: 'root' },
      [OVERLAY_SLOT]: { kind: 'list', scope: 'root' },
    },
  } as never, () => null)
  return { ctx, slots: ctx.get('slots') as SlotRegistry, locale, section, mutate }
}

/** Mirror the framework's inject choreography for the settings row. */
function rowFaceOf(slots: SlotRegistry) {
  const entry = slots.entries(ITEM_SLOT).find(e => e.component === NotificationRow)!
  const handle = entry.store as ReturnType<typeof createNotificationRowStore>
  const instance = handle.create()
  const face = entry.inject as unknown as (actions: typeof instance.actions) => Record<string, unknown>
  return { entry, instance, face: face(instance.actions) }
}

describe('ui-notification browser half', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['slots', 'locale', 'sessions', 'settingsScope'])
  })

  it('registers the preference row and the global announcement bridge', async () => {
    const { ctx } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    const row = ctx.slots.entries(ITEM_SLOT).find(e => e.component === NotificationRow)
    expect(row?.options).toMatchObject({ id: 'notification', order: 12 })
    const bridge = ctx.slots.entries(OVERLAY_SLOT).find(e => e.component === NotificationBridge)
    expect(bridge?.options).toMatchObject({ id: 'notification' })
    expect(bridge?.locale).toBe(SETTINGS_NS)
  })

  it('registers the dictionaries under its own namespace', async () => {
    const { ctx, locale } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    expect(locale.bind(SETTINGS_NS)('row.title')).toBe('系统通知')
    locale.setLocale('en')
    expect(locale.bind(SETTINGS_NS)('row.title')).toBe('System notifications')
  })

  it('mirrors the durable preferences into the row store and writes through the scope', async () => {
    const { ctx, slots, mutate } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    const { instance, face } = rowFaceOf(slots)
    expect(instance.getSnapshot().settings).toMatchObject({ enabled: true, awaitingInput: false })
    ;(face.setField as (field: string, value: boolean) => void)('awaitingInput', true)
    // The wire carries the revision the write was issued at, so a stale editor is refused.
    await vi.waitFor(() => {
      expect(mutate).toHaveBeenCalledWith(
        NOTIFICATION_SETTINGS_NAMESPACE,
        [{ op: 'set', path: ['awaitingInput'], value: true }],
        expect.any(Number),
      )
    })
  })

  it('hands the bridge a preferences source and a trigger sink', async () => {
    const { ctx, slots } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    const entry = slots.entries(OVERLAY_SLOT).find(e => e.component === NotificationBridge)!
    const injected = entry.inject as unknown as () => { hooks: { settings: { getSnapshot(): unknown } }; push: unknown }
    const face = injected()
    expect(face.hooks.settings.getSnapshot()).toMatchObject({ enabled: true, awaitingInput: false })
    expect(typeof face.push).toBe('function')
  })

  it('removes both entries when the fiber unloads (HMR safety)', async () => {
    const { ctx } = await bench()
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    expect(ctx.slots.entries(ITEM_SLOT)).toHaveLength(1)
    expect(ctx.slots.entries(OVERLAY_SLOT)).toHaveLength(1)
    await fiber.dispose()
    expect(ctx.slots.entries(ITEM_SLOT)).toHaveLength(0)
    expect(ctx.slots.entries(OVERLAY_SLOT)).toHaveLength(0)
  })
})

/** Stub the Electron preload carrier, capturing the click listener it registers. */
function stubDesktopShell(): { shown: { title: string; body: string; sessionId?: string }[]; click: (id: string) => void } {
  const shown: { title: string; body: string; sessionId?: string }[] = []
  let listener: ((id: string) => void) | undefined
  vi.stubGlobal('dshDesktop', {
    protocolVersion: 1,
    notifications: {
      show: vi.fn(async (request: { title: string; body: string; sessionId?: string }) => { shown.push(request) }),
      subscribe: vi.fn((registered: (id: string) => void) => { listener = registered; return () => {} }),
      permission: vi.fn(async () => 'granted' as const),
    },
  })
  return { shown, click: (id) => { listener?.(id) } }
}

describe('ui-notification announcements', () => {
  it('presents a merged completion after the coalescing window', async () => {
    vi.useFakeTimers()
    try {
      const shell = stubDesktopShell()
      const { ctx, slots } = await bench()
      await ctx.plugin({ inject: [...inject], apply }).await()
      const entry = slots.entries(OVERLAY_SLOT).find(e => e.component === NotificationBridge)!
      const injected = entry.inject as unknown as () => { push: (trigger: unknown) => void }
      injected().push({ kind: 'turn-complete', sessionId: sessionId('s1') })
      injected().push({ kind: 'turn-complete', sessionId: sessionId('s2') })
      await vi.advanceTimersByTimeAsync(800)
      expect(shell.shown).toEqual([{ title: '2 个会话已完成', body: '点击查看', sessionId: 's1' }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('presents one session with its display title when the list knows it', async () => {
    vi.useFakeTimers()
    try {
      const shell = stubDesktopShell()
      const ctx = new Context()
      await ctx.plugin(SlotRegistry).await()
      const locale = new LocaleRuntime(ctx)
      locale.setLocale('zh')
      ctx.provide('locale', locale)
      const events = new TestRemote(ctx, { settings: { describe: vi.fn(), mutate: vi.fn() } })
      events.$host = { home: undefined, isLoopback: true }
      await ctx.plugin({ inject: [...settingsInject], apply: settingsApply }).await()
      ctx.provide('sessions', { list: { getSnapshot: () => ({ byId: { s1: { displayTitle: '重构登录' } } }) } })
      ;(ctx.get('slots') as SlotRegistry).register({
        name: 'root', children: { [OVERLAY_SLOT]: { kind: 'list', scope: 'root' } },
      } as never, () => null)
      await ctx.plugin({ inject: [...inject], apply }).await()
      const entry = ctx.slots.entries(OVERLAY_SLOT).find(e => e.component === NotificationBridge)!
      const injected = entry.inject as unknown as () => { push: (trigger: unknown) => void }
      injected().push({ kind: 'turn-complete', sessionId: sessionId('s1') })
      await vi.advanceTimersByTimeAsync(800)
      expect(shell.shown).toEqual([{ title: '会话已完成', body: '「重构登录」', sessionId: 's1' }])
    } finally {
      vi.useRealTimers()
    }
  })

  it('opens the session a click names through the workspace collaborator', async () => {
    const shell = stubDesktopShell()
    const openSession = vi.fn()
    const { ctx } = await bench({ workspace: { openSession } })
    await ctx.plugin({ inject: [...inject], apply }).await()
    shell.click('s1')
    expect(openSession).toHaveBeenCalledWith('s1')
  })

  it('ignores a click when no workspace collaborator is composed', async () => {
    const shell = stubDesktopShell()
    const { ctx } = await bench()
    await ctx.plugin({ inject: [...inject], apply }).await()
    expect(() => { shell.click('s1') }).not.toThrow()
  })

  it('records a trigger without a transport and presents nothing', async () => {
    vi.useFakeTimers()
    try {
      const { ctx, slots } = await bench()
      await ctx.plugin({ inject: [...inject], apply }).await()
      const entry = slots.entries(OVERLAY_SLOT).find(e => e.component === NotificationBridge)!
      const injected = entry.inject as unknown as () => { push: (trigger: unknown) => void }
      expect(() => {
        injected().push({ kind: 'turn-complete', sessionId: sessionId('s1') })
        vi.advanceTimersByTime(800)
      }).not.toThrow()
    } finally {
      vi.useRealTimers()
    }
  })

  it('logs a refused presentation and keeps the merge window usable', async () => {
    vi.useFakeTimers()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      vi.stubGlobal('dshDesktop', {
        protocolVersion: 1,
        notifications: {
          show: vi.fn(async () => { throw new Error('refused') }),
          subscribe: vi.fn(() => () => {}),
          permission: vi.fn(async () => 'granted' as const),
        },
      })
      const { ctx, slots } = await bench()
      await ctx.plugin({ inject: [...inject], apply }).await()
      const entry = slots.entries(OVERLAY_SLOT).find(e => e.component === NotificationBridge)!
      const injected = entry.inject as unknown as () => { push: (trigger: unknown) => void }
      injected().push({ kind: 'turn-complete', sessionId: sessionId('s1') })
      await vi.advanceTimersByTimeAsync(800)
      expect(warn).toHaveBeenCalled()
    } finally {
      warn.mockRestore()
      vi.useRealTimers()
    }
  })

  it('carries a missing revision as 0, which the row store guard then holds', async () => {
    const { ctx, slots, mutate } = await bench({ revision: undefined })
    await ctx.plugin({ inject: [...inject], apply }).await()
    const { instance, face } = rowFaceOf(slots)
    ;(face.setField as (field: string, value: boolean) => void)('awaitingInput', true)
    await vi.waitFor(() => { expect(mutate).toHaveBeenCalled() })
    // Revision 0 is not ahead of the revision 0 the row already synced at, so
    // the guard holds and the mirror keeps its value.
    expect(instance.getSnapshot().revision).toBe(0)
    expect(instance.getSnapshot().settings.awaitingInput).toBe(false)
  })

  it('syncs the row with revision 0 when the wire supplied none', async () => {
    const { ctx, slots } = await bench({ revision: undefined })
    await ctx.plugin({ inject: [...inject], apply }).await()
    const { instance } = rowFaceOf(slots)
    expect(instance.getSnapshot().revision).toBe(0)
  })
})
