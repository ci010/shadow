import { applyChanges, unpack, type Change, type Json } from '../../src/shared/snapshot-wire.ts'

/** A reader is local to one resource URL. Commit version only after domain validation. */
export function createSnapshotReader<T>(read: (version: string | undefined, signal?: AbortSignal) => Promise<unknown>, parse: (value: unknown) => T, project: (value: unknown) => unknown = value => value) {
  let current: { version: string; value: Json } | undefined
  async function load(signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response: any = await read(current?.version, signal)
      // Old servers remain usable during rolling upgrades.
      if (response?.protocol !== 'snapshot-v1') { current = undefined; return parse(response) }
      try {
        if (typeof response.version !== 'string' || !response.version || !Array.isArray(response.dictionary) || !response.dictionary.every((text: unknown) => typeof text === 'string')) throw new Error('Invalid snapshot envelope')
        const decoded = unpack(response.data, response.dictionary)
        if (response.base !== undefined && (!current || response.base !== current.version || !Array.isArray(decoded))) throw new Error('Snapshot base mismatch')
        const value = response.base === undefined ? decoded : applyChanges(current!.value, decoded as Change[])
        const parsed = parse(project(value))
        signal?.throwIfAborted()
        current = { version: response.version, value }
        return parsed
      } catch (error) {
        current = undefined
        if (attempt || signal?.aborted) throw error
      }
    }
    throw new Error('Snapshot recovery failed')
  }
  // Serialize consumers; responses from an older request cannot roll back the base.
  let pending: Promise<unknown> = Promise.resolve()
  return { load(signal?: AbortSignal): Promise<T> {
    const next = pending.then(() => { signal?.throwIfAborted(); return load(signal) })
    pending = next.catch(() => {})
    return next
  } }
}
