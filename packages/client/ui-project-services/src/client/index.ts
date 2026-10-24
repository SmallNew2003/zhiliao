/**
 * Project services browser UI: the copy dictionary, the global panel page, and
 * the sidebar row that opens it.
 *
 * The panel is a `root`-scoped page, not a session surface: project services
 * belong to a Git project and its worktrees, so a session-scoped seat would
 * remount the panel on every session switch and discard the selected checkout
 * together with the open log viewer. `apply` therefore registers the page into
 * the layout's keyed `main` seat and its row into the sidebar's
 * `sidebar.panellist`, both through `ctx.slots.inject` so neither owner's
 * activation order matters.
 *
 * Data comes from the `projectServices` Remote namespace through
 * `ctx.remote`. This package contributes no Service Definition and no Host
 * behavior; `src/index.ts` stays an empty Host entry.
 *
 * @module
 */

import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.remote Context merge through the Client assembly boundary.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls the `main` keyed seat, its MainPanelId key domain, and the ctx.layout merge.
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls the `sidebar.panellist` row declaration.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls the SlotRegistry service merge (ctx.slots).
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { PANEL_ID } from './contract/slots.ts'
import { createProjectServicesPanelSource } from './panel-source.ts'
import { ProjectServicesPanel } from './ProjectServicesPanel.tsx'
import { ProjectServicesPanelIcon } from './ProjectServicesPanelIcon.tsx'
import { en, NS, zh, type ProjectServicesKey } from './locales.ts'

export { ProjectServicesPanel } from './ProjectServicesPanel.tsx'
export { ProjectServicesPanelIcon } from './ProjectServicesPanelIcon.tsx'
export { createProjectServicesPanelSource } from './panel-source.ts'
export { PANEL_ID } from './contract/slots.ts'
export type {
  ProjectServicesControlAction,
  ProjectServicesPanelInjected,
  ProjectServicesPanelProps,
  ProjectServicesPanelSnapshot,
  ProjectServicesStopTarget,
} from './contract/slots.ts'
export type { ProjectServicesPanelSource, ProjectServicesPanelSourceDeps } from './panel-source.ts'
export { en, NS, zh } from './locales.ts'
export type { ProjectServicesKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Project services copy. */
    'projectServices': ProjectServicesKey
  }
}

/** Services the panel page, its sidebar row, and the Remote reads need. */
export const inject = ['slots', 'locale', 'remote', 'remote.projectServices']

/**
 * Register the project services copy, the panel page, and the sidebar row that
 * opens it. Both registrations ride `slots.inject`, so they install whenever
 * the declaring entry is live and leave with it.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-project-services: dictionaries')

  const source = createProjectServicesPanelSource({
    remote: ctx.remote.projectServices,
    subscribeReset: listener => ctx.on('connection/reset', listener),
  })
  ctx.effect(() => () => { source.dispose() }, 'ui-project-services: source lifetime')

  // The page is a global panel: it belongs to the profile, not to a Session,
  // and the sidebar's row selects it. Its data reads start only once the page
  // renders, so an unopened page holds no snapshot and streams nothing.
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => source.inject(),
  }, ProjectServicesPanel))

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 30,
    label: () => ctx.locale.bind(NS)('panel'),
    locale: NS,
  }, ProjectServicesPanelIcon))
}
