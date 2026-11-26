export interface ChildIpcProcess {
  on?(event: 'message', listener: (value: unknown) => void): unknown
  removeListener?(event: 'message', listener: (value: unknown) => void): unknown
  send?(message: object, callback: (error: Error | null) => void): boolean
}

/** This channel is inherited at spawn, not addressable by a renderer or network peer. */
export class ChildControlClient {
  private id = 0
  private closed = false
  private readonly pending = new Map<number, (value: unknown) => void>()
  private readonly receive = (message: unknown) => {
    if (!message || typeof message !== 'object') return
    const { type, id, result } = message as Record<string, unknown>
    if (type !== 'shadow-child-control-v1' || typeof id !== 'number') return
    this.pending.get(id)?.(result)
  }
  constructor(private readonly child: ChildIpcProcess) { child.on?.('message', this.receive) }
  request(operation: 'readiness' | 'status' | 'inventory' | 'grant' | 'invalidateGrant', timeoutMs = 9000): Promise<unknown> {
    if (this.closed || !this.child.send || this.pending.size >= 64) return Promise.resolve(null)
    const id = ++this.id
    return new Promise(resolve => {
      const finish = (value: unknown) => { clearTimeout(timer); this.pending.delete(id); resolve(value) }
      const timer = setTimeout(() => finish(null), timeoutMs)
      this.pending.set(id, finish)
      try { this.child.send!({ type: 'shadow-child-control-v1', id, operation }, error => { if (error) finish(null) }) }
      catch { finish(null) }
    })
  }
  stop() {
    if (this.closed) return
    try { this.child.send?.({ type: 'shadow-child-control-v1', id: ++this.id, operation: 'shutdown' }, () => {}) }
    catch { /* The supervisor will terminate an unavailable process. */ }
  }
  close() {
    this.closed = true
    this.child.removeListener?.('message', this.receive)
    for (const finish of this.pending.values()) finish(null)
  }
}
