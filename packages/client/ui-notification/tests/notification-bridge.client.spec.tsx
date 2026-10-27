// @vitest-environment jsdom
/**
 * The announcement bridge's diff: the first observation is a baseline that
 * never announces, a real status transition pushes exactly one trigger, and
 * a preference change alone pushes nothing.
 */

import type { SessionStatus, SessionStatusSnapshot } from '@deepseek-ai/dsh-client-ui-session/client'
import type { WorkspaceSnapshot } from '@deepseek-ai/dsh-api-workspace-controller/client'
import type { GlobalStandardProps } from '@deepseek-ai/dsh-client-ui-slots'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render } from '@testing-library/react'
import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import { bindSnapshotSelector } from '@deepseek-ai/dsh-client-test-runtime'
import { NotificationBridge } from '../src/client/NotificationBridge.tsx'
import type { NotificationBridgeComponentProps } from '../src/client/NotificationBridge.tsx'
import { DEFAULT_SETTINGS, type NotificationSettings } from '../src/notification-settings.ts'

afterEach(cleanup)

const useResource = (() => ({ status: 'none' as const, value: undefined, failure: undefined, reload: () => {} })) as GlobalStandardProps['useResource']
const usePanelInfo: GlobalStandardProps['usePanelInfo'] = selector => selector({ activePanelId: null })

const sessionId = (value: string): SessionId => value as SessionId

const status = (overrides: Partial<SessionStatus> = {}): SessionStatus => ({
  running: undefined,
  pendingInteraction: undefined,
  completionUnread: false,
  lastAgentError: null,
  ...overrides,
})

/** Empty workspace catalog; the bridge never reads it. */
function emptyWorkspaces() {
  return bindSnapshotSelector(createSnapshotStore<WorkspaceSnapshot>({
    items: [], archivedSessionIds: [], state: 'idle', phase: 'ready', error: null,
  }))
}

/** Mounted bridge surfaces: the trigger sink plus the two sources the diff reads. */
interface BridgeHandles {
  readonly push: ReturnType<typeof vi.fn>
  readonly statuses: SnapshotStore<SessionStatusSnapshot>
  readonly settings: SnapshotStore<NotificationSettings>
}

function mountBridge(): BridgeHandles {
  const push = vi.fn()
  const statuses = createSnapshotStore<SessionStatusSnapshot>(new Map())
  const settings = createSnapshotStore<NotificationSettings>(DEFAULT_SETTINGS)
  const props: NotificationBridgeComponentProps = {
    useSessionStatus: bindSnapshotSelector(statuses),
    useSettings: bindSnapshotSelector(settings),
    useSessions: bindSnapshotSelector(createSnapshotStore({ ids: [], byId: {}, phase: 'ready', subagentsByParent: {}, jobsBySession: {} })),
    useWorkspaces: emptyWorkspaces(),
    useSessionRetainInfo: () => undefined,
    usePanelInfo,
    useResource,
    push,
  }
  render(<NotificationBridge {...props} />)
  return { push, statuses, settings }
}

describe('NotificationBridge', () => {
  it('renders nothing', () => {
    mountBridge()
    expect(document.body.textContent).toBe('')
  })

  it('treats the first observation as a baseline and pushes nothing', async () => {
    const { push, statuses } = mountBridge()
    await act(async () => {
      statuses.set(new Map([[sessionId('s1'), status({ running: false, completionUnread: true })]]))
    })
    expect(push).not.toHaveBeenCalled()
  })

  it('pushes one trigger when a session stops outside the main view', async () => {
    const { push, statuses } = mountBridge()
    const id = sessionId('s1')
    await act(async () => {
      statuses.set(new Map([[id, status({ running: true })]]))
    })
    await act(async () => {
      statuses.set(new Map([[id, status({ running: false, completionUnread: true })]]))
    })
    expect(push).toHaveBeenCalledTimes(1)
    expect(push).toHaveBeenCalledWith({ kind: 'turn-complete', sessionId: id })
  })

  it('pushes nothing when only the preferences change', async () => {
    const { push, statuses, settings } = mountBridge()
    const id = sessionId('s1')
    await act(async () => {
      statuses.set(new Map([[id, status({ running: false, completionUnread: true })]]))
    })
    await act(async () => {
      settings.set({ ...DEFAULT_SETTINGS, turnComplete: false })
    })
    expect(push).not.toHaveBeenCalled()
  })

  it('pushes a failure trigger when the agent-loop error arrives', async () => {
    const { push, statuses } = mountBridge()
    const id = sessionId('s1')
    await act(async () => {
      statuses.set(new Map([[id, status({ running: true })]]))
    })
    await act(async () => {
      statuses.set(new Map([[id, status({ running: false, lastAgentError: 'provider down' })]]))
    })
    expect(push).toHaveBeenCalledWith({ kind: 'error', sessionId: id })
  })
})
