/** Map the application's public theme and typography into dsh-v1 visual defaults. */
import type { ThemeSnapshot } from '@deepseek-ai/dsh-client-ui-theme/client'
import type { PreviewTheme } from './runtime/bridge.ts'

/**
 * Capture public resolved CSS values after the application's theme presenter.
 * @param snapshot - Active theme and content font size.
 * @returns JSON-compatible palette values for the isolated document.
 */
export function previewTheme(snapshot: ThemeSnapshot): PreviewTheme {
  const dark = snapshot.active.colorScheme === 'dark'
  const css = typeof document === 'undefined' ? undefined : getComputedStyle(document.body)
  const read = (name: string, fallback: string): string => css?.getPropertyValue(name).trim() || fallback
  return {
    colorScheme: snapshot.active.colorScheme,
    background: read('--dsw-alias-bg-base', dark ? '#212529' : '#ffffff'),
    foreground: read('--dsw-alias-label-primary', dark ? '#dee2e6' : '#212529'),
    accent: read('--dsw-alias-brand-primary', '#0d6efd'),
    fontFamily: css?.fontFamily || 'system-ui, sans-serif',
    fontSize: snapshot.fontSize,
  }
}
