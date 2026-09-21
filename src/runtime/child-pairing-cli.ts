import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { AtomicDeviceCredentialReferenceStore } from '../cluster/device-credential-reference-store.ts'
import { ProtectedEd25519DeviceCredentialProvider, resolveDeviceCredentialForConnect, validateDeviceCredentialReferenceV1, type DeviceCredentialReferenceV1 } from '../cluster/device-credentials.ts'
import { createPlatformDeviceKeyStore } from '../cluster/protected-device-key-stores.ts'
import { requestDeviceChallengeProtocol, type ChallengeFetch } from '../cluster/device-challenge-client.ts'
import { parseBootstrapConfigV1 } from './bootstrap-config.ts'
import { pairProductionChild, type ProductionChildPairingOptions } from './production-child-pairing.ts'
import { deriveRuntimePaths } from './runtime-cli.ts'

/** PIN input travels only over stdin; this command is also shipped in the backend bundle. */
export async function runChildPairingCli(
  args: readonly string[],
  input: AsyncIterable<string | Uint8Array> = process.stdin,
  write: (text: string) => void = text => { process.stdout.write(text) },
  overrides: Pick<ProductionChildPairingOptions, 'keyStore' | 'fetchPairing'> & { fetchChallenge?: ChallengeFetch } = {},
): Promise<void> {
  if (args.length !== 2 || args[0] !== '--config' || !args[1] || !isAbsolute(args[1])) {
    throw new TypeError('Use child pair --config <absolute bootstrap configuration>; pairing input is read from stdin')
  }
  const chunks: Buffer[] = []
  let bytes = 0
  for await (const chunk of input) {
    const buffer = Buffer.from(chunk)
    bytes += buffer.byteLength
    if (bytes > 4096) throw new TypeError('Pairing input is too large')
    chunks.push(buffer)
  }
  const value = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).length !== 3
    || typeof value.offerId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(value.offerId)
    || typeof value.pin !== 'string' || !/^\d{6}$/.test(value.pin)
    || typeof value.displayName !== 'string' || !value.displayName.trim() || value.displayName.length > 128) {
    throw new TypeError('Pairing input is invalid')
  }
  const config = parseBootstrapConfigV1(JSON.parse(await readFile(args[1], 'utf8')))
  if (config.mode !== 'child') throw new TypeError('Pairing requires Child configuration')
  const paths = deriveRuntimePaths(args[1], config.dataDir, { platform: process.platform === 'win32' ? 'windows' : 'posix' })
  const referenceStore = new AtomicDeviceCredentialReferenceStore(paths.childCredentialPath)
  const existing = await referenceStore.load()
  if (existing) {
    const parsed = validateDeviceCredentialReferenceV1(existing)
    if (!parsed.success || parsed.value.nodeId !== config.localNodeId) throw new TypeError('Saved Child credential does not match this node')
  } else {
    const keyStore = overrides.keyStore ?? createPlatformDeviceKeyStore(paths.dataDir)
    const provider = new ProtectedEd25519DeviceCredentialProvider(keyStore)
    const id = (index: number) => createHash('sha256').update(`${config.localNodeId}:desktop-pair:${index}`).digest('hex')
    const identity = await provider.loadOrCreateKey(`device-key-${id(0)}`, AbortSignal.timeout(10_000))
    const reference: DeviceCredentialReferenceV1 = {
      version: 1, kind: 'protected-device-credential', providerId: identity.providerId, keyId: identity.keyId,
      deviceId: id(0), nodeId: config.localNodeId, credentialId: id(2), deviceIdentityFingerprint: identity.deviceIdentityFingerprint,
    }
    const infoPath = join(dirname(paths.childCredentialPath), 'device-pairing-info.v1.json')
    let retry = false
    try {
      const info = JSON.parse(await readFile(infoPath, 'utf8'))
      retry = info.nodeId === config.localNodeId && info.fingerprint === identity.deviceIdentityFingerprint
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    await mkdir(dirname(infoPath), { recursive: true })
    const staging = `${infoPath}.${randomUUID()}.tmp`
    try {
      const file = await open(staging, 'wx', 0o600)
      try {
        await file.writeFile(JSON.stringify({ version: 1, nodeId: config.localNodeId, fingerprint: identity.deviceIdentityFingerprint }))
        await file.sync()
      } finally { await file.close() }
      await rename(staging, infoPath)
    } finally { await rm(staging, { force: true }) }
    // If Main accepted a request whose response was lost, approval can recover the
    // same reference without consuming a second offer or generating a new key.
    if (retry) {
      try {
        const signal = AbortSignal.timeout(3_000)
        const resolved = await resolveDeviceCredentialForConnect(provider, reference, { endpoint: config.mainEndpoint, localNodeId: config.localNodeId, signal })
        await requestDeviceChallengeProtocol(config.mainEndpoint, resolved.authentication, resolved.proof, overrides.fetchChallenge, signal)
        await referenceStore.save(reference)
        write('{"version":1,"state":"pending"}\n')
        return
      } catch { /* An unapproved device must still present a valid offer and PIN. */ }
    }
    // A retry reuses the protected key and identifiers even if an earlier HTTP request failed.
    let index = 0
    await pairProductionChild(config, paths, {
      ...overrides, keyStore, referenceStore, offerId: value.offerId, pin: value.pin, displayName: value.displayName.trim(),
      fetchPairing: overrides.fetchPairing ?? ((input, init) => fetch(input, { ...init, redirect: 'error' })),
      idFactory: () => id(index++),
      signal: AbortSignal.timeout(15_000),
    })
  }
  write('{"version":1,"state":"pending"}\n')
}
