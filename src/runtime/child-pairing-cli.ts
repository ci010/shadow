import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, open, readFile, rename, rm } from 'node:fs/promises'
import { dirname, isAbsolute, join } from 'node:path'
import { AtomicDeviceCredentialReferenceStore } from '../cluster/device-credential-reference-store.ts'
import { ProtectedEd25519DeviceCredentialProvider, resolveDeviceCredentialForConnect, validateDeviceCredentialReferenceV1, type DeviceCredentialReferenceV1 } from '../cluster/device-credentials.ts'
import { createPlatformDeviceKeyStore } from '../cluster/protected-device-key-stores.ts'
import { DeviceApprovalUnavailableError, requestDeviceChallengeProtocol, type ChallengeFetch } from '../cluster/device-challenge-client.ts'
import { parseBootstrapConfigV1 } from './bootstrap-config.ts'
import { pairProductionChild, type ProductionChildPairingOptions } from './production-child-pairing.ts'
import { presentPinPairing } from '../cluster/pin-pairing-client.ts'
import { deriveRuntimePaths } from './runtime-cli.ts'

/** PIN input travels only over stdin; this command is also shipped in the backend bundle. */
export async function runChildPairingCli(
  args: readonly string[],
  input: AsyncIterable<string | Uint8Array> = process.stdin,
  write: (text: string) => void = text => { process.stdout.write(text) },
  overrides: Pick<ProductionChildPairingOptions, 'keyStore' | 'fetchPairing'> & { fetchChallenge?: ChallengeFetch } = {},
): Promise<void> {
  const restore = args[2] === '--restore-identity' && args.length === 3
  if ((!restore && args.length !== 2) || args[0] !== '--config' || !args[1] || !isAbsolute(args[1])) {
    throw new TypeError('Use child pair --config <absolute bootstrap configuration>; pairing input is read from stdin')
  }
  if (restore) {
    await restoreChildIdentity(args[1], overrides.keyStore)
    write('{"version":1,"state":"identity-restored"}\n')
    return
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
    const provider = new ProtectedEd25519DeviceCredentialProvider(overrides.keyStore ?? createPlatformDeviceKeyStore(paths.dataDir))
    const signal = AbortSignal.timeout(15_000)
    const resolved = await resolveDeviceCredentialForConnect(provider, parsed.value, { endpoint: config.mainEndpoint, localNodeId: config.localNodeId, signal })
    const info = JSON.parse(await readFile(join(dirname(paths.childCredentialPath), 'device-pairing-info.v1.json'), 'utf8'))
    if (info.version !== 1 || info.nodeId !== config.localNodeId || info.fingerprint !== parsed.value.deviceIdentityFingerprint) throw new TypeError('Saved Child pairing identity does not match this node')
    try {
      await requestDeviceChallengeProtocol(config.mainEndpoint, resolved.authentication, resolved.proof, overrides.fetchChallenge, signal)
    } catch (error) {
      // Only an explicit authorization denial may fall back to a fresh invitation;
      // network/TLS/format errors must not be mistaken for revoked approval.
      if (!(error instanceof DeviceApprovalUnavailableError)) throw error
      await presentPinPairing({ endpoint: config.mainEndpoint, offerId: value.offerId, pin: value.pin,
        displayName: value.displayName.trim(), localNodeId: config.localNodeId, credentialProvider: provider,
        referenceStore, existingReference: parsed.value, idFactory: () => createHash('sha256').update(`${config.localNodeId}:desktop-pair:1`).digest('hex'), allowInsecureHttp: config.allowInsecureLocalTransport,
        fetchPairing: overrides.fetchPairing ?? ((input, init) => fetch(input, { ...init, redirect: 'error' })), signal })
    }
  } else {
    try {
      const saved = JSON.parse(await readFile(join(dirname(paths.childCredentialPath), 'device-pairing-info.v1.json'), 'utf8'))
      if (saved.version !== 1 || saved.nodeId !== config.localNodeId || typeof saved.fingerprint !== 'string') throw new TypeError('Saved Child pairing identity does not match this node')
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
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

/** Explicit local repair: never creates keys, changes Main, or discards credentials. */
export async function restoreChildIdentity(configPath: string, keyStore?: ProductionChildPairingOptions['keyStore']): Promise<void> {
  const config = parseBootstrapConfigV1(JSON.parse(await readFile(configPath, 'utf8')))
  if (config.mode !== 'child') throw new TypeError('Identity restoration requires Child configuration')
  const paths = deriveRuntimePaths(configPath, config.dataDir, { platform: process.platform === 'win32' ? 'windows' : 'posix' })
  const reference = await new AtomicDeviceCredentialReferenceStore(paths.childCredentialPath).load()
  const parsed = validateDeviceCredentialReferenceV1(reference)
  if (!parsed.success) throw new TypeError('A valid saved credential is required for identity restoration')
  const info = JSON.parse(await readFile(join(dirname(paths.childCredentialPath), 'device-pairing-info.v1.json'), 'utf8'))
  if (info.version !== 1 || info.nodeId !== parsed.value.nodeId || info.fingerprint !== parsed.value.deviceIdentityFingerprint) throw new TypeError('Saved identity metadata conflicts; no files changed')
  await resolveDeviceCredentialForConnect(new ProtectedEd25519DeviceCredentialProvider(keyStore ?? createPlatformDeviceKeyStore(paths.dataDir)), parsed.value,
    { endpoint: config.mainEndpoint, localNodeId: parsed.value.nodeId, signal: AbortSignal.timeout(10_000) })
  if (config.localNodeId === parsed.value.nodeId) return
  // Exclusive backup is retained beside the original. Only localNodeId changes.
  await copyFile(configPath, `${configPath}.${randomUUID()}.identity-backup`, 1)
  const staging = `${configPath}.${randomUUID()}.tmp`
  try {
    const file = await open(staging, 'wx', 0o600)
    try { await file.writeFile(JSON.stringify({ ...config, localNodeId: parsed.value.nodeId }) + '\n'); await file.sync() } finally { await file.close() }
    await rename(staging, configPath)
  } finally { await rm(staging, { force: true }) }
}
