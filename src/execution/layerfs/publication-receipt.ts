/** Pinned 73d974d branch.rs + sdk_values.rs. Only domain receipts settle mutation
 * reservations; generic JSON/ok envelopes are insufficient. */
export function validatePublicationReceipt(action: 'merge' | 'publish', input: unknown, args: { branch?: unknown; ref?: unknown; name?: unknown }): void {
  const v = input as Record<string, any> | null
  const hex = (s: unknown): s is string => typeof s === 'string' && /^(?:[a-f0-9]{2})+$/.test(s)
  const count = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw Error('Missing SDK publication receipt')
  if (action === 'merge') {
    if (v.kind !== 'Merged' || v.branch !== args.name || typeof v.fastForward !== 'boolean' || !(v.head === null || hex(v.head)) || !hex(v.root) || !hex(v.mergeBase)
      || !Array.isArray(v.sources) || v.sources.length !== 2 || v.sources[0]?.ref !== args.ref || v.sources[1]?.ref !== args.branch || !v.sources.every((s: any) => hex(s.node))
      || !Array.isArray(v.conflicts) || v.conflicts.length !== 0 || !Array.isArray(v.lww) || !Array.isArray(v.units)
      || !['conflictsTruncated', 'lwwTruncated', 'unitsTruncated'].every(key => typeof v[key] === 'boolean')) throw Error('Invalid SDK Merged receipt')
    return
  }
  if (v.kind === 'UpToDate' && hex(v.layer)) return
  if (v.kind === 'NoChanges' && hex(v.headLayer)) return
  const layer = v.publishedLayer
  if (v.kind === 'Added' && v.source?.branch === args.branch && hex(v.source?.commit) && (args.ref === undefined || args.ref === v.source.commit)
    && layer && hex(layer.id) && hex(layer.root) && (layer.parent === null || hex(layer.parent)) && count(layer.logical) && count(layer.overwroteCount)
    && layer.sourceBranch === args.branch && layer.sourceCommit === v.source.commit && hex(v.basedOn) && count(v.overwroteCount)
    && Array.isArray(v.overwrote) && v.overwrote.every(hex) && typeof v.overwroteHasMore === 'boolean') return
  throw Error('Invalid SDK publish receipt')
}
