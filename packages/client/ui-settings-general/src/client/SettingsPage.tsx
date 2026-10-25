/**
 * Settings page: the `main` panel behind the sidebar's Settings entry — the
 * section nav rail plus the content column, replacing the former centered
 * modal. There is no mask and no focus hand-off: leaving settings is
 * navigation (the close control calls the injected close), and the active
 * section is the shared selection store, so onboarding's `openSection` and
 * the nav land on the same state. Escape still leaves settings while the
 * page is mounted (the modal's dismissed gesture, kept as muscle memory);
 * the shell is otherwise a pure composition face — slot-owned text (panel
 * title, close label, sections) arrives from registrants through slots.
 */
import { useEffect, useId } from 'react'
import clsx from 'clsx'
import {
  IconAgentPresetOutline16, IconArchiveOutline20, IconCloseOutline16, IconDataOutline16,
  IconPersonalizationOutline16, IconSettingsOutline16,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SettingsPageComponentProps } from './shell-contract.ts'
import css from './SettingsPage.module.css'

/** Nav glyph by section id; unknown ids fall back to the settings gear. */
function navIcon(id: string) {
  if (id === 'models') return <IconDataOutline16 className={css.navIcon} size={16} />
  if (id === 'agent-presets') return <IconAgentPresetOutline16 className={css.navIcon} size={16} />
  if (id === 'plugins') return <IconPersonalizationOutline16 className={css.navIcon} size={16} />
  // 20-native glyph in the rail's 16px icon slot, as on the Session row menu.
  if (id === 'archived-sessions') return <IconArchiveOutline20 className={css.navIcon} size={16} />
  return <IconSettingsOutline16 className={css.navIcon} size={16} />
}

/**
 * Render the settings page.
 * @param props - composed slot props (shell-contract.ts).
 * @returns the settings page element tree.
 */
export function SettingsPage(props: SettingsPageComponentProps) {
  const { useSections, useActiveSection, selectSection, closeSettings, renderSlot } = props
  // Entries can unmount underneath the requested id, so the render-time
  // projection falls back to the first row when the id is gone.
  const rows = useSections(s => s)
  const activeId = useActiveSection(s => s)
  const active = rows.find(row => row.id === activeId)?.id ?? rows[0]?.id
  const titleId = useId()

  // The listener lifetime is the page's: Escape leaves settings only while
  // the page is the selected main panel.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeSettings()
    }
    document.addEventListener('keydown', onKeyDown)
    return () => { document.removeEventListener('keydown', onKeyDown) }
  }, [closeSettings])

  return (
    <div className={css.page} role="region" aria-labelledby={titleId} data-settings-page>
      <nav className={css.nav} aria-labelledby={titleId}>
        <div className={css.navTitle} id={titleId}>{renderSlot('settings.header', {})}</div>
        <div className={css.navList}>
          {rows.map(row => (
            <button
              key={row.id}
              type="button"
              className={clsx(css.navCell, row.id === active && css.active)}
              aria-current={row.id === active ? 'true' : undefined}
              onClick={() => { selectSection(row.id) }}
            >
              {navIcon(row.id)}
              <span className={css.navLabel}>{row.label}</span>
            </button>
          ))}
        </div>
      </nav>
      <div className={css.content}>
        <div className={css.header}>
          <div className={css.actions}>{renderSlot('settings.action', {})}</div>
          <button type="button" className={css.close} onClick={closeSettings}>
            <IconCloseOutline16 size={14} />
            <span className={css.hiddenLabel}>{renderSlot('settings.close', {})}</span>
          </button>
        </div>
        <div className={css.options}>
          {active !== undefined && renderSlot('settings.section', { close: closeSettings }, { only: active })}
        </div>
      </div>
    </div>
  )
}
