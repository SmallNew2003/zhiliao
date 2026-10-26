/**
 * Native notification IPC: only the owned window's top frame may present,
 * a malformed payload is rejected whole, and a click focuses the window and
 * forwards the session id the announcement carried.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { BrowserWindow, IpcMainInvokeEvent } from 'electron'
import { DESKTOP_IPC } from '../src/ipc.ts'

/** One stubbed OS notification, with the click handler the shell registered. */
interface FakeInstance {
  readonly options: Record<string, unknown>
  readonly show: ReturnType<typeof vi.fn>
  clickNotification(): void
}

const electron = vi.hoisted(() => {
  const state = { supported: true }
  const created: FakeInstance[] = []
  class FakeNotification {
    readonly options: Record<string, unknown>
    readonly show = vi.fn()
    private click: (() => void) | undefined
    constructor(options: Record<string, unknown>) {
      this.options = options
      created.push(this)
    }
    on(event: string, handler: () => void): this {
      if (event === 'click') this.click = handler
      return this
    }
    clickNotification(): void { this.click?.() }
    static isSupported(): boolean { return state.supported }
  }
  return {
    state,
    created,
    Notification: FakeNotification,
    ipcMain: { handle: vi.fn<(channel: string, handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) => void>() },
  }
})
vi.mock('electron', () => ({ Notification: electron.Notification, ipcMain: electron.ipcMain }))

const { installDesktopNotifications } = await import('../src/notifications.ts')

beforeEach(() => {
  vi.resetAllMocks()
  electron.created.length = 0
  electron.state.supported = true
})

/** Mount the handlers over one owned window and expose its assertion handles. */
function fixture() {
  const mainFrame = { url: 'dsh-app://app/index.html' }
  const window = {
    webContents: { mainFrame, send: vi.fn() },
    isDestroyed: () => false,
    isMinimized: vi.fn(() => false),
    restore: vi.fn(),
    show: vi.fn(),
    focus: vi.fn(),
  }
  let current: BrowserWindow | undefined = window as unknown as BrowserWindow
  installDesktopNotifications(() => current)
  const showHandler = electron.ipcMain.handle.mock.calls.find(([channel]) => channel === DESKTOP_IPC.notifyShow)?.[1]
  const permissionHandler = electron.ipcMain.handle.mock.calls.find(([channel]) => channel === DESKTOP_IPC.notifyPermission)?.[1]
  if (showHandler === undefined || permissionHandler === undefined) throw new Error('notification handlers are not registered')
  const event = { sender: window.webContents, senderFrame: mainFrame } as unknown as IpcMainInvokeEvent
  const foreignEvent = { sender: window.webContents, senderFrame: { url: 'dsh-app://app/sub.html' } } as unknown as IpcMainInvokeEvent
  return { window, event, foreignEvent, showHandler, permissionHandler, detach: () => { current = undefined } }
}

describe('Desktop notifications', () => {
  it('presents a validated request', async () => {
    const f = fixture()
    await f.showHandler(f.event, { title: '会话已完成', body: '「demo」', sessionId: 's1' })
    expect(electron.created).toHaveLength(1)
    expect(electron.created[0]?.options).toEqual({ title: '会话已完成', body: '「demo」' })
    expect(electron.created[0]?.show).toHaveBeenCalledOnce()
  })

  it.each([
    ['a missing title', { body: '「demo」' }],
    ['a non-string body', { title: 't', body: 7 }],
    ['a non-string session id', { title: 't', body: 'b', sessionId: 7 }],
    ['a non-object payload', 'nope'],
  ])('rejects a malformed payload (%s)', (_label, payload) => {
    const f = fixture()
    expect(() => f.showHandler(f.event, payload)).toThrow('malformed notification request')
    expect(electron.created).toHaveLength(0)
  })

  it('rejects a presentation from a detached window', () => {
    const f = fixture()
    f.detach()
    expect(() => f.showHandler(f.event, { title: 't', body: 'b' })).toThrow('unowned renderer')
    expect(electron.created).toHaveLength(0)
  })

  it('rejects a presentation from a subframe', () => {
    const f = fixture()
    expect(() => f.showHandler(f.foreignEvent, { title: 't', body: 'b' })).toThrow('unowned renderer')
  })

  it('focuses the window and forwards the session id on click', async () => {
    const f = fixture()
    await f.showHandler(f.event, { title: 't', body: 'b', sessionId: 's1' })
    electron.created[0]?.clickNotification()
    expect(f.window.restore).not.toHaveBeenCalled()
    expect(f.window.show).toHaveBeenCalledOnce()
    expect(f.window.focus).toHaveBeenCalledOnce()
    expect(f.window.webContents.send).toHaveBeenCalledWith(DESKTOP_IPC.notifyClicked, 's1')
  })

  it('restores a minimized window before focusing it', async () => {
    const f = fixture()
    f.window.isMinimized.mockReturnValue(true)
    await f.showHandler(f.event, { title: 't', body: 'b', sessionId: 's1' })
    electron.created[0]?.clickNotification()
    expect(f.window.restore).toHaveBeenCalledOnce()
    expect(f.window.show).toHaveBeenCalledOnce()
    expect(f.window.focus).toHaveBeenCalledOnce()
  })

  it('focuses the window without forwarding when the request carries no session', async () => {
    const f = fixture()
    await f.showHandler(f.event, { title: 't', body: 'b' })
    electron.created[0]?.clickNotification()
    expect(f.window.focus).toHaveBeenCalledOnce()
    expect(f.window.webContents.send).not.toHaveBeenCalled()
  })

  it('reports the authorization state the OS exposes', async () => {
    const f = fixture()
    expect(await f.permissionHandler(f.event)).toBe('default')
    electron.state.supported = false
    expect(await f.permissionHandler(f.event)).toBe('unsupported')
  })

  it('rejects a permission read from a subframe', () => {
    const f = fixture()
    expect(() => f.permissionHandler(f.foreignEvent)).toThrow('unowned renderer')
  })
})
