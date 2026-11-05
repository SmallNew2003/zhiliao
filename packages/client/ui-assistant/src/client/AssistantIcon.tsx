/** Sidebar assistant launcher icon. */

import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the assistant entry glyph.
 * @param props - requested square edge and active state.
 * @returns a simple assistant mark.
 */
export function AssistantIcon({ size, active }: SidebarPanelIconOwnerProps) {
  return (
    <svg width={size} height={size} viewBox="0 0 16 16" aria-hidden="true" focusable="false">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeWidth={active ? 1.6 : 1.2} />
      <circle cx="8" cy="8" r="2" fill="currentColor" />
    </svg>
  )
}
