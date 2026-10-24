/**
 * Registrant-private live source for the project services panel: the
 * `projectServices` Remote reads, the follow stream that keeps the inventory
 * current, and the view state the panel's verbs move.
 *
 * `apply` creates one source per registration lifetime, so its snapshot
 * survives the panel's remounts. The follow stream and every in-flight read
 * live only while a framework hook observes the source: the first observer
 * opens the stream, the last one aborts it, and a connection-generation reset
 * reopens it. Every verb resolves to a plain `Promise<void>` and never rejects
 * — a Host failure becomes the snapshot's `error`, which the panel renders.
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote Context merge through the Client assembly boundary,
// and re-exports the Remote result vocabulary the source publishes.
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type { HostObservable } from '@deepseek-ai/dsh-client-ui-slots'
import type { ApiServiceInventoryView } from '@deepseek-ai/dsh-api-project-services-controller/types'
import type {
  ProjectServicesControlAction,
  ProjectServicesPanelInjected,
  ProjectServicesPanelSnapshot,
  ProjectServicesStopTarget,
} from './contract/slots.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Retained log tail the panel asks for; the truncation label states this same bound. */
const LOG_TAIL_BYTES = 16 * 1024

/** Snapshot before the Host answers: no inventory, no selection, nothing in flight. */
const INITIAL_SNAPSHOT: ProjectServicesPanelSnapshot = {
  inventory: undefined,
  selectedCheckoutId: undefined,
  logsTargetId: undefined,
  logs: undefined,
  isLoadingLogs: false,
  pendingActions: {},
  error: undefined,
}

/** Live inputs the source needs from its `apply` closure. */
export interface ProjectServicesPanelSourceDeps {
  /** Generated `projectServices` Remote namespace, reached as `ctx.remote.projectServices`. */
  readonly remote: ClientContext['remote']['projectServices']
  /** Subscribe to a connection-generation reset; the source reopens its follow stream. */
  readonly subscribeReset: (listener: () => void) => () => void
}

/** One activation: the span in which at least one framework hook observes the source. */
interface Activation {
  /** Signal aborted when the last observer leaves; every in-flight read carries it. */
  readonly signal: AbortSignal
  /** Stop the follow stream and the reset listener. */
  dispose(): void
}

/** The panel's live source: one observable snapshot plus the verbs that move it. */
export interface ProjectServicesPanelSource {
  /** Snapshot source the registration hands the component through the inject face. */
  readonly panel: HostObservable<ProjectServicesPanelSnapshot>
  /** Build the inject face the registration hands the component. */
  inject(): ProjectServicesPanelInjected
  /** Stop the follow stream and drop every live listener. */
  dispose(): void
}

/** What a thrown failure said, for the banner text. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** What a rejected Remote call said, with its code so the operator can trace it. */
function failureText(failure: RemoteFailure): string {
  return `${failure.message} (${failure.code})`
}

/**
 * Create the panel's live source.
 * @param deps - the Remote namespace and the connection-reset subscription.
 * @returns the observable snapshot source, the inject-face builder, and the disposer.
 */
