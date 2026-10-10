/** Marked preview admission and deployment limits. */
import { describe, expect, it } from 'vitest'
import { Config } from '../src/config.ts'
import { parsePreview } from '../src/client/protocol.ts'
import type { MarkdownCodeBlock } from '@deepseek-ai/dsh-client-ui-primitives'

const block = (meta: string | undefined = 'preview runtime=dsh-v1', code = '你好', closed = true, language = 'html'): MarkdownCodeBlock => ({ code, meta, language, closed, sourceOffset: 0, streaming: !closed })

describe('preview admission', () => {
  it('declines ordinary and unsupported-language blocks', () => {
    expect(parsePreview(block(''), Config({}))).toBeUndefined()
    expect(parsePreview(block('preview runtime=dsh-v1', '', true, 'js'), Config({}))).toBeUndefined()
  })
  it('admits only closed marked fences and the frozen runtime', () => {
    expect(parsePreview(block(), Config({}))).toMatchObject({ kind: 'valid', language: 'html', libraries: [], closed: true })
    expect(parsePreview(block('preview runtime=dsh-v1 libs=echarts'), Config({}))).toMatchObject({ libraries: ['echarts'] })
    expect(parsePreview(block('preview runtime=dsh-v1', '', false), Config({}))).toMatchObject({ kind: 'valid', closed: false })
  })
  it.each(['preview', 'preview runtime=dsh-v2', 'preview runtime=dsh-v1 runtime=dsh-v1', 'preview preview runtime=dsh-v1', 'preview runtime=dsh-v1 foo=bar', 'preview runtime=dsh-v1 libs=d3', 'preview runtime=dsh-v1 libs=echarts,echarts'])('rejects marked invalid metadata: %s', (meta) => {
    expect(parsePreview(block(meta), Config({}))).toMatchObject({ kind: 'error' })
  })
  it('rejects HTML-only libraries in Mermaid and counts source in UTF-8 bytes', () => {
    expect(parsePreview(block('preview runtime=dsh-v1 libs=echarts', '', true, 'mermaid'), Config({}))).toMatchObject({ kind: 'error' })
    expect(parsePreview(block(), Config({ maxSourceBytes: 5 }))).toMatchObject({ kind: 'error', error: 'sourceTooLarge' })
    expect(parsePreview(block(), Config({ maxSourceBytes: 6 }))).toMatchObject({ kind: 'valid' })
  })
})

describe('preview configuration', () => {
  it('resolves defaults before rendering', () => {
    expect(Config({})).toEqual({
      maxSourceBytes: 262144,
      maxExportBytes: 33554432,
      maxActiveFrames: 4,
      minHeight: 180,
      maxHeight: 640,
      readinessTimeoutMs: 15000,
    })
  })
  it.each([{ maxActiveFrames: 0 }, { maxSourceBytes: -1 }, { maxExportBytes: 1.5 }, { readinessTimeoutMs: 0 }, { minHeight: 641, maxHeight: 640 }])('rejects invalid limits %j', (config) => {
    expect(() => Config(config)).toThrow()
  })
})
