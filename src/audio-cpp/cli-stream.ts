import { spawn } from 'node:child_process'
import { createInterface } from 'node:readline'

export interface PcmStream {
  write(pcm: Buffer): Promise<void>
  finish(): Promise<void>
  closed: Promise<void>
}
/** v0.9.1 CLI's line protocol. SenseVoice emits buffered window deltas, not tokens. */
export function openCliStream(binary: string, args: string[], signal: AbortSignal, partial: (delta: string) => void): PcmStream {
  signal.throwIfAborted()
  const child = spawn(binary, args, { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], signal })
  let diagnostic = ''; let bytes = 0; let failure: Error | undefined
  const lines = createInterface({ input: child.stdout, crlfDelay: Infinity })
  const capture = (chunk: Buffer) => {
    bytes += chunk.length
    if (bytes > 1024 * 1024) { failure = new Error('audio.cpp stream output exceeded limit'); child.kill() }
  }
  child.stdout.on('data', capture)
  child.stderr.on('data', (chunk: Buffer) => { capture(chunk); diagnostic = (diagnostic + chunk.toString('utf8')).slice(-4000) })
  lines.on('line', line => { if (line.startsWith('partial_text=')) partial(line.slice('partial_text='.length)) })
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', error => { failure = error })
    child.once('close', code => {
      lines.close()
      if (failure) reject(failure)
      else if (signal.aborted) reject(signal.reason ?? new Error('Audio stream cancelled'))
      else if (code !== 0) reject(new Error(`audio.cpp streaming exited ${code}: ${diagnostic}`))
      else resolve()
    })
  })
  void closed.catch(() => {})
  child.stdin.on('error', () => {})
  return {
    closed,
    write: pcm => new Promise<void>((resolve, reject) => {
      if (signal.aborted) { reject(signal.reason); return }
      child.stdin.write(pcm, error => error ? reject(error) : resolve())
    }),
    finish: async () => { child.stdin.end(); await closed },
  }
}
