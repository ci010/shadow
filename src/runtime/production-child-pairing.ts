import { AtomicDeviceCredentialReferenceStore } from '../cluster/device-credential-reference-store.ts'
import type { DeviceCredentialReferenceStore } from '../cluster/device-credential-reference-store.ts'
import {
  ProtectedEd25519DeviceCredentialProvider,
  type ProtectedDeviceKeyStore,
} from '../cluster/device-credentials.ts'
import {
  presentPinPairing,
  type PairingFetch,
  type PinPairingClientResult,
} from '../cluster/pin-pairing-client.ts'
import { createPlatformDeviceKeyStore } from '../cluster/protected-device-key-stores.ts'
import type { ChildBootstrapConfigV1 } from './bootstrap-config.ts'
import type { RuntimeDerivedPaths } from './runtime-cli.ts'

export interface ProductionChildPairingOptions {
  readonly offerId: string
  readonly pin: string
  readonly displayName: string
  readonly keyStore?: ProtectedDeviceKeyStore
  readonly referenceStore?: DeviceCredentialReferenceStore
  readonly fetchPairing?: PairingFetch
  readonly idFactory?: () => string
  readonly signal?: AbortSignal
}

export async function pairProductionChild(
  config: ChildBootstrapConfigV1,
  paths: RuntimeDerivedPaths,
  options: ProductionChildPairingOptions,
): Promise<PinPairingClientResult> {
  const referenceStore = options.referenceStore ??
    new AtomicDeviceCredentialReferenceStore(paths.childCredentialPath)
  if (await referenceStore.load() !== null) {
    throw new Error('Child already has a credential reference')
  }
  const keyStore = options.keyStore ?? createPlatformDeviceKeyStore(paths.dataDir)
  return await presentPinPairing({
    endpoint: config.mainEndpoint,
    offerId: options.offerId,
    pin: options.pin,
    localNodeId: config.localNodeId,
    displayName: options.displayName,
    credentialProvider: new ProtectedEd25519DeviceCredentialProvider(keyStore),
    referenceStore,
    fetchPairing: options.fetchPairing,
    idFactory: options.idFactory,
    allowInsecureHttp: config.allowInsecureLocalTransport,
    signal: options.signal,
  })
}