import { FILESYSTEM_READ_OPERATION } from '../execution/capability-filesystem.ts'
import { LayerFSImportReview } from '../execution/layerfs/import-review.ts'
import { IMPORT_TIMEOUT, importTimeoutMs } from '../execution/layerfs/import-timeout.ts'
import { backgroundExecutionId, type BackgroundTaskManager } from '../agent/background-task.ts'
import { configuration, LayerFSConfigurationError, layerfsName, runBridge } from '../execution/layerfs/bridge.ts'
import { managedLayerFS, type ManagedLayerFS } from '../execution/layerfs/managed.ts'
import type { LayerFSBootstrap } from '../execution/layerfs/bootstrap.ts'
import type { LayerFSWorkflow } from '../execution/layerfs/workflow.ts'
import type { ExecutionContext } from './context.ts'
import { ToolNoEffectError, completedToolFailure, type Tool, type ToolParameters, type ToolResult } from './tool.ts'

const actions = ['doctor', 'setup', 'connect', 'runtime_status', 'bootstrap_plan', 'bootstrap', 'bootstrap_status', 'bootstrap_recover', 'bootstrap_recover_connection', 'import_preview', 'import_status', 'import_recovery_plan', 'import_recover', 'namespace_status', 'baseline_plan', 'baseline_prepare', 'create', 'list', 'branches', 'history', 'fork', 'load', 'mount', 'status', 'read', 'write', 'exec', 'commit', 'close', 'diff', 'merge', 'publish'] as const
const workspaceActions = new Set(['status', 'read', 'write', 'exec', 'commit', 'close'])
const busy = new Set<string>()
const reviewServices = new Map<string, LayerFSImportReview>()
export function validateLayerArgs(a: Record<string, unknown>, project: string): void {
  if (!actions.includes(a.action as typeof actions[number])) throw new Error('Unsupported LayerFS action.')
  const required: Record<string, string[]> = {
    import_preview: ['workspace'], baseline_plan: ['workspace', 'destinationWorkspace'], baseline_prepare: ['workspace', 'destinationWorkspace'], create: ['workspace'], history: ['branch'], fork: ['branch'], load: ['branch', 'ref'], mount: ['branch'],
    read: ['path'], write: ['path', 'content'], exec: ['command'], diff: ['ref', 'branch'], merge: ['ref', 'branch', 'name'], publish: ['branch'],
  }
  for (const key of required[String(a.action)] ?? []) if (typeof a[key] !== 'string' || (key !== 'content' && !a[key])) throw new Error(`Missing ${key}.`)
  for (const key of ['branch', 'ref', 'name', 'message', 'command', 'path', 'workspace', 'content']) {
    if (a[key] !== undefined && typeof a[key] !== 'string') throw new Error(`Invalid ${key}.`)
  }
  if (typeof a.content === 'string' && Buffer.byteLength(a.content) > 65536) throw new Error('Write is limited to 64 KiB per call.')
  if (typeof a.command === 'string' && Buffer.byteLength(a.command) > 65536) throw new Error('Command too large.')
  if (a.path !== undefined && (!a.path || String(a.path).includes('\0') || String(a.path).split('/').includes('..'))) throw new Error('Expected sandbox-relative file path without traversal.')
  if (a.offset !== undefined && (!Number.isSafeInteger(a.offset) || Number(a.offset) < 0)) throw new Error('Invalid page offset.')
  if (a.action === 'read') {
    a.start ??= 1; a.end ??= Number(a.start) + 199
    if (!Number.isSafeInteger(a.start) || !Number.isSafeInteger(a.end) || Number(a.start) < 1 || Number(a.end) < Number(a.start) || Number(a.end) - Number(a.start) > 999) throw new Error('Read requires 1–1000 lines.')
  }
  if (workspaceActions.has(String(a.action))) {
    if (typeof a.workspace !== 'string' || a.workspace.length > 1024) throw new Error('Expected LayerFS workspace ID returned by mount.')
    let ws: { project?: string; sandbox?: string; path?: string }
    try { ws = JSON.parse(Buffer.from(a.workspace.replace(/^layerfs:/, ''), 'base64url').toString()) } catch { throw new Error('Invalid LayerFS workspace ID.') }
    if (ws.project !== project || !/^\d+$/.test(ws.sandbox ?? '') || !/^\/workspaces\/\d+$/.test(ws.path ?? '')) throw new Error('Workspace ID is invalid or belongs to another Project or quarantined namespace.')
  }
}

