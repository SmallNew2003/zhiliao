// @vitest-environment jsdom
/** User-download bytes are bounded before any Blob URL is allocated. */
import { afterEach, expect, it, vi } from 'vitest'
import { downloadBytes, createDownloadNames } from '../src/client/downloads.ts'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers() })
it('creates a local download and revokes its URL after the click even if the browser rejects it', () => {
  vi.useFakeTimers()
  const create = vi.fn<(blob: Blob) => string>(() => 'blob:test'), revoke = vi.fn()
  vi.stubGlobal('URL', { createObjectURL: create, revokeObjectURL: revoke })
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.download).toBe('title_20261010.html')
    expect(this.href).toBe('blob:test')
  })
  downloadBytes(new TextEncoder().encode('你好'), 'text/html', 'title_20261010.html', 6)
  expect(create.mock.calls[0]?.[0].size).toBe(6)
  expect(click).toHaveBeenCalledOnce()
  expect(revoke).not.toHaveBeenCalled()
  vi.runAllTimers()
  expect(revoke).toHaveBeenCalledWith('blob:test')
  expect(() => { downloadBytes(new TextEncoder().encode('你好'), 'text/plain', 'source.txt', 5) }).toThrow('exportTooLarge')
  expect(() => { downloadBytes(new Uint8Array(), 'application/javascript', 'code.js', 1) }).toThrow('invalidExport')
  click.mockImplementation(() => { throw new Error('browser refused') })
  expect(() => { downloadBytes(new Uint8Array(), 'image/svg+xml', 'diagram.svg', 1) }).toThrow('browser refused')
  vi.runAllTimers()
  expect(revoke).toHaveBeenCalledTimes(2)
  expect(createDownloadNames()('', 'txt')).toMatch(/^visualization_[0-9]{8}\.txt$/u)
})
