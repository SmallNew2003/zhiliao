/**
 * Public JSON projections of project service records, shared by the consumers
 * that publish them to a Remote client or to a model. Consumers keep their own
 * view types and key order; these functions own only the repeated projection
 * work.
 * @module
 */
import type { ServiceItem, ServiceItemViewTail, ServiceLogPage, ServiceLogsView } from './types.ts'

/**
 * Project the item fields every public service view publishes identically:
 * available actions plus the optional observation facts. Consumers spread the
 * result into their own view, so the published key order stays theirs.
 * @param item - Observed service item.
 * @returns Actions and the optional ports, detail, and staleness facts.
 */
export function serviceItemViewTail(item: ServiceItem): ServiceItemViewTail {
  return {
    actions: [...item.actions],
    ...(item.ports !== undefined ? { ports: [...item.ports] } : {}),
    ...(item.detail !== undefined ? { detail: item.detail } : {}),
    ...(item.stale !== undefined ? { stale: item.stale } : {}),
  }
}

/**
 * Project one retained log page into the public view its readers publish.
 * @param page - Domain log page.
 * @returns Chunks with stringified identities, the loss facts, and the optional
 *   cursor and unavailability.
 */
export function serviceLogsView(page: ServiceLogPage): ServiceLogsView {
  return {
    chunks: page.chunks.map(chunk => ({
      targetId: String(chunk.targetId),
      stream: chunk.stream,
      text: chunk.text,
    })),
    truncated: page.truncated,
    gap: page.gap,
    ...(page.nextCursor !== undefined ? { nextCursor: String(page.nextCursor) } : {}),
    ...(page.unavailable !== undefined ? { unavailable: page.unavailable } : {}),
  }
}
