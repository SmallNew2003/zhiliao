/** Public theme defaults also support non-DOM source inspection. */
import { expect, it } from 'vitest'
import { previewTheme } from '../src/client/theme.ts'

it('maps public light/dark defaults without a browser document', () => {
  const base = { preference: 'light' as const, themes: [], fontSize: 16, revision: 0, active: { id: 'light', colorScheme: 'light' as const, tokens: {} } }
  expect(previewTheme(base)).toMatchObject({ colorScheme: 'light', background: '#ffffff', foreground: '#212529', fontFamily: 'system-ui, sans-serif', fontSize: 16 })
  expect(previewTheme({ ...base, active: { ...base.active, colorScheme: 'dark' } })).toMatchObject({ background: '#212529', foreground: '#dee2e6' })
})
