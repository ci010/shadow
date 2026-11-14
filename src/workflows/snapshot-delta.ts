import { createHash } from 'node:crypto'

/** Process-local, bounded HTTP reconciliation versions, not execution checkpoints. */
export function createWorkflowSnapshotDelta(options: { maxBytes?: number; ttlMs?: number; now?: () => number } = {}) {
  const cache = new Map<string, { json: string; at: number }>()
  const maxBytes = options.maxBytes ?? 8 * 1024 * 1024
  const now = options.now ?? Date.now
  return (snapshot: { projectId: string; definitions: { id: string }[]; runs: { id: string }[]; [key: string]: unknown }, since?: string) => {
    const time = now(), json = JSON.stringify(snapshot)
    const cursor = 'wf1-' + createHash('sha256').update(json).digest('hex')
    for (const [key, value] of cache) if (time - value.at > (options.ttlMs ?? 120_000)) cache.delete(key)
    const previous = since ? cache.get(since) : undefined
    if (!cache.has(cursor) && Buffer.byteLength(json) <= maxBytes) cache.set(cursor, { json, at: time })
    else if (cache.has(cursor)) cache.get(cursor)!.at = time
    let bytes = [...cache.values()].reduce((sum, value) => sum + Buffer.byteLength(value.json), 0)
    for (const [key, value] of cache) {
      if (cache.size <= 8 && bytes <= maxBytes) break
      cache.delete(key); bytes -= Buffer.byteLength(value.json)
    }
    if (!previous) return { version: 1, kind: 'full', cursor, snapshot }
    if (since === cursor) return { version: 1, kind: 'noop', cursor, projectId: snapshot.projectId }
    const old = JSON.parse(previous.json) as typeof snapshot
    const collections = Object.fromEntries(['definitions', 'runs'].filter(key => JSON.stringify(old[key]) !== JSON.stringify(snapshot[key])).map(key => {
      const before = new Map((old[key] as { id: string }[]).map(item => [item.id, item]))
      const items = snapshot[key] as { id: string }[]
      const ids = new Set(items.map(item => item.id))
      return [key, { upsert: items.filter(item => JSON.stringify(before.get(item.id)) !== JSON.stringify(item)), remove: [...before.keys()].filter(id => !ids.has(id)), order: items.map(item => item.id) }]
    }))
    const metadata = Object.fromEntries(Object.entries(snapshot).filter(([key]) => !['definitions', 'runs'].includes(key)))
    const oldMetadata = Object.fromEntries(Object.entries(old).filter(([key]) => !['definitions', 'runs'].includes(key)))
    return { version: 1, kind: 'delta', projectId: snapshot.projectId, base: since, cursor, ...collections,
      ...(JSON.stringify(metadata) === JSON.stringify(oldMetadata) ? {} : { metadata }) }
  }
}
