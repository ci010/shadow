import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { writePrivateFile } from '../../utils/private-file.ts'
import { projectDataPaths } from '../../utils/data-paths.ts'
import { ToolNoEffectError, ToolOutcomeUnknownError } from '../../tools/tool.ts'
import { layerfsName, type LayerConfig } from './bridge.ts'
import { managedRunner } from './managed-runner.ts'

const absoluteHost = z.string().min(1).refine(isAbsolute)
const absoluteLinux = z.string().regex(/^\/(?!\/)/).refine(v => !v.includes('\0') && !v.split('/').includes('..'))
export const installationSchema = z.object({
  apiRoot: absoluteHost,
  bundle: absoluteLinux,
  image: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  distribution: z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/),
  node: absoluteLinux,
}).strict()
export type LayerFSInstallation = z.infer<typeof installationSchema>
const savedSchema = z.object({ version: z.literal(1), projectId: z.string(), installation: installationSchema,
  approvedRootWorker: z.literal(true) }).strict()
const phaseSchema = z.object({ phase: z.enum(['starting', 'running', 'uncertain', 'stopped']) }).strict()
export interface ManagedDriver {
  request(action: string, input: unknown, signal: AbortSignal, authorizeSource?: () => Promise<string>): Promise<unknown>
  close(): Promise<void>
}
export interface Deployment {
  project: string; sdkModule: string; runtimeModule: string
  settings: { home: string; bundle: string; image: string; containerPrefix: string; sweep: false;
    wsl: { distribution: string; user: 'root'; node: string; home: string } }
}
const runtimeStatusSchema = z.object({ worker: z.enum(['running', 'unknown']), answering: z.boolean(), docker: z.enum(['ok', 'down', 'unknown']), ready: z.boolean(), sandboxVerified: z.literal(false),
  health: z.literal('not_checked').optional(), activeCalls: z.number().int().nonnegative().safe().optional() }).strict()
const runtimeConfigSchema = z.object({ sdkModule: absoluteHost, env: z.object({
  LAYERFS_HOME: absoluteLinux, LAYERFS_DOCKER: z.literal('/var/run/docker.sock'), LAYERFS_IMAGE: z.string().regex(/^sha256:[a-f0-9]{64}$/),
  LAYERFS_DAEMON: absoluteLinux, LAYERFS_VOLUME: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
  LAYERFS_STORE_PATH: absoluteLinux, LAYERFS_CONTAINER_PREFIX: z.string(), LAYERFS_WORKER_ENDPOINT: absoluteHost,
}).strict() }).strict()
export class ManagedRuntimeError extends Error {
  constructor(readonly code: string) { super(`LayerFS managed runtime reported ${code}. Inspect runtime status and retained resources before retrying; no raw SDK diagnostics are returned.`) }
}

/** IPC is internal only; SDK code and worker ownership never enter the backend process. */
export function spawnManagedDriver(options: { launch?: typeof spawn; requestTimeoutMs?: number } = {}): ManagedDriver {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('LAYERFS_')))
  // Upstream must resolve Windows SID-reporting whoami, not Git's GNU whoami.
  if (process.platform === 'win32' && process.env.SystemRoot) {
    const pathKey = Object.keys(env).find(key => key.toLowerCase() === 'path') ?? 'PATH'
    env[pathKey] = `${join(process.env.SystemRoot, 'System32')};${env[pathKey] ?? ''}`
  }
  const child: ChildProcess = (options.launch ?? spawn)(process.execPath, ['--input-type=module', '-e', managedRunner], {
    // The desktop backend is an Electron utility process, whose environment
    // deliberately lacks this flag. execPath is still electron.exe there.
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true, stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  })
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void }>()
  const sourceScopes = new Map<string, () => Promise<string>>()
  let ended = false
  const unknown = (reason = 'worker receipt lost') => new ToolOutcomeUnknownError(`LayerFS managed worker outcome unknown (${reason}); inspect runtime_status and retained state before retrying. Daemon work may continue.`)
  const lost = () => { ended = true; for (const p of pending.values()) p.reject(unknown()); pending.clear() }
  child.on('error', lost)
  child.on('exit', lost)
  child.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object') return
    const m = message as { id?: string; type?: string; token?: string; ok?: boolean; result?: unknown; code?: string }
    if (m.type === 'authorize-source') {
      const check = sourceScopes.get(m.token ?? '')
      void (check ? check() : Promise.reject(new Error('No source scope'))).then(
        source => { if (child.connected) child.send({ type: 'source-authorization', id: m.id, ok: true, source }, () => {}) },
        () => { if (child.connected) child.send({ type: 'source-authorization', id: m.id, ok: false }, () => {}) },
      )
      return
    }
    const p = pending.get(m.id ?? '')
    if (!p) return
    if (m.ok === true) p.resolve(m.result)
    else if (m.ok === false && m.code === 'Unknown') p.reject(unknown())
    else if (m.ok === false && typeof m.code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(m.code)) p.reject(new ManagedRuntimeError(m.code))
    else p.reject(unknown())
  })
  const request = (action: string, input: unknown, signal: AbortSignal, authorizeSource?: () => Promise<string>): Promise<unknown> => {
    signal.throwIfAborted()
    if (authorizeSource) {
      if (action !== 'context') throw new ToolNoEffectError('Source scope is context-only.')
      const sourceToken = randomUUID(); sourceScopes.set(sourceToken, authorizeSource)
      input = { sourceToken }
    }
    if (ended || !child.connected) return Promise.reject(unknown())
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const finish = (error?: Error, value?: unknown) => {
        pending.delete(id); clearTimeout(timer); signal.removeEventListener('abort', abort)
        if (error) reject(error); else resolve(value)
      }
      const abort = () => finish(unknown('observation cancelled'))
      const timer = setTimeout(() => finish(unknown(`${action} receipt deadline`)),
        options.requestTimeoutMs ?? (action === 'status' ? 10000 : 330000))
      pending.set(id, { resolve: value => finish(undefined, value), reject: error => finish(error) })
      signal.addEventListener('abort', abort, { once: true })
      child.send({ id, action, input }, error => { if (error) finish(unknown()) })
      if (signal.aborted) abort()
    })
  }
  return { request, async close() {
    if (ended) throw unknown()
    try { await request('close', {}, AbortSignal.timeout(15000)) }
    finally {
      // Even Busy/timeout releases this IPC owner through EOF, never SIGKILL.
      // The helper drains its admitted queue before upstream graceful close.
      // Failure is still reported and the durable uncertain marker blocks reuse.
      sourceScopes.clear()
      if (child.connected) child.disconnect()
      child.unref()
    }
  } }
}

