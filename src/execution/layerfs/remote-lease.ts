import { ToolNoEffectError } from '../../tools/tool.ts'
import type { RemoteLayerFSCall } from './remote-contract.ts'
export interface LayerFSContextBinding { projectId: string; runtimeId: string; sourceRoot: string; sourcePath?: string; installationFingerprint: string }
export interface LayerFSContextLease { assert(): void; signal: AbortSignal; expiresAt: string; revoke(): void }
export type LayerFSContextLeaseFactory = (binding: Readonly<LayerFSContextBinding>) => LayerFSContextLease
/** A bounded target-owned launcher capability, separate from the one-dispatch sidecar.
 * The owning connection epoch changes on disconnect/re-pair; reconnect cannot resurrect it. */
export function remoteLayerFSLeaseFactory(call: RemoteLayerFSCall, current: () => { online: boolean; epoch: number | string; pairingId: string }, now: () => number = Date.now, lifetimeMs = 300000): LayerFSContextLeaseFactory {
  const connection = current()
  if (call.action !== 'runtime_context' || !connection.online || connection.pairingId !== call.authority.pairingId || lifetimeMs <= 0 || lifetimeMs > 300000) throw new ToolNoEffectError('Remote launcher lease admission refused')
  return binding => {
    if (binding.projectId !== call.authority.projectScope || binding.runtimeId !== call.input.runtimeId || !binding.installationFingerprint || (call.input.sourceName === undefined) !== (binding.sourcePath === undefined)) throw new ToolNoEffectError('Remote launcher lease binding mismatch')
    const frozen = Object.freeze({ ...binding })
    const expires = now() + lifetimeMs
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(new Error('Remote launcher lease expired')), lifetimeMs)
    timer.unref()
    const revoke = () => { clearTimeout(timer); controller.abort(new Error('Remote launcher lease revoked')) }
    return { signal: controller.signal, expiresAt: new Date(expires).toISOString(), revoke,
      assert() {
        const live = current()
        if (controller.signal.aborted || now() >= expires || !live.online || live.epoch !== connection.epoch || live.pairingId !== connection.pairingId || frozen.projectId !== call.authority.projectScope) {
          revoke(); throw new ToolNoEffectError('Remote launcher lease expired, revoked or connection changed; obtain a new target runtime_context')
        }
      },
    }
  }
}
