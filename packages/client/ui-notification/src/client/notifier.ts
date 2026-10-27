/**
 * Notification transport seam: one interface, two providers. The Desktop
 * provider delegates to the Electron shell, which owns the OS notification
 * API and the window focus; the Web provider speaks the browser Notification
 * API directly. Selection happens once per page, so a build never wires a
 * provider it cannot use.
 *
 * @module @deepseek-ai/dsh-client-ui-notification/client/notifier
 */

import type { DesktopGlobal, DesktopNotificationBridge, DesktopNotificationPermission } from './desktop-bridge.ts'

/** OS notification authorization state. */
export type NotificationPermission = DesktopNotificationPermission

/** One notification a provider presents. */
export interface NotificationShowRequest {
  /** Short headline the OS shows. */
  readonly title: string
  /** Detail line the OS shows under the headline. */
  readonly body: string
  /** Session the notification opens when clicked; absent opens no conversation. */
  readonly sessionId?: string
}

/** Transport every provider implements. */
export interface Notifier {
  /** @returns the current OS authorization state. */
  permission(): Promise<NotificationPermission>
  /**
   * @param request - headline, detail, and the session to open on click.
   * @returns after the provider accepted the request; never throws for a denied permission.
   */
  show(request: NotificationShowRequest): Promise<void>
  /**
   * @param listener - receives the clicked notification's session id, when it carried one.
   * @returns unsubscribe.
   */
  subscribe(listener: (sessionId: string) => void): () => void
}

/**
 * Read the Electron preload carrier.
 * @returns the carrier the shell exposed, or undefined outside the Desktop shell.
 */
export function readDesktopGlobal(): DesktopGlobal | undefined {
  return (globalThis as typeof globalThis & { dshDesktop?: DesktopGlobal }).dshDesktop
}

/** Provider that delegates to the Electron shell. */
export class DesktopNotifier implements Notifier {
  constructor(private readonly bridge: DesktopNotificationBridge) {}

  /** @returns the shell-reported authorization state. */
  permission(): Promise<NotificationPermission> {
    return this.bridge.permission()
  }

  /**
   * @param request - headline, detail, and the session to open on click.
   * @returns after the shell accepted the request.
   */
  show(request: NotificationShowRequest): Promise<void> {
    return this.bridge.show(request)
  }

  /**
   * @param listener - receives the clicked notification's session id.
   * @returns unsubscribe.
   */
  subscribe(listener: (sessionId: string) => void): () => void {
    return this.bridge.subscribe(listener)
  }
}

/** Narrow one browser value to a permission state this package understands. */
function toPermission(value: unknown): NotificationPermission {
  return value === 'granted' || value === 'denied' || value === 'default' ? value : 'unsupported'
}

/** Provider that speaks the browser Notification API. */
export class WebNotifier implements Notifier {
  private readonly clicks = new Set<(sessionId: string) => void>()

  /** @returns the browser-reported authorization state, or `unsupported` without the API. */
  permission(): Promise<NotificationPermission> {
    if (typeof Notification === 'undefined') return Promise.resolve('unsupported')
    return Promise.resolve(toPermission(Notification.permission))
  }

  /**
   * Present one notification, asking the browser for authorization first when
   * it has not decided yet. Chrome admits the prompt once the page has been
   * interacted with, so the first announcement is also the moment the user is
   * asked.
   * @param request - headline, detail, and the session to open on click.
   * @returns after the browser accepted the request; a denied permission stays silent.
   */
  async show(request: NotificationShowRequest): Promise<void> {
    if (typeof Notification === 'undefined') return
    let state = toPermission(Notification.permission)
    if (state === 'default' && typeof Notification.requestPermission === 'function') {
      state = toPermission(await Notification.requestPermission())
    }
    if (state !== 'granted') return
    const notification = new Notification(request.title, {
      body: request.body,
      ...(request.sessionId !== undefined ? { tag: request.sessionId } : {}),
    })
    if (request.sessionId === undefined) return
    const sessionId = request.sessionId
    notification.onclick = (): void => {
      for (const listener of [...this.clicks]) listener(sessionId)
      notification.close()
    }
  }

  /**
   * @param listener - receives the clicked notification's session id.
   * @returns unsubscribe.
   */
  subscribe(listener: (sessionId: string) => void): () => void {
    this.clicks.add(listener)
    return () => { this.clicks.delete(listener) }
  }
}

/**
 * Select the transport for this page. The Electron shell wins whenever it
 * owns the document, because only it can focus the application window on a
 * click; the browser API is the fallback for the plain Web build.
 * @returns the provider, or undefined when neither transport exists.
 */
export function selectNotifier(): Notifier | undefined {
  const desktop = readDesktopGlobal()
  const bridge = desktop?.notifications
  if (desktop !== undefined && bridge !== undefined && desktop.protocolVersion === 1) return new DesktopNotifier(bridge)
  if (typeof Notification !== 'undefined') return new WebNotifier()
  return undefined
}
