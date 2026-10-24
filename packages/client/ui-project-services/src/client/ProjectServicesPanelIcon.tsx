/**
 * The sidebar's Project Services entry icon; the sidebar owns the button, the
 * label, and the selected state around it. The glyph is the API mark: the page
 * it opens reports the local processes, containers, and ports a project serves.
 */

import type { ReactNode } from 'react'
import { IconApiOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
// Type-only: the `sidebar.panellist` row this icon registers into.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'

/**
 * Render the project services glyph at the size the sidebar asks for.
 * @param props - the sidebar's icon share: the requested edge and whether the panel is selected.
 * @returns the icon element.
 */
export function ProjectServicesPanelIcon({ size }: PropsRuntime<'sidebar.panellist'>): ReactNode {
  return <IconApiOutline14 size={size} />
}
