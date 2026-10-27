/**
 * Transport selection and both providers: the Electron shell wins whenever
 * it owns the document, the browser API is the fallback, and each provider's
 * permission and click behaviour is what the announcement path relies on.
 */

import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  DesktopNotifier, WebNotifier, readDesktopGlobal, selectNotifier,
  type NotificationShowRequest,
} from '../src/client/notifier.ts'
import type { DesktopGlobal } from '../src/client/desktop-bridge.ts'

/** One stubbed browser notification instance. */
interface FakeInstance {
  readonly title: string
  readonly body: string
  onclick: (() => void) | undefined
  close(): void
}

afterEach(() => { vi.unstubAllGlobals() })

/** The prompt function of each stubbed Notification API, in stub order. */
const prompts: ReturnType<typeof vi.fn<() => Promise<string>>>[] = []

/** Stub the browser Notification API and record every instance it creates. */
function stubWeb(permission: 'granted' | 'denied' | 'default', promptOutcome: 'granted' | 'denied' | 'default' = permission): FakeInstance[] {
  const created: FakeInstance[] = []
  const requestPermission = vi.fn(async () => promptOutcome)
  class FakeNotification {
    static permission = permission
    static requestPermission = requestPermission
    readonly title: string
    readonly body: string
    onclick: (() => void) | undefined = undefined
    constructor(title: string, options?: { body?: string }) {
      this.title = title
      this.body = options?.body ?? ''
      created.push(this)
    }
    close(): void {}
  }
  vi.stubGlobal('Notification', FakeNotification)
  prompts.push(requestPermission)
  return created
}

/** Stub the Electron preload carrier, returning the recorded show calls. */
function stubDesktop(): { show: ReturnType<typeof vi.fn>; subscribe: ReturnType<typeof vi.fn>; permission: ReturnType<typeof vi.fn> } {
  const bridge = {
    show: vi.fn(async () => {}),
    subscribe: vi.fn(() => () => {}),
    permission: vi.fn(async () => 'granted' as const),
  }
  vi.stubGlobal('dshDesktop', { protocolVersion: 1, notifications: bridge } satisfies DesktopGlobal)
  return bridge
}

const request: NotificationShowRequest = { title: '会话已完成', body: '「demo」', sessionId: 's1' }

describe('selectNotifier', () => {
  it('returns undefined without either transport', () => {
    vi.stubGlobal('Notification', undefined)
    vi.stubGlobal('dshDesktop', undefined)
    expect(selectNotifier()).toBeUndefined()
  })

  it('prefers the Electron shell when it owns the document', () => {
    stubWeb('granted')
    stubDesktop()
    expect(selectNotifier()).toBeInstanceOf(DesktopNotifier)
  })

  it('falls back to the browser API when the shell carries no notification carrier', () => {
    stubWeb('granted')
    vi.stubGlobal('dshDesktop', { protocolVersion: 1 })
    expect(selectNotifier()).toBeInstanceOf(WebNotifier)
  })

  it('falls back to the browser API when the shell protocol is not this build', () => {
    stubWeb('granted')
    vi.stubGlobal('dshDesktop', { protocolVersion: 2, notifications: { show: vi.fn(), subscribe: vi.fn(), permission: vi.fn() } })
    expect(selectNotifier()).toBeInstanceOf(WebNotifier)
  })
})

describe('DesktopNotifier', () => {
  it('forwards show, permission, and the click subscription to the shell', async () => {
    const bridge = stubDesktop()
    const notifier = new DesktopNotifier(readDesktopGlobal()!.notifications!)
    await notifier.show(request)
    expect(bridge.show).toHaveBeenCalledWith(request)
    expect(await notifier.permission()).toBe('granted')
    const off = notifier.subscribe(vi.fn())
    expect(bridge.subscribe).toHaveBeenCalled()
    off()
  })
})

describe('WebNotifier', () => {
  it('presents with the session tag when permission is granted', async () => {
    const created = stubWeb('granted')
    await new WebNotifier().show(request)
    expect(created.map(instance => ({ title: instance.title, body: instance.body })))
      .toEqual([{ title: '会话已完成', body: '「demo」' }])
  })

  it('presents after the browser prompt grants permission', async () => {
    const created = stubWeb('default', 'granted')
    await new WebNotifier().show(request)
    expect(prompts.at(-1)).toHaveBeenCalled()
    expect(created).toHaveLength(1)
  })

  it('stays silent when the browser prompt leaves the permission undecided', async () => {
    const created = stubWeb('default', 'default')
    await new WebNotifier().show(request)
    expect(prompts.at(-1)).toHaveBeenCalled()
    expect(created).toHaveLength(0)
  })

  it('stays silent when the permission is denied', async () => {
    const created = stubWeb('denied')
    await new WebNotifier().show(request)
    expect(created).toHaveLength(0)
    expect(prompts.at(-1)).not.toHaveBeenCalled()
  })

  it('presents without a click target when the request carries no session', async () => {
    const created = stubWeb('granted')
    await new WebNotifier().show({ title: '会话已完成', body: '「demo」' })
    expect(created).toHaveLength(1)
  })

  it('stays silent when the browser API is absent', async () => {
    vi.stubGlobal('Notification', undefined)
    await expect(new WebNotifier().show(request)).resolves.toBeUndefined()
  })

  it('routes a click to the subscribers carrying that session', async () => {
    const created = stubWeb('granted')
    const notifier = new WebNotifier()
    const listener = vi.fn()
    notifier.subscribe(listener)
    await notifier.show(request)
    created[0]?.onclick?.()
    expect(listener).toHaveBeenCalledWith('s1')
  })

  it('drops a click subscription when it is released', async () => {
    const created = stubWeb('granted')
    const notifier = new WebNotifier()
    const listener = vi.fn()
    const off = notifier.subscribe(listener)
    off()
    await notifier.show(request)
    created[0]?.onclick?.()
    expect(listener).not.toHaveBeenCalled()
  })

  it('reports the browser permission state when the API is present', async () => {
    stubWeb('granted')
    expect(await new WebNotifier().permission()).toBe('granted')
    stubWeb('denied')
    expect(await new WebNotifier().permission()).toBe('denied')
  })

  it('reports unsupported for a permission value the union does not name', async () => {
    vi.stubGlobal('Notification', { permission: 'prompt' })
    expect(await new WebNotifier().permission()).toBe('unsupported')
  })

  it('reports unsupported and stays silent without the browser API', async () => {
    vi.stubGlobal('Notification', undefined)
    const notifier = new WebNotifier()
    expect(await notifier.permission()).toBe('unsupported')
    await expect(notifier.show(request)).resolves.toBeUndefined()
  })
})
