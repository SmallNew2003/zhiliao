/** Assistant-only inline visualization registration; ordinary Markdown declines. */
import type { Context } from '@deepseek-ai/cordis'
import type { ChatCodeBlockOwnerProps } from '@deepseek-ai/dsh-client-ui-chat/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-theme/client'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Config } from '../config.ts'
import { parsePreview } from './protocol.ts'
import { Preview } from './Preview.tsx'
import type { PreviewInjected } from './Preview.tsx'
import { createPreviewBudget } from './budget.ts'
import { createDownloadNames, downloadBytes } from './downloads.ts'
import { previewTheme } from './theme.ts'
import { en, zh } from './locales.ts'

export type { PreviewInjected, PreviewProps } from './Preview.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Controls and diagnostics owned by inline assistant previews. */
    visualizations: import('./locales.ts').VisualizationKey
  }
}

/** Required browser registries and public theme provider. */
export const inject = ['slots', 'locale', 'theme']

/**
 * Register a reversible preview selector, global budget, and localized controls.
 * @param ctx - Client context with the assistant chain declaration and resolved Host limits.
 */
export function apply(ctx: Context): void {
  const injected = (globalThis as { __DSH_VISUALIZATION_CONFIG__?: unknown }).__DSH_VISUALIZATION_CONFIG__
  if (injected === undefined) throw new Error('Inline visualization Host configuration is missing')
  const config = Config(injected)
  const budget = createPreviewBudget(config.maxActiveFrames)
  const theme = createSnapshotStore(previewTheme(ctx.theme.getTheme()))
  const filename = createDownloadNames()
  ctx.on('theme/change', (snapshot) => { theme.set(previewTheme(snapshot)) })
  ctx.effect(() => () => { budget.dispose() })
  ctx.effect(() => ctx.locale.register('visualizations', { en, zh }))
  ctx.slots.inject('conversation.chat.codeBlock', () => ctx.slots.register({
    name: 'conversation.chat.codeBlock', locale: 'visualizations',
    select: ({ block }: ChatCodeBlockOwnerProps) => parsePreview(block, config) ?? null,
    inject: (): PreviewInjected => ({
      config,
      enter: (id: string) => { budget.enter(id) },
      leave: (id: string) => { budget.leave(id) },
      activate: (id: string) => { budget.activate(id) },
      filename,
      download: (bytes, mime, name) => { downloadBytes(bytes, mime, name, config.maxExportBytes) },
      hooks: { budget, theme },
    }),
  }, Preview))
}
