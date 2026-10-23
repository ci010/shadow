import { randomUUID } from 'node:crypto'
import {
  ComputerActionResultSchema, ComputerActionSchema, ComputerError, ComputerObservationSchema,
  ComputerTargetSchema, ComputerWindowsSchema, isForegroundAction, isPointerAction,
  type ComputerAction, type ComputerDesktop, type ComputerObservation, type ComputerTarget,
} from '../execution/computer/contracts.ts'
import {
  ComputerOwnerSchema, type ComputerApproval, type ComputerOwner, type ComputerReceipt, type ComputerStatus,
} from './contracts.ts'

const GRANT_MS = 10 * 60_000
const REVIEW_MS = 60_000
interface Grant {
  owner: ComputerOwner
  target: ComputerTarget
  generation: number
  expiresAt: number
  controller: AbortController
  timer: ReturnType<typeof setTimeout>
  observation?: { value: ComputerObservation; at: number; frame?: ComputerObservation['screenshot']; timer?: ReturnType<typeof setTimeout> }
}
interface Pending {
  approval: ComputerApproval
  frame?: ComputerObservation['screenshot']
  settle(approved: boolean): void
  reject(error: ComputerError): void
  cleanup(): void
}
const sameOwner = (left: ComputerOwner, right: ComputerOwner) =>
  left.projectId === right.projectId && left.sessionId === right.sessionId

/** A desktop is a host resource, not a Project workdir. V1 leases one window at a time. */
export class ComputerService {
  private grant?: Grant
  private binding?: ComputerOwner
  private listing?: { owner: ComputerOwner; ids: Set<string>; generation: number; timer: ReturnType<typeof setTimeout> }
  private pending?: Pending
  private executing = false
  private operation = false
  private stopped = false
  private revision = 0
  private last?: { owner: ComputerOwner; receipt: ComputerReceipt }

  constructor(private readonly desktop: ComputerDesktop, private readonly options: {
    enabled?: boolean
    now?: () => number
    grantMs?: number
    reviewMs?: number
  } = {}) {}

  private now(): number { return this.options.now?.() ?? Date.now() }
  private get available(): boolean { return !this.stopped && this.options.enabled !== false && this.desktop.available }

  status(owner: ComputerOwner): ComputerStatus {
    ComputerOwnerSchema.parse(owner)
    this.expire()
    const grant = this.grant && sameOwner(this.grant.owner, owner) ? this.grant : undefined
    return {
      ...owner, available: this.available,
      busy: !!(this.binding || this.grant && !grant),
      grant: grant ? { target: structuredClone(grant.target), expiresAt: new Date(grant.expiresAt).toISOString() } : null,
      pending: grant && this.pending ? structuredClone(this.pending.approval) : null,
      executing: !!grant && this.executing,
      lastAction: this.last && sameOwner(this.last.owner, owner) ? { ...this.last.receipt } : null,
    }
  }

  private assertAvailable(owner: ComputerOwner): void {
    ComputerOwnerSchema.parse(owner)
    this.expire()
    if (!this.available) throw new ComputerError('unavailable', 'Computer use requires Windows and an enabled Main local executor.', 503)
    if (this.binding || this.grant && !sameOwner(this.grant.owner, owner)) {
      throw new ComputerError('desktop_busy', 'Another conversation owns desktop access. Stop it before sharing a window here.')
    }
  }

  async windows(owner: ComputerOwner, signal: AbortSignal) {
    this.assertAvailable(owner)
    if (this.operation) throw new ComputerError('desktop_busy', 'The previous desktop operation is still stopping.')
    if (this.grant) throw new ComputerError('already_shared', 'Stop the current window before selecting another.')
    this.binding = { ...owner }
    this.clearListing()
    const revision = this.revision
    const generation = this.desktop.generation
    try {
      const result = ComputerWindowsSchema.parse(await this.desktop.request({ method: 'list' }, signal))
      signal.throwIfAborted()
      if (revision !== this.revision || generation !== this.desktop.generation || this.stopped) {
        throw new ComputerError('interrupted', 'Window discovery was interrupted. Refresh the window list.')
      }
      const timer = setTimeout(() => {
        if (this.listing?.timer === timer) {
          void this.release(owner).catch(() => console.error('[computer] Could not stop the unused desktop host.'))
        }
      }, 30_000)
      timer.unref()
      this.listing = { owner: { ...owner }, ids: new Set(result.windows.map(window => window.id)), generation, timer }
      return result
    } catch (error) {
      await this.desktop.interrupt()
      throw error
    } finally { this.binding = undefined }
  }

