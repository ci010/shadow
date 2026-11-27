/** Copy RPCs are single-consumer, non-replayable, and have no durable job history.
 * Only bounded job-ID tombstones survive terminal delivery; never retain payloads.
 * Non-copy jobs deliberately keep their existing execution/reconciliation semantics.
 */
export const isCopyJob = (operation: string): boolean => operation === 'filesystem.copy.read' || operation === 'filesystem.copy.write'
export class CopyJobLifetime {
  readonly #active = new Set<string>()
  readonly #recent = new Set<string>()
  get counts() { return { activeJobs: this.#active.size, recentJobIds: this.#recent.size } }
  admit(id: string, args: unknown): void {
    if (Buffer.byteLength(JSON.stringify(args) ?? '') > 1024 * 1024) throw new Error('Copy RPC arguments exceed their bounded size')
    if (this.#active.has(id) || this.#recent.has(id)) throw new Error('Copy RPC job IDs cannot be replayed; inspect the transfer outcome instead')
    if (this.#active.size >= 64) throw new Error('Too many active copy RPC jobs')
    this.#active.add(id)
  }
  finish(id: string): void {
    if (!this.#active.delete(id)) return
    this.#recent.add(id)
    if (this.#recent.size > 128) this.#recent.delete(this.#recent.values().next().value!)
  }
}
