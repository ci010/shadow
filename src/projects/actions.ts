import { projectStoragePath } from '../utils/data-paths.ts'
import { randomUUID } from 'node:crypto'
import { access, mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { FolderError, type FolderRegistry } from '../folders/registry.ts'
import { ProcessManager } from '../execution/processes/manager.ts'
import type { Executor } from '../execution/executor.ts'
import { executeRemoteFilesystemText } from '../execution/remote-filesystem-client.ts'
import type { ExecutionReceiptV1 } from '../execution/contracts.ts'
import { isUnknownShellReceipt } from '../execution/shell-journal.ts'

const fields = {
  name: z.string().trim().min(1).max(120),
  command: z.string().min(1).max(32_000).refine(v => !!v.trim() && !v.includes('\0')),
  folderId: z.string().uuid(), pinned: z.boolean(),
}
export const ActionCreateSchema = z.object({ ...fields, pinned: fields.pinned.default(false) }).strict()
export const ActionPatchSchema = z.object(fields).partial().strict().refine(v => Object.keys(v).length > 0)
const ActionSchema = z.object({ ...fields, id: z.string().uuid(), createdAt: z.string().datetime(), updatedAt: z.string().datetime() }).strict()
export type UserAction = z.infer<typeof ActionSchema>
export interface ActionRun {
  id: string; actionId: string; name: string; command: string; folderId: string
  state: 'running' | 'stopping' | 'succeeded' | 'failed' | 'stopped'
  startedAt: string; finishedAt?: string; exitCode?: number; stdout: string; stderr: string
}
const MAX_LOG = 128_000

/** Never interpolate package-supplied executable names or version strings into shell code. */
async function scriptPackageManager(folder: string, declared: unknown, remoteEntries?: Set<string>): Promise<'npm' | 'pnpm' | 'yarn' | 'bun'> {
  if (typeof declared === 'string') {
    const match = /^(npm|pnpm|yarn|bun)@\d[0-9A-Za-z.+_-]*$/.exec(declared)
    if (match) return match[1] as 'npm' | 'pnpm' | 'yarn' | 'bun'
  }
  const locks = [['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'], ['package-lock.json', 'npm']] as const
  const found = new Set<'npm' | 'pnpm' | 'yarn' | 'bun'>()
  for (const [file, manager] of locks) {
    if (remoteEntries) { if (remoteEntries.has(file)) found.add(manager); continue }
    try { await access(join(folder, file)); found.add(manager) }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  // Conflicting lockfiles are not enough evidence to choose a different runner.
  return found.size === 1 ? [...found][0] : 'npm'
}

/** Definitions persist per project; process handles and bounded run history are ephemeral. */
export class ProjectActions {
  #actions: UserAction[] = []
  #writes: Promise<unknown> = Promise.resolve()
  #runs = new Map<string, { run: ActionRun; stop: () => Promise<unknown> }>()
  #closing = false
  #launches = new Set<Promise<ActionRun>>()
  #starting = 0
  readonly filePath: string
  constructor(home: string, private folders: FolderRegistry, private processes = new ProcessManager(), private localExecutor = true, private remoteExecutor?: Executor) {
    this.filePath = projectStoragePath(home, 'user-actions.v1.json')
  }
  async init() {
    try {
      const value = z.object({ version: z.literal(1), actions: z.array(ActionSchema).max(500) }).strict().parse(JSON.parse(await readFile(this.filePath, 'utf8')))
      if (new Set(value.actions.map(a => a.id)).size !== value.actions.length) throw new Error('Duplicate action IDs')
      this.#actions = value.actions
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
  }
  list() { return structuredClone(this.#actions) }
  async #local(id: string) {
    const folder = this.folders.get(id)
    if (!folder) throw new FolderError('folder_not_found', 'Folder not found.', 404)
    // Remote display paths are never interpreted on Main.
    if (folder.kind === 'remote' || folder.kind === 'layerfs') throw new FolderError('remote_actions_unsupported', 'User actions currently require a registered local folder.', 409)
    return this.folders.requireAvailable(id)
  }
  async #savedTarget(id: string) {
    const folder = this.#target(id)
    return folder.kind === 'remote' ? folder : this.#local(id)
  }
  #target(id: string) {
    const folder = this.folders.get(id)
    if (!folder) throw new FolderError('folder_not_found', 'Folder not found.', 404)
    if (folder.kind === 'layerfs') throw new FolderError('remote_actions_unsupported', 'LayerFS Quick Actions are not supported.', 409)
    return folder
  }
  #mutate<T>(fn: (next: UserAction[]) => Promise<T> | T): Promise<T> {
    const pending = this.#writes.then(async () => {
      if (this.#closing) throw new FolderError('actions_stopping', 'Project is shutting down.', 503)
      const next = structuredClone(this.#actions)
      const release = this.folders.acquireAccess()
      try {
        const result = await fn(next)
        await mkdir(dirname(this.filePath), { recursive: true })
        const temp = `${this.filePath}.${randomUUID()}.tmp`
        try { await writeFile(temp, JSON.stringify({ version: 1, actions: next }), { mode: 0o600, flag: 'wx' }); await rename(temp, this.filePath) }
        finally { await unlink(temp).catch(error => { if (error.code !== 'ENOENT') throw error }) }
        this.#actions = next
        return result
      } finally { release() }
    })
    this.#writes = pending.catch(() => {})
    return pending
  }
  create(body: unknown) {
    const data = ActionCreateSchema.parse(body)
    return this.#mutate(async next => {
      await this.#savedTarget(data.folderId)
      if (next.length >= 500) throw new FolderError('actions_limit', 'At most 500 actions per project.', 409)
      const now = new Date().toISOString()
      const action = { ...data, id: randomUUID(), createdAt: now, updatedAt: now }
      next.push(action); return structuredClone(action)
    })
  }
  patch(id: string, body: unknown) {
    const data = ActionPatchSchema.parse(body)
    return this.#mutate(async next => {
      const action = next.find(a => a.id === id)
      if (!action) throw new FolderError('action_not_found', 'Action not found.', 404)
      if (data.folderId !== undefined) await this.#savedTarget(data.folderId)
      Object.assign(action, data, { updatedAt: new Date().toISOString() }); return structuredClone(action)
    })
  }
  delete(id: string) {
    return this.#mutate(next => {
      const index = next.findIndex(a => a.id === id)
      if (index < 0) throw new FolderError('action_not_found', 'Action not found.', 404)
      next.splice(index, 1)
    })
  }
  async scripts(folderId: string) {
    const release = this.folders.acquireAccess()
    try {
      const target = this.#target(folderId)
      const folder = target.kind === 'remote' ? target : await this.#local(folderId)
      let remoteEntries: Set<string> | undefined
      const remoteRead = async (path: string) => {
        if (folder.kind !== 'remote' || !this.remoteExecutor) throw new FolderError('remote_executor_unavailable', 'Child filesystem reads are unavailable. No Main fallback.', 503)
        return executeRemoteFilesystemText({ executor: this.remoteExecutor, ...folder.workdir,
          sessionId: `folder:${folderId}`, turnId: randomUUID(), signal: new AbortController().signal }, 'filesystem.read', { path }, 1024 * 1024)
      }
      if (folder.kind === 'remote') {
        remoteEntries = new Set((await remoteRead('.')).split('\n'))
        if (!remoteEntries.has('package.json')) return { scripts: [], packageManager: 'npm' }
      }
      // Transport/permission errors must remain errors, never an empty discovery.
      const source = folder.kind === 'remote' ? await remoteRead('package.json') : undefined
      let pkg: unknown
      try { pkg = JSON.parse(folder.kind === 'remote' ? source! : await readFile(join(folder.path, 'package.json'), 'utf8')) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { scripts: [], packageManager: 'npm' }; throw new FolderError('invalid_package_json', 'Unable to read package.json scripts.', 400) }
      const parsed = z.object({ scripts: z.record(z.string(), z.string()).optional() }).passthrough().safeParse(pkg)
      if (!parsed.success) throw new FolderError('invalid_package_json', 'Invalid package.json scripts.', 400)
      // Keep the repository's runner/PATH semantics, not an unconditional npm fallback.
      const packageManager = await scriptPackageManager(folder.kind === 'remote' ? '' : folder.path, parsed.data.packageManager, remoteEntries)
      const entries = Object.entries(parsed.data.scripts ?? {})
      const safeName = (name: string) => /^[a-zA-Z0-9_][a-zA-Z0-9_:@./-]*$/.test(name)
      return { packageManager, scripts: entries.filter(([name]) => safeName(name)).map(([name, script]) => ({ name, command: `${packageManager} run ${name}`, script })), unsupportedScripts: entries.filter(([name]) => !safeName(name)).map(([name]) => name) }
    } finally { release() }
  }
  runs() { return [...this.#runs.values()].map(v => structuredClone(v.run)).reverse() }
  getRun(id: string) {
    const entry = this.#runs.get(id)
    if (!entry) throw new FolderError('run_not_found', 'Run not found.', 404)
    return structuredClone(entry.run)
  }
  run(id: string) {
    const pending = this.#start(id)
    this.#launches.add(pending)
    void pending.finally(() => this.#launches.delete(pending)).catch(() => {})
    return pending
  }
  async #start(id: string): Promise<ActionRun> {
    if (this.#closing) throw new FolderError('actions_stopping', 'Project is shutting down.', 503)
    const action = structuredClone(this.#actions.find(a => a.id === id))
    if (!action) throw new FolderError('action_not_found', 'Action not found.', 404)
    if (this.#starting + [...this.#runs.values()].filter(v => !v.run.finishedAt).length >= 20) throw new FolderError('runs_limit', 'At most 20 active runs.', 409)
    const release = this.folders.acquireAccess()
    this.#starting++
    try {
      const target = this.#target(action.folderId)
      if (target.kind === 'remote') return await this.#startRemote(action, target.workdir, release)
      if (!this.localExecutor) throw new FolderError('local_executor_disabled', 'Main local executor is disabled. Local Quick Actions cannot run; no Main or remote fallback is available.', 409)
      const folder = await this.#local(action.folderId)
      const process = await this.processes.spawn(action.command, folder.path, undefined, undefined, [], { isolated: true })
      const run: ActionRun = { id: randomUUID(), actionId: action.id, name: action.name, command: action.command, folderId: action.folderId, state: 'running', startedAt: new Date().toISOString(), stdout: '', stderr: '' }
      const out = new TextDecoder(), err = new TextDecoder()
      const drain = (final = false) => {
        for (const chunk of process.stdoutChunks.splice(0)) run.stdout = (run.stdout + out.decode(chunk, { stream: true })).slice(-MAX_LOG)
        for (const chunk of process.stderrChunks.splice(0)) run.stderr = (run.stderr + err.decode(chunk, { stream: true })).slice(-MAX_LOG)
        if (final) { run.stdout = (run.stdout + out.decode()).slice(-MAX_LOG); run.stderr = (run.stderr + err.decode()).slice(-MAX_LOG) }
      }
      const timer = setInterval(drain, 100); timer.unref()
      this.#runs.set(run.id, { run, stop: () => this.processes.terminate(process) })
      void process.exitPromise.then(status => {
        clearInterval(timer); drain(true)
        run.state = run.state === 'stopping' ? 'stopped' : status.success ? 'succeeded' : 'failed'
        run.exitCode = status.code; run.finishedAt = new Date().toISOString()
        this.processes.remove(process.pid); release()
        while (this.#runs.size > 100) {
          const completed = [...this.#runs].find(([, v]) => v.run.finishedAt)
          if (!completed) break
          this.#runs.delete(completed[0])
        }
      })
      return structuredClone(run)
    } catch (error) { release(); throw error }
    finally { this.#starting-- }
  }
  async #startRemote(action: UserAction, workdir: { nodeId: string; workdirId: string }, release: () => void): Promise<ActionRun> {
    const executor = this.remoteExecutor
    if (!executor) throw new FolderError('remote_executor_unavailable', 'Child execution is unavailable. No Main fallback.', 503)
    const id = randomUUID(), now = new Date()
    const request = {
      version: 2 as const, jobId: id, idempotencyKey: id, sessionId: `folder:${action.folderId}`, turnId: id,
      nodeId: workdir.nodeId, workdirId: workdir.workdirId, operation: 'workdir.process.execute-once',
      args: { script: action.command, lifetime: 'until-exit' }, createdAt: now.toISOString(),
      deadlineAt: new Date(now.getTime() + 120_000).toISOString(),
    }
    const signal = new AbortController().signal
    await executor.assertCanExecute?.(request, signal)
    const run: ActionRun = { id, actionId: action.id, name: action.name, command: action.command, folderId: action.folderId,
      state: 'running', startedAt: now.toISOString(), stdout: '', stderr: '' }
    const finish = (receipt: ExecutionReceiptV1) => {
      if (receipt.jobId !== id || receipt.nodeId !== workdir.nodeId) throw new Error('Uncorrelated Child receipt')
      if (isUnknownShellReceipt(receipt)) throw new Error(receipt.reason?.message ?? 'Child execution outcome unknown')
      if (run.finishedAt) return
      run.state = receipt.state === 'cancelled' ? 'stopped' : receipt.state === 'completed' ? 'succeeded' : 'failed'
      run.exitCode = receipt.exitCode; run.finishedAt = receipt.finishedAt
      if (receipt.reason) run.stderr = (run.stderr + `\n${receipt.reason.message}`).slice(-MAX_LOG)
      release()
      while (this.#runs.size > 100) {
        const completed = [...this.#runs].find(([, v]) => v.run.finishedAt)
        if (!completed) break
        this.#runs.delete(completed[0])
      }
    }
    let streamDone!: () => void, admissionDone!: () => void
    const done = new Promise<void>(resolve => { streamDone = resolve })
    const admitted = new Promise<void>(resolve => { admissionDone = resolve })
    this.#runs.set(id, { run, stop: async () => {
      const result = await executor.cancel(id)
      if (result.status?.receipt) finish(result.status.receipt)
      if (result.outcome === 'requested' && !run.finishedAt) {
        let timer: ReturnType<typeof setTimeout> | undefined
        try { await Promise.race([done, new Promise<void>(resolve => { timer = setTimeout(resolve, 10_000) })]) }
        finally { clearTimeout(timer) }
      }
      if (!run.finishedAt) throw new FolderError('remote_stop_unconfirmed', 'Child process stop is not confirmed. Restore the Child connection and retry Stop; no fallback.', 503)
    } })
    // Do not abort transport on HTTP response completion: the Project owns this run.
    void (async () => {
      try {
        for await (const event of executor.execute(request, signal)) {
          if (event.jobId !== id) throw new Error('Uncorrelated Child event')
          admissionDone()
          if (event.type === 'stdout' || event.type === 'stderr') run[event.type] = (run[event.type] + event.chunk).slice(-MAX_LOG)
          if ('receipt' in event) finish(event.receipt)
        }
        if (!run.finishedAt) throw new Error('Child execution ended without a terminal receipt')
      } catch (error) {
        // A transport failure is NOT evidence the process stopped. Retain the
        // access lease and active run; cancellation can later confirm cleanup.
        if (!run.finishedAt) run.stderr = (run.stderr + `\nChild execution outcome unknown: ${error instanceof Error ? error.message : String(error)}. Restore connection and retry Stop.`).slice(-MAX_LOG)
      } finally { streamDone(); admissionDone() }
    })()
    // Admission must have entered the Project executor before Stop/shutdown can
    // address this job. An unregistered cancellation cannot prevent a later spawn.
    await admitted
    return structuredClone(run)
  }
  async stop(id: string) {
    const entry = this.#runs.get(id)
    if (!entry) throw new FolderError('run_not_found', 'Run not found.', 404)
    if (!entry.run.finishedAt) {
      entry.run.state = 'stopping'
      try { await entry.stop() }
      catch (error) {
        if (!entry.run.finishedAt) entry.run.state = 'running'
        throw error
      }
    }
    return this.getRun(id)
  }
  async shutdown() {
    this.#closing = true
    await Promise.allSettled([...this.#launches])
    const results = await Promise.allSettled([...this.#runs.keys()].map(id => this.stop(id)))
    await this.#writes
    const errors = results.filter(r => r.status === 'rejected').map(r => r.reason)
    if (errors.length) throw new AggregateError(errors, 'Action processes failed to stop')
  }
}
