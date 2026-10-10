/** Safe serialization for sandboxed and offline authored documents. */
import type { PreviewTheme } from './bridge.ts'
import type { RuntimeAssets } from './assets.ts'
import { bootstrapSource } from './bootstrap.ts'

/** Authored initial state and the exact declared runtime bytes. */
export interface PreviewDocument {
  readonly source: string
  readonly language: 'html' | 'mermaid'
  readonly assets: RuntimeAssets
  readonly theme: PreviewTheme
}

const policy = "default-src 'none'; script-src 'unsafe-inline' blob:; style-src 'unsafe-inline' blob:; img-src data: blob:; font-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"

function documentOf(value: PreviewDocument & { readonly generation?: string }, offline: boolean): string {
  const payload = JSON.stringify(value).replace(/</gu, '\\u003c').replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029')
  const code = bootstrapSource.replace('__DSH_OFFLINE__', String(offline)).replace('__DSH_PAYLOAD__', () => payload)
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><script>${code}</script></body></html>`
}

/**
 * Build one controlled opaque document, with trusted code before authored HTML.
 * @param value - Source, assets, theme, and generation identity.
 * @returns CSP-first srcdoc bytes.
 */
export function createPreviewDocument(value: PreviewDocument & { readonly generation: string }): string {
  return documentOf(value, false)
}

/**
 * Build an offline HTML download from authored initial values.
 * @param value - Original source and declared immutable runtime assets.
 * @returns Self-contained HTML with no parent handshake or Host dependencies.
 */
export function createStandaloneDocument(value: PreviewDocument): string {
  const offline = bootstrapSource.slice(0, bootstrapSource.indexOf('  const initialize ='))
    + '})().catch(error => { document.body.textContent = String(error && error.message || error); });'
  const payload = JSON.stringify(value).replace(/</gu, '\\u003c').replace(/\u2028/gu, '\\u2028').replace(/\u2029/gu, '\\u2029')
  const code = offline.replace('__DSH_OFFLINE__', 'true').replace('__DSH_PAYLOAD__', () => payload)
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${policy}"><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><script>${code}</script></body></html>`
}
