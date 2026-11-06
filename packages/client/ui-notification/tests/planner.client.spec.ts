/**
 * Announcement decision coverage: which Session status transitions earn a
 * trigger, which are deliberately silent, and how the per-kind switches gate
 * each path. The planner is pure, so every case is a snapshot pair.
 */

import type { SessionStatus, SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { describe, expect, it } from 'vitest'
import { detectTriggers } from '../src/planner.ts'
import { DEFAULT_SETTINGS, NOTIFICATION_KINDS, isKindEnabled, type NotificationSettings } from '../src/notification-settings.ts'

const sessionId = (value: string): SessionId => value as SessionId

const interaction = (id: SessionId): SessionStatus['pendingInteraction'] =>
  ({ key: `key-${String(id)}`, kind: 'approval', sessionId: id }) as SessionStatus['pendingInteraction']

const status = (overrides: Partial<SessionStatus> = {}): SessionStatus => ({
  running: undefined,
  pendingInteraction: undefined,
  completionUnread: false,
  lastAgentError: null,
  ...overrides,
})

const snapshot = (...entries: readonly SessionStatus[]): SessionStatusSnapshot =>
  new Map(entries.map((value, index) => [sessionId(`s${String(index)}`), value]))

const withSettings = (overrides: Partial<NotificationSettings> = {}): NotificationSettings =>
  ({ ...DEFAULT_SETTINGS, ...overrides })

describe('detectTriggers', () => {
  it('announces a session that stopped outside the main view', () => {
    const previous = snapshot(status({ running: true }))
    const next = snapshot(status({ running: false, completionUnread: true }))
    expect(detectTriggers(previous, next, withSettings())).toEqual([{ kind: 'turn-complete', sessionId: sessionId('s0') }])
  })

  it('stays silent for a stop the user is already looking at', () => {
    const previous = snapshot(status({ running: true }))
    const next = snapshot(status({ running: false, completionUnread: false }))
    expect(detectTriggers(previous, next, withSettings())).toEqual([])
  })

  it('stays silent on the first observation, which has no previous state', () => {
    const next = snapshot(status({ running: false, completionUnread: true }))
    expect(detectTriggers(new Map(), next, withSettings())).toEqual([])
  })

  it('stays silent while the session keeps running', () => {
    const previous = snapshot(status({ running: true }))
    const next = snapshot(status({ running: true, completionUnread: false }))
    expect(detectTriggers(previous, next, withSettings())).toEqual([])
  })

  it('announces a failure instead of a completion, so one stop raises one trigger', () => {
    const previous = snapshot(status({ running: true }))
    const next = snapshot(status({ running: false, completionUnread: true, lastAgentError: 'provider down' }))
    expect(detectTriggers(previous, next, withSettings())).toEqual([{ kind: 'error', sessionId: sessionId('s0') }])
  })

  it('announces each new failure message, including a second distinct one', () => {
    const first = snapshot(status({ running: false, lastAgentError: 'provider down' }))
    const second = snapshot(status({ running: false, lastAgentError: 'timeout' }))
    expect(detectTriggers(first, second, withSettings())).toEqual([{ kind: 'error', sessionId: sessionId('s0') }])
  })

  it('stays silent when the failure message is unchanged', () => {
    const previous = snapshot(status({ running: false, lastAgentError: 'provider down' }))
    const next = snapshot(status({ running: false, lastAgentError: 'provider down' }))
    expect(detectTriggers(previous, next, withSettings())).toEqual([])
  })

  it('announces the arrival of a pending interaction', () => {
    const id = sessionId('s0')
    const previous = snapshot(status({ running: true }))
    const next = snapshot(status({ running: true, pendingInteraction: interaction(id) }))
    expect(detectTriggers(previous, next, withSettings())).toEqual([{ kind: 'awaiting-input', sessionId: id }])
  })

  it('stays silent when a pending interaction is replaced, not newly arrived', () => {
    const id = sessionId('s0')
    const previous = snapshot(status({ running: true, pendingInteraction: { key: 'a', kind: 'approval', sessionId: id } as never }))
    const next = snapshot(status({ running: true, pendingInteraction: interaction(id) }))
    expect(detectTriggers(previous, next, withSettings())).toEqual([])
  })

  it('stays silent once a pending interaction is answered', () => {
    const id = sessionId('s0')
    const previous = snapshot(status({ running: true, pendingInteraction: interaction(id) }))
    const next = snapshot(status({ running: true }))
    expect(detectTriggers(previous, next, withSettings())).toEqual([])
  })

  it('returns nothing while the master switch is off', () => {
    const previous = snapshot(status({ running: true }))
    const next = snapshot(status({ running: false, completionUnread: true, lastAgentError: 'boom' }))
    expect(detectTriggers(previous, next, withSettings({ enabled: false }))).toEqual([])
  })

  it('honours each per-kind switch independently', () => {
    const previous = snapshot(status({ running: true }))
    const next = snapshot(status({ running: false, completionUnread: true }))
    expect(detectTriggers(previous, next, withSettings({ turnComplete: false }))).toEqual([])

    const failed = snapshot(status({ running: false, lastAgentError: 'boom' }))
    const clean = snapshot(status({ running: false }))
    expect(detectTriggers(failed, clean, withSettings({ error: false }))).toEqual([])
  })

  it('announces several sessions at once, ordered by id for a stable merge', () => {
    const previous = snapshot(status({ running: true }), status({ running: true }))
    const next = snapshot(status({ running: false, completionUnread: true }), status({ running: false, completionUnread: true }))
    expect(detectTriggers(previous, next, withSettings())).toEqual([
      { kind: 'turn-complete', sessionId: sessionId('s0') },
      { kind: 'turn-complete', sessionId: sessionId('s1') },
    ])
  })

  it('orders triggers by session id even when the snapshot lists them in reverse', () => {
    const first = sessionId('s2')
    const second = sessionId('s0')
    const previous = new Map<SessionId, SessionStatus>([[first, status({ running: true })], [second, status({ running: true })]])
    const next = new Map<SessionId, SessionStatus>([
      [first, status({ running: false, completionUnread: true })],
      [second, status({ running: false, completionUnread: true })],
    ])
    expect(detectTriggers(previous, next, withSettings()).map(trigger => trigger.sessionId)).toEqual([second, first])
  })

  it('ignores a session that left the snapshot', () => {
    const id = sessionId('gone')
    const previous = snapshot(status({ running: true }))
    const next = new Map<SessionId, SessionStatus>()
    expect(detectTriggers(previous, next, withSettings())).toEqual([])
    expect(previous.get(id)).toBeUndefined()
  })
})

describe('isKindEnabled', () => {
  it('answers false for every kind while the master switch is off', () => {
    for (const kind of NOTIFICATION_KINDS) {
      expect(isKindEnabled(withSettings({ enabled: false }), kind)).toBe(false)
    }
  })

  it('answers the per-kind switch while the master switch is on', () => {
    expect(isKindEnabled(withSettings(), 'turn-complete')).toBe(true)
    expect(isKindEnabled(withSettings({ turnComplete: false }), 'turn-complete')).toBe(false)
    expect(isKindEnabled(withSettings({ awaitingInput: false }), 'awaiting-input')).toBe(false)
    expect(isKindEnabled(withSettings({ error: false }), 'error')).toBe(false)
  })
})