  /** Acquire a listed target. Foreground mutations require exact owner review; supported UIA actions run directly. */
  async share(owner: ComputerOwner, windowId: string, signal: AbortSignal): Promise<ComputerStatus> {
    this.assertAvailable(owner)
    if (this.operation) throw new ComputerError('desktop_busy', 'The previous desktop operation is still stopping.')
    if (this.grant) throw new ComputerError('already_shared', 'Stop the current window before selecting another.')
    if (!this.listing || !sameOwner(this.listing.owner, owner) || !this.listing.ids.has(windowId)
      || this.listing.generation !== this.desktop.generation) {
      throw new ComputerError('window_unavailable', 'Refresh the window list and select a current window.')
    }
    this.binding = { ...owner }
    this.clearListing()
    const revision = this.revision
    const generation = this.desktop.generation
    try {
      const target = ComputerTargetSchema.parse(await this.desktop.request({ method: 'bind', windowId }, signal))
      signal.throwIfAborted()
      if (revision !== this.revision || generation !== this.desktop.generation || this.stopped) {
        throw new ComputerError('interrupted', 'Window sharing was interrupted.')
      }
      const expiresAt = this.now() + (this.options.grantMs ?? GRANT_MS)
      const timer = setTimeout(() => {
        void this.release(owner).catch(() => console.error('[computer] Could not stop the desktop host after grant expiry.'))
      }, this.options.grantMs ?? GRANT_MS)
      timer.unref()
      this.grant = { owner: { ...owner }, target, expiresAt, generation, timer, controller: new AbortController() }
      this.last = undefined
    } catch (error) {
      await this.desktop.interrupt()
      throw error
    } finally { this.binding = undefined }
    return this.status(owner)
  }

  private requireGrant(owner: ComputerOwner, targetId: string): Grant {
    this.assertAvailable(owner)
    const grant = this.grant
    if (!grant || !sameOwner(grant.owner, owner) || grant.target.id !== targetId) {
      throw new ComputerError('not_shared', 'List supported windows with computer_setup action:windows, then select a task-relevant windowId.', 403)
    }
    return grant
  }

  async observe(owner: ComputerOwner, targetId: string, screenshot: boolean, signal: AbortSignal): Promise<ComputerObservation> {
    const grant = this.requireGrant(owner, targetId)
    if (this.operation) throw new ComputerError('action_pending', 'Finish or reject the pending action before observing again.')
    const result = ComputerObservationSchema.parse(await this.desktop.request(
      { method: 'observe', targetId, screenshot }, AbortSignal.any([signal, grant.controller.signal]),
    ))
    signal.throwIfAborted()
    if (this.requireGrant(owner, targetId) !== grant || result.targetId !== targetId) {
      throw new ComputerError('stale_observation', 'The shared window changed. Observe again.')
    }
    this.retainObservation(grant, result)
    return result
  }

  private retainObservation(grant: Grant, observation: ComputerObservation): void {
    this.clearObservation(grant)
    const { screenshot, ...tree } = observation
    grant.target = { ...grant.target, title: tree.title, bounds: tree.bounds }
    const observed: NonNullable<Grant['observation']> = {
      value: tree, at: this.now(), ...(screenshot ? { frame: screenshot } : {}),
    }
    if (observed.frame) {
      observed.timer = setTimeout(() => { observed.frame = undefined }, 120_000)
      observed.timer.unref()
    }
    grant.observation = observed
  }

