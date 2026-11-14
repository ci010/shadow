import { createHash, randomUUID } from 'node:crypto'
import { diff, pack, type Json, type SnapshotWire } from './snapshot-wire.ts'

/** Bounded history, scoped to a route registration (and therefore Project). Cache misses resync. */
export function createSnapshotResponder(maxBytes = 16 * 1024 * 1024) {
  const epoch = randomUUID()
  const history = new Map<string, { value: Json; bytes: number }>()
  let bytes = 0
  return (input: unknown, base?: string): SnapshotWire => {
    // Detach mutable service state and remove undefined exactly as HTTP JSON does.
    const serialized = JSON.stringify(input)
    const size = Buffer.byteLength(serialized)
    const value = JSON.parse(serialized) as Json
    const version = `${epoch}:${createHash('sha256').update(serialized).digest('hex')}`
    const previous = base ? history.get(base) : undefined
    const snapshot: SnapshotWire = { protocol: 'snapshot-v1', version, ...pack(value) }
    let result = snapshot
    if (previous && base) {
      const changes = diff(previous.value, value)
      const delta: SnapshotWire = { protocol: 'snapshot-v1', version, base, ...pack(changes as Json) }
      if (!changes.length || JSON.stringify(delta).length < JSON.stringify(snapshot).length) result = delta
    }
    if (!history.has(version) && size <= maxBytes) {
      history.set(version, { value, bytes: size }); bytes += size
      while (history.size > 4 || bytes > maxBytes) {
        const oldest = history.keys().next().value!
        bytes -= history.get(oldest)!.bytes; history.delete(oldest)
      }
    }
    return result
  }
}
