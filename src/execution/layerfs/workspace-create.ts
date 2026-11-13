import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { join, toNamespacedPath } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { parseBranchWorkspace } from './workspace-identity.ts'
import type { ExecutionContext } from '../../tools/context.ts'
import { isCompletedToolFailure, toolResultText, ToolNoEffectError, ToolOutcomeUnknownError, type ToolResult } from '../../tools/tool.ts'

export interface LayerFSWorkspaceRequest {
  source: string
  branch?: string
  idempotencyKey?: string
  description?: string
  name?: string
  workKey?: string
}
interface Creation {
  fingerprint: string
  identity: string
  branch: string
  source: string
  phase: 'planned' | 'fork-dispatched' | 'forked' | 'binding-dispatched' | 'bound' | 'failed'
  workspace?: string
}
const queues = new Map<string, Promise<unknown>>()

/** A LayerFS committed-branch identity is deliberately NOT registered as a host directory. Creation
 * journals preserve uncertain mutations; retrying a request never repeats them. */
export class LayerFSWorkspaces {
  constructor(private readonly options: {
    projectId: string
    directory: string
    identity: () => Promise<string>
    bindingProject?: () => Promise<string>
    run: (args: Record<string, unknown>, context: ExecutionContext) => Promise<ToolResult>
    register: (mount: string, context: ExecutionContext, description?: string) => Promise<{ id: string }>
    validateWork?: (key: string) => void
  }) {}

