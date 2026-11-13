import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, stat, writeFile, open, unlink } from 'node:fs/promises'
import { LayerFSNamespaces, type LayerFSNamespace } from './namespace.ts'
import { inspectInactiveImportWorker } from './import-ownership.ts'
import { inspectUnstartedConnection } from './connection-recovery.ts'
import type { BootstrapRun } from './bootstrap-command.ts'
import { isAbsolute, join, resolve } from 'node:path'
import { z } from 'zod'
import { writePrivateFile } from '../../utils/private-file.ts'
import { projectDataPaths } from '../../utils/data-paths.ts'
import { ToolNoEffectError, ToolOutcomeUnknownError } from '../../tools/tool.ts'
import { layerfsName, type LayerConfig } from './bridge.ts'
import { managedRunner } from './managed-runner.ts'
import { importRefusal } from './import-diagnostic.ts'
import { IMPORT_TIMEOUT, importTimeoutMs } from './import-timeout.ts'

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
  request(action: string, input: unknown, signal: AbortSignal, onProgress?: (progress: ImportProgress) => void): Promise<unknown>
  close(): Promise<void>
}
export interface Deployment {
  project: string; sdkModule: string; runtimeModule: string
  settings: { home: string; bundle: string; image: string; containerPrefix: string; sweep: false;
    wsl: { distribution: string; user: 'root'; node: string; home: string } }
}
const countsSchema = z.object({ entries: z.number().int().nonnegative().safe().optional(), files: z.number().int().nonnegative().safe().optional(), bytes: z.number().int().nonnegative().safe().optional() }).strict()
export const importProgressSchema = z.object({ stage: z.enum(['not_started', 'preparing', 'scan', 'volume', 'import', 'done', 'failed', 'unknown']),
  startedAt: z.number().nonnegative().optional(), endedAt: z.number().nonnegative().optional(), elapsedMs: z.number().nonnegative().optional(), jobId: z.string().min(1).max(128).optional(),
  refusal: z.object({ reason: z.enum(['Changed', 'Mtime', 'NotDirectory', 'Mode']), path: z.string().min(1).max(240).regex(/^[A-Za-z0-9_./ @()+-]+$/).refine(p => !p.startsWith('/') && !p.split('/').some(s => s === '..' || !s)), mode: z.string().regex(/^[0-7]{4}$/).optional() }).strict().optional(),
  scanned: countsSchema.optional(), totals: countsSchema.optional(), imported: countsSchema.optional(), code: z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/).optional() }).strict()
