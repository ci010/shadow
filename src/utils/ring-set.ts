/**
 * A bounded set that evicts the oldest entries when capacity is exceeded.
 * Useful for deduplication with a sliding window (e.g. seen-message IDs).
 */
export class RingSet<T> {
  private set = new Set<T>()
  private order: T[] = []

  constructor(private maxSize: number) {}

  has(item: T): boolean {
    return this.set.has(item)
  }

  /** Add an item. Returns `true` if the item was new, `false` if already present. */
  add(item: T): boolean {
    if (this.set.has(item)) return false
    this.set.add(item)
    this.order.push(item)
    if (this.order.length > this.maxSize) {
      this.set.delete(this.order.shift()!)
    }
    return true
  }

  get size(): number {
    return this.set.size
  }
}
