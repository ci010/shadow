import { z } from 'zod'
import { managedProjectScope } from '../managed-workdir.ts'
import type { RemoteLayerFSTarget } from './remote-client.ts'
import type { ProjectCatalog } from '../../projects/catalog.ts'
import { ToolNoEffectError } from '../../tools/tool.ts'
const prefix = 'layerfs-bootstrap-reservation-v1:'
const reference = z.object({ sessionId: z.string().min(1), physicalId: z.string().min(1), requestId: z.string().min(1) }).strict()
const targetFields = { nodeId: z.string().min(1), pairingId: z.string().min(1), projectScope: z.string().regex(/^[a-f0-9]{32}$/) }
const reservation = z.object({ ...targetFields, requestId: z.string().uuid(), approval: reference, targetJobId: z.string().regex(/^layerfs-target:[a-f0-9-]{36}$/).optional() }).strict()
export const remoteBootstrapTerminalProof = z.object({ ...targetFields, targetJobId: z.string().regex(/^layerfs-target:[a-f0-9-]{36}$/), approval: reference, phase: z.string(), active: z.boolean(), provisioningStarted: z.boolean().optional(), launcherExited: z.boolean().optional(), diagnosticReason: z.string().optional(), step: z.string().optional(), code: z.string().optional(), journal: z.string().optional(), terminal: z.boolean(), reason: z.string(), noReplay: z.literal(true) }).strict()
export type RemoteBootstrapTerminalProof = z.infer<typeof remoteBootstrapTerminalProof>
export function isTerminalBootstrapEvidence(proof: Pick<RemoteBootstrapTerminalProof, 'phase' | 'active' | 'provisioningStarted' | 'launcherExited' | 'diagnosticReason'>): boolean {
  const ended = proof.launcherExited === true || proof.diagnosticReason === 'spawn_error'
  return !proof.active && (proof.phase === 'ready' || proof.phase === 'blocked' && ended || ['probe_failed', 'recovered'].includes(proof.phase) && proof.provisioningStarted === false && ended)
}
type Reservation = z.infer<typeof reservation>
const encode = (value: Reservation) => prefix + Buffer.from(JSON.stringify(value)).toString('base64url')
const sameTarget = (a: RemoteLayerFSTarget, b: RemoteLayerFSTarget) => a.nodeId === b.nodeId && a.pairingId === b.pairingId && a.projectScope === b.projectScope
const sameApproval = (a: Reservation['approval'], b: Reservation['approval']) => a.sessionId === b.sessionId && a.physicalId === b.physicalId && a.requestId === b.requestId
/** Existing Project pending-remote-job guard, not a second background/task store.
 * Entries are durable before dispatch; target journals alone provide release evidence. */
export class RemoteLayerFSJobReservations {
  constructor(private readonly projectId: string, private readonly catalog: Pick<ProjectCatalog, 'remoteJobIds' | 'recordRemoteJob'>, private readonly settleRequest?: (requestId: string) => void) {}
  private entries(): Array<{ key: string; value: Reservation }> {
    return this.catalog.remoteJobIds(this.projectId).filter(key => key.startsWith(prefix)).map(key => {
      const value = reservation.parse(JSON.parse(Buffer.from(key.slice(prefix.length), 'base64url').toString()))
      if (value.projectScope !== managedProjectScope(this.projectId)) throw new Error('Foreign Project LayerFS job reservation retained')
      return { key, value }
    })
  }
  list() { return this.entries().map(({ value }) => ({ ...value, recovery: value.targetJobId ? 'Select this exact target and call layerfs_bootstrap_reconcile with targetJobId. Cancellation/disconnect alone cannot release.' : 'Call layerfs_reconcile with requestId to inspect target admission; layerfs_bootstrap_status reveals targetJobId. Match its canonical approval before explicit terminal reconciliation.' })) }
  reserve(target: RemoteLayerFSTarget, requestId: string, approval: unknown): void {
    if (target.projectScope !== managedProjectScope(this.projectId)) throw new ToolNoEffectError('LayerFS job Project mismatch')
    const value = reservation.parse({ ...target, requestId, approval })
    this.catalog.recordRemoteJob(this.projectId, encode(value), true)
  }
  refused(target: RemoteLayerFSTarget, requestId: string): void {
    for (const entry of this.entries().filter(entry => sameTarget(entry.value, target) && entry.value.requestId === requestId)) {
      if (entry.value.targetJobId) throw new ToolNoEffectError('An admitted target job cannot be released by a request refusal')
      this.catalog.recordRemoteJob(this.projectId, entry.key, false)
    }
    this.settleRequest?.(requestId)
  }
  admitted(target: RemoteLayerFSTarget, requestId: string, targetJobId: string): void {
    const existing = this.entries().filter(entry => sameTarget(entry.value, target) && entry.value.requestId === requestId)
    if (!existing.length) throw new ToolNoEffectError('No matching Main-owned target bootstrap reservation; retained for inspection')
    const next = reservation.parse({ ...existing[0]!.value, targetJobId })
    for (const entry of existing) if (entry.value.targetJobId && entry.value.targetJobId !== targetJobId) throw new ToolNoEffectError('Target bootstrap job identity changed')
    const key = encode(next)
    this.catalog.recordRemoteJob(this.projectId, key, true) // persist replacement before removing original
    for (const entry of existing) if (entry.key !== key) this.catalog.recordRemoteJob(this.projectId, entry.key, false)
    this.settleRequest?.(requestId) // only dispatch settled; target job guard remains
  }
  release(target: RemoteLayerFSTarget, input: unknown): { released: number; proof: RemoteBootstrapTerminalProof } {
    const proof = remoteBootstrapTerminalProof.parse(input)
    if (!sameTarget(target, proof) || target.projectScope !== managedProjectScope(this.projectId)) throw new ToolNoEffectError('Target bootstrap reconciliation Project/pairing mismatch')
    if (proof.terminal !== isTerminalBootstrapEvidence(proof)) throw new ToolNoEffectError('Inconsistent target terminal evidence; reservation retained')
    if (!proof.terminal) return { released: 0, proof }
    const matches = this.entries().filter(entry => sameTarget(entry.value, target) && sameApproval(entry.value.approval, proof.approval) && (!entry.value.targetJobId || entry.value.targetJobId === proof.targetJobId))
    for (const entry of matches) { this.catalog.recordRemoteJob(this.projectId, entry.key, false); this.settleRequest?.(entry.value.requestId) }
    return { released: matches.length, proof }
  }
}
