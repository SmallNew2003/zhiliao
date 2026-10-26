/**
 * Settings shell contracts — the types of the two occupants this package
 * renders: the `sidebar.settings` trigger row and the `main` settings page.
 * They live here rather than in ui-settings because they reference the
 * sidebar's and layout's own slot types: ui-settings is the settings domain's
 * base layer and must not depend on any `ui-*` presentation package, or the
 * reference graph closes a cycle through ui-sidebar → ui-layout → ui-theme.
 * The settings SLOT types (what registrants contribute) stay in ui-settings.
 */
import type { ConnectionState } from '@deepseek-ai/dsh-client-connection/client'
import type {
  HostObservable, InjectFace, PropsLocale, PropsRenderSlots, PropsRuntime,
} from '@deepseek-ai/dsh-client-ui-slots'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
// Type-only: pulls ui-sidebar's SlotMap merge (the 'sidebar.settings' entry)
// into every program that sees this contract.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
// Type-only: pulls the settings slot declarations the shell renders into.
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { DesktopUpdateView } from './desktop-update-bridge.ts'

/** Identity shared by the sidebar trigger's target and the main-key page. */
export const SETTINGS_PANEL_ID = 'settings' as MainPanelId

/** One nav row projected from a settings.section registration's options. */
export interface SettingsSectionRow {
  id: string
  order: number
  label: string
}

/** One ordered onboarding step projected from a slot registration. */
export interface SettingsOnboardingStep {
  id: string
  order: number
}

/**
 * Registrant-private injected share of the sidebar trigger row (assembled in
 * apply): connection state and the onboarding ledger arrive as
 * hook-compartment sources, while the navigation and reconnect commands are
 * plain callbacks. The navigation commands receive the panel to restore on
 * close — the trigger reads it from its panel-info seat.
 */
export type SettingsTriggerInjected = {
  /** Select the settings page in the main column, remembering the return panel. */
  openSettings: (returnPanelId: MainPanelId | null) => void
  /** Select the settings page on one registered section (onboarding's entry). */
  openSettingsSection: (id: string, returnPanelId: MainPanelId | null) => void
  /** Request the current shell-owned update action. */
  openDesktopUpdate: () => void
  /** Request a fresh logical generation and physical WebSocket immediately. */
  reconnect: () => void
  hooks: {
    /** Shared Electron status for both sidebar locations. */
    desktopUpdate: HostObservable<DesktopUpdateView>
    /** Connection-owned state for the current Host connection. */
    connectionState: HostObservable<ConnectionState | undefined>
    /** settings.onboarding ledger projected into coordinator order. */
    onboardingSteps: HostObservable<readonly SettingsOnboardingStep[]>
  }
}

/**
 * Full component props of the sidebar trigger row: the sidebar owner share
 * (wide/rail state), its declared render shares, the injected face (hooks
 * compartment bound to useOnboardingSteps), and the standard locale seat.
 */
export type SettingsTriggerComponentProps =
  PropsRuntime<'sidebar.settings'>
  & PropsRenderSlots<'settings.trigger' | 'settings.onboarding'>
  & InjectFace<SettingsTriggerInjected>
  & PropsLocale<'settings'>

/**
 * Registrant-private injected share of the settings page (assembled in
 * apply): the section ledger and the shared active-section selection arrive
 * as hook-compartment sources, and the two navigation commands as plain
 * callbacks.
 */
export type SettingsPageInjected = {
  /** Leave settings for the Conversation (the close control's action). */
  closeSettings: () => void
  /** Select the section the page renders (the nav's action). */
  selectSection: (id: string) => void
  hooks: {
    /** settings.section ledger projected into ordered nav rows. */
    sections: HostObservable<readonly SettingsSectionRow[]>
    /** Shared active-section id; undefined selects the first row. */
    activeSection: HostObservable<string | undefined>
  }
}

/**
 * Full component props of the settings page: the `main` runtime share, the
 * page's declared render shares, the injected face, and the standard locale
 * seat.
 */
export type SettingsPageComponentProps =
  PropsRuntime<'main'>
  & PropsRenderSlots<'settings.header' | 'settings.action' | 'settings.close' | 'settings.section'>
  & InjectFace<SettingsPageInjected>
  & PropsLocale<'settings'>
