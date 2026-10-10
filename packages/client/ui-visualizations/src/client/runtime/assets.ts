/** Immutable library bytes loaded only after preview admission. */
import { runtimeManifest } from '../../runtime-manifest.ts'

/** Self-contained classic browser scripts and inline stylesheets. */
export interface RuntimeAssets {
  readonly css: readonly string[]
  readonly scripts: readonly string[]
}

const cache = new Map<string, Promise<RuntimeAssets>>()

/**
 * Resolve exact packaged assets without retaining any authored data.
 * @param kind - Admitted renderer language.
 * @param libraries - Validated HTML library declarations.
 * @returns Shared immutable bytes for this runtime and declared library set.
 */
export function loadRuntimeAssets(kind: 'html' | 'mermaid', libraries: readonly 'echarts'[]): Promise<RuntimeAssets> {
  const key = `${runtimeManifest.id}:${kind}:${libraries.join(',')}`
  const cached = cache.get(key)
  if (cached !== undefined) return cached
  const loading = (async (): Promise<RuntimeAssets> => {
    if (kind === 'mermaid') return (await import('./mermaid-assets.ts')).assets
    const html = (await import('./html-assets.ts')).assets
    if (!libraries.includes('echarts')) return html
    const charts = (await import('./echarts-assets.ts')).assets
    return Object.freeze({ css: html.css, scripts: Object.freeze([...html.scripts, ...charts.scripts]) })
  })()
  cache.set(key, loading)
  void loading.catch(() => { cache.delete(key) })
  return loading
}
