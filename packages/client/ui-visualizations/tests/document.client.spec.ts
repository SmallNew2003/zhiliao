/** Safe document serialization and self-contained runtime selection. */
import { expect, it } from 'vitest'
import { createPreviewDocument, createStandaloneDocument } from '../src/client/runtime/document.ts'
import { loadRuntimeAssets } from '../src/client/runtime/assets.ts'
import { runtimeManifest } from '../src/runtime-manifest.ts'

const theme = { colorScheme: 'light' as const, background: '#fff', foreground: '#222', accent: '#0d6efd', fontFamily: 'system-ui', fontSize: 14 }
const source = '<title>Chart</title><script>window.value="你好";</script><script>window.other="</script>\u2028";</script>'

it('places its CSP before every executable script and encodes authored closing tags', () => {
  const html = createPreviewDocument({ source, language: 'html', assets: { css: [], scripts: [] }, theme, generation: 'g' })
  expect(html.indexOf('Content-Security-Policy')).toBeLessThan(html.indexOf('<script>'))
  expect(html).toContain("connect-src 'none'")
  expect(html).toContain("frame-src 'none'")
  expect(html).not.toContain(source)
  expect(html.match(/<script>/gu)).toHaveLength(1)
  expect(html.match(/<\/script>/gu)).toHaveLength(1)
})

it('loads pinned libraries lazily and reuses only immutable same-runtime assets', async () => {
  const html = await loadRuntimeAssets('html', [])
  expect(html.scripts[0]).toContain('Bootstrap v5.3.8')
  expect(html.scripts.join('')).not.toContain('Apache ECharts')
  expect(await loadRuntimeAssets('html', [])).toBe(html)
  const charts = await loadRuntimeAssets('html', ['echarts'])
  expect(charts.scripts).toHaveLength(2)
  expect(charts.scripts[1]).toContain('6.1.0')
  expect(Object.isFrozen(charts.scripts)).toBe(true)
  const diagrams = await loadRuntimeAssets('mermaid', [])
  expect(diagrams.scripts).toHaveLength(1)
  expect(diagrams.scripts[0]).toContain('mermaid')
  expect(runtimeManifest.libraries).toEqual({ bootstrap: '5.3.8', echarts: '6.1.0', mermaid: '11.16.0' })
})

it('exports the original document with embedded runtime bytes and no parent handshake', () => {
  const html = createStandaloneDocument({ source, language: 'html', assets: { css: ['body{color:red}'], scripts: ['window.bootstrap={}'] }, theme })
  expect(html).not.toContain('dsh-preview-init')
  expect(html).toContain('body{color:red}')
  expect(html).toContain('window.bootstrap={}')
  expect(html).not.toContain('https://')
})

it('keeps bootstrap placeholder spellings inside authored source literal', () => {
  const html = createPreviewDocument({ source: '__DSH_OFFLINE__', language: 'html', assets: { css: [], scripts: [] }, theme, generation: 'g' })
  expect(html).toContain('"source":"__DSH_OFFLINE__"')
  expect(html).toContain('const offline = false;')
})
