import { childTransportError } from './pairing-transport.js'
import { spawn, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { access, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises'
import { homedir, hostname } from 'node:os'
import { dirname, join, parse, relative, sep } from 'node:path'
import { isMissingRuntimeConfig, normalizeMainDirectoryPath } from './runtime-config.js'
import { resolveRuntimePaths, type RuntimePathsInput } from '../sidecar/runtime-host.js'

export interface ChildPairInput {
  readonly endpoint: string
  readonly offerId: string
  readonly pin: string
  readonly displayName: string
  readonly dataDir: string
  readonly workdir: string
  readonly allowInsecureLocalTransport: boolean
  readonly executionConsent: true
}
export interface ChildConfig {
  readonly version: 1
  readonly mode: 'child'
  readonly localNodeId: string
  readonly dataDir: string
  readonly mainEndpoint: string
  readonly allowInsecureLocalTransport: boolean
  readonly workdirs: readonly [{ readonly workdirId: 'desktop-workdir'; readonly rootPath: string; readonly displayName: string }]
}
export interface ChildSetupInfo {
  readonly dataDir: string
  readonly workdir: string
  readonly displayName: string
  readonly endpoint: string
  readonly allowInsecureLocalTransport: boolean
  readonly saved: boolean
  readonly fingerprint?: string
  readonly identityIssue?: 'identity-conflict' | 'identity-unreadable'
}
export interface ChildBootstrap {
  info(): Promise<ChildSetupInfo>
  readConfig(): Promise<ChildConfig>
  pair(input: ChildPairInput): Promise<void>
}

export function parseChildPairInput(value: unknown): ChildPairInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('Child pairing options are invalid')
  const v = value as Record<string, unknown>
  const fields = ['endpoint', 'offerId', 'pin', 'displayName', 'dataDir', 'workdir', 'allowInsecureLocalTransport', 'executionConsent']
  if (Object.keys(v).length !== fields.length || Object.keys(v).some(key => !fields.includes(key))
    || typeof v.endpoint !== 'string' || v.endpoint.length > 2048
    || typeof v.offerId !== 'string' || !/^[A-Za-z0-9._:-]{1,128}$/.test(v.offerId)
    || typeof v.pin !== 'string' || !/^\d{6}$/.test(v.pin)
    || typeof v.displayName !== 'string' || !v.displayName.trim() || v.displayName.length > 128 || /[\u0000-\u001f]/u.test(v.displayName)
    || typeof v.allowInsecureLocalTransport !== 'boolean' || v.executionConsent !== true) {
    throw new TypeError('Provide an endpoint, offer ID, six-digit PIN, device name and explicit execution consent')
  }
  const transportError = childTransportError(v.endpoint, v.allowInsecureLocalTransport)
  if (transportError) throw new TypeError(transportError)
  const endpoint = new URL(v.endpoint)
  if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.search || endpoint.hash
    || (endpoint.protocol === 'http:' && !v.allowInsecureLocalTransport)) {
    throw new TypeError('Use HTTPS, or explicitly consent to trusted LAN/VPN HTTP testing')
  }
  const dataDir = normalizeMainDirectoryPath(v.dataDir)
  const workdir = normalizeMainDirectoryPath(v.workdir)
  if (dataDir === parse(dataDir).root || workdir === parse(workdir).root || overlaps(dataDir, workdir)) {
    throw new TypeError('Child home and work folder must be separate, non-overlapping folders, not drive roots')
  }
  return {
    endpoint: endpoint.href.replace(/\/+$/, ''), offerId: v.offerId, pin: v.pin,
    displayName: v.displayName.trim(), dataDir, workdir,
    allowInsecureLocalTransport: v.allowInsecureLocalTransport, executionConsent: true,
  }
}

function overlaps(a: string, b: string): boolean {
  const contains = (parent: string, child: string) => {
    const path = relative(parent, child)
    return path === '' || (path !== '..' && !path.startsWith(`..${sep}`) && !parse(path).root)
  }
  return contains(a, b) || contains(b, a)
}

