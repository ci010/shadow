/** Bounded ordered reads. Drain workers before surfacing the first input-order error. */
export async function readStatePool<T, R>(items: readonly T[], read: (item: T) => Promise<R>, concurrency = 8): Promise<R[]> {
  if (!Number.isSafeInteger(concurrency) || concurrency < 1) throw new RangeError('Invalid state read concurrency')
  const results: R[] = new Array(items.length)
  const errors = new Map<number, unknown>()
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++
      try { results[index] = await read(items[index]!) }
      catch (error) { errors.set(index, error) }
    }
  }))
  if (errors.size) {
    for (let index = 0; index < items.length; index++) if (errors.has(index)) throw errors.get(index)
  }
  return results
}
