import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, stat, unlink } from 'node:fs/promises'
import { nativeSourceRoot, nativeSourcePath, verifyNativeSource } from './native-source.ts'
import { join, resolve } from 'node:path'
import { z } from 'zod'
import { type ExecutionContext } from '../../tools/context.ts'
import { ToolNoEffectError, ToolOutcomeUnknownError, type ToolResult } from '../../tools/tool.ts'
import { writePrivateFile } from '../../utils/private-file.ts'
import { assertLayerFSSetupOwner } from './bootstrap.ts'
import { ManagedLayerFS, managedLayerFS, installationSchema } from './managed.ts'
import { runBridge } from './bridge.ts'
import { LayerFSResourceCatalog, resourceSchema, type LayerFSResource } from './resources.ts'
import { sdkLauncher } from './sdk-launcher.ts'
import { parseBranchWorkspace } from './workspace-identity.ts'
import { LayerFSWorkspaces } from './workspace-create.ts'

const idSchema = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/)
const runtimeSchema = z.object({ version: z.literal(1), projectId: z.string(), runtimeId: idSchema, owner: z.string(), installation: installationSchema, phase: z.enum(['planned', 'starting', 'ready', 'unknown']) }).strict()
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

export interface ResourceRuntime {
  sourceIdentity: ManagedLayerFS['sourceIdentity']; setup: ManagedLayerFS['setup']; execContext: ManagedLayerFS['execContext']; status: (signal: AbortSignal) => Promise<unknown>; projectConfiguration: ManagedLayerFS['projectConfiguration']; close: ManagedLayerFS['close']
}
export interface ResourceDependencies {
  installation?: () => ReturnType<ManagedLayerFS['approvedInstallation']>
  runtime?: (home: string) => ResourceRuntime
  bridge?: typeof runBridge
}

/** Project-owned catalog/runtime boundary. No user SDK path and no active namespace
 * pointer participates in resource routing. Old installations are artifact donors only. */
