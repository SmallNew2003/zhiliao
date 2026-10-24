/** User-initiated, byte-bounded downloads and local calendar filenames. */

/**
 * Allocate date-stamped names within one Client registration.
 * @returns A filename callback using sanitized titles and same-day sequence numbers.
 */
export function createDownloadNames(): (title: string, extension: string, date?: Date) => string {
  const counts = new Map<string, number>()
  return (title, extension, date = new Date()) => {
    let stem = title.replace(/[<>:"/\\|?*\u0000-\u001f]/gu, ' ').replace(/\s+/gu, ' ').trim().replace(/[. ]+$/u, '').slice(0, 80) || 'visualization'
    if (/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/iu.test(stem)) stem = `_${stem}`
    const day = `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, '0')}${String(date.getDate()).padStart(2, '0')}`
    const key = `${stem}_${day}.${extension}`
    const count = (counts.get(key) ?? 0) + 1
    counts.set(key, count)
    return `${stem}_${day}${count === 1 ? '' : `_${String(count).padStart(2, '0')}`}.${extension}`
  }
}

/**
 * Download a bounded local Blob; callers invoke this only from user gestures.
 * @param bytes - Complete UTF-8 or binary content.
 * @param mime - Validated supported MIME.
 * @param filename - Already allocated date-stamped filename.
 * @param limit - Maximum download bytes.
 */
export function downloadBytes(bytes: Uint8Array<ArrayBuffer>, mime: string, filename: string, limit: number): void {
  if (!['text/html', 'text/plain', 'image/svg+xml', 'image/png'].includes(mime)) throw new Error('invalidExport')
  if (bytes.byteLength > limit) throw new Error('exportTooLarge')
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }))
  try {
    const anchor = document.createElement('a')
    anchor.href = url
    anchor.download = filename
    anchor.click()
  } finally {
    setTimeout(() => { URL.revokeObjectURL(url) }, 0)
  }
}
