import { projectStoragePath } from '../utils/data-paths.ts'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile, rename, unlink } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { z } from 'zod'
import { FolderError, type FolderRegistry } from '../folders/registry.ts'
import { ProcessManager, type ManagedProcess } from '../execution/processes/manager.ts'

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

/** Definitions persist per project; process handles and bounded run history are ephemeral. */
export class ProjectActions {
  #actions: UserAction[] = []
  #writes: Promise<unknown> = Promise.resolve()
  #runs = new Map<string, { run: ActionRun; process: ManagedProcess }>()
  #closing = false
  #launches = new Set<Promise<ActionRun>>()
  #starting = 0
  readonly filePath: string
  constructor(home: string, private folders: FolderRegistry, private processes = new ProcessManager(), private localExecutor = true) {
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
    if (folder.kind === 'remote') throw new FolderError('remote_actions_unsupported', 'User actions currently require a registered local folder.', 409)
    return this.folders.requireAvailable(id)
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
      await this.#local(data.folderId)
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
      if (data.folderId !== undefined) await this.#local(data.folderId)
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
      const folder = await this.#local(folderId)
      let pkg: unknown
      try { pkg = JSON.parse(await readFile(join(folder.path, 'package.json'), 'utf8')) }
      catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { scripts: [], packageManager: 'npm' }; throw new FolderError('invalid_package_json', 'Unable to read package.json scripts.', 400) }
      const parsed = z.object({ scripts: z.record(z.string(), z.string()).optional() }).passthrough().safeParse(pkg)
      if (!parsed.success) throw new FolderError('invalid_package_json', 'Invalid package.json scripts.', 400)
      // npm lifecycle/PATH semantics, with only shell-safe names accepted on all supported hosts.
      const entries = Object.entries(parsed.data.scripts ?? {})
      const safeName = (name: string) => /^[a-zA-Z0-9_][a-zA-Z0-9_:@./-]*$/.test(name)
      return { packageManager: 'npm', scripts: entries.filter(([name]) => safeName(name)).map(([name, script]) => ({ name, command: `npm run ${name}`, script })), unsupportedScripts: entries.filter(([name]) => !safeName(name)).map(([name]) => name) }
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
    if (!this.localExecutor) throw new FolderError('local_executor_disabled', 'Main local executor is disabled. Local Quick Actions cannot run; no Main or remote fallback is available.', 409)
    if (this.#closing) throw new FolderError('actions_stopping', 'Project is shutting down.', 503)
    const action = structuredClone(this.#actions.find(a => a.id === id))
    if (!action) throw new FolderError('action_not_found', 'Action not found.', 404)
    if (this.#starting + [...this.#runs.values()].filter(v => !v.run.finishedAt).length >= 20) throw new FolderError('runs_limit', 'At most 20 active runs.', 409)
    const release = this.folders.acquireAccess()
    this.#starting++
    try {
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
      this.#runs.set(run.id, { run, process })
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
  async stop(id: string) {
    const entry = this.#runs.get(id)
    if (!entry) throw new FolderError('run_not_found', 'Run not found.', 404)
    if (!entry.run.finishedAt) {
      entry.run.state = 'stopping'
      try { await this.processes.terminate(entry.process) }
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
