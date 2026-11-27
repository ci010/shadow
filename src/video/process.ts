import { spawn } from 'node:child_process'
/** Bounded argv-only process; completion always waits for close, including timeout/abort. */
export async function run(binary: string, args: string[], signal?: AbortSignal, timeoutMs = 30 * 60 * 1000): Promise<string> {
  signal?.throwIfAborted()
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Invalid process timeout')
  return await new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'], shell: false })
    const chunks: Buffer[] = []; let bytes = 0, stderr = Buffer.alloc(0)
    let killTimer: ReturnType<typeof setTimeout> | undefined, failure: Error | undefined
    const terminate = () => { child.kill('SIGTERM'); if (!killTimer) { killTimer = setTimeout(() => child.kill('SIGKILL'), 1500); killTimer.unref() } }
    const abort = () => { terminate() }
    const deadline = setTimeout(() => { failure = new Error(`${binary} timed out after ${timeoutMs}ms`); terminate() }, timeoutMs)
    deadline.unref()
    signal?.addEventListener('abort', abort, { once: true })
    const clean = () => { clearTimeout(deadline); if (killTimer) clearTimeout(killTimer); signal?.removeEventListener('abort', abort) }
    child.stdout.on('data', (chunk: Buffer) => {
      if (failure) return
      if (bytes + chunk.length > 4 * 1024 * 1024) { failure = new Error('Process output limit exceeded'); terminate(); return }
      chunks.push(chunk); bytes += chunk.length
    })
    child.stderr.on('data', (chunk: Buffer) => { stderr = Buffer.concat([stderr, chunk]).subarray(-16000) })
    child.on('error', error => { failure = new Error(`Cannot execute ${binary}: ${error.message}. Supply --ffmpeg/--ffprobe with an installed executable path or add it to PATH; nothing is installed automatically.`) })
    child.on('close', code => {
      clean()
      if (signal?.aborted) reject(signal.reason ?? new Error('Aborted'))
      else if (failure) reject(failure)
      else if (code !== 0) reject(new Error(`${binary} exited ${code}: ${stderr.toString()}`))
      else resolve(Buffer.concat(chunks).toString())
    })
    if (signal?.aborted) abort()
  })
}
