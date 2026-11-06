/** Sidebar assistant launcher icon. */
import { IconUserOutlineRegular } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarPanelIconOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the assistant entry glyph.
 * @param props - requested square edge and active state.
 * @returns the shared user icon.
 */
export function AssistantIcon({ size }: SidebarPanelIconOwnerProps) {
  return <IconUserOutlineRegular size={size} />
}
