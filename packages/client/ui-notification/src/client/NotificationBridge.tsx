/**
 * Global notification bridge: the seat that turns Session status transitions
 * into announcement triggers. It renders nothing — it is the only place the
 * Session status snapshot reaches the announcement decision, mounted once in
 * the shell overlay so it survives every conversation switch.
 *
 * @module @deepseek-ai/dsh-client-ui-notification/client/NotificationBridge
 */

import { useEffect, useRef, type ReactNode } from 'react'
import type { SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { HostObservable, InjectFace, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import { detectTriggers } from '../planner.ts'
import type { NotificationTrigger } from '../planner.ts'
import type { NotificationSettings } from '../notification-settings.ts'

/** Baseline snapshot: no session has any status yet, so the first read never announces. */
const EMPTY_STATUS: SessionStatusSnapshot = new Map<SessionId, never>()

/** Injected business face: the mirrored preferences and the trigger sink. */
export interface NotificationBridgeInjected {
  readonly hooks: { readonly settings: HostObservable<NotificationSettings> }
  /** Hand one earned trigger to the merge window. */
  readonly push: (trigger: NotificationTrigger) => void
}

/** Full component props: the shell overlay runtime seat plus the injected face. */
export type NotificationBridgeComponentProps =
  PropsRuntime<'shell.overlay'> & InjectFace<NotificationBridgeInjected>

/**
 * Diff each Session status snapshot against the previous one and hand every
 * earned trigger to the merge window. The reference comparison is sound
 * because the source republishes only on a real change.
 * @param props - root overlay hooks and the trigger sink.
 * @returns nothing; this seat exists for its effect only.
 */
export function NotificationBridge({ useSessionStatus, useSettings, push }: NotificationBridgeComponentProps): ReactNode {
  const statuses = useSessionStatus(value => value)
  const settings = useSettings(value => value)
  const previous = useRef<SessionStatusSnapshot>(EMPTY_STATUS)
  useEffect(() => {
    const triggers = detectTriggers(previous.current, statuses, settings)
    previous.current = statuses
    for (const trigger of triggers) push(trigger)
  }, [statuses, settings, push])
  return null
}
