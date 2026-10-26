/**
 * The plugin manager page's open view. The page unmounts when another global
 * panel (settings) replaces it in the main column; the view lives here so
 * returning to the panel restores the page the user was reading.
 */
import { defineStore, type EngineStoreHandle } from '@deepseek-ai/dsh-client-store'

/** What the page shows: the cards, a bundle's page, an official plugin's page, or a row's configuration page. */
export type View =
  | { readonly kind: 'list' }
  | { readonly kind: 'package'; readonly name: string }
  | { readonly kind: 'item'; readonly id: string }
  | { readonly kind: 'row'; readonly name: string; readonly rowId: string }

type PluginManagerViewState = { view: View }

type PluginManagerViewActions = {
  openView: (draft: PluginManagerViewState, view: View) => void
}

/**
 * Create the view store handle seated on the page's `main` registration.
 * @returns the store handle (spec + type + identity + factory in one).
 */
export function createPluginManagerViewStore(): EngineStoreHandle<PluginManagerViewState, PluginManagerViewActions> {
  return defineStore({
    init: (): PluginManagerViewState => ({ view: { kind: 'list' } }),
    actions: {
      openView: (d, view: View) => { d.view = view },
    },
  })
}
