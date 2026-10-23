import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { setTimeout as delay } from 'node:timers/promises'
import { z } from 'zod'
import {
  ComputerActionSchema, ComputerActionResultSchema, ComputerError, ComputerObservationSchema, isForegroundAction,
  ComputerTargetSchema, ComputerWindowsSchema, type ComputerDesktop, type DesktopRequest,
} from './contracts.ts'
import { DesktopStdioTransport } from './stdio-transport.ts'

const uuid = z.string().uuid()
export const AgentDesktopRequestSchema = z.discriminatedUnion('method', [
  z.object({ method: z.literal('list'), processId: z.number().int().positive().optional() }).strict(),
  z.object({ method: z.literal('bind'), windowId: uuid }).strict(),
  z.object({ method: z.literal('observe'), targetId: uuid, screenshot: z.boolean() }).strict(),
  z.object({ method: z.literal('act'), targetId: uuid, observationId: uuid, actionId: uuid, action: ComputerActionSchema }).strict(),
  z.object({ method: z.literal('release'), targetId: uuid }).strict(),
])

/** The native desktop backend. Authorization and immutable
 * foreground per-action approval remain in ComputerService; native checks are additional. */
export class AgentDesktopComputerDesktop implements ComputerDesktop {
  readonly available = process.platform === 'win32' && ['x64', 'arm64'].includes(process.arch)
  private readonly transport: DesktopStdioTransport
  private inFlight = false
  private guardRisk = false
  private retiring?: Promise<void>
  get generation(): number { return this.transport.generation }

  constructor(options: { timeoutMs?: number; spawnWorker?: () => ChildProcessWithoutNullStreams } = {}) {
    this.transport = new DesktopStdioTransport({
      timeoutMs: options.timeoutMs,
      spawnHost: options.spawnWorker ?? (() => spawn(process.execPath,
        [fileURLToPath(new URL('./agent-desktop-worker.js', import.meta.url))], {
          stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
          env: { ...process.env, NODE_OPTIONS: '', ELECTRON_RUN_AS_NODE: '1' },
        })),
    })
  }

  async request(request: DesktopRequest, signal: AbortSignal): Promise<unknown> {
    signal.throwIfAborted()
    const parsed = AgentDesktopRequestSchema.safeParse(request)
    if (!parsed.success) throw new ComputerError('invalid_request', 'Invalid native desktop request.', 400)
    if (this.inFlight || this.retiring) throw new ComputerError('desktop_busy', 'Another desktop operation is in progress or stopping. No operation was queued.')
    this.inFlight = true
    const physical = request.method === 'act' && isForegroundAction(request.action)
    if (physical) this.guardRisk = true
    try {
      const value = await this.transport.request(parsed.data, signal)
      const schema = request.method === 'list' ? ComputerWindowsSchema
        : request.method === 'bind' ? ComputerTargetSchema
        : request.method === 'observe' ? ComputerObservationSchema
        : request.method === 'act' ? ComputerActionResultSchema
        : z.object({ released: z.literal(true) }).strict()
      const result = schema.safeParse(value)
      const observation = result.data as { targetId?: string; screenshot?: unknown }
      const action = result.data as { actionId?: string; focusRestored?: unknown; observation?: { id?: string; targetId?: string } }
      if (!result.success || request.method === 'observe' && (
        observation.targetId !== request.targetId || request.screenshot && !observation.screenshot
      ) || request.method === 'act' && (
        action.actionId !== request.actionId || action.observation?.targetId !== request.targetId
        || action.observation?.id === request.observationId || physical && action.focusRestored === undefined
      )) {
        await this.interrupt()
        if (request.method === 'act') throw new ComputerError('outcome_unknown', 'The action may have taken effect. No replay was attempted. Inspect the application before selecting it again.')
        throw new ComputerError('host_protocol', 'The native desktop response violated its contract. Select the window again.')
      }
      if (physical) this.guardRisk = false // acknowledged guard disposal and fresh post-observation
      return result.data
    } catch (error) {
      if (error instanceof ComputerError && ['outcome_unknown', 'host_failure', 'input_unavailable', 'user_interrupted'].includes(error.code)) await this.interrupt()
      else if (physical) this.guardRisk = false // native pre-dispatch refusal; ambiguous failures use outcome_unknown
      if (error instanceof ComputerError && error.code === 'host_failure') {
        throw new ComputerError('host_failure', 'The isolated agent-desktop addon is missing, incompatible, or unavailable. Build/install the matching native artifact; no PowerShell fallback was attempted.', 503)
      }
      throw error
    } finally { this.inFlight = false }
  }

  interrupt(): Promise<void> {
    if (!this.retiring) {
      const drainGuard = this.guardRisk
      this.retiring = (async () => {
        await this.transport.interrupt()
        // An abnormal Node exit can precede its guard's owner-death watcher.
        // Keep this adapter busy until the 1500ms cleanup window has elapsed.
        if (drainGuard) await delay(1600)
      })().finally(() => { this.guardRisk = false; this.retiring = undefined })
    }
    return this.retiring
  }
}