export function createProjectServicesPanelSource(
  deps: ProjectServicesPanelSourceDeps,
): ProjectServicesPanelSource {
  const store = createSnapshotStore<ProjectServicesPanelSnapshot>(INITIAL_SNAPSHOT)
  let activation: Activation | undefined
  let observers = 0
  /** Supersedes a superseded read: only the newest epoch may publish. */
  let readEpoch = 0
  let logEpoch = 0
  let controlEpoch = 0

  /** Replace the snapshot, keeping the store's identity so selectors stay stable. */
  const patch = (next: Partial<ProjectServicesPanelSnapshot>): void => {
    store.set({ ...store.getSnapshot(), ...next })
  }

  /** Take an inventory, keeping the operator's checkout unless it left the project. */
  const applyInventory = (inventory: ApiServiceInventoryView): void => {
    const selected = store.getSnapshot().selectedCheckoutId
    const next = selected !== undefined && inventory.checkouts.some(checkout => checkout.id === selected)
      ? selected
      : inventory.checkouts[0]?.id
    patch({ inventory, selectedCheckoutId: next })
  }

  const reportFailure = (message: string): void => { patch({ error: message }) }

  /** Release the in-flight markers of the named targets. */
  const settlePending = (targetIds: readonly string[]): void => {
    const settled = new Set(targetIds)
    const pending: Record<string, ProjectServicesControlAction> = {}
    for (const [targetId, action] of Object.entries(store.getSnapshot().pendingActions)) {
      if (!settled.has(targetId)) pending[targetId] = action
    }
    patch({ pendingActions: pending })
  }

  const refresh = (): void => {
    const epoch = ++readEpoch
    void deps.remote.list({}, activation?.signal)
      .then((result) => {
        if (epoch !== readEpoch) return
        if (!result.ok) { reportFailure(failureText(result.error)); return }
        applyInventory(result.value)
      })
      .catch((error: unknown) => {
        if (epoch !== readEpoch) return
        reportFailure(messageOf(error))
      })
  }

  const readLogs = async (targetId: string, epoch: number): Promise<void> => {
    try {
      const result = await deps.remote.logs({ targetId, maxBytes: LOG_TAIL_BYTES }, activation?.signal)
      if (epoch !== logEpoch) return
      if (!result.ok) { patch({ isLoadingLogs: false, error: failureText(result.error) }); return }
      patch({ isLoadingLogs: false, logs: result.value })
    } catch (error) {
      if (epoch !== logEpoch) return
      patch({ isLoadingLogs: false, error: messageOf(error) })
    }
  }

  const control = async (
    action: ProjectServicesControlAction,
    targetId: string,
    expectedRevision: string,
  ): Promise<void> => {
    const epoch = ++controlEpoch
    patch({ pendingActions: { ...store.getSnapshot().pendingActions, [targetId]: action } })
    try {
      const result = await deps.remote.control({ action, targetId, expectedRevision }, activation?.signal)
      if (epoch !== controlEpoch) return
      if (!result.ok) reportFailure(failureText(result.error))
    } catch (error) {
      if (epoch !== controlEpoch) return
      reportFailure(messageOf(error))
    } finally {
      // The marker belongs to this call: the verb is no longer in flight for
      // the target, whether or not a newer verb has since superseded its result.
      settlePending([targetId])
    }
  }

  const stopGroup = async (members: readonly ProjectServicesStopTarget[]): Promise<void> => {
    const epoch = ++controlEpoch
    const targetIds = members.map(member => member.targetId)
    const pending = { ...store.getSnapshot().pendingActions }
    for (const member of members) pending[member.targetId] = 'stop'
    patch({ pendingActions: pending })
    try {
      for (const member of members) {
        const result = await deps.remote.control(
          { action: 'stop', targetId: member.targetId, expectedRevision: member.expectedRevision },
          activation?.signal,
        )
        if (epoch !== controlEpoch) return
        if (!result.ok) { reportFailure(failureText(result.error)); return }
      }
    } catch (error) {
      if (epoch !== controlEpoch) return
      reportFailure(messageOf(error))
    } finally {
      // Every member this call marked is no longer in flight for it.
      settlePending(targetIds)
    }
  }

  const selectCheckout = (checkoutId: string): void => {
    if (store.getSnapshot().selectedCheckoutId === checkoutId) return
    // An open log viewer belongs to the checkout that was showing: switching
    // checkouts withdraws it rather than leaving a viewer for an unmounted card.
    logEpoch += 1
    patch({
      selectedCheckoutId: checkoutId,
      logsTargetId: undefined,
      logs: undefined,
      isLoadingLogs: false,
    })
  }

  const openLogs = (targetId: string): void => {
    const epoch = ++logEpoch
    patch({ logsTargetId: targetId, logs: undefined, isLoadingLogs: true })
    void readLogs(targetId, epoch)
  }

  const closeLogs = (): void => {
    logEpoch += 1
    patch({ logsTargetId: undefined, logs: undefined, isLoadingLogs: false })
  }

  const dismissError = (): void => { patch({ error: undefined }) }

  const startActivation = (): Activation => {
    const lifetime = new AbortController()
    let stream: AbortController | undefined
    const stopFollow = (): void => {
      stream?.abort()
      stream = undefined
    }
    const runFollow = async (): Promise<void> => {
      const generation = new AbortController()
      stream = generation
      try {
        for await (const frame of deps.remote.follow({}, generation.signal)) {
          if (lifetime.signal.aborted) return
          applyInventory(frame.snapshot)
        }
      } catch (error) {
        // A stream this source stopped, or a lifetime that ended underneath it,
        // is a deliberate teardown rather than a failure to report.
        if (lifetime.signal.aborted || generation.signal.aborted) return
        reportFailure(messageOf(error))
      } finally {
        if (stream === generation) stream = undefined
      }
    }
    const unsubscribeReset = deps.subscribeReset(() => {
      stopFollow()
      void runFollow()
    })
    void runFollow()
    return {
      signal: lifetime.signal,
      dispose: () => {
        unsubscribeReset()
        stopFollow()
        lifetime.abort()
      },
    }
  }

  const panel: HostObservable<ProjectServicesPanelSnapshot> = {
    getSnapshot: () => store.getSnapshot(),
    subscribe: (listener) => {
      observers += 1
      if (observers === 1) activation = startActivation()
      const unsubscribe = store.subscribe(listener)
      return () => {
        unsubscribe()
        observers -= 1
        if (observers === 0) {
          activation?.dispose()
          activation = undefined
        }
      }
    },
  }

  return {
    panel,
    inject: () => ({
      hooks: { panel },
      selectCheckout,
      refresh,
      control,
      stopGroup,
      openLogs,
      closeLogs,
      dismissError,
    }),
    dispose: () => {
      activation?.dispose()
      activation = undefined
    },
  }
}
