/** Native OS notifications for the local Desktop renderer, with click routing back into the owned window. */

import { Notification, ipcMain, type BrowserWindow } from 'electron'
import { DESKTOP_IPC, assertDesktopSender, type DesktopNotificationRequest } from './ipc.ts'

/**
 * Narrow one IPC payload to a presentable request. The renderer is typed, but
 * IPC is a process boundary, so a payload the shell did not construct is
 * rejected rather than partially shown.
 * @param value - raw IPC argument.
 * @returns the validated request, or undefined when the payload is malformed.
 */
function parseRequest(value: unknown): DesktopNotificationRequest | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.title !== 'string' || typeof record.body !== 'string') return undefined
  if (record.sessionId !== undefined && typeof record.sessionId !== 'string') return undefined
  return {
    title: record.title,
    body: record.body,
    ...(record.sessionId !== undefined ? { sessionId: record.sessionId } : {}),
  }
}

/**
 * Install the application-lifetime notification IPC handlers. Every handler
 * accepts only the main window's top frame, and a click both focuses that
 * window and forwards the session id so the renderer can open the
 * conversation the announcement named.
 * @param getWindow - Current local application window; shell pages and subframes cannot notify.
 */
export function installDesktopNotifications(getWindow: () => BrowserWindow | undefined): void {
  ipcMain.handle(DESKTOP_IPC.notifyShow, (event, payload: unknown) => {
    const window = getWindow()
    if (window === undefined || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('dsh desktop: rejected notification from an unowned renderer')
    }
    assertDesktopSender(event, ['app'])
    const request = parseRequest(payload)
    if (request === undefined) throw new Error('dsh desktop: rejected malformed notification request')
    const notification = new Notification({ title: request.title, body: request.body })
    notification.on('click', () => {
      if (window.isDestroyed()) return
      if (window.isMinimized()) window.restore()
      window.show()
      window.focus()
      if (request.sessionId !== undefined) window.webContents.send(DESKTOP_IPC.notifyClicked, request.sessionId)
    })
    notification.show()
  })
  ipcMain.handle(DESKTOP_IPC.notifyPermission, (event) => {
    const window = getWindow()
    if (window === undefined || window.isDestroyed() || event.sender !== window.webContents
      || event.senderFrame !== window.webContents.mainFrame) {
      throw new Error('dsh desktop: rejected notification permission read from an unowned renderer')
    }
    assertDesktopSender(event, ['app'])
    // macOS asks on the first presentation and never exposes the answer
    // before then, so an unsupported build is the only state distinguishable
    // here; the renderer treats `default` as "not yet asked".
    return Notification.isSupported() ? 'default' : 'unsupported'
  })
}