export class LayerFSResources {
  readonly catalog: LayerFSResourceCatalog
  private readonly root: string
  private readonly runtimes = new Map<string, ResourceRuntime>()
  private readonly workspaces = new Map<string, LayerFSWorkspaces>()
  constructor(readonly projectId: string, readonly home: string, private readonly dependencies: ResourceDependencies = {}) {
    this.root = join(home, 'layerfs-catalog')
    this.catalog = new LayerFSResourceCatalog(this.root, projectId)
  }
  private runtimeHome(id: string) { return join(this.root, 'runtimes', idSchema.parse(id)) }
  private runtimeFile(id: string) { return join(this.runtimeHome(id), 'runtime.json') }
  private async record(id: string) {
    const value = runtimeSchema.parse(JSON.parse(await readFile(this.runtimeFile(id), 'utf8')))
    if (value.projectId !== this.projectId || value.runtimeId !== id) throw new ToolNoEffectError('Runtime catalog identity mismatch.')
    return value
  }
  private runtime(id: string) {
    let runtime = this.runtimes.get(id)
    if (!runtime) { runtime = this.dependencies.runtime?.(this.runtimeHome(id)) ?? new ManagedLayerFS(this.projectId, this.runtimeHome(id)); this.runtimes.set(id, runtime) }
    return runtime
  }
  private assertOwner(context: ExecutionContext) {
    assertLayerFSSetupOwner(context)
    if (context.projectId !== this.projectId) throw new ToolNoEffectError('Current-Project owner context required.')
    context.signal.throwIfAborted()
  }
  async runtimePlan(id: string, context: ExecutionContext) {
    this.assertOwner(context)
    const installation = await (this.dependencies.installation?.() ?? managedLayerFS(this.projectId, this.home).approvedInstallation())
    const value = runtimeSchema.parse({ version: 1, projectId: this.projectId, runtimeId: id, owner: context.sessionId, installation, phase: 'planned' })
    await mkdir(this.runtimeHome(id), { recursive: true, mode: 0o700 })
    await writeFile(this.runtimeFile(id), JSON.stringify(value), { flag: 'wx', mode: 0o600 })
    return { runtimeId: id, installation: { distribution: installation.distribution, fingerprint: digest(installation) }, phase: 'planned', resourcesRetained: true }
  }
  async runtimeStart(id: string, context: ExecutionContext) {
    this.assertOwner(context)
    const value = await this.record(id)
    if (value.owner !== context.sessionId) throw new ToolNoEffectError('Runtime is owned by another session; ownership transfer is not supported.')
    // A transient exclusive lease covers preflight as well as dispatch across service
    // instances. A crash retains it; never steal it or clear historical admissions.
    const lease = join(this.runtimeHome(id), 'start-lease.json')
    try { await writeFile(lease, JSON.stringify({ owner: context.sessionId }), { flag: 'wx', mode: 0o600 }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ToolNoEffectError('Runtime start is already admitted or unresolved; inspect status, no replay.')
      throw error
    }
    try {
      const current = await this.record(id)
      if (current.owner !== context.sessionId) throw new ToolNoEffectError('Runtime is owned by another session.')
      if (current.phase !== 'planned' && current.phase !== 'ready') throw new ToolOutcomeUnknownError('Runtime startup is unresolved; inspect retained state, no replay.')
      if (current.phase === 'ready') {
        const status = await this.runtime(id).status(context.signal)
        if (!status || typeof status !== 'object' || !('phase' in status) || status.phase !== 'stopped') {
          throw new ToolNoEffectError('Runtime start already consumed; only a confirmed normally stopped worker can restart. Inspect runtime_status.')
        }
      }
      context.signal.throwIfAborted()
      writePrivateFile(this.runtimeFile(id), JSON.stringify({ ...current, phase: 'starting' }))
      try {
        await this.runtime(id).setup(current.installation, context.signal)
        writePrivateFile(this.runtimeFile(id), JSON.stringify({ ...current, phase: 'ready' }))
        // Report after releasing the admission lease, so status does not mistake
        // this completed start for an outstanding/crash-retained admission.
      } catch (error) {
        // A proven pre-dispatch refusal must not poison an otherwise retryable
        // plan/stopped runtime. All other failures retain unknown ownership.
        writePrivateFile(this.runtimeFile(id), JSON.stringify({ ...current, phase: error instanceof ToolNoEffectError ? current.phase : 'unknown' }))
        throw error
      }
    } finally { await unlink(lease) }
    return this.runtimeStatus(id, context.signal)
  }
  async runtimeStatus(id: string, signal: AbortSignal) {
    const value = await this.record(id)
    const result = await this.runtime(id).status(signal)
    const live = z.object({ ready: z.boolean().optional(), worker: z.string().optional(), answering: z.boolean().optional(), docker: z.string().optional(), phase: z.string().optional() }).passthrough().parse(result)
    let admissionRetained = false
    try { await stat(join(this.runtimeHome(id), 'start-lease.json')); admissionRetained = true }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    const ready = !admissionRetained && value.phase === 'ready' && live.ready === true && live.worker === 'running' && live.answering === true && live.docker === 'ok'
    const phase = admissionRetained ? (value.phase === 'starting' ? 'starting' : 'unknown') : ready ? 'ready' : value.phase === 'ready' ? (live.phase === 'stopped' ? 'stopped' : 'unknown') : value.phase
    return { runtimeId: id, recordPhase: value.phase, phase, ready, owner: value.owner,
      next: phase === 'planned' || phase === 'stopped' ? 'layerfs_runtime_start' : ready ? 'layerfs_runtime_context' : 'inspect_retained_state',
      message: phase === 'stopped' ? 'Worker stopped normally. The original direct owner session may explicitly start this same runtime; no ownership transfer or implicit restart.' : undefined,
      result }
  }
  async runtimeContext(id: string, context: ExecutionContext, sourceName?: string) {
    this.assertOwner(context)
    const record = await this.record(id)
    if (record.phase !== 'ready' || record.owner !== context.sessionId) throw new ToolNoEffectError('Only the running runtime owner may obtain its SDK launcher.')
    const sourceRoot = nativeSourceRoot(this.projectId, id)
    const path = sourceName === undefined ? undefined : nativeSourcePath(sourceRoot, sourceName)
    const source = async () => {
      this.assertOwner(context)
      const current = await this.record(id)
      if (current.phase !== 'ready' || current.owner !== context.sessionId || digest(current.installation) !== digest(record.installation)) throw new ToolNoEffectError('Runtime source binding changed; obtain a new context.')
      const identity = verifyNativeSource(path!, await this.runtime(id).sourceIdentity(path!, context.signal))
      return { path: path!, identity }
    }
    const initial = path ? await source() : undefined
    const authorizeSource = initial ? async () => {
      const current = await source()
      if (JSON.stringify(current) !== JSON.stringify(initial)) throw new ToolNoEffectError('Native source directory identity changed; obtain a new context.')
      return current.path
    } : undefined
    const { profile, installation } = await this.runtime(id).execContext(context.signal, authorizeSource)
    const launcher = join(this.runtimeHome(id), `sdk-exec-${randomUUID()}.mjs`)
    writePrivateFile(launcher, sdkLauncher(profile))
    return { runtimeId: id, sourceRoot, sourcePath: initial?.path, executable: process.execPath, launcher, env: { ELECTRON_RUN_AS_NODE: '1' },
      distribution: installation.distribution, linuxNode: installation.node,
      usage: 'Run executable launcher absolute-script.mjs [args...] using ordinary exec from a local host workspace. Script exports default async ({runtime,open,args}) => {...}. runtime.project provides official list/start_init/get_init; open(name) opens one official agent SDK client per exec process. Do not log private launcher contents. No worker is started by this launcher.' }
  }
  async register(input: unknown, context: ExecutionContext) {
    this.assertOwner(context)
    const value = resourceSchema.parse(input)
    if ((await this.record(value.runtimeId)).phase !== 'ready') throw new ToolNoEffectError('Runtime is not ready.')
    const config = await this.runtime(value.runtimeId).projectConfiguration(value.layerfsProject, value.image, context.signal)
    const output = JSON.parse(await (this.dependencies.bridge ?? runBridge)(config, value.layerfsProject, 'validate_ref', { ref: value.baselineRef }, context.signal))
    if (output.ok !== true || output.result?.ref !== value.baselineRef) throw new ToolNoEffectError('Official baseline identity is unavailable.')
    return this.catalog.register(value)
  }
  private journal(value: LayerFSResource) { return join(this.root, 'operations', value.runtimeId, value.layerfsProject + '.jsonl') }
  ready(revision: string) {
    const value = this.catalog.get(revision)
    return value
  }
  async execute(action: string, args: Record<string, unknown>, context: ExecutionContext, lifecycle?: { observe: (text: string) => void }): Promise<ToolResult> {
    if (context.projectId !== this.projectId || context.remoteWorkdir || context.recoveringToolCall) throw new ToolNoEffectError('Invalid resource execution context; no replay/fallback.')
    if (!['list', 'branches', 'history', 'diff', 'merge', 'publish', 'fork', 'branch_workspace', 'status', 'read', 'write', 'search', 'exec'].includes(action)) throw new ToolNoEffectError('Unsupported resource operation.')
    for (const key of ['branch', 'ref', 'name']) if (args[key] !== undefined && (typeof args[key] !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$/.test(String(args[key])) || String(args[key]).split('/').includes('..'))) throw new ToolNoEffectError(`Invalid ${key}.`)
    const required: Record<string, string[]> = { history: ['branch'], diff: ['ref', 'branch'], merge: ['ref', 'branch', 'name'], publish: ['branch'], fork: ['branch', 'ref'], branch_workspace: ['branch'] }
    for (const key of required[action] ?? []) if (!args[key]) throw new ToolNoEffectError(`Missing ${key}.`)
    if (args.offset !== undefined && (!Number.isSafeInteger(args.offset) || Number(args.offset) < 0)) throw new ToolNoEffectError('Invalid page offset.')
    const binding = typeof args.workspace === 'string' ? parseBranchWorkspace(args.workspace) : undefined
    if (binding && !this.catalog.hasWorkspace(String(args.workspace))) throw new ToolNoEffectError('Workspace was not minted by this Project resource service; forged identity refused.')
    const value = this.ready(String(binding?.resourceId ?? args.resourceId))
    if (binding && (binding.version !== 3 || binding.ownerProject !== this.projectId || binding.runtimeId !== value.runtimeId || binding.project !== value.layerfsProject)) throw new ToolNoEffectError('Workspace immutable catalog binding mismatch.')
    if ((await this.record(value.runtimeId)).phase !== 'ready') throw new ToolNoEffectError('Runtime catalog is not ready.')
    const config = await this.runtime(value.runtimeId).projectConfiguration(value.layerfsProject, value.image!, context.signal)
    const output = await (this.dependencies.bridge ?? runBridge)(config, value.layerfsProject, action, { ...args, journal: this.journal(value), binding: { ownerProject: this.projectId, runtimeId: value.runtimeId, resourceId: value.revision } }, context.signal, undefined, lifecycle)
    if (action === 'branch_workspace') {
      const receipt = JSON.parse(output)
      const candidate = receipt.result?.workspace
      if (receipt.ok !== true || typeof candidate !== 'string') throw new ToolOutcomeUnknownError('Missing official workspace binding receipt.')
      const minted = parseBranchWorkspace(candidate)
      if (minted.version !== 3 || minted.ownerProject !== this.projectId || minted.runtimeId !== value.runtimeId || minted.resourceId !== value.revision || minted.project !== value.layerfsProject || minted.branch !== args.branch) throw new ToolOutcomeUnknownError('Invalid workspace binding receipt.')
      this.catalog.bindWorkspace(candidate)
    }
    return output
  }
  async createWorkspace(args: Record<string, unknown>, context: ExecutionContext, register: (mount: string, context: ExecutionContext, description?: string) => Promise<{ id: string }>, validateWork: (key: string) => void, sourceBinding?: string) {
    const binding = sourceBinding ? parseBranchWorkspace(sourceBinding) : undefined
    if (binding && !this.catalog.hasWorkspace(sourceBinding!)) throw new ToolNoEffectError('Source workspace was not minted by this resource service.')
    const value = this.ready(String(binding?.resourceId ?? args.source))
    if (binding && (binding.version !== 3 || binding.ownerProject !== this.projectId || binding.runtimeId !== value.runtimeId || binding.project !== value.layerfsProject || binding.branch !== args.source)) throw new ToolNoEffectError('Source resource binding mismatch.')
    let service = this.workspaces.get(value.revision)
    if (!service) {
      service = new LayerFSWorkspaces({ projectId: this.projectId, directory: join(this.root, 'workspace-creation', value.revision),
        identity: async () => { this.ready(value.revision); return `resource:${value.revision}` }, bindingProject: async () => value.layerfsProject,
        run: (input, ctx) => this.execute(String(input.action), { ...input, resourceId: value.revision }, ctx), register, validateWork })
      this.workspaces.set(value.revision, service)
    }
    return service.create({ ...args, source: binding?.branch ?? value.baselineRef }, context, sourceBinding)
  }
  async close() {
    const results = await Promise.allSettled([...this.runtimes.values()].map(runtime => runtime.close()))
    const failures = results.filter(result => result.status === 'rejected')
    if (failures.length) throw new AggregateError(failures.map(result => result.reason), 'Runtime shutdown retained unresolved resources.')
  }
}
const services = new Map<string, LayerFSResources>()
export function layerfsResources(project: string, home: string, create?: () => LayerFSResources) {
  const key = `${resolve(home)}\0${project}`
  let service = services.get(key)
  if (!service) { service = create?.() ?? new LayerFSResources(project, home); services.set(key, service) }
  return service
}

export async function closeLayerFSResources(project: string, home: string) {
  const key = `${resolve(home)}\0${project}`, service = services.get(key)
  if (!service) return
  try { await service.close() } finally { if (services.get(key) === service) services.delete(key) }
}
