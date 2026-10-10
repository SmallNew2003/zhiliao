/** Registration-owned global activity store; only frame identities are retained. */
import type { ObservableSnapshot } from '@deepseek-ai/dsh-client-store'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Global document identities and viewport ownership for one Client registration. */
export interface PreviewBudget extends ObservableSnapshot<readonly string[]> {
  /**
   * Enroll a visible document; waiting documents do not evict active peers.
   * @param id - Mounted preview identity.
   */
  enter(id: string): void
  /**
   * Retire an invisible or unmounted document and promote a waiting peer.
   * @param id - Preview leaving the viewport.
   */
  leave(id: string): void
  /**
   * Activate a user-selected document, evicting the oldest active peer if needed.
   * @param id - Explicitly selected preview.
   */
  activate(id: string): void
  /** Release visible ownership and publish an empty activity snapshot. */
  dispose(): void
}

/**
 * Allocate active slots without repeatedly cycling visible waiting previews.
 * @param limit - Validated maximum number of active documents.
 * @returns An observable snapshot and plain owner callbacks; no source or DOM is retained.
 */
export function createPreviewBudget(limit: number): PreviewBudget {
  const store = createSnapshotStore<readonly string[]>([])
  const visible = new Set<string>()
  const publish = (active: readonly string[]): void => {
    const next = [...active]
    for (const id of visible) {
      if (next.length >= limit) break
      if (!next.includes(id)) next.push(id)
    }
    if (next.join('\0') !== store.getSnapshot().join('\0')) store.set(next)
  }
  return {
    getSnapshot: () => store.getSnapshot(),
    subscribe: (listener: () => void) => store.subscribe(listener),
    enter(id: string): void { visible.add(id); publish(store.getSnapshot()) },
    leave(id: string): void { visible.delete(id); publish(store.getSnapshot().filter(value => value !== id)) },
    activate(id: string): void {
      visible.add(id)
      const active = store.getSnapshot().filter(value => value !== id)
      const retained = limit > 1 ? active.slice(-(limit - 1)) : []
      publish([...retained, id])
    },
    dispose(): void { visible.clear(); store.set([]) },
  }
}
