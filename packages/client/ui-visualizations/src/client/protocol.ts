/** Admission policy for explicitly marked top-level assistant fences. */
import type { MarkdownCodeBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { Config } from '../config.ts'
import { runtimeManifest } from '../runtime-manifest.ts'

/** Localized admission diagnostics; source remains readable for every rejection. */
export type PreviewError = 'invalidMetadata' | 'runtimeUnavailable' | 'invalidLibrary' | 'sourceTooLarge'

/** An admitted source or a marked input requiring a diagnostic. */
export type ParsedPreview =
  | { readonly kind: 'error'; readonly error: PreviewError }
  | { readonly kind: 'valid'; readonly language: 'html' | 'mermaid'; readonly libraries: readonly 'echarts'[]; readonly closed: boolean }

/**
 * Select only marked HTML/Mermaid; validate before any asset request.
 * @param block - Parser-confirmed source and closure.
 * @param config - Resolved source limit.
 * @returns Admission or diagnostic; undefined declines ordinary code.
 */
export function parsePreview(block: MarkdownCodeBlock, config: Config): ParsedPreview | undefined {
  if (block.language !== 'html' && block.language !== 'mermaid') return undefined
  const tokens = (block.meta ?? '').split(/\s+/u).filter(Boolean)
  if (!tokens.includes('preview')) return undefined
  const metadata = new Map<string, string>()
  let marked = false
  for (const token of tokens) {
    if (token === 'preview' && !marked) { marked = true; continue }
    const match = /^(runtime|libs)=([^\s="']+)$/u.exec(token)
    if (match === null) return { kind: 'error', error: 'invalidMetadata' }
    const [, key, value] = match
    if (key === undefined || value === undefined || metadata.has(key)) {
      return { kind: 'error', error: 'invalidMetadata' }
    }
    metadata.set(key, value)
  }
  if (metadata.get('runtime') !== runtimeManifest.id) return { kind: 'error', error: 'runtimeUnavailable' }
  const libraries = metadata.get('libs')
  if (libraries !== undefined && (block.language !== 'html' || libraries !== 'echarts')) return { kind: 'error', error: 'invalidLibrary' }
  if (new TextEncoder().encode(block.code).byteLength > config.maxSourceBytes) return { kind: 'error', error: 'sourceTooLarge' }
  return { kind: 'valid', language: block.language, libraries: libraries === undefined ? [] : ['echarts'], closed: block.closed }
}
