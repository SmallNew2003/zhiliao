/**
 * Independent UTF-8 log tails with complete-response byte limits.
 * @module
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type { ServiceCursor, ServiceLogPage, ServiceLogsRequest, ServiceTargetId } from '@deepseek-ai/dsh-project-services'

/** Byte-bounded retained output; every reader owns its own absolute byte cursor. */
export class RetainedServiceLog {
  private bytes = Buffer.alloc(0)
  private end = 0
  constructor(private readonly targetId: ServiceTargetId, private readonly maxBytes: number) {
    if (!Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('Invalid retained log limit')
  }

  /**
   * Retain the newest complete UTF-8 characters within the byte cap.
   * @param text - Complete decoded output to append; oldest bytes are discarded at the cap.
   */
  append(text: string): void {
    const appended = Buffer.from(text)
    this.end += appended.length
    this.bytes = Buffer.concat([this.bytes, appended])
    let start = Math.max(0, this.bytes.length - this.maxBytes)
    while (start < this.bytes.length && (this.bytes.readUInt8(start) & 0xc0) === 0x80) start++
    this.bytes = Buffer.from(this.bytes.subarray(start))
  }

  /**
   * Read an independent page whose serialized metadata also fits the cap.
   * @param request - Explicit complete JSON byte limit and optional absolute cursor.
   * @returns Independent page with retained-tail gaps.
   */
  read(request: ServiceLogsRequest): ServiceLogPage {
    if (request.targetId !== this.targetId) throw new Error('Log cursor belongs to another service')
    const maxBytes = request.maxBytes
    if (maxBytes === undefined || !Number.isInteger(maxBytes) || maxBytes < 1) throw new Error('Explicit log response limit required')
    const from = request.cursor === undefined ? 0 : Number(request.cursor)
    if (!Number.isSafeInteger(from) || from < 0 || from > this.end) throw new Error('Invalid service log cursor')
    const retainedStart = this.end - this.bytes.length
    let offset = Math.max(from, retainedStart)
    while (offset < this.end && (this.bytes.readUInt8(offset - retainedStart) & 0xc0) === 0x80) offset++
    const gap = offset > from
    const text = this.bytes.subarray(offset - retainedStart).toString('utf8')
    const page = (count: number): ServiceLogPage => {
      // Slice only at Unicode code-point boundaries before deriving the byte cursor.
      const value = [...text].slice(0, count).join('')
      const next = offset + Buffer.byteLength(value)
      return { chunks: value === '' ? [] : [{ targetId: this.targetId, stream: 'combined', text: value }], nextCursor: brandString<ServiceCursor>(String(next)), truncated: gap || next < this.end, gap }
    }
    if (Buffer.byteLength(JSON.stringify(page(0))) > maxBytes) throw new Error('Service log response limit cannot hold metadata')
    let low = 0, high = [...text].length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (Buffer.byteLength(JSON.stringify(page(middle))) <= maxBytes) low = middle
      else high = middle - 1
    }
    if (low === 0 && text !== '') throw new Error('Service log response limit cannot hold a character')
    return page(low)
  }
}
