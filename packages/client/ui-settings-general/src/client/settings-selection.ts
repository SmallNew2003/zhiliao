/**
 * Shared active-section selection for the settings page: the viewing state
 * that used to be the modal panel's local state, now shared across the two
 * registrants that address it — the sidebar trigger (onboarding's
 * `openSection`) writes it before navigating, and the page reads it and
 * writes it from its nav. `undefined` renders the first registered section.
 * The store also remembers the main panel settings was entered from, so the
 * close control restores it instead of hard-coding the Conversation.
 */

import { createSnapshotStore, type SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'

/** Coordinates the settings page's active section across its entry points. */
export class SettingsSelectionStore {
  /** uSES-safe active-section id source shared by the trigger and the page. */
  readonly store: SnapshotStore<string | undefined> = createSnapshotStore<string | undefined>(undefined)

  private returnPanelId: MainPanelId | null = null

  /**
   * Select the section the settings page renders.
   * @param id - registered `settings.section` id.
   */
  select(id: string): void {
    this.store.set(id)
  }

  /** Forget the selection, so the next entry lands on the first section. */
  reset(): void {
    this.store.set(undefined)
  }

  /**
   * Remember the main panel settings was entered from.
   * @param panelId - the panel to restore on close, or null for the Conversation.
   */
  setReturn(panelId: MainPanelId | null): void {
    this.returnPanelId = panelId
  }

  /**
   * Read and clear the panel settings closes back to.
   * @returns the remembered panel id, or null for the Conversation.
   */
  takeReturn(): MainPanelId | null {
    const panelId = this.returnPanelId
    this.returnPanelId = null
    return panelId
  }
}