  async create(args: Record<string, unknown>, context: ExecutionContext, sourceBinding?: string): Promise<string> {
    if (context.projectId !== this.options.projectId || context.remoteWorkdir || context.recoveringToolCall || context.scriptInvocation) throw new ToolNoEffectError('LayerFS workspace creation requires a direct local invocation; no fallback or replay.')
    for (const [key, value] of Object.entries(args)) {
      if (!['source', 'branch', 'idempotencyKey', 'description', 'name', 'workKey'].includes(key) || typeof value !== 'string' || (!value && key !== 'description') || value.length > 2000 || /[\x00-\x1f\x7f]/.test(value)) throw new ToolNoEffectError('Invalid LayerFS workspace creation parameters. Use source (an imported LayerFS branch), optional branch and idempotencyKey only.')
    }
    const source = args.source
    if (typeof source !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$/.test(source) || source.split('/').includes('..')) throw new ToolNoEffectError('LayerFS source must be an existing imported branch name, not a host path or workspace selector.')
    if (args.branch !== undefined && (typeof args.branch !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,255}$/.test(args.branch) || args.branch.split('/').includes('..'))) throw new ToolNoEffectError('Invalid new LayerFS branch name.')
    if (args.branch === source) throw new ToolNoEffectError('The new LayerFS branch must differ from its source.')
    if (args.name !== undefined && !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/.test(String(args.name))) throw new ToolNoEffectError('Invalid workspace name.')
    if (typeof args.workKey === 'string') {
      if (!this.options.validateWork) throw new ToolNoEffectError('Work association validation is unavailable.')
      this.options.validateWork(args.workKey)
    }
    const recoveryKey = typeof args.idempotencyKey === 'string' ? args.idempotencyKey : randomUUID()
    const file = join(this.options.directory, createHash('sha256').update(recoveryKey).digest('hex') + '.json')
    const fingerprint = createHash('sha256').update(JSON.stringify([this.options.projectId, source, args.branch ?? null, args.name ?? null, args.description ?? null, args.workKey ?? null, ...(sourceBinding === undefined ? [] : [sourceBinding])])).digest('hex')
    const prior = queues.get(file) ?? Promise.resolve()
    const pending = prior.catch(() => {}).then(async () => {
      let lock: DatabaseSync | undefined
      const save = async (record: Creation) => {
        const temporary = `${file}.${randomUUID()}.tmp`
        const handle = await open(temporary, 'wx', 0o600)
        try { await handle.writeFile(JSON.stringify(record)); await handle.sync() } finally { await handle.close() }
        await rename(temporary, file)
      }
      try {
        context.signal.throwIfAborted()
        const identity = await this.options.identity()
        const validateBinding = async () => {
          if (sourceBinding === undefined) return
          if (!this.options.bindingProject) throw new ToolNoEffectError('LayerFS binding validation is unavailable; no dispatch.')
          const binding = parseBranchWorkspace(sourceBinding, await this.options.bindingProject())
          if (binding.branch !== source || await this.options.identity() !== identity) throw new ToolNoEffectError('LayerFS source binding/connection changed; no redirection.')
        }
        await validateBinding()
        await mkdir(this.options.directory, { recursive: true })
        lock = new DatabaseSync(toNamespacedPath(`${file}.lock.sqlite`))
        lock.exec('BEGIN IMMEDIATE')
        let record: Creation
        try {
          record = JSON.parse(await readFile(file, 'utf8'))
          if (record.fingerprint !== fingerprint || record.identity !== identity || record.source !== source || typeof record.branch !== 'string' || (args.branch !== undefined && record.branch !== args.branch) || !['planned', 'fork-dispatched', 'forked', 'binding-dispatched', 'bound', 'failed'].includes(record.phase)) throw new ToolNoEffectError('LayerFS creation identity or idempotency parameters changed; retained resources were not touched.')
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
          record = { fingerprint, identity, source, branch: typeof args.branch === 'string' ? args.branch : `shadow-derived-${args.name ? String(args.name) + '-' : ''}${randomUUID()}`, phase: 'planned' }
          await save(record)
        }
        const run = async (request: Record<string, unknown>) => {
          context.signal.throwIfAborted()
          if (await this.options.identity() !== identity) throw new ToolNoEffectError('LayerFS namespace changed during creation; retained resources were not redirected.')
          await validateBinding()
          const result = await this.options.run({ ...request, ...(identity.startsWith('managed:') ? { namespace: identity.slice('managed:'.length) } : {}) }, context)
          const receipt = JSON.parse(toolResultText(result))
          if (isCompletedToolFailure(result) || receipt.ok !== true) {
            record.phase = 'failed'; await save(record)
            throw new Error('LayerFS workspace creation was refused by the SDK. Inspect branches/sandboxes; partial resources are retained, not replayed.')
          }
          return receipt.result
        }
        if (record.phase === 'fork-dispatched' || record.phase === 'binding-dispatched') throw new ToolOutcomeUnknownError('LayerFS creation has an unconfirmed mutation. Inspect branches/sandboxes and reconcile; this request was not replayed.')
        if (record.phase === 'failed') throw new ToolNoEffectError('This LayerFS creation previously failed. Inspect retained branches/sandboxes; use a new request only after reconciliation.')
        if (record.phase === 'planned') {
          record.phase = 'fork-dispatched'; await save(record)
          await run({ action: 'fork', branch: record.branch, ref: source })
          record.phase = 'forked'; await save(record)
        }
        if (record.phase === 'forked') {
          record.phase = 'binding-dispatched'; await save(record)
          const mounted = await run({ action: 'branch_workspace', branch: record.branch })
          if (typeof mounted?.workspace !== 'string' || !mounted.workspace.startsWith('layerfs:')) throw new ToolOutcomeUnknownError('LayerFS branch binding receipt lacks a workspace ID; inspect branches, do not repeat creation.')
          record.workspace = mounted.workspace; record.phase = 'bound'; await save(record)
        }
        if (!record.workspace?.startsWith('layerfs:')) throw new ToolOutcomeUnknownError('Invalid retained LayerFS branch binding receipt; no mutation was replayed.')
        if (parseBranchWorkspace(record.workspace).branch !== record.branch) throw new ToolOutcomeUnknownError('Retained LayerFS branch identity differs from the creation journal; no registration or replay.')
        const description = `${args.description ? String(args.description) + '\n' : ''}LayerFS workspace from ${record.source} (${record.branch})${args.workKey ? `; Work ${String(args.workKey)}` : ''}`
        await validateBinding()
        const registered = await this.options.register(record.workspace, context, description)
        return JSON.stringify({ backend: 'layerfs', source: record.source, branch: record.branch, workspaceId: registered.id,
          idempotencyKey: recoveryKey, description, ...(args.workKey ? { workKey: args.workKey } : {}), registered: true, location: { backend: 'layerfs', mount: record.workspace },
          routing: 'Use the registered workspaceId with ordinary tools or workspace_use. Branch location is display metadata only, never a Main path. File writes and completed exec checkpoint automatically.',
          delivery: 'Checkpoint/publish retain LayerFS changes only; no automatic export to the original checkout.' })
      } catch (error) {
        const message = `${error instanceof Error ? error.message : String(error)} Recovery idempotencyKey: ${recoveryKey}`
        if (error instanceof ToolOutcomeUnknownError) throw new ToolOutcomeUnknownError(message, { cause: error })
        if (error instanceof ToolNoEffectError) throw new ToolNoEffectError(message, { cause: error })
        throw new Error(message, { cause: error })
      } finally { lock?.close() }
    })
    queues.set(file, pending)
    try { return await pending } finally { if (queues.get(file) === pending) queues.delete(file) }
  }
}
