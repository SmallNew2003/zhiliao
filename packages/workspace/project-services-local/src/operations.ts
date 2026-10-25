/**
 * Target reservations and immutable authorization descriptions.
 * @module
 */

/**
 * Clone JSON facts before authorization so providers cannot mutate approved values.
 * @param value - JSON-compatible facts.
 * @returns Deeply frozen detached value.
 */
export function immutableFacts<T>(value: T): T {
  const cloned = structuredClone(value)
  const freeze = (item: unknown): void => {
    if (item === null || typeof item !== 'object') return
    for (const child of Object.values(item)) freeze(child)
    Object.freeze(item)
  }
  freeze(cloned)
  return cloned
}

/** Multi-target reservations serialize overlapping groups without blocking unrelated targets. */
export class ServiceTargetLocks {
  private readonly tails = new Map<string, Promise<void>>()

  /**
   * Reserve the complete target set until the work settles.
   * @param keys - Complete target set, including group members.
   * @param run - Work whose settlement releases every reservation.
   * @returns Work result.
   */
  run<T>(keys: readonly string[], run: () => Promise<T>): Promise<T> {
    const unique = [...new Set(keys)].sort()
    const previous = unique.map(key => this.tails.get(key) ?? Promise.resolve())
    const result = Promise.all(previous).then(run)
    const tail = result.then(() => {}, () => {})
    for (const key of unique) this.tails.set(key, tail)
    void tail.then(() => { for (const key of unique) if (this.tails.get(key) === tail) this.tails.delete(key) })
    return result
  }
}
