import { type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { z } from 'zod'
import { ComputerError, type ComputerDesktop, type DesktopRequest } from './contracts.ts'

const errorCodeSchema = z.enum(['unavailable', 'window_unavailable', 'protected_target', 'stale_observation',
      'unsupported_action', 'outcome_unknown', 'invalid_request', 'capture_failed', 'host_failure',
      'foreground_not_allowed', 'user_interrupted', 'focus_denied', 'keyboard_focus_changed', 'input_outside_window',
      'input_unavailable', 'unsupported_shortcut'])
const errorReasonSchema = z.union([errorCodeSchema, z.enum([
  'keyboard_input_detected', 'mouse_input_detected', 'foreign_input_detected',
  'input_tag_changed', 'input_cancelled', 'input_lease_expired',
])])
const responseSchema = z.union([
  z.object({ id: z.string().uuid(), result: z.unknown().refine(value => value !== undefined) }).strict(),
  z.object({ id: z.string().uuid(), error: z.object({
    code: errorCodeSchema, reason: errorReasonSchema.nullable().optional(),
  }).strict() }).strict(),
])
const messages: Record<string, string> = {
  unavailable: 'An unlocked, interactive Windows desktop is required.',
  window_unavailable: 'The selected window is no longer available. Select it again.',
  protected_target: 'Browsers, Shadow, elevated applications and protected fields are not supported.',
  stale_observation: 'The window changed or the observation expired. Observe again before acting.',
  unsupported_action: 'This control does not support the requested operation.',
  foreground_not_allowed: 'Keyboard and mouse input require an explicit foreground-input grant.',
  user_interrupted: 'Desktop input was interrupted by activity, cancellation, or an expired foreground lease. No action was replayed.',
  focus_denied: 'The approved window did not become or remain foreground. No foreground workaround was used.',
  keyboard_focus_changed: 'Keyboard focus could not be confirmed on the approved control. Observe again before continuing.',
  input_outside_window: 'Input must stay inside the shared window client area, with no other window covering the target.',
  input_unavailable: 'Windows could not establish guarded foreground input.',
  unsupported_shortcut: 'System and window-switching shortcuts are not supported.',
  keyboard_input_detected: 'Keyboard input outside this operation was detected.',
  mouse_input_detected: 'Mouse input outside this operation was detected.',
  foreign_input_detected: 'Input injected by another source was detected.',
  input_tag_changed: 'Windows or an input interceptor changed the operation input marker.',
  input_cancelled: 'The input guard was cancelled or its owner disconnected.',
  input_lease_expired: 'The foreground input lease expired.',
  outcome_unknown: 'The operation may have taken effect. It was not replayed. Inspect the application before continuing.',
  invalid_request: 'The desktop host rejected an invalid request.',
  capture_failed: 'This window could not be captured. No desktop-wide fallback was used.',
  host_failure: 'The native agent-desktop worker could not start or disconnected. Build/install the matching native addon and input guard; no legacy fallback is available.',
}

interface Pending {
  id: string
  request: DesktopRequest
  resolve(value: unknown): void
  reject(error: ComputerError): void
  cleanup(): void
}

/** Private, bounded stdio transport. The caller must supply the native worker launcher. */
export class DesktopStdioTransport implements ComputerDesktop {
  readonly available = process.platform === 'win32'
  generation = 0
  private child?: ChildProcessWithoutNullStreams
  private pending?: Pending
  private stopping?: Promise<void>
  private buffer = ''

  constructor(private readonly options: {
    timeoutMs?: number
    spawnHost: () => ChildProcessWithoutNullStreams
  }) {}

  async request(request: DesktopRequest, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    if (!this.available && !this.options.spawnHost) throw new ComputerError('unavailable', 'Computer use is available only on Windows.', 503)
    if (this.pending || this.stopping) throw new ComputerError('desktop_busy', 'Another desktop operation is in progress. No operation was queued.')
    const child = this.child ?? this.start()
    return new Promise((resolve, reject) => {
      const abort = () => this.fail('interrupted', 'Desktop operation stopped.', true)
      const timer = setTimeout(() => this.fail('host_timeout', 'The desktop host timed out. Select the window again.', true), this.options.timeoutMs ?? 15_000)
      this.pending = {
        id: randomUUID(), request, resolve, reject,
        cleanup: () => { clearTimeout(timer); signal.removeEventListener('abort', abort) },
      }
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) { abort(); return }
      child.stdin.write(JSON.stringify({ id: this.pending.id, ...request }) + '\n', error => {
        if (error && this.child === child) this.fail('host_failure', messages.host_failure, true)
      })
    })
  }

  private start(): ChildProcessWithoutNullStreams {
    const child = this.options.spawnHost()
    this.child = child
    this.buffer = ''
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (text: string) => {
      if (this.child !== child) return
      this.buffer += text
      if (this.buffer.length > 6 * 1024 * 1024) { this.fail('host_protocol', 'Desktop host response exceeded its limit.', true); return }
      let end: number
      while ((end = this.buffer.indexOf('\n')) >= 0) {
        const line = this.buffer.slice(0, end)
        this.buffer = this.buffer.slice(end + 1)
        let parsed: z.infer<typeof responseSchema>
        try { parsed = responseSchema.parse(JSON.parse(line)) }
        catch { this.fail('host_protocol', 'Invalid desktop host response. Select the window again.', true); return }
        const pending = this.pending
        if (!pending || pending.id !== parsed.id) { this.fail('host_protocol', 'Unexpected desktop host response.', true); return }
        this.pending = undefined
        pending.cleanup()
        if ('error' in parsed) pending.reject(new ComputerError(parsed.error.code,
          messages[parsed.error.code] + (parsed.error.reason ? ` ${messages[parsed.error.reason]}` : '')))
        else pending.resolve(parsed.result)
      }
    })
    // Never log compiler output or native exceptions: they may contain window data.
    child.stderr.resume()
    child.stdin.on('error', () => { if (this.child === child) this.fail('host_failure', messages.host_failure, true) })
    child.on('error', () => { if (this.child === child) this.fail('host_failure', messages.host_failure, true) })
    child.on('close', () => { if (this.child === child) this.fail('host_failure', messages.host_failure, false) })
    return child
  }

  private fail(code: string, message: string, kill: boolean): void {
    const pending = this.pending
    this.pending = undefined
    pending?.cleanup()
    if (pending?.request.method === 'act') pending.reject(new ComputerError('outcome_unknown', messages.outcome_unknown))
    else pending?.reject(new ComputerError(code, message))
    const child = this.child
    this.child = undefined
    this.buffer = ''
    this.generation++
    if (kill && child) {
      this.stopping = new Promise<void>(resolve => {
        const force = setTimeout(() => child.kill(), 2000)
        child.once('close', () => { clearTimeout(force); resolve() })
        // EOF reaches the independent input guard even while the UIA thread is blocked.
        child.stdin.end()
      }).finally(() => { this.stopping = undefined })
    }
  }

  async interrupt(): Promise<void> {
    if (this.child) this.fail('interrupted', 'Desktop access was stopped.', true)
    await this.stopping
  }
}