export class LayerFSTool implements Tool<ToolResult> {
  readonly name = 'layerfs'
  readonly description = 'Optional real LayerFS 1.1 SDK bridge. Use connect as the everyday entry: reuse approved managed Windows/WSL, or return an automatic first-run bootstrap plan. After one explicit owner approval, bootstrap downloads/builds pinned official sources in the selected existing WSL distro and connects automatically in a background job; no user paths or environment edits. Requires approved, allowRootWorker, allowDownloads, the session-bound plan and a matching recorded human decision reference. Inspect bootstrap_status; bootstrap_recover can archive an exact failed pre-provisioning probe after safety checks, never a dispatched/uncertain build. bootstrap_recover_connection reuses a retained completed build only after explicit owner consent, exact executionId, absent SDK runtime directory, no managed helper and stopped distro checks; one connection attempt, no rebuild/import. setup is the advanced existing-installation path. Shadow persists private paths and owns worker lifecycle; no environment variable or backend restart. setup is not an installer/download. doctor checks configuration only; runtime_status never starts a worker. Explicit operator environment remains supported and takes precedence. For failed imports, import_recovery_plan returns an exact human approval request; import_recover verifies inactive ownership and selects a fresh private namespace while retaining all old resources. It never retries/deletes the old import. namespace_status lists safe quarantine metadata; use the returned namespace for connect. baseline_plan takes registered source workspace and a separate write-authorized destinationWorkspace; after exact approval baseline_prepare copies selected tracked working-tree files to a new exclusive directory and registers it, excluding dependencies/known credential artifacts and leaving the original untouched. Both workflows require direct owner-session context and recorded human approval, not flags alone. Before create, import_preview performs a bounded metadata-only review of the registered local source. It blocks VCS/dependency trees, symlinks and credential artifacts; secret-related source/test/assets names are bounded review warnings, not evidence that they contain credentials. Use a separate curated baseline, never delete from the original checkout. create requires sourceReview from that preview and sourceReviewed:true after content review; tokens are session/source-bound, single-use and expire in 15 minutes. Managed create returns a background execution ID; wait for its completion event. import_status exposes sanitized current/retained progress and deadline failures, never retries; runtime_status does not queue behind imports and reports health:not_checked while busy. create imports every allowed file (no ignore rules or credential-free guarantee); fork/load creates a new branch (load requires historical ref), mount returns a sandbox workspace ID. Use ordinary read/write/exec workspace with that ID (bounded UTF-8 files/overwrite and sh/bash only; see skill); never use its container path as a host workspace. commit checkpoints without overwriting source; close refuses dirty workspaces. publish updates LayerFS main, NOT source files. No retries on unknown outcomes. See v:skills/layerfs.'
  readonly parameters: ToolParameters = {
    type: 'object', additionalProperties: false,
    properties: {
      action: { type: 'string', enum: [...actions] },
      namespace: { type: 'string', description: 'Optional assertion of the active managed namespace returned by import_recover/namespace_status. Use the fresh value after quarantine; old namespaces/mount IDs are refused, never redirected.' },
      destinationWorkspace: { type: 'string', description: 'baseline_plan/baseline_prepare only: registered local write-authorized destination, separate from the source checkout. A new exclusive directory is created under .layerfs-baselines there, without overwriting existing files.' },
      installation: { type: 'object', description: 'setup only: existing trusted matching {apiRoot: absolute host root containing api/agent and api/runtime, bundle: absolute sealed Linux bundle path, image: installed sha256:<64 hex> image ID, distribution: WSL distribution, node: absolute Linux Node executable}. Discover paths; never invent downloads or use an untrusted module. Read v:skills/layerfs/setup.md.' },
      approved: { type: 'boolean', description: 'Explicit owner consent for the matching setup/bootstrap/recovery/baseline action. Plan-based actions additionally verify the exact recorded human decision.' },
      allowRootWorker: { type: 'boolean', description: 'setup/bootstrap/connection recovery/import_recover: explicit consent to the described root WSL worker or ownership inspection and private namespace reuse. Baseline preparation never needs this flag.' },
      allowDownloads: { type: 'boolean', description: 'bootstrap only: owner approved the pinned source/images/dependency downloads and source build, potentially several GiB and lengthy.' },
      plan: { type: 'string', description: 'Current single-use session-bound plan from bootstrap_plan, import_recovery_plan or baseline_plan, supplied only to its matching approval-gated action. Do not invent or replay.' },
      approval: { type: 'object', description: 'bootstrap/import_recover/baseline_prepare: {sessionId,physicalId,requestId} reference from the human ask answer for this exact approvalRequest. Host verifies the recorded decision; flags or a deferred/unrelated answer are not authorization.' },
      distribution: { type: 'string', description: 'bootstrap_plan only: choose a distribution from discovered candidates when ambiguous; omit when unique. No host paths.' },
      executionId: { type: 'string', description: 'Guarded recovery only: exact failed bg: ID from bootstrap_status. bootstrap_recover archives pre-provisioning probe failures. bootstrap_recover_connection requires explicit approved/allowRootWorker consent and a retained completed build that never opened its SDK runtime; no rebuild, deletion or import.' },
      ...Object.fromEntries(['workspace', 'branch', 'ref', 'name', 'path', 'content', 'command', 'message'].map(key => [key, { type: 'string' }])),
      sourceReview: { type: 'string', description: 'create only: unexpired, single-use token from import_preview for the same registered source and session. Required before any import; source must stay unchanged.' },
      sourceReviewed: { type: 'boolean', description: 'create only: true after reviewing import_preview and confirming this stable source baseline contains no credentials. A metadata preview is not a content/secret scan.' },
      importTimeoutMs: { type: 'integer', description: `create only: single native Init budget, default ${IMPORT_TIMEOUT.defaultMs} ms, range ${IMPORT_TIMEOUT.minMs}–${IMPORT_TIMEOUT.maxMs}. Passed unchanged to LayerFS in both modes. Native scan/construction share this budget; managed pre-scan is outside it. No competing Shadow import wall-clock timeout; helper silence/cancellation means unknown outcome, not rollback. Never retry an uncertain import.` },
      offset: { type: 'integer' }, start: { type: 'integer' }, end: { type: 'integer' },
    }, required: ['action'],
  }
  private readonly managed?: ManagedLayerFS
  private readonly reviews: LayerFSImportReview
  constructor(private readonly projectId: string, home?: string, managed?: ManagedLayerFS, private readonly bootstrap?: LayerFSBootstrap,
    private readonly background?: Pick<BackgroundTaskManager, 'runPromiseTask'>, private readonly workflow?: LayerFSWorkflow) {
    this.managed = managed ?? (home ? managedLayerFS(projectId, home) : undefined)
    const key = `${home ?? ''}\0${projectId}`
    let reviews = reviewServices.get(key)
    if (!reviews) { reviews = new LayerFSImportReview(); reviewServices.set(key, reviews) }
    this.reviews = reviews
  }
  async execute(args: Record<string, unknown>, context: ExecutionContext): Promise<ToolResult> {
    if (context.projectId !== this.projectId) throw new Error('LayerFS Project mismatch.')
    if (context.remoteWorkdir) throw new Error('LayerFS remote execution is unsupported; no Main fallback.')
    context.signal.throwIfAborted()
    const a = { ...args }
    const useManaged = !process.env.SHADOW_LAYERFS_CONFIG && this.managed
    const identity = useManaged ? await useManaged.namespaceInfo() : { namespace: 'legacy', project: layerfsName(this.projectId) }
    const project = identity.project
    if (a.namespace !== undefined && (!useManaged || a.namespace !== identity.namespace)) throw new ToolNoEffectError('The explicit LayerFS namespace is not active. Old namespaces and mount IDs are quarantined, not silently redirected.')
    validateLayerArgs(a, project)
    if (a.action !== 'setup' && a.installation !== undefined) throw new ToolNoEffectError('Installation is setup-only.')
    if (!['setup', 'bootstrap', 'bootstrap_recover_connection', 'import_recover', 'baseline_prepare'].includes(String(a.action)) && ['approved', 'allowRootWorker'].some(key => a[key] !== undefined)) throw new ToolNoEffectError('Approval fields are setup/bootstrap-only.')
    if (a.action !== 'bootstrap' && a.allowDownloads !== undefined) throw new ToolNoEffectError('Download approval is bootstrap-only.')
    if (!['bootstrap', 'import_recover', 'baseline_prepare'].includes(String(a.action)) && (a.plan !== undefined || a.approval !== undefined)) throw new ToolNoEffectError('Plan/decision fields are only for their approval-gated actions.')
    if (a.action === 'baseline_prepare' && a.allowRootWorker !== undefined) throw new ToolNoEffectError('Baseline preparation runs no root worker.')
    if (!['baseline_plan', 'baseline_prepare'].includes(String(a.action)) && a.destinationWorkspace !== undefined) throw new ToolNoEffectError('Destination workspace is baseline preparation only.')
    if (a.action !== 'bootstrap_plan' && a.distribution !== undefined) throw new ToolNoEffectError('Distribution selection is bootstrap_plan-only.')
    if (!['bootstrap_recover', 'bootstrap_recover_connection'].includes(String(a.action)) && a.executionId !== undefined) throw new ToolNoEffectError('Execution ID is only for guarded bootstrap recovery.')
    if (a.action !== 'create' && ['sourceReview', 'sourceReviewed', 'importTimeoutMs'].some(key => a[key] !== undefined)) throw new ToolNoEffectError('Source review and import timeout fields are create-only.')
    if (a.action === 'create') a.importTimeoutMs = importTimeoutMs(a.importTimeoutMs)
    if (['import_preview', 'create'].includes(String(a.action)) && !context.sessionId) throw new ToolNoEffectError('Import review requires a session-bound owner.')
    if (a.action === 'create' && this.background && (context.tools?.executionMode !== 'session' || context.tools.dynamicOwner !== context.tools || context.scriptInvocation || context.recoveringToolCall)) {
      throw new ToolNoEffectError('Background LayerFS imports require a direct durable session, not a task, leaf call, nested script or recovered call. Preview/review the source in the owning session.')
    }
    const reviewOwner = `${this.projectId}\0${identity.namespace}\0${context.sessionId}`
    if (['import_recovery_plan', 'import_recover', 'baseline_plan', 'baseline_prepare'].includes(String(a.action))) {
      if (!this.workflow) throw new ToolNoEffectError('The owning Project workflow service is required; no ad hoc recovery or copying was attempted.')
      if (['import_recovery_plan', 'import_recover'].includes(String(a.action)) && !useManaged) throw new ToolNoEffectError('Namespace recovery is managed-mode only.')
      const result = a.action === 'import_recovery_plan' ? await this.workflow.recoveryPlan(context)
        : a.action === 'import_recover' ? await this.workflow.recover(a, context)
        : a.action === 'baseline_plan' ? await this.workflow.baselinePlan(a, context) : await this.workflow.prepareBaseline(a, context)
      return JSON.stringify({ ok: true, result })
    }
    if (a.action === 'namespace_status') {
      if (!useManaged) throw new ToolNoEffectError('Namespace status is managed-mode only.')
      return JSON.stringify({ ok: true, result: await useManaged.namespaceStatus() })
    }
    if (a.action === 'import_preview') {
      if (!context.resolveToolTarget) throw new ToolNoEffectError('Registered workspace authorization is unavailable.')
      const target = await context.resolveToolTarget(String(a.workspace), FILESYSTEM_READ_OPERATION)
      if (target.remoteWorkdir || !target.cwd) throw new ToolNoEffectError('Import preview requires a registered local source; no fallback.')
      return JSON.stringify({ ok: true, result: await this.reviews.preview(target.cwd, reviewOwner, context.signal) })
    }
    if (a.action === 'import_status') {
      if (!useManaged) throw new ToolNoEffectError('Import diagnostics require managed mode; operator mode retains operator-owned diagnostics.')
      return JSON.stringify({ ok: true, result: await useManaged.importStatus(context.signal, identity.namespace) })
    }
    if (['bootstrap_plan', 'bootstrap', 'bootstrap_status', 'bootstrap_recover', 'bootstrap_recover_connection'].includes(String(a.action))) {
      if (!useManaged || !this.bootstrap) throw new ToolNoEffectError('First-run bootstrap requires the owning local Project runtime and no operator environment override.')
      const result = a.action === 'bootstrap_plan' ? await this.bootstrap.plan(context, a.distribution)
        : a.action === 'bootstrap_status' ? await this.bootstrap.status(context)
        : a.action === 'bootstrap_recover' ? await this.bootstrap.recover(context, a.executionId)
        : a.action === 'bootstrap_recover_connection' ? await this.bootstrap.recoverConnection(a, context) : await this.bootstrap.start(a, context)
      return JSON.stringify({ ok: true, result })
    }
    if (a.action === 'doctor' && useManaged) return JSON.stringify({ ok: true, result: await useManaged.describe() })
    if (a.action === 'runtime_status') {
      if (!useManaged) throw new ToolNoEffectError('Managed runtime status is unavailable in operator-environment mode. No worker was started.')
      return JSON.stringify({ ok: true, result: await useManaged.status(context.signal, identity.namespace) })
    }
    if (a.action === 'doctor') {
      let result: Record<string, unknown>
      try {
        await configuration(this.projectId)
        result = { configured: true, runtime: 'not_checked', message: 'Configuration is valid. SDK artifacts, worker connectivity, Store, Docker and sandbox operations have not been verified.' }
      } catch (error) {
        if (!(error instanceof LayerFSConfigurationError)) throw error
        result = { configured: false, runtime: 'not_checked', code: error.code, message: error.message }
      }
      context.signal.throwIfAborted()
      return JSON.stringify({ ok: true, result })
    }
    const selected = workspaceActions.has(String(a.action)) ? JSON.parse(Buffer.from(String(a.workspace).replace(/^layerfs:/, ''), 'base64url').toString()) : undefined
    const lock = selected ? `${project}:${selected.sandbox}:${selected.path}` : `${project}:management`
    if (busy.has(lock)) throw new Error('LayerFS Project operation already in flight; wait for its receipt, do not replay.')
    busy.add(lock)
    let backgroundOwnsLock = false
    try {
      if (a.action === 'connect' && process.env.SHADOW_LAYERFS_CONFIG) {
        await configuration(this.projectId)
        return JSON.stringify({ ok: true, result: { configured: true, mode: 'operator', runtime: 'not_checked', next: 'list', message: 'Using explicit operator configuration. Worker lifecycle remains operator-owned; inspect inventory before mutations.' } })
      }
      if (a.action === 'setup' || a.action === 'connect') {
        if (!useManaged) throw new ToolNoEffectError('Managed LayerFS requires an owning Project Home and no SHADOW_LAYERFS_CONFIG override. The explicit operator configuration was not replaced.')
        if (a.action === 'setup') {
          if (context.channel !== 'web' || context.admin !== true || context.isGroup || context.tools?.executionMode !== 'session' || context.tools.dynamicOwner !== context.tools || context.scriptInvocation || context.recoveringToolCall) throw new ToolNoEffectError('LayerFS setup requires a direct durable local owner Web session, not a task, script, replay or borrowed tool context.')
          if (a.approved !== true || a.allowRootWorker !== true) throw new ToolNoEffectError('LayerFS setup requires explicit owner approval for this installation and its root WSL worker. Ask first; no worker was started.')
          return JSON.stringify({ ok: true, result: await useManaged.setup(a.installation, context.signal, undefined, identity.namespace) })
        }
        if (!await useManaged.configured()) return JSON.stringify({ ok: true, result: this.bootstrap ? await this.bootstrap.plan(context) : await useManaged.describe() })
        return JSON.stringify({ ok: true, result: await useManaged.connect(context.signal, undefined, identity.namespace) })
      }
      if (a.action === 'create') {
        if (!context.resolveToolTarget) throw new Error('Registered workspace authorization is unavailable.')
        const target = await context.resolveToolTarget(String(a.workspace), FILESYSTEM_READ_OPERATION)
        if (target.remoteWorkdir || !target.cwd) throw new Error('LayerFS import requires a registered local workspace; no fallback.')
        await this.reviews.consume(a.sourceReview, target.cwd, reviewOwner, a.sourceReviewed, context.signal)
        a.source = target.cwd
        const timeoutMs = importTimeoutMs(a.importTimeoutMs)
        if (useManaged && await useManaged.configured()) {
          if (!this.background) return JSON.stringify({ ok: true, result: await useManaged.create(target.cwd, context.signal, timeoutMs, identity.namespace) })
          context.signal.throwIfAborted()
          const controller = new AbortController(), outcome = Promise.withResolvers<string>()
          const taskId = this.background.runPromiseTask({ kind: 'tool', title: 'LayerFS reviewed source import', sessionId: context.sessionId, inputId: context.messageId,
            observe: async () => JSON.stringify(await useManaged.importStatus(new AbortController().signal, identity.namespace)),
            onCancel: async () => {
              controller.abort(new Error('Import observation cancelled; native work may continue'))
              await outcome.promise
              throw new Error('Import already completed; cancellation did not roll back its effects.')
            },
            callback: { sessionId: context.sessionId, replyTo: { channel: context.channel, chatId: context.chatId }, isGroup: context.isGroup, senderName: 'LayerFS import',
              contentPrefix: 'LayerFS source import result. Only Initialized confirms import completion. On failure inspect import_status; never retry or clear retained state. Parallel sandbox testing is still a separate step.' },
          }, outcome.promise)
          backgroundOwnsLock = true
          void useManaged.create(target.cwd, controller.signal, timeoutMs, identity.namespace).then(
            result => { busy.delete(lock); outcome.resolve(JSON.stringify({ ok: true, result })) },
            error => { busy.delete(lock); outcome.reject(error) },
          )
          return JSON.stringify({ ok: true, result: { status: 'running', executionId: backgroundExecutionId(taskId),
            next: 'Wait for the background completion event. import_status/v:bg expose safe progress; do not poll or resend create. Cancellation stops observation, not necessarily native work.' } })
        }
      }
      const config = useManaged && await useManaged.configured() ? await useManaged.configuration(context.signal, identity.namespace) : await configuration(this.projectId)
      context.signal.throwIfAborted()
      const output = await runBridge(config, project, String(a.action), a, context.signal, a.action !== 'create' && typeof a.bridgeTimeoutMs === 'number' ? a.bridgeTimeoutMs : undefined)
      // A definite SDK refusal is a completed failure, not a successful text result.
      // This does not claim rollback/no effect; Unknown is raised by the bridge.
      if (JSON.parse(output).ok === false) return completedToolFailure({
        isError: true, content: [{ type: 'text', text: output }],
      })
      return output
    } finally { if (!backgroundOwnsLock) busy.delete(lock) }
  }
}
