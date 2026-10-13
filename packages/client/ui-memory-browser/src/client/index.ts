/**
 * Long-term memory browser, browser half: the **Memory** entry of the sidebar
 * and the management panel it opens in the main column. The panel lists the
 * deployment's memory banks, and for the selected bank shows its statistics and
 * fact-type composition, its knowledge pages, a search over the knowledge index,
 * and one page's body. A deployment with no usable memory provider, or a daemon
 * that cannot answer, says so with the reason the Host classified instead of
 * showing an empty panel.
 */

import type {} from '@deepseek-ai/dsh-client-locale/client'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: the root `main` keyed slot the page registers into, declared by
// ui-layout with the panel id brand, and the `sidebar.panellist` list the
// entry registers into, declared by ui-sidebar.
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the ctx.remote Context merge carrying the `memoryController`
// namespace the page reads through.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import { MemoryBrowserPage } from './MemoryBrowserPage.tsx'
import { MemoryPanelIcon } from './MemoryPanelIcon.tsx'
import { MemoryBrowserController } from './memory-store.ts'
import { en, zh, type MemoryBrowserLocaleKey } from './locales.ts'

export type { MemoryBrowserPageProps } from './MemoryBrowserPage.tsx'
export type { Translate } from './presentation.ts'
export type {
  MemoryBrowserFace,
  MemoryBrowserState,
  MemoryLoadScope,
  MemoryPanelProblem,
} from './memory-store.ts'
export type { MemoryBrowserLocaleKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Memory browser copy. */
    'memoryBrowser': MemoryBrowserLocaleKey
  }
}

/** Dictionary namespace owned by this plugin. */
export const NS = 'memoryBrowser'

/** The id shared by the sidebar entry and the main panel it opens. */
export const PANEL_ID = 'memory' as MainPanelId

/** Services required by the sidebar registration and the Remote methods. */
export const inject = ['slots', 'locale', 'remote', 'remote.memoryController']

/**
 * Contribute the Memory entry to the sidebar with the browse panel it opens.
 *
 * The panel is global rather than session-scoped: what a deployment remembers
 * belongs to the installation, not to one conversation, and every session's
 * sidebar offers the same view of it. The controller is created here and
 * disposed with this plugin, so a reload leaves no state behind.
 * @param ctx - the browser plugin context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-memory-browser: dictionaries')
  const t = ctx.locale.bind(NS)
  const controller = new MemoryBrowserController(ctx)
  ctx.effect(() => () => { controller.dispose() }, 'ui-memory-browser: controller')
  // The Host owns the daemon, and it can restart under a running browser; a
  // reconnect is the only signal this panel gets that the answer may differ.
  ctx.effect(() => {
    const refresh = (): void => {
      if (controller.getSnapshot().status !== 'idle') void controller.load()
    }
    const dispose = ctx.on('connection/reset', refresh)
    return () => { dispose() }
  }, 'ui-memory-browser: host invalidations')

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: () => controller.inject(),
  }, MemoryBrowserPage))
  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: 0,
    label: () => t('panel'),
    locale: NS,
  }, MemoryPanelIcon))
}