export type ImportProgress = z.infer<typeof importProgressSchema>
const runtimeStatusSchema = z.object({ worker: z.enum(['running', 'unknown']), answering: z.boolean(), docker: z.enum(['ok', 'down', 'unknown']), ready: z.boolean(), sandboxVerified: z.literal(false),
  health: z.literal('not_checked').optional(), activeCalls: z.number().int().nonnegative().safe().optional(), operation: importProgressSchema.optional() }).strict()
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
  const pending = new Map<string, { resolve(value: unknown): void; reject(error: Error): void; progress?(value: ImportProgress): void }>()
  let ended = false
  const unknown = (reason = 'worker receipt lost') => new ToolOutcomeUnknownError(`LayerFS managed worker outcome unknown (${reason}); inspect import_status/runtime_status and retained state before retrying. Daemon work may continue.`)
  const lost = () => { ended = true; for (const p of pending.values()) p.reject(unknown()); pending.clear() }
  child.on('error', lost)
  child.on('exit', lost)
  child.on('message', (message: unknown) => {
    if (!message || typeof message !== 'object') return
    const m = message as { id?: string; ok?: boolean; result?: unknown; code?: string; progress?: unknown }
    const p = pending.get(m.id ?? '')
    if (!p) return
    if (m.progress !== undefined) {
      const progress = importProgressSchema.safeParse(m.progress)
      if (progress.success) p.progress?.(progress.data)
      return
    }
    if (m.ok === true) p.resolve(m.result)
    else if (m.ok === false && m.code === 'Unknown') p.reject(unknown())
    else if (m.ok === false && typeof m.code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(m.code)) p.reject(new ManagedRuntimeError(m.code))
    else p.reject(unknown())
  })
  const request = (action: string, input: unknown, signal: AbortSignal, onProgress?: (progress: ImportProgress) => void): Promise<unknown> => {
    signal.throwIfAborted()
    if (action === 'create') input = { ...(input as Record<string, unknown>), timeoutMs: importTimeoutMs((input as { timeoutMs?: unknown } | null)?.timeoutMs) }
    if (ended || !child.connected) return Promise.reject(unknown())
    return new Promise((resolve, reject) => {
      const id = randomUUID()
      const finish = (error?: Error, value?: unknown) => {
        pending.delete(id); clearTimeout(timer); signal.removeEventListener('abort', abort)
        if (error) reject(error); else resolve(value)
      }
      const abort = () => finish(unknown('observation cancelled'))
      // Only the SDK owns the import deadline. Valid progress/heartbeats refresh
      // this transport watchdog; silence means lost observation, never Init failure.
      const timer = setTimeout(() => finish(unknown(action === 'create' ? 'import helper heartbeat lost' : `${action} receipt deadline`)),
        options.requestTimeoutMs ?? (['status', 'import_status'].includes(action) ? 10000 : IMPORT_TIMEOUT.silenceMs))
      pending.set(id, { resolve: value => finish(undefined, value), reject: error => finish(error),
        ...(action === 'create' ? { progress: (value: ImportProgress) => {
          timer.refresh()
          try { onProgress?.(value) } catch { finish(unknown('progress evidence could not be retained')) }
        } } : {}) })
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
  private importing = false
  private setupOwner?: symbol
  acquireSetup() {
    if (this.closed || this.setupOwner) throw new ToolNoEffectError('LayerFS setup/bootstrap/recovery is already owned or the Project is shutting down.')
    const token = Symbol('LayerFS setup owner')
    this.setupOwner = token
    return { token, release: () => { if (this.setupOwner === token) this.setupOwner = undefined } }
  }
  private directory: string
  private readonly profile: string
  private readonly namespaces: LayerFSNamespaces
  private namespace: LayerFSNamespace
  private get journal() { return join(this.directory, 'worker-state.json') }
  constructor(readonly projectId: string, readonly home: string,
    private readonly factory: () => ManagedDriver = spawnManagedDriver,
    private readonly platform: string = process.platform) {
    this.namespaces = new LayerFSNamespaces(projectId, home)
    this.namespace = this.namespaces.reference()
    this.directory = this.namespace.directory
    this.profile = join(projectDataPaths(home).config, 'layerfs-managed.json')
  }
  private async loadNamespace() {
    const current = await this.namespaces.current()
    if (current.id === this.namespace.id) return
    if (current.id === 'legacy' || this.driver || this.connecting || this.importing || this.active.size) throw new ToolOutcomeUnknownError('LayerFS namespace changed while ownership was active or its pointer disappeared. No fallback or automatic restart is allowed.')
    this.namespace = current
    this.directory = current.directory
  }
  private requireNamespace(expected?: string) {
    if (expected !== undefined && expected !== this.namespace.id) throw new ToolNoEffectError('The LayerFS namespace changed while this request was in flight; no operation was redirected. Inspect namespace_status and submit a new explicit request.')
  }
  async namespaceInfo() {
    await this.loadNamespace()
    return { namespace: this.namespace.id, project: this.namespace.project }
  }
  async namespaceStatus() {
    return { ...(await this.namespaceInfo()), quarantined: await this.namespaces.history(),
      message: 'Quarantined namespaces retain their files and Store resources; old mount IDs are not routed into the active namespace.' }
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
  private async phase() {
    try { return phaseSchema.parse(JSON.parse(await readFile(this.journal, 'utf8'))).phase } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'stopped' as const
      throw new ToolOutcomeUnknownError('LayerFS worker state cannot be reconciled; inspect retained state, do not restart automatically.')
    }
  }
  private savePhase(phase: z.infer<typeof phaseSchema>['phase']) { writePrivateFile(this.journal, JSON.stringify({ phase })) }
  private deployment(installation: LayerFSInstallation): Deployment {
    // Include the owning Home as well as Project ID: separate app data roots never alias a Linux home.
    const key = createHash('sha256').update(`${resolve(this.home)}\0${this.projectId}${this.namespace.id === 'legacy' ? '' : `\0${this.namespace.id}`}`).digest('hex').slice(0, 32)
    return { project: this.namespace.project, sdkModule: join(installation.apiRoot, 'api', 'agent', 'src', 'index.js'),
      runtimeModule: join(installation.apiRoot, 'api', 'runtime', 'src', 'index.js'),
      settings: { home: join(this.directory, 'runtime'), bundle: installation.bundle, image: installation.image,
        containerPrefix: `shadow-${key}-`, sweep: false,
        wsl: { distribution: installation.distribution, user: 'root', node: installation.node, home: `/var/lib/shadow-layerfs/${key}` } } }
  }
  async describe() {
    await this.loadNamespace()
    const saved = await this.saved(), phase = saved ? await this.phase() : 'unconfigured'
    return { configured: !!saved, mode: 'managed', platform: this.platform, runtime: 'not_checked', namespace: this.namespace.id, project: this.namespace.project,
      phase,
      next: phase === 'uncertain' ? 'import_status' : saved ? 'connect' : 'setup',
      message: saved ? 'Saved installation approval is available. Worker, Docker and sandbox health are not verified by doctor.' :
        'Approve an existing matching LayerFS installation with setup. Shadow manages private homes, worker lifecycle and configuration; no environment variable or backend restart is needed. There is no upstream prebuilt download; do not invent an installer URL.' }
  }
  async configured() { return !!await this.saved() }
  async setup(installation: unknown, signal: AbortSignal, owner?: symbol, expectedNamespace?: string) {
    const lease = owner === undefined ? this.acquireSetup() : undefined
    if (owner !== undefined && owner !== this.setupOwner) throw new ToolNoEffectError('LayerFS setup ownership is invalid.')
    try { return await this.setupOwned(installation, signal, expectedNamespace) } finally { lease?.release() }
  }
  private async setupOwned(installation: unknown, signal: AbortSignal, expectedNamespace?: string) {
    signal.throwIfAborted()
    await this.loadNamespace()
    this.requireNamespace(expectedNamespace)
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
  async connect(signal: AbortSignal, owner?: symbol, expectedNamespace?: string): Promise<unknown> {
    signal.throwIfAborted()
    await this.loadNamespace()
    this.requireNamespace(expectedNamespace)
    if (this.setupOwner && owner !== this.setupOwner) throw new ToolNoEffectError('LayerFS setup/recovery owns this Project; wait for its result.')
    if (this.closed) throw new ToolNoEffectError('LayerFS Project is shutting down.')
    if (this.connecting) { await this.connecting; signal.throwIfAborted(); return this.status(signal) }
    if (this.driver) {
      if (await this.phase() !== 'running') throw new ToolOutcomeUnknownError('LayerFS previous operation is uncertain; inspect import_status/runtime_status. For a failed import, import_recovery_plan provides approval-gated quarantine into a fresh namespace; never retry the old import.')
      return this.status(signal)
    }
    const operation = this.start(signal)
    this.connecting = operation
    try { return await operation } finally { this.connecting = undefined }
  }
  /** Called only by the owning bootstrap recovery after matching the exact retained build.
   * Never expose an intermediate stopped state that another caller could auto-start.
   */
  async recoverUnstartedConnection(installation: LayerFSInstallation, signal: AbortSignal, owner: symbol, beforeStart: () => Promise<void>, run?: BootstrapRun) {
    if (owner !== this.setupOwner || this.closed || this.driver || this.connecting || this.active.size) throw new ToolNoEffectError('Connection recovery requires exclusive setup ownership and no in-memory worker or operation.')
    const operation = this.recoverUnstartedOwned(installation, signal, beforeStart, run)
    this.connecting = operation
    try { return await operation } finally { this.connecting = undefined }
  }
  private async recoverUnstartedOwned(installation: LayerFSInstallation, signal: AbortSignal, beforeStart: () => Promise<void>, run?: BootstrapRun) {
    const saved = await this.saved()
    if (!saved || JSON.stringify(saved.installation) !== JSON.stringify(installation) || await this.phase() !== 'uncertain') throw new ToolNoEffectError('Saved installation or worker state no longer matches the retained failed connection.')
    if (this.platform !== 'win32') throw new ToolNoEffectError('Connection recovery currently supports Windows/WSL only.')
    await inspectUnstartedConnection(this.home, saved.installation.distribution, signal, run)
    if (this.closed || this.driver || JSON.stringify(await this.saved()) !== JSON.stringify(saved) || await this.phase() !== 'uncertain') throw new ToolNoEffectError('LayerFS state changed during inspection; recovery refused.')
    signal.throwIfAborted()
    const history = join(this.directory, 'history')
    await mkdir(history, { recursive: true, mode: 0o700 })
    await writeFile(join(history, `worker-uncertain-${randomUUID()}.json`), JSON.stringify({ phase: 'uncertain', recoveredAt: new Date().toISOString(), evidence: 'absent_host_runtime_no_managed_helper_stopped_distribution' }), { flag: 'wx', mode: 0o600 })
    signal.throwIfAborted()
    await beforeStart()
    signal.throwIfAborted()
    return await this.start(signal, true)
  }
  private async start(signal: AbortSignal, recoveredUnstarted = false) {
    const saved = await this.saved()
    if (!saved) throw new ToolNoEffectError('LayerFS has no approved installation. Use setup; no SDK was loaded.')
    if (this.platform !== 'win32') throw new ToolNoEffectError('Saved managed LayerFS installation requires Windows/WSL.')
    if (await this.phase() !== (recoveredUnstarted ? 'uncertain' : 'stopped')) throw new ToolOutcomeUnknownError('LayerFS previous worker ownership is unresolved; automatic restart is refused. Inspect import_status and, for a failed import, use import_recovery_plan for an explicitly approved fresh namespace. Retained worker/Store resources must not be cleared or replayed.')
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
  async status(signal: AbortSignal, expectedNamespace?: string) {
    signal.throwIfAborted()
    await this.loadNamespace()
    this.requireNamespace(expectedNamespace)
    if (!this.driver) return this.describe()
    return runtimeStatusSchema.parse(await this.driver.request('status', {}, signal))
  }
  /** Read progress or bounded retained SDK failure metadata; never opens a worker. */
  async importStatus(signal: AbortSignal, expectedNamespace?: string) {
    signal.throwIfAborted()
    await this.loadNamespace()
    this.requireNamespace(expectedNamespace)
    let liveUnavailable = false
    if (this.driver) {
      try {
        const progress = importProgressSchema.parse(await this.driver.request('import_status', {}, signal))
        if (progress.stage !== 'not_started') return { observation: 'live_helper', ...progress, retryAllowed: false,
          ...(['failed', 'unknown'].includes(progress.stage) ? { next: 'import_recovery_plan' } : {}) }
      } catch { signal.throwIfAborted(); liveUnavailable = true }
    }
    try {
      const progress = importProgressSchema.parse(JSON.parse(await readFile(join(this.directory, 'import-state.json'), 'utf8')))
      return { observation: 'retained', ...progress, liveUnavailable, retryAllowed: false,
        ...(['failed', 'unknown'].includes(progress.stage) ? { next: 'import_recovery_plan' } : {}) }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ToolNoEffectError('Retained LayerFS import diagnostics are invalid or unreadable; no worker was started.')
    }
    // Older helpers retained only upstream failure records. Read a bounded tail,
    // return allowlisted metadata only: native messages can contain catalog keys.
    let file
    try { file = await open(join(this.directory, 'runtime', '.runtime', 'init-failures.jsonl'), 'r') }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { observation: 'none', stage: 'not_started', liveUnavailable, retryAllowed: false }; throw error }
    try {
      const size = (await file.stat()).size, offset = Math.max(0, size - 65536), bytes = Buffer.alloc(Math.min(size, 65536))
      const { bytesRead } = await file.read(bytes, 0, bytes.length, offset)
      let rows = bytes.subarray(0, bytesRead).toString('utf8').split(/\r?\n/)
      if (offset) rows = rows.slice(1)
      for (const row of rows.reverse()) {
        let value
        try { value = JSON.parse(row) } catch { continue }
        if (value?.project?.name !== this.namespace.project) continue
        const code = /Project\(Deadline\)/.test(String(value.message ?? '')) ? 'ImportDeadline'
          : typeof value.code === 'string' && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(value.code) ? value.code : 'Unknown'
        const refusal = importRefusal(value, value.project.source)
        return { observation: 'retained_sdk_failure', stage: 'failed', code, ...(refusal ? { refusal } : {}), liveUnavailable, retryAllowed: false, next: 'import_recovery_plan',
          message: 'The SDK recorded a failed import. Its resources remain unreconciled; no cleanup or replay was performed.' }
      }
      return { observation: 'unavailable', stage: 'unknown', liveUnavailable, retryAllowed: false }
    } finally { await file.close() }
  }
  private async recoveryEvidence(signal: AbortSignal) {
    signal.throwIfAborted()
    await this.loadNamespace()
    const saved = await this.saved(), phase = await this.phase()
    if (!saved || !['uncertain', 'stopped'].includes(phase)) throw new ToolNoEffectError('Import quarantine requires a saved installation with unresolved/stopped ownership; no namespace was changed.')
    const observation = await this.importStatus(signal)
    if (observation.stage !== 'failed' && observation.stage !== 'unknown') throw new ToolNoEffectError('No failed/unknown import is eligible for quarantine. Active or completed imports are not replaced.')
    const fingerprint = await this.namespaces.fingerprint(this.namespace, saved)
    signal.throwIfAborted()
    return { namespace: this.namespace.id, project: this.namespace.project, distribution: saved.installation.distribution,
      importStage: observation.stage as 'failed' | 'unknown', importCode: 'code' in observation ? observation.code : undefined, fingerprint }
  }
  async importRecoveryPlan(signal: AbortSignal) {
    if (this.closed || this.connecting || this.active.size || this.importing || this.setupOwner) throw new ToolNoEffectError('Wait for the current LayerFS operation before planning import quarantine.')
    return { ...(await this.recoveryEvidence(signal)), resourcesRetained: true,
      message: 'A new isolated namespace can be selected after explicit approval and inactive-worker verification. This does not retry, repair or delete the retained import.' }
  }
  /** Approval is enforced by the owner tool workflow; this method owns the full
   * lifecycle and a cross-process file lock. It never rewrites the old journals.
   */
  async recoverImport(expectedFingerprint: string, ownerSessionId: string, signal: AbortSignal, run?: BootstrapRun) {
    await this.loadNamespace()
    if (this.connecting || this.active.size || this.importing) throw new ToolNoEffectError('An active LayerFS operation prevents import quarantine.')
    const lease = this.acquireSetup()
    const operation = this.recoverImportOwned(expectedFingerprint, ownerSessionId, signal, run)
    this.connecting = operation
    try { return await operation } finally { this.connecting = undefined; lease.release() }
  }
  private async recoverImportOwned(expectedFingerprint: string, ownerSessionId: string, signal: AbortSignal, run?: BootstrapRun) {
    if (this.platform !== 'win32') throw new ToolNoEffectError('Guarded import quarantine currently supports Windows/WSL only.')
    const lockPath = join(this.namespaces.root, 'namespace-recovery.lock'), token = randomUUID()
    let lock
    try { lock = await open(lockPath, 'wx', 0o600) }
    catch { throw new ToolNoEffectError('Another or interrupted namespace recovery owns the Project lock. Inspect it; do not remove it or replay automatically.') }
    let touched = false
    try {
      await lock.writeFile(JSON.stringify({ token, pid: process.pid }))
      const before = await this.recoveryEvidence(signal)
      if (before.fingerprint !== expectedFingerprint) throw new ToolNoEffectError('Import evidence changed since approval; obtain a fresh recovery plan.')
      if (this.driver) {
        const health = runtimeStatusSchema.parse(await this.driver.request('status', {}, signal))
        if (!health.answering || !health.ready || health.activeCalls !== 0 || health.health === 'not_checked') throw new ToolOutcomeUnknownError('The owned worker is not confirmed idle; quarantine refused without stopping it.')
        const driver = this.driver
        touched = true
        try { await driver.close() } finally { this.driver = undefined }
      }
      touched = true // Root inspection can start WSL if its inventory races shutdown.
      const evidence = await inspectInactiveImportWorker(before.distribution, signal, run)
      const after = await this.recoveryEvidence(signal)
      if (after.fingerprint !== expectedFingerprint || after.namespace !== before.namespace) throw new ToolNoEffectError('Import evidence changed during ownership reconciliation. Retained state was not selected for reuse; obtain a fresh plan.')
      if (this.closed) throw new ToolNoEffectError('Project shutdown interrupted import quarantine.')
      const previous = this.namespace
      const next = await this.namespaces.prepare(previous, { ownerSessionId, evidence: evidence.evidence, priorFingerprint: expectedFingerprint,
        importStage: after.importStage, importCode: after.importCode })
      const final = await this.recoveryEvidence(signal)
      if (final.fingerprint !== expectedFingerprint || final.namespace !== previous.id) throw new ToolNoEffectError('Import evidence changed before namespace selection; the prepared directory was retained but not activated.')
      signal.throwIfAborted()
      if (this.closed) throw new ToolNoEffectError('Project shutdown interrupted namespace selection; no new worker was started.')
      this.namespaces.select(next)
      this.namespace = next; this.directory = next.directory
      return { status: 'quarantined', previousNamespace: previous.id, namespace: next.id, project: next.project, phase: 'stopped',
        resourcesRetained: true, rebuilt: false, imported: false, workerStarted: false,
        next: 'Prepare/review a separate baseline, then connect/create with the returned namespace. Old mount IDs and import attempts cannot be reused.',
        message: 'Old runtime, journals and Store resources remain intact in their previous namespace. Selection of a fresh namespace is not successful import or parallel-test completion.' }
    } catch (error) {
      if (touched && !(error instanceof ToolOutcomeUnknownError)) throw new ToolOutcomeUnknownError('Import quarantine did not complete. Ownership inspection/worker close or a prepared directory may have effects; retained files were not deleted. Inspect namespace_status and obtain a fresh plan, never replay the old request.')
      throw error
    } finally {
      this.namespaces.endPreparation()
      await lock.close()
      try {
        const held = JSON.parse(await readFile(lockPath, 'utf8'))
        if (held.token === token) await unlink(lockPath)
      } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw new ToolOutcomeUnknownError('Namespace recovery lock cleanup could not be confirmed; inspect retained state before another recovery.') }
    }
  }
  async configuration(signal: AbortSignal, expectedNamespace?: string): Promise<LayerConfig> {
    this.requireReady(await this.connect(signal, undefined, expectedNamespace))
    try { return runtimeConfigSchema.parse(await this.driver!.request('configuration', {}, signal)) } catch (error) {
      if (error instanceof ManagedRuntimeError && error.code === 'NotInitialized') throw new ToolNoEffectError('LayerFS worker is connected but no source has been imported. Check credentials/import scope, then create once with a registered workspace.')
      throw error
    }
  }
  private requireReady(value: unknown) {
    const status = runtimeStatusSchema.parse(value)
    if (!status.ready || !status.answering || status.docker !== 'ok') throw new ToolNoEffectError('LayerFS worker or Docker is not ready. Inspect runtime_status; no source import or sandbox operation was dispatched.')
  }
  async create(source: string, signal: AbortSignal, timeoutMs: number = IMPORT_TIMEOUT.defaultMs, expectedNamespace?: string, importPolicy: 'git' | 'curated' | 'whole_tree' = 'git') {
    signal.throwIfAborted()
    await this.loadNamespace()
    this.requireNamespace(expectedNamespace)
    timeoutMs = importTimeoutMs(timeoutMs)
    if (this.importing) throw new ToolNoEffectError('A LayerFS import is already active; inspect import_status, do not repeat it.')
    this.importing = true
    let operation: Promise<unknown> | undefined
    let progress: ImportProgress = { stage: 'preparing', startedAt: Date.now() }
    let admitted = false, lastWrite = 0
    const journal = join(this.directory, 'import-state.json')
    try {
      this.requireReady(await this.connect(signal, undefined, expectedNamespace))
      try { await stat(journal); throw new ToolNoEffectError('A prior LayerFS import attempt is retained. Inspect import_status; create never replays it.') }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
      signal.throwIfAborted()
      if (this.closed) throw new ToolNoEffectError('LayerFS Project is shutting down; no import was dispatched.')
      writePrivateFile(journal, JSON.stringify(progress))
      admitted = true
      operation = this.driver!.request('create', { source, timeoutMs, importPolicy }, signal, value => {
        const previousStage = progress.stage
        progress = importProgressSchema.parse(value)
        if (previousStage !== progress.stage || Date.now() - lastWrite >= 5000) {
          writePrivateFile(journal, JSON.stringify(progress)); lastWrite = Date.now()
        }
      })
      this.active.add(operation)
      const result = await operation
      writePrivateFile(journal, JSON.stringify({ ...progress, stage: 'done', endedAt: Date.now() }))
      return result
    } catch (error) {
      if (admitted) {
        // Every Windows Init failure retains resources. Evidence is not rollback.
        this.savePhase('uncertain')
        const terminalFailure = progress.stage === 'failed' && progress.endedAt !== undefined
        try { writePrivateFile(journal, JSON.stringify({ ...progress, stage: terminalFailure || error instanceof ManagedRuntimeError ? 'failed' : 'unknown',
          code: terminalFailure ? progress.code ?? 'Unknown' : error instanceof ManagedRuntimeError ? error.code : 'OUTCOME_UNKNOWN' })) } catch { /* Preserve original failure; worker marker still blocks replay. */ }
      }
      throw error
    } finally { this.importing = false; if (operation) this.active.delete(operation) }
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
