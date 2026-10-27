/**
 * Optional Electron preload declarations consumed by the notification bridge.
 * The Web build never sees this object; the shell exposes it only to documents
 * it owns, exactly as it does for the update carrier.
 *
 * @module @deepseek-ai/dsh-client-ui-notification/client/desktop-bridge
 */

/** OS notification authorization state as the shell reports it. */
export type DesktopNotificationPermission = 'granted' | 'denied' | 'default' | 'unsupported'

/** One native notification the shell is asked to present. */
export interface DesktopNotificationRequest {
  /** Short headline the OS shows in the notification centre. */
  readonly title: string
  /** Detail line the OS shows under the headline. */
  readonly body: string
  /** Session the notification opens when clicked; absent opens no conversation. */
  readonly sessionId?: string
}

/** Optional carrier API exposed by the Electron preload script. */
export interface DesktopNotificationBridge {
  /**
   * Present one native notification.
   * @param request - headline, detail, and the session to open on click.
   * @returns after the shell accepted the request.
   */
  show(request: DesktopNotificationRequest): Promise<void>
  /**
   * Subscribe to notification clicks.
   * @param listener - receives the clicked notification's session id, when it carried one.
   * @returns unsubscribe.
   */
  subscribe(listener: (sessionId: string) => void): () => void
  /** @returns the current OS authorization state. */
  permission(): Promise<DesktopNotificationPermission>
}

/** Shape of the `dshDesktop` global this package reads. */
export interface DesktopGlobal {
  readonly protocolVersion: number
  readonly notifications?: DesktopNotificationBridge
}
