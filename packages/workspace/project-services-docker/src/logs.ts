/**
 * Bounded Docker container log reader with cursor and truncation tracking.
 * @module
 */
import { brandString } from '@deepseek-ai/dsh-brand'
import type {
  ServiceCursor,
  ServiceItem,
  ServiceLogChunk,
  ServiceLogPage,
  ServiceLogsRequest,
} from '@deepseek-ai/dsh-project-services'
import type { DockerTransport } from './transport.ts'
import { extractContainerId } from './operations.ts'

/**
 * Timestamp prefix of one `docker logs --timestamps` line: an optional RFC3339 nano
 * stamp, an optional separating whitespace run, and the remaining line text.
 */
const TIMESTAMP_PREFIX = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)?(?:\s(.*))?$/

/** One parsed log line; a line without a timestamp prefix is delivered verbatim. */
interface LogLine {
  timestamp: string | undefined
  text: string
}

/**
 * Fetch bounded Docker container logs with cursor and truncation.
 * @param target - Observed Docker service item.
 * @param request - Reader-local cursor and byte cap.
 * @param transport - Docker transport.
 * @param maxLines - Maximum tail lines.
 * @param signal - Read cancellation.
 * @returns Bounded log page.
 */
export async function fetchDockerLogs(
  target: ServiceItem,
  request: ServiceLogsRequest,
  transport: DockerTransport,
  maxLines: number,
  signal: AbortSignal,
): Promise<ServiceLogPage> {
  const containerId = extractContainerId(target.id)
  if (!containerId) {
    return {
      chunks: [],
      truncated: false,
      gap: false,
      unavailable: `Cannot read logs from non-container target: ${target.id}`,
    }
  }

  const maxBytes = request.maxBytes
  if (maxBytes === undefined || !Number.isInteger(maxBytes) || maxBytes < 1) {
    throw new Error('Explicit log response limit required')
  }

  try {
    const logOptions: { tail: number; since?: string } = { tail: maxLines }
    if (request.cursor) logOptions.since = String(request.cursor)
    const rawOutput = await transport.logs(containerId, logOptions, signal)

    if (!rawOutput.trim()) {
      return {
        chunks: [],
        ...(request.cursor !== undefined ? { nextCursor: request.cursor } : {}),
        truncated: false,
        gap: false,
      }
    }

    const cursor = request.cursor === undefined ? undefined : String(request.cursor)
    const parsed: LogLine[] = rawOutput.split('\n').filter(line => line !== '').flatMap((line) => {
      const match = TIMESTAMP_PREFIX.exec(line)
      // A line whose prefix is neither a daemon timestamp nor plain text is delivered verbatim.
      if (match === null) return [{ timestamp: undefined, text: line }]
      return [{ timestamp: match[1], text: match[2] ?? '' }]
    })
    // `docker logs --since` includes the boundary instant, so the cursor line and every
    // earlier line were already delivered and are dropped instead of repeated.
    const lines = parsed.filter(line => line.timestamp === undefined || cursor === undefined || line.timestamp > cursor)

    const chunks: ServiceLogChunk[] = lines.map(line => ({ targetId: target.id, stream: 'combined', text: line.text }))
    // The cursor advances only over delivered lines: a page cut short by the byte cap
    // resumes from its last delivered line instead of skipping the remainder.
    const nextCursor = (count: number): ServiceCursor | undefined => {
      for (const line of lines.slice(0, count).reverse()) {
        if (line.timestamp !== undefined) return brandString<ServiceCursor>(line.timestamp)
      }
      return request.cursor
    }
    const page = (count: number): ServiceLogPage => {
      const resume = nextCursor(count)
      return {
        chunks: chunks.slice(0, count),
        ...(resume !== undefined ? { nextCursor: resume } : {}),
        truncated: count < lines.length,
        gap: false,
      }
    }

    // The cap applies to the complete response: per-line metadata and JSON escaping
    // count toward it, so the delivered prefix is chosen by serialized size.
    if (Buffer.byteLength(JSON.stringify(page(0))) > maxBytes) {
      return { chunks: [], truncated: false, gap: false, unavailable: 'Service log response limit cannot hold metadata' }
    }
    let low = 0, high = lines.length
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (Buffer.byteLength(JSON.stringify(page(middle))) <= maxBytes) low = middle
      else high = middle - 1
    }
    if (low === 0 && lines.length > 0) {
      return { chunks: [], truncated: false, gap: false, unavailable: 'Service log response limit cannot hold one log line' }
    }
    return page(low)
  } catch (error) {
    return {
      chunks: [],
      truncated: false,
      gap: false,
      unavailable: error instanceof Error ? error.message : String(error),
    }
  }
}