  private clearObservation(grant: Grant): void {
    if (grant.observation?.timer) clearTimeout(grant.observation.timer)
    grant.observation = undefined
  }

  async act(owner: ComputerOwner, input: { targetId: string; observationId: string; action: ComputerAction }, signal: AbortSignal) {
    const action = ComputerActionSchema.parse(input.action)
    input = { ...input, action }
    const grant = this.requireGrant(owner, input.targetId)
    signal.throwIfAborted()
    if (this.operation) throw new ComputerError('action_pending', 'Another action is already awaiting review or executing.')
    const observed = grant.observation
    if (!observed || observed.value.id !== input.observationId || this.now() - observed.at >= 120_000) {
      throw new ComputerError('stale_observation', 'Observe the window again before requesting an action.')
    }
    const element = 'elementId' in action ? observed.value.elements.find(element => element.id === action.elementId) : undefined
    if (isPointerAction(action)) {
      const frame = observed.frame
      if (!frame) throw new ComputerError('screenshot_required', 'Observe again with screenshot:true before requesting a coordinate action.')
      const points = action.kind === 'drag' ? [[action.x, action.y], [action.toX, action.toY]] : [[action.x, action.y]]
      if (points.some(([x, y]) => x >= frame.width || y >= frame.height)) {
        throw new ComputerError('invalid_coordinates', 'Coordinates must be inside the observed screenshot, not screen or desktop coordinates.', 400)
      }
    } else if (!element || element.protected || !element.enabled || element.offscreen
      || (isForegroundAction(action) ? !element.focusable
        || action.kind === 'type_text' && !['ControlType.Edit', 'ControlType.Document'].includes(element.role)
        : !element.actions.includes(action.kind))) {
      throw new ComputerError('unsupported_action', 'The observed control does not support this operation.')
    }
    const approval: ComputerApproval = {
      id: randomUUID(), targetId: input.targetId, observationId: input.observationId, action,
      expiresAt: new Date(Math.min(grant.expiresAt, this.now() + (this.options.reviewMs ?? REVIEW_MS))).toISOString(),
      element: element ? { name: element.name, role: element.role } : null,
      ...(isPointerAction(action) && observed.frame ? { frame: { width: observed.frame.width, height: observed.frame.height } } : {}),
    }
    this.operation = true
    this.clearObservation(grant)
    const combined = AbortSignal.any([signal, grant.controller.signal])
    let dispatched = false
    try {
      const approved = !isForegroundAction(action) || await this.review(approval, combined, isPointerAction(action) ? observed.frame : undefined)
      observed.frame = undefined
      if (!approved) {
        const receipt: ComputerReceipt = { actionId: approval.id, kind: action.kind, outcome: 'denied', verified: false }
        this.last = { owner: { ...owner }, receipt }
        return receipt
      }
      combined.throwIfAborted()
      if (this.requireGrant(owner, input.targetId) !== grant) throw new ComputerError('interrupted', 'Window sharing changed.')
      this.executing = true
      dispatched = true
      const result = ComputerActionResultSchema.parse(await this.desktop.request({
        method: 'act', ...input, action, actionId: approval.id,
      }, combined))
      if (result.actionId !== approval.id || result.observation.targetId !== input.targetId) {
        throw new ComputerError('outcome_unknown', 'The desktop returned an inconsistent action receipt. Inspect the application.')
      }
      combined.throwIfAborted()
      this.requireGrant(owner, input.targetId)
      this.retainObservation(grant, result.observation)
      const receipt: ComputerReceipt = { actionId: approval.id, kind: action.kind, outcome: 'executed', verified: result.verified,
        ...(result.focusRestored !== undefined ? { focusRestored: result.focusRestored } : {}) }
      this.last = { owner: { ...owner }, receipt }
      return { ...receipt, observation: result.observation }
    } catch (error) {
      const unknown = dispatched && (!(error instanceof ComputerError) || error.code === 'outcome_unknown' || combined.aborted)
      this.last = { owner: { ...owner }, receipt: {
        actionId: approval.id, kind: action.kind, outcome: unknown ? 'outcome_unknown' : combined.aborted ? 'cancelled' : 'failed', verified: false,
      } }
      if (unknown || combined.aborted || error instanceof ComputerError && error.code === 'user_interrupted') await this.release(owner)
      if (unknown) throw new ComputerError('outcome_unknown', 'The action may have taken effect. It was not replayed. Window access was revoked; inspect the application before sharing it again.')
      throw error
    } finally {
      observed.frame = undefined
      this.pending?.cleanup()
      this.pending = undefined
      this.executing = false
      this.operation = false
    }
  }

