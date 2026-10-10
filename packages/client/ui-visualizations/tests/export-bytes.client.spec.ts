/** Export MIME, encoding, signatures and decoded byte limits. */
import { expect, it } from 'vitest'
import { exportBytes } from '../src/client/runtime/bridge.ts'

it('accepts complete SVG/PNG bytes and rejects invalid encoding and content', () => {
  expect(new TextDecoder().decode(exportBytes({ mime: 'image/svg+xml', data: '<svg />' }, 7))).toBe('<svg />')
  expect(() => exportBytes({ mime: 'image/svg+xml', data: 'not-svg' }, 20)).toThrow('invalidExport')
  const prefix = 'data:image/png;base64,'
  const png = prefix + btoa(String.fromCharCode(137, 80, 78, 71, 13, 10, 26, 10))
  expect(exportBytes({ mime: 'image/png', data: png }, 8).length).toBe(8)
  expect(() => exportBytes({ mime: 'image/png', data: png }, 7)).toThrow('exportTooLarge')
  for (const data of ['other', prefix + '?', prefix + btoa('bad')]) expect(() => exportBytes({ mime: 'image/png', data }, 20)).toThrow('invalidExport')
  expect(() => exportBytes({ mime: 'image/png', data: prefix + btoa('x') }, 0)).toThrow('exportTooLarge')
})
