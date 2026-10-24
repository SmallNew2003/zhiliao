/**
 * Project services panel contracts. Two registrations share this package:
 *
 * - `ProjectServicesPanel` fills the layout's keyed `main` seat, so the panel
 *   is a global page the sidebar row selects, exactly like the plugin manager's
 *   page. - `ProjectServicesPanelIcon` fills the sidebar's `sidebar.panellist`
 *   row that opens that page.
 *
 * Both seats are `root` scope. Project services belong to a Git project and its
 * worktrees, not to one Session: a session-scoped seat would remount the panel
 * on every session switch and discard the selected checkout together with the
 * open log viewer.
 *
 * This package contributes no Service Definition and no Host behavior. Every
 * fact it renders arrives from the `projectServices` Remote namespace through
 * `ctx.remote`, projected into one registrant-private snapshot source plus the
 * panel's control verbs. The component therefore stays pure presentation: it
 * reads the snapshot through the framework-bound `usePanel` selector hook and
 * calls the verbs.
 */

import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the `main` keyed seat and its `MainPanelId` key domain.
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: the `sidebar.panellist` row the panel's icon registers into.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {
  ApiServiceInventoryView,
  ApiServiceLogsView,
} from '@deepseek-ai/dsh-api-project-services-controller/types'

/** The main-panel key this package's page registers under, shared with its sidebar row. */
export const PANEL_ID = 'projectServices' as MainPanelId

/** Lifecycle verb the panel offers for one service target. */
export type ProjectServicesControlAction = 'start' | 'stop' | 'restart'

/**
 * One Compose group member the panel asks the Host to stop, carrying the
 * revision the panel observed: the Host rejects a control whose target revision
 * has since moved, so a stale revision fails loud instead of acting on a
 * service the operator no longer sees.
 */
export interface ProjectServicesStopTarget {
  /** Service target id. */
  readonly targetId: string
  /** Revision the panel's inventory reported for that target. */
  readonly expectedRevision: string
}

/**
 * Everything the panel renders, published as one registrant-private snapshot.
 * `inventory` is undefined until the Host answers the first read; `error`
 * carries the failure text of the last rejected verb or read.
 */
export interface ProjectServicesPanelSnapshot {
  /** Latest inventory the Host published, undefined before the first answer. */
  readonly inventory: ApiServiceInventoryView | undefined
  /** Checkout the panel shows; the source keeps the caller's last explicit choice. */
  readonly selectedCheckoutId: string | undefined
  /** Service whose inline log viewer is open, undefined when none is. */
  readonly logsTargetId: string | undefined
  /** Log page for the open viewer, undefined before it answers. */
  readonly logs: ApiServiceLogsView | undefined
  /** True while the open viewer's log read is in flight. */
  readonly isLoadingLogs: boolean
  /** Service id mapped to the verb in flight for it; the disabled state is all the panel reads. */
  readonly pendingActions: Readonly<Record<string, ProjectServicesControlAction>>
  /** Failure text of the last rejected verb or read, undefined when none is pending. */
  readonly error: string | undefined
}

/**
 * Registrant-private injected share of the panel entry. The reserved `hooks`
 * compartment carries the one live fact the component reads; every other member
 * is a plain callback the component invokes from an event handler.
 */
export interface ProjectServicesPanelInjected {
  readonly hooks: {
    /** Live panel snapshot, bound by the renderer as `usePanel`. */
    readonly panel: HostObservable<ProjectServicesPanelSnapshot>
  }
  /** Show the named checkout; the source re-reads the Host for its log viewer. */
  readonly selectCheckout: (checkoutId: string) => void
  /** Read the inventory again. */
  readonly refresh: () => void
  /** Run one lifecycle verb on one service target at the revision the panel observed. */
  readonly control: (
    action: ProjectServicesControlAction,
    targetId: string,
    expectedRevision: string,
  ) => Promise<void>
  /** Stop every member of one Compose group; the Host addresses each member on its own. */
  readonly stopGroup: (members: readonly ProjectServicesStopTarget[]) => Promise<void>
  /** Open a service's inline log viewer and read its retained output. */
  readonly openLogs: (targetId: string) => void
  /** Close the open log viewer. */
  readonly closeLogs: () => void
  /** Drop the failure banner without touching the snapshot. */
  readonly dismissError: () => void
}

/**
 * Full panel props: the `main` seat's runtime share, the declared namespace's
 * `t` seat, and the inject face with its hook compartment bound.
 */
export type ProjectServicesPanelProps =
  PropsRuntime<'main'>
  & PropsLocale<'projectServices'>
  & InjectFace<ProjectServicesPanelInjected>