/** One owner per Project Home, reused by management and ordinary tool routes. */
export class ManagedLayerFS {
  private driver?: ManagedDriver
  private connecting?: Promise<unknown>
  private closed = false
  private active = new Set<Promise<unknown>>()
  private setupOwner?: symbol
  acquireSetup() {
    if (this.closed || this.setupOwner) throw new ToolNoEffectError('LayerFS setup/bootstrap/recovery is already owned or the Project is shutting down.')
    const token = Symbol('LayerFS setup owner')
    this.setupOwner = token
    return { token, release: () => { if (this.setupOwner === token) this.setupOwner = undefined } }
  }
  private directory: string
  private readonly profile: string
  private get journal() { return join(this.directory, 'worker-state.json') }
  constructor(readonly projectId: string, readonly home: string,
    private readonly factory: () => ManagedDriver = spawnManagedDriver,
    private readonly platform: string = process.platform) {
    this.directory = join(projectDataPaths(home).state, 'layerfs')
    this.profile = join(projectDataPaths(home).config, 'layerfs-managed.json')
  }
  private async saved() {
    let raw: string
    try { raw = await readFile(this.profile, 'utf8') } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new ToolNoEffectError('LayerFS managed profile cannot be read; no fallback or worker startup was attempted.')
    }
    const value = savedSchema.safeParse((() => { try { return JSON.parse(raw) } catch { return null } })())
    if (!value.success || value.data.projectId !== this.projectId) throw new ToolNoEffectError('LayerFS managed profile is invalid or belongs to another Project; no worker was started.')
    return value.data
  }
  private async phase(missing: 'stopped' | 'uncertain' = 'stopped') {
    try { return phaseSchema.parse(JSON.parse(await readFile(this.journal, 'utf8'))).phase } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return missing
      throw new ToolOutcomeUnknownError('LayerFS worker state cannot be reconciled; inspect retained state, do not restart automatically.')
    }
  }
  private savePhase(phase: z.infer<typeof phaseSchema>['phase']) { writePrivateFile(this.journal, JSON.stringify({ phase })) }
  private deployment(installation: LayerFSInstallation): Deployment {
    // Include the owning Home as well as Project ID: separate app data roots never alias a Linux home.
    const key = createHash('sha256').update(`${resolve(this.home)}\0${this.projectId}`).digest('hex').slice(0, 32)
    return { project: layerfsName(this.projectId), sdkModule: join(installation.apiRoot, 'api', 'agent', 'src', 'index.js'),
      runtimeModule: join(installation.apiRoot, 'api', 'runtime', 'src', 'index.js'),
      settings: { home: join(this.directory, 'runtime'), bundle: installation.bundle, image: installation.image,
        containerPrefix: `shadow-${key}-`, sweep: false,
        wsl: { distribution: installation.distribution, user: 'root', node: installation.node, home: `/var/lib/shadow-layerfs/${key}` } } }
  }
  async describe() {
    // Missing retained evidence is not a confirmed clean stop. Initial setup
    // alone may start without a journal; status must never advertise that as restartable.
    const saved = await this.saved(), phase = saved ? await this.phase('uncertain') : 'unconfigured'
    return { configured: !!saved, mode: 'managed', platform: this.platform, runtime: 'not_checked', project: layerfsName(this.projectId),
      phase,
      next: saved ? 'layerfs_runtime_status' : 'layerfs_setup',
      message: saved ? 'Saved installation approval is available. Worker, Docker and sandbox health are not verified by doctor.' :
        'Approve an existing matching LayerFS installation with setup. Shadow manages private homes, worker lifecycle and configuration; no environment variable or backend restart is needed. There is no upstream prebuilt download; do not invent an installer URL.' }
  }
  async configured() { return !!await this.saved() }
  async setup(installation: unknown, signal: AbortSignal, owner?: symbol) {
    const lease = owner === undefined ? this.acquireSetup() : undefined
    if (owner !== undefined && owner !== this.setupOwner) throw new ToolNoEffectError('LayerFS setup ownership is invalid.')
    try { return await this.setupOwned(installation, signal) } finally { lease?.release() }
  }
  private async setupOwned(installation: unknown, signal: AbortSignal) {
    signal.throwIfAborted()
    if (this.closed) throw new ToolNoEffectError('LayerFS Project is shutting down.')
    if (this.platform !== 'win32') throw new ToolNoEffectError('Managed LayerFS setup currently supports Windows/WSL only; use explicit operator configuration on other platforms.')
    const parsed = installationSchema.safeParse(installation)
    if (!parsed.success) throw new ToolNoEffectError('Invalid LayerFS installation: supply the trusted matching API root, absolute sealed Linux bundle/Node paths, WSL distribution and installed sha256 image ID.')
    const previous = await this.saved()
    if (previous && JSON.stringify(previous.installation) !== JSON.stringify(parsed.data)) throw new ToolNoEffectError('A different LayerFS installation is already approved for this Project. Existing runtime state will not be replaced.')
    const deployment = this.deployment(parsed.data)
    for (const [file, name] of [[deployment.sdkModule, '@layerfs/agent'], [deployment.runtimeModule, '@layerfs/runtime']]) {
      try { if (!(await stat(file!)).isFile()) throw new Error('not a file') }
      catch { throw new ToolNoEffectError('LayerFS installation is missing a readable API entry; select the existing matching API root. No code was loaded.') }
      const packagePath = join(file!, '..', '..', 'package.json')
      let metadata: unknown
      try { metadata = JSON.parse(await readFile(packagePath, 'utf8')) } catch { throw new ToolNoEffectError('LayerFS installation package metadata is unavailable.') }
      if (!metadata || typeof metadata !== 'object' || (metadata as { name?: unknown }).name !== name) throw new ToolNoEffectError('LayerFS installation does not contain the expected matching API packages.')
    }
    signal.throwIfAborted()
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    await mkdir(projectDataPaths(this.home).config, { recursive: true, mode: 0o700 })
    signal.throwIfAborted()
    if (!previous) writePrivateFile(this.profile, JSON.stringify({ version: 1, projectId: this.projectId, installation: parsed.data, approvedRootWorker: true }))
    try { return await this.connect(signal, this.setupOwner) } catch (error) {
      // Saving the approval is already an effect, even if cancellation wins before launch.
      if (!previous) {
        this.savePhase('uncertain')
        if (!(error instanceof ToolOutcomeUnknownError) && !(error instanceof ManagedRuntimeError)) throw new ToolOutcomeUnknownError('LayerFS approval was saved but setup did not complete. Inspect doctor/runtime_status before any manual recovery; do not replay setup.')
      }
      throw error
    }
  }
  async connect(signal: AbortSignal, owner?: symbol): Promise<unknown> {
    signal.throwIfAborted()
    if (this.setupOwner && owner !== this.setupOwner) throw new ToolNoEffectError('LayerFS setup/recovery owns this Project; wait for its result.')
    if (this.closed) throw new ToolNoEffectError('LayerFS Project is shutting down.')
    if (this.connecting) { await this.connecting; signal.throwIfAborted(); return this.status(signal) }
    if (this.driver) {
      if (await this.phase() !== 'running') throw new ToolOutcomeUnknownError('LayerFS previous operation is uncertain; inspect runtime_status. Inspect retained resources; never replay an unknown operation.')
      return this.status(signal)
    }
    const operation = this.start(signal)
    this.connecting = operation
    try { return await operation } finally { this.connecting = undefined }
  }
  private async start(signal: AbortSignal) {
    // Retired namespace selection is not interpreted or migrated. Its presence
    // cannot be used to bypass retained ownership by starting a different home.
    for (const name of ['active-generation.json', 'generations']) {
      try { await stat(join(this.directory, name)); throw new ToolNoEffectError('Retired namespace resources are retained; create an explicitly isolated runtime instead of adopting this home.') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    }
    const saved = await this.saved()
    if (!saved) throw new ToolNoEffectError('LayerFS has no approved installation. Use setup; no SDK was loaded.')
    if (this.platform !== 'win32') throw new ToolNoEffectError('Saved managed LayerFS installation requires Windows/WSL.')
    if (await this.phase() !== 'stopped') throw new ToolOutcomeUnknownError('LayerFS previous worker ownership is unresolved; automatic restart is refused. Inspect runtime_status and retained ownership evidence. Retained worker/Store resources must not be cleared or replayed.')
    signal.throwIfAborted()
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    if (this.closed) throw new ToolNoEffectError('LayerFS Project is shutting down; no worker was dispatched.')
    signal.throwIfAborted()
    this.savePhase('starting')
    try {
      this.driver = this.factory()
      const result = runtimeStatusSchema.parse(await this.driver.request('open', this.deployment(saved.installation), signal))
      this.savePhase('running')
      return result
    } catch (error) { this.savePhase('uncertain'); throw error }
  }
  async status(signal: AbortSignal) {
    signal.throwIfAborted()
    if (!this.driver) return this.describe()
    return runtimeStatusSchema.parse(await this.driver.request('status', {}, signal))
  }
  /** Read approved artifacts only; never inherits worker ownership or starts it. */
  async approvedInstallation(): Promise<LayerFSInstallation> {
    const saved = await this.saved()
    if (!saved) throw new ToolNoEffectError('No approved installation artifacts; use the explicit installation/bootstrap workflow first.')
    return saved.installation
  }
  async sourceIdentity(path: string, signal: AbortSignal): Promise<unknown> {
    if (this.closed || !this.driver || await this.phase() !== 'running') throw new ToolNoEffectError('Runtime owner is not running; no native source probe.')
    return this.driver.request('source_identity', { path }, signal)
  }
  async execContext(signal: AbortSignal, authorizeSource?: () => Promise<string>) {
    if (this.closed || !this.driver || await this.phase() !== 'running') throw new ToolNoEffectError('Runtime owner is not running; no implicit start.')
    const profile = z.object({ port: z.number().int().min(1).max(65535), token: z.string().regex(/^[a-f0-9]{64}$/), sdkModule: absoluteHost }).strict().parse(await this.driver.request('context', {}, signal, authorizeSource))
    const installation = await this.approvedInstallation()
    return { profile, installation }
  }
  async projectConfiguration(project: string, image: string, signal: AbortSignal): Promise<LayerConfig> {
    signal.throwIfAborted()
    if (this.closed) throw new ToolNoEffectError('LayerFS runtime is closing.')
    // A different project may be importing. Its busy status is not evidence
    // that this initialized project is unhealthy; query its explicit binding.
    if (!this.driver) throw new ToolNoEffectError('Runtime owner is not running; use explicit runtime_start from its original owner session. No implicit start.')
    else if (await this.phase() !== 'running') throw new ToolOutcomeUnknownError('Runtime worker ownership is unresolved; no configuration fallback.')
    const operation = this.driver!.request('configuration', { project }, signal)
    this.active.add(operation)
    try {
      const result = runtimeConfigSchema.parse(await operation)
      if (result.env.LAYERFS_IMAGE !== image) throw new ToolOutcomeUnknownError('Template project image differs from its immutable catalog binding; no dispatch.')
      return result
    } finally { this.active.delete(operation) }
  }
  async close() {
    this.closed = true
    await Promise.allSettled([...(this.connecting ? [this.connecting] : []), ...this.active])
    if (!this.driver) return
    try {
      await this.driver.close()
      // A clean worker close does not resolve an uncertain Init/import.
      if (await this.phase() === 'running') this.savePhase('stopped')
    } catch (error) { this.savePhase('uncertain'); throw error }
    finally { this.driver = undefined }
  }
}

const services = new Map<string, ManagedLayerFS>()
export function managedLayerFS(projectId: string, home: string, create: () => ManagedLayerFS = () => new ManagedLayerFS(projectId, home)): ManagedLayerFS {
  const key = `${resolve(home)}\0${projectId}`
  let service = services.get(key)
  if (!service) { service = create(); services.set(key, service) }
  return service
}
export async function closeManagedLayerFS(projectId: string, home: string) {
  const key = `${resolve(home)}\0${projectId}`
  const service = services.get(key)
  if (!service) return
  await service.close()
  services.delete(key)
}
