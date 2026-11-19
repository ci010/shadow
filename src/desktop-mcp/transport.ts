import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { once } from 'node:events'
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js'
import type { JSONRPCMessage } from '@modelcontextprotocol/sdk/types.js'

/** A direct-child stdio transport. No process-name/tree killing: launched user
 * applications and persistent clipboard effects are not rollback targets. */
export class DesktopStdioTransport implements Transport {
  onclose?: () => void
  onerror?: (error: Error) => void
  onmessage?: (message: JSONRPCMessage) => void
  private child?: ChildProcessWithoutNullStreams
  private closing?: Promise<void>
  private exited?: Promise<void>
  private closed?: Promise<void>
  private pending = new Map<string, string | number>()
  dispatched = 0
  private notified = false
  constructor(private command: string, private args: string[], private env: Record<string, string>,
    private uncertain: (reason: string) => void,
    // Let official Unix cancellation complete its own TERM/3s/KILL sequence
    // before terminating the MCP server that owns that cancellation thread.
    private grace = { eof: process.platform === 'win32' ? 500 : 3500, term: 3000 }) {}

  async start(): Promise<void> {
    if (this.child) throw new Error('Desktop transport already started')
    const child = spawn(this.command, this.args, { env: this.env, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'], shell: false })
    this.child = child
    this.exited = new Promise(resolve => {
      child.once('exit', () => resolve())
      child.once('error', () => { if (!child.pid) resolve() })
    })
    this.closed = new Promise(resolve => child.once('close', () => resolve()))
    child.on('error', error => this.onerror?.(error))
    child.stdin.on('error', error => this.onerror?.(error))
    // Never log native stderr: it can contain desktop/clipboard data.
    child.stderr.resume()
    let buffer = Buffer.alloc(0)
    child.stdout.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk])
      if (buffer.length > 64 * 1024 * 1024) {
        this.fail(new Error('Desktop MCP response exceeds 64 MiB'))
        return
      }
      let newline: number
      while ((newline = buffer.indexOf(10)) >= 0) {
        const line = buffer.subarray(0, newline).toString('utf8').replace(/\r$/, '')
        buffer = buffer.subarray(newline + 1)
        if (!line) continue
        try {
          const message = JSON.parse(line) as JSONRPCMessage
          if ('id' in message && ('result' in message || 'error' in message)) this.pending.delete(String(message.id))
          this.onmessage?.(message)
        } catch { this.fail(new Error('Malformed desktop MCP JSON response')); return }
      }
    })
    child.once('close', () => {
      if (this.pending.size) this.uncertain('Desktop MCP exited with a dispatched call still outstanding')
      if (!this.notified) { this.notified = true; this.onclose?.() }
    })
    await once(child, 'spawn')
  }
  private fail(error: Error): void {
    if (this.pending.size) this.uncertain(error.message)
    this.onerror?.(error)
    void this.close().catch(error => this.onerror?.(error))
  }
  async send(message: JSONRPCMessage): Promise<void> {
    if (!this.child || this.closing || this.child.exitCode !== null || this.child.signalCode !== null) throw new Error('Desktop MCP transport is closed')
    if ('method' in message && message.method === 'tools/call' && 'id' in message) { this.pending.set(String(message.id), message.id); this.dispatched++ }
    if ('method' in message && message.method === 'notifications/cancelled') {
      const params = message.params as { requestId?: unknown } | undefined
      if (params && this.pending.has(String(params.requestId))) this.uncertain('Dispatched desktop action was cancelled; completion is unknown')
    }
    await new Promise<void>((resolve, reject) => this.child!.stdin.write(JSON.stringify(message) + '\n', error => error ? reject(error) : resolve()))
  }
  close(): Promise<void> { return this.closing ??= this.stop() }
  private async wait(ms: number, done = this.exited!): Promise<boolean> {
    let timer: ReturnType<typeof setTimeout> | undefined
    try { return await Promise.race([done.then(() => true), new Promise<false>(resolve => { timer = setTimeout(() => resolve(false), ms) })]) }
    finally { clearTimeout(timer) }
  }
  private async stop(): Promise<void> {
    const child = this.child
    if (!child) return
    try { await this.terminate(child) } finally {
      // A deliberately launched app must not hold transport cleanup hostage by
      // retaining a stdio FD. Drain briefly, then close only our own pipe handles.
      await this.wait(100, this.closed!)
      child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy()
    }
  }
  private async terminate(child: ChildProcessWithoutNullStreams): Promise<void> {
    if (this.pending.size) this.uncertain('Desktop MCP disconnected during a dispatched action')
    // Disconnect may occur without a caller AbortSignal. Best-effort official
    // cancellation must precede EOF; never await a potentially blocked stdin
    // write here, since the cleanup deadline must still terminate this child.
    for (const id of this.pending.values()) {
      try { child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: id, reason: 'Host connection closing' } }) + '\n') } catch { /* forceful cleanup below */ }
    }
    child.stdin.end() // EOF drains official in-flight work, so it must be bounded.
    if (await this.wait(this.grace.eof)) return
    if (child.exitCode === null && child.signalCode === null) child.kill(process.platform === 'win32' ? 'SIGKILL' : 'SIGTERM')
    if (await this.wait(process.platform === 'win32' ? 1000 : this.grace.term)) return
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    if (!await this.wait(1000)) {
      this.uncertain('Desktop MCP direct-child cleanup could not be confirmed')
      throw new Error('Desktop MCP cleanup failed; device desktop actions remain blocked')
    }
  }
}