// Inspect public identity metadata only; never return credential contents across IPC.
async function inspectChildIdentity(dataDir: string, nodeId?: string): Promise<Pick<ChildSetupInfo, 'fingerprint' | 'identityIssue'>> {
  let fingerprint: string | undefined
  let credentialFingerprint: string | undefined
  for (const name of ['device-pairing-info.v1.json', 'device-credential.v1.json']) {
    try {
      const value: unknown = JSON.parse(await readFile(join(dataDir, 'credentials', name), 'utf8'))
      if (!value || typeof value !== 'object' || Array.isArray(value)) return { identityIssue: 'identity-unreadable' }
      const info = value as Record<string, unknown>
      if (info.version !== 1 || typeof info.nodeId !== 'string' || !info.nodeId) return { identityIssue: 'identity-unreadable' }
      if (!nodeId || info.nodeId !== nodeId) return { identityIssue: 'identity-conflict' }
      const publicFingerprint = name === 'device-pairing-info.v1.json' ? info.fingerprint : info.deviceIdentityFingerprint
      if (typeof publicFingerprint !== 'string' || !publicFingerprint) return { identityIssue: 'identity-unreadable' }
      if (name === 'device-pairing-info.v1.json') fingerprint = publicFingerprint
      else credentialFingerprint = publicFingerprint
    } catch (error) {
      if (!isMissingRuntimeConfig(error)) return { identityIssue: 'identity-unreadable' }
    }
  }
  if (fingerprint && credentialFingerprint && fingerprint !== credentialFingerprint) return { identityIssue: 'identity-conflict' }
  return fingerprint ? { fingerprint } : {}
}

export class FileChildBootstrap implements ChildBootstrap {
  constructor(
    readonly configPath: string,
    readonly runPairing: (input: Pick<ChildPairInput, 'offerId' | 'pin' | 'displayName'>) => Promise<void>,
    readonly defaultHome = join(homedir(), '.shadow-child'),
    readonly defaultWorkdir = join(homedir(), 'Shadow-work'),
    readonly validateFolders?: (paths: readonly string[]) => Promise<void>,
  ) {}

  async info(): Promise<ChildSetupInfo> {
    try {
      const config = await this.readConfig()
      const identity = await inspectChildIdentity(config.dataDir, config.localNodeId)
      return { dataDir: config.dataDir, workdir: config.workdirs[0].rootPath, displayName: hostname(),
        endpoint: config.mainEndpoint, allowInsecureLocalTransport: config.allowInsecureLocalTransport, saved: true,
        ...identity }
    } catch (error) {
      if (!isMissingRuntimeConfig(error)) throw error
      return { dataDir: this.defaultHome, workdir: this.defaultWorkdir, displayName: hostname(),
        endpoint: '', allowInsecureLocalTransport: false, saved: false,
        ...await inspectChildIdentity(this.defaultHome) }
    }
  }

  async readConfig(): Promise<ChildConfig> {
    const saved = JSON.parse(await readFile(this.configPath, 'utf8'))
    // Storage-only adapter: keep the original desktop resource/node identity.
    const value = saved && typeof saved === 'object' && Array.isArray(saved.workdirs)
      ? { ...saved, workdirs: saved.workdirs.map((entry: unknown) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry
        const old = entry as Record<string, unknown>
        const fields = ['workdirId', 'resourceId', 'capabilityId'].filter(key => Object.hasOwn(old, key))
        if (fields.length !== 1) throw new TypeError('Saved Child directory identity is invalid')
        return Object.fromEntries(Object.entries(old).map(([key, value]) => [key === fields[0] ? 'workdirId' : key, value]))
      }) } as ChildConfig : saved as ChildConfig
    if (value.version !== 1 || value.mode !== 'child' || typeof value.localNodeId !== 'string' || !value.localNodeId
      || !Array.isArray(value.workdirs) || value.workdirs.length !== 1 || value.workdirs[0]?.workdirId !== 'desktop-workdir'
      || Object.keys(value).length !== 7 || Object.keys(value.workdirs[0]).sort().join(',') !== 'displayName,rootPath,workdirId') throw new TypeError('Saved Child configuration is invalid')
    parseChildPairInput({ endpoint: value.mainEndpoint, offerId: 'validate', pin: '000000', displayName: 'Child',
      dataDir: value.dataDir, workdir: value.workdirs[0].rootPath,
      allowInsecureLocalTransport: value.allowInsecureLocalTransport, executionConsent: true })
    await this.validateFolders?.([value.dataDir, value.workdirs[0].rootPath])
    return value
  }

  async pair(raw: ChildPairInput): Promise<void> {
    const input = parseChildPairInput(raw)
    let config: ChildConfig | undefined
    try { config = await this.readConfig() } catch (error) { if (!isMissingRuntimeConfig(error)) throw error }
    if (config && config.dataDir !== input.dataDir) {
      throw new Error('Keep the saved Child home when retrying; the existing device identity must not be replaced')
    }
    // Never generate a new node ID over an existing home, or submit pairing with
    // another node's identity. Inspection is read-only and precedes all writes.
    const identity = await inspectChildIdentity(input.dataDir, config?.localNodeId)
    if (identity.identityIssue) throw new Error('Child identity conflicts with the saved configuration or cannot be read. Restore the matching Child configuration; existing identity data is retained.')
    const changed = config && (config.mainEndpoint !== input.endpoint || config.workdirs[0].rootPath !== input.workdir
      || config.allowInsecureLocalTransport !== input.allowInsecureLocalTransport)
    if (config && changed) {
      try {
        await access(join(config.dataDir, 'credentials', 'device-credential.v1.json'))
        throw new Error('This Child has already paired. Restore its saved endpoint and folders to resume safely.')
      } catch (error) { if (!isMissingRuntimeConfig(error)) throw error }
    }
    await this.validateFolders?.([input.dataDir, input.workdir])
    await mkdir(input.dataDir, { recursive: true })
    await mkdir(input.workdir, { recursive: true })
    const actualHome = await realpath(input.dataDir)
    const actualWorkdir = await realpath(input.workdir)
    if (actualHome === parse(actualHome).root || actualWorkdir === parse(actualWorkdir).root || overlaps(actualHome, actualWorkdir)) {
      throw new TypeError('Child home and work folder resolve to overlapping folders or a drive root')
    }
    if (!config || changed) {
      config = { version: 1, mode: 'child', localNodeId: config?.localNodeId ?? randomUUID(), dataDir: input.dataDir,
        mainEndpoint: input.endpoint, allowInsecureLocalTransport: input.allowInsecureLocalTransport,
        workdirs: [{ workdirId: 'desktop-workdir', rootPath: input.workdir, displayName: 'Shared work folder' }] }
      await mkdir(dirname(this.configPath), { recursive: true })
      const staging = `${this.configPath}.${randomUUID()}.tmp`
      try {
        const file = await open(staging, 'wx', 0o600)
        try { await file.writeFile(`${JSON.stringify(config)}\n`); await file.sync() } finally { await file.close() }
        await rename(staging, this.configPath)
      } finally { await rm(staging, { force: true }) }
    }
    await this.runPairing({ offerId: input.offerId, pin: input.pin, displayName: input.displayName })
  }
}