  private review(approval: ComputerApproval, signal: AbortSignal, frame?: ComputerObservation['screenshot']): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        pending.cleanup()
        if (this.pending === pending) this.pending = undefined
        reject(new ComputerError('interrupted', 'The action review was interrupted. No approval was retained.'))
      }
      const timer = setTimeout(() => {
        pending.cleanup()
        if (this.pending === pending) this.pending = undefined
        reject(new ComputerError('review_expired', 'The action review expired. No action ran.'))
      }, Math.max(0, Date.parse(approval.expiresAt) - this.now()))
      timer.unref()
      const pending: Pending = {
        approval, frame, settle: resolve, reject,
        cleanup: () => { pending.frame = undefined; clearTimeout(timer); signal.removeEventListener('abort', abort) },
      }
      this.pending = pending
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  }

  reviewFrame(owner: ComputerOwner, requestId: string): Buffer {
    const pending = this.pending
    if (!pending) throw new ComputerError('stale_request', 'This review is no longer available.', 404)
    this.requireGrant(owner, pending.approval.targetId)
    if (pending !== this.pending || pending.approval.id !== requestId || !pending.frame
      || Date.parse(pending.approval.expiresAt) <= this.now()) {
      throw new ComputerError('stale_request', 'This review frame expired or changed.', 404)
    }
    return Buffer.from(pending.frame.base64, 'base64')
  }

  decide(owner: ComputerOwner, requestId: string, approved: boolean): void {
    const pending = this.pending
    if (!pending) throw new ComputerError('stale_request', 'This action is no longer awaiting approval.')
    this.requireGrant(owner, pending.approval.targetId)
    if (pending !== this.pending || pending.approval.id !== requestId || Date.parse(pending.approval.expiresAt) <= this.now()) {
      throw new ComputerError('stale_request', 'This exact action review expired or changed.')
    }
    pending.cleanup()
    this.pending = undefined
    pending.settle(approved)
  }

  private clear(): void {
    this.revision++
    const grant = this.grant
    this.grant = undefined
    this.clearListing()
    if (grant) {
      clearTimeout(grant.timer)
      this.clearObservation(grant)
      grant.controller.abort()
    }

    if (this.pending) {
      this.pending.cleanup()
      this.pending.reject(new ComputerError('interrupted', 'Desktop access was revoked.'))
      this.pending = undefined
    }
  }

  private clearListing(): void {
    if (this.listing) clearTimeout(this.listing.timer)
    this.listing = undefined
  }

  private expire(): void {
    if (this.grant && (this.grant.generation !== this.desktop.generation || this.grant.expiresAt <= this.now())) {
      this.clear()
      void this.desktop.interrupt().catch(() => console.error('[computer] Could not stop the expired desktop host.'))
    }
  }

  async release(owner: ComputerOwner): Promise<void> {
    ComputerOwnerSchema.parse(owner)
    if (!(this.grant && sameOwner(this.grant.owner, owner)) && !(this.binding && sameOwner(this.binding, owner))
      && !(this.listing && sameOwner(this.listing.owner, owner))) return
    this.clear()
    await this.desktop.interrupt()
  }

  async stopProject(projectId: string): Promise<void> {
    const owner = this.grant?.owner ?? this.binding ?? this.listing?.owner
    if (owner?.projectId === projectId) await this.release(owner)
  }

  async close(): Promise<void> {
    this.stopped = true
    await this.stopAll()
  }

  async stopAll(): Promise<void> {
    this.clear()
    await this.desktop.interrupt()
  }
}