export function pairingDiagnostic(output: string): string {
  let code: unknown
  try { const value = JSON.parse(output); if (value.version === 1 && value.state === 'failed') code = value.code } catch { /* Unstructured output is never displayed. */ }
  const messages: Record<string, string> = {
    'network': 'Cannot reach Main or verify its TLS certificate. Check the address, listener, firewall and trusted certificate; do not disable TLS verification.',
    'timeout': 'Main pairing timed out. Check connectivity and whether Main already lists this device before retrying.',
    'key-store': 'The protected OS key store is unavailable or could not unlock this identity. Check the signed-in OS account and key-store permissions.',
    'offer-rejected': 'Main rejected the pairing request. Create a fresh invitation, check its PIN and expiry, and check Main for an existing pending device.',
    'main-response': 'Main returned an unexpected pairing response. Check Main availability and that both devices use compatible Shadow versions.',
    'configuration': 'The Child configuration or identity is invalid. Check the saved endpoint and folders; do not delete the existing identity.',
    'storage': 'The Child identity could not be saved. Check folder permissions and free disk space before retrying.',
  }
  return `${typeof code === 'string' && Object.hasOwn(messages, code) ? messages[code] : 'Pairing failed. Check Main, the endpoint and protected OS key store.'} If Main already shows this device, compare its fingerprint before approving. The saved identity is retained.`
}

export type BackendPairingCommand = FileChildBootstrap['runPairing'] & { stop(): Promise<void> }

export function createBackendPairingCommand(pathsInput: RuntimePathsInput): BackendPairingCommand {
  const paths = resolveRuntimePaths(pathsInput)
  const active = new Set<ChildProcess>()
  let stopping = false
  const command: FileChildBootstrap['runPairing'] = (input) => new Promise<void>((resolve, reject) => {
    if (stopping) { reject(new Error('Desktop is shutting down')); return }
    const child = spawn(paths.executablePath, [paths.entryPath, 'child', 'pair', '--config', paths.configPath], {
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    })
    active.add(child)
    let output = ''
    const timer = setTimeout(() => { child.kill(); reject(new Error('Pairing timed out. Check Main and retry; the saved identity is retained.')) }, 25_000)
    child.stdout.on('data', chunk => { if (output.length < 4096) output += String(chunk) })
    // Backend diagnostics must never echo pairing input into Electron logs.
    child.stderr.resume()
    child.stdin.on('error', () => {})
    child.once('error', () => { clearTimeout(timer); reject(new Error('Could not start the pairing backend')) })
    child.once('close', code => {
      active.delete(child)
      clearTimeout(timer)
      if (code === 0 && output.trim() === '{"version":1,"state":"pending"}') resolve()
      else reject(new Error(pairingDiagnostic(output)))
    })
    child.stdin.end(JSON.stringify(input))
  })
  return Object.assign(command, {
    async stop(): Promise<void> {
      stopping = true
      await Promise.all([...active].map(async child => {
        const closed = once(child, 'close').catch(() => {})
        child.kill()
        await closed
      }))
    },
  })
}
