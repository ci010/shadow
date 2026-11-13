import { randomBytes } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { BackgroundTaskManager, backgroundExecutionId } from '../../agent/background-task.ts'
import type { ExecutionContext } from '../../tools/context.ts'
import { ToolNoEffectError, ToolOutcomeUnknownError } from '../../tools/tool.ts'
import { projectDataPaths } from '../../utils/data-paths.ts'
import { writePrivateFile } from '../../utils/private-file.ts'
import { ManagedLayerFS, installationSchema, type LayerFSInstallation } from './managed.ts'
import { bootstrapPins, bootstrapScript } from './bootstrap-script.ts'
import { parseYieldReference, type YieldReference, type YieldQuestion, type YieldDecisionRecord } from '../../sessions/yield-contract.ts'

import { BootstrapCommandError, runBootstrapCommand, type BootstrapRun, type BootstrapCommand, type BootstrapReceipt } from './bootstrap-command.ts'
export { BootstrapCommandError, runBootstrapCommand } from './bootstrap-command.ts'
export type { BootstrapRun, BootstrapCommand, BootstrapReceipt } from './bootstrap-command.ts'

const diagnosticSchema = z.object({ reason: z.enum(['exit', 'timeout', 'cancelled', 'spawn_error', 'stdin_error', 'signal']),
  timeoutMs: z.number().nonnegative(), elapsedMs: z.number().nonnegative(), exitCode: z.number().int().nullable(),
  signal: z.string().max(40).nullable(), launcherExited: z.boolean(), launcherPid: z.number().int().positive().optional(), osCode: z.string().regex(/^[A-Z0-9_]{1,40}$/).optional(),
}).strict()
const probeSteps = new Set(['admitted', 'wsl_ready', 'resolve_paths'])
const distroName = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/)
const resultSchema = z.object({ bundle: z.string(), node: z.string(), image: z.string().regex(/^sha256:[a-f0-9]{64}$/), revision: z.literal(bootstrapPins.revision) }).strict()
const journalSchema = z.object({ version: z.literal(1), projectId: z.string(), sessionId: z.string(),
  phase: z.enum(['running', 'ready', 'blocked', 'failed', 'uncertain', 'probe_failed', 'recovered']), step: z.string(),
  provisioningStarted: z.boolean().optional(), diagnostic: diagnosticSchema.optional(), evidenceWriteFailed: z.boolean().optional(),
  recoveredBy: z.string().optional(), recoveredAt: z.string().optional(),
  key: z.string().regex(/^[a-f0-9]{32}$/), distribution: distroName, executionId: z.string(),
  code: z.string().optional(), installation: installationSchema.optional(),
  approval: z.object({ sessionId: z.string(), physicalId: z.string(), requestId: z.string() }).strict(),
}).strict()
type Journal = z.infer<typeof journalSchema>
type Plan = { id: string; sessionId: string; distribution: string; createdAt: number }
export type BootstrapApprovalVerifier = (question: YieldQuestion, reference: YieldReference, context: ExecutionContext) => Promise<boolean>
/** Match the recorded human decision, not model assertions or a linked unrelated approval. */
export function matchesBootstrapApproval(question: YieldQuestion, reference: YieldReference, records: YieldDecisionRecord[], sessionId: string): boolean {
  if (reference.sessionId !== sessionId) return false
  const record = records.find(value => value.request.id === reference.requestId && value.request.sessionId === sessionId && value.request.origin?.physicalId === reference.physicalId)
  return !!record && !record.closed && !record.invalidated && record.request.recipient.kind === 'user' && record.request.recipient.sessionId === sessionId
    && record.answer?.requestId === reference.requestId && record.request.question === question.question && JSON.stringify(record.request.options) === JSON.stringify(question.options)
    && record.request.defaultOption === question.defaultOption && record.answer?.answeredBy === 'user'
    && !record.answer.custom && !record.answer.revisedQuestion && record.answer.option === question.options[0]
}
function approvalQuestion(plan: Plan): YieldQuestion {
  const approve = 'Approve this LayerFS bootstrap plan, downloads/build and root WSL worker.'
  return { question: `May Shadow download/build pinned LayerFS ${bootstrapPins.revision} using the official rust/node images in ${plan.distribution}, run the root WSL worker, retain private resources and reuse it across sessions? This can take a long time and several GiB. It will not install OS packages, reconfigure Docker or import your repository. Plan ${plan.id}.`,
    options: [approve, 'Do not provision LayerFS on this machine.'], defaultOption: approve }
}
class BuildRefusal extends Error {
  constructor(readonly phase: 'blocked' | 'uncertain', readonly code: string) { super(code) }
}

export function assertLayerFSSetupOwner(context: ExecutionContext) {
  if (context.channel !== 'web' || context.admin !== true || context.isGroup || context.remoteWorkdir || context.tools?.executionMode !== 'session' || context.tools.dynamicOwner !== context.tools || context.scriptInvocation || context.recoveringToolCall) throw new ToolNoEffectError('LayerFS provisioning requires a direct durable local owner Web session, not a task, script, replay or borrowed tool context.')
}
function decodeInventory(value: Buffer) {
  return (value.includes(0) ? value.toString('utf16le') : value.toString('utf8')).replace(/^\uFEFF/, '')
}

/** First-run orchestration accepts no model-provided URL, script, SDK path or image. */
export class LayerFSBootstrap {
  private readonly directory: string
  private readonly journalPath: string
  private plans = new Map<string, Plan>()
  private admitting = false
  constructor(private readonly projectId: string, private readonly home: string,
    private readonly background: Pick<BackgroundTaskManager, 'runPromiseTask'>,
    private readonly managed: ManagedLayerFS,
    private readonly run: BootstrapRun = runBootstrapCommand,
    private readonly platform: string = process.platform,
    private readonly arch: string = process.arch,
    private readonly verifyApproval?: BootstrapApprovalVerifier) {
    this.directory = join(projectDataPaths(home).state, 'layerfs', 'bootstrap')
    this.journalPath = join(this.directory, 'bootstrap.json')
  }
  private assertProject(context: ExecutionContext) {
    if (context.projectId !== this.projectId || context.remoteWorkdir) throw new ToolNoEffectError('LayerFS bootstrap is bound to the owning local Project; no remote fallback.')
    context.signal.throwIfAborted()
  }
  private async journal(): Promise<Journal | undefined> {
    try {
      const parsed = journalSchema.parse(JSON.parse(await readFile(this.journalPath, 'utf8')))
      if (parsed.projectId !== this.projectId) throw Error('foreign Project')
      return parsed
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new ToolOutcomeUnknownError('LayerFS bootstrap journal is invalid or unreadable; inspect retained state before provisioning.')
    }
  }
  private save(value: Journal) { writePrivateFile(this.journalPath, JSON.stringify(value)) }
  private async archive(value: Journal) {
    const directory = join(this.directory, 'history')
    await mkdir(directory, { recursive: true, mode: 0o700 })
    const path = join(directory, `${value.key}-${value.phase}.json`), text = JSON.stringify(value)
    try { await writeFile(path, text, { flag: 'wx', mode: 0o600 }) }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || await readFile(path, 'utf8') !== text) throw new ToolNoEffectError('Previous bootstrap evidence could not be archived safely; recovery/admission was refused.')
    }
  }
  async status(context: ExecutionContext) {
    this.assertProject(context)
    const journal = await this.journal()
    return journal ? { phase: journal.phase, step: journal.step, executionId: journal.executionId,
      code: journal.code, distribution: journal.distribution, lastBootstrapReady: journal.phase === 'ready', runtime: 'not_checked', sandboxVerified: false,
      diagnostic: journal.diagnostic, provisioningStarted: journal.provisioningStarted, evidenceWriteFailed: journal.evidenceWriteFailed,
      recovery: 'Inspect retained resources; do not replay unknown provisioning.' } : { phase: 'not_started', next: 'bootstrap_plan' }
  }
  async plan(context: ExecutionContext, selected?: unknown) {
    this.assertProject(context); assertLayerFSSetupOwner(context)
    if (process.env.SHADOW_LAYERFS_CONFIG) throw new ToolNoEffectError('Explicit operator LayerFS configuration takes precedence; bootstrap will not replace it.')
    if (this.platform !== 'win32' || this.arch !== 'x64') return { status: 'blocked', code: 'UNSUPPORTED_PLATFORM', message: 'Automated source bootstrap targets Windows x64 with an existing WSL2 Linux distribution. No commands were run.' }
    if (await this.managed.configured()) return { status: 'configured', next: 'connect' }
    const previous = await this.journal()
    if (previous && !['blocked', 'recovered'].includes(previous.phase)) return { status: 'existing_attempt', ...(await this.status(context)) }
    const inventory = await this.run({ file: 'wsl.exe', args: ['--list', '--quiet'], timeoutMs: 10000 }, context.signal)
    if (inventory.code !== 0) return { status: 'blocked', code: 'WSL_UNAVAILABLE', message: 'WSL inventory is unavailable. WSL/OS installation needs a separate approved platform setup; no system setting was changed.' }
    const candidates = [...new Set(decodeInventory(inventory.stdout).split(/\r?\n/).map(s => s.trim()).filter(s => distroName.safeParse(s).success && !/^docker-desktop(?:-data)?$/i.test(s)))].sort()
    if (selected !== undefined && (typeof selected !== 'string' || !candidates.includes(selected))) throw new ToolNoEffectError('Choose a distribution returned by bootstrap_plan; Docker Desktop internal distributions are refused.')
    if (!selected && candidates.length !== 1) return { status: candidates.length ? 'needs_selection' : 'blocked', code: candidates.length ? 'SELECT_DISTRIBUTION' : 'WSL_DISTRIBUTION_REQUIRED', distributions: candidates,
      message: candidates.length ? 'Choose the Linux distribution; no root command or download has run.' : 'No eligible WSL Linux distribution was found. Install one through approved OS onboarding; Docker Desktop internal distributions are not used.' }
    const distribution = String(selected ?? candidates[0])
    const plan: Plan = { id: randomBytes(16).toString('hex'), sessionId: context.sessionId, distribution, createdAt: Date.now() }
    for (const [id, prior] of this.plans) {
      if (prior.sessionId === context.sessionId || Date.now() - prior.createdAt > 15 * 60_000) this.plans.delete(id)
    }
    this.plans.set(plan.id, plan)
    const question = approvalQuestion(plan)
    return { status: 'needs_approval', plan: plan.id, distribution, revision: bootstrapPins.revision,
      approvalRequest: { kind: 'decision', question: question.question, options: question.options, default_option: question.defaultOption },
      source: bootstrapPins.repository, images: [bootstrapPins.buildImage, bootstrapPins.runtimeImage],
      effects: ['Download pinned official source and Docker build/runtime images; locked source build may download dependencies.',
        'Run scoped build commands and the LayerFS worker as root inside this selected WSL distribution.',
        'Allocate private artifacts, caches, runtime homes and later Store volumes; reuse approved runtime across sessions.',
        'No OS/package installation, Docker reconfiguration, repository import, or modification of OfficeAgent.'],
      requirements: ['Existing WSL2 with Python3, git, Docker Engine API >=1.48, FUSE, and supported local Linux filesystem.', 'Several GiB of free disk and potentially a lengthy first build; download size is not fixed.'],
      next: 'Call ask with the exact approvalRequest fields, without rewriting the question/options. After explicit owner approval, call bootstrap with this plan, the answer receipt reference as approval, and approved/allowRootWorker/allowDownloads true. The saved human decision is checked; flags alone cannot authorize setup. No manual paths, JSON, environment variables or backend restart are required.' }
  }
  async start(args: Record<string, unknown>, context: ExecutionContext) {
    this.assertProject(context); assertLayerFSSetupOwner(context)
    if (process.env.SHADOW_LAYERFS_CONFIG) throw new ToolNoEffectError('Explicit operator configuration must not be replaced by bootstrap.')
    if (args.approved !== true || args.allowRootWorker !== true || args.allowDownloads !== true) throw new ToolNoEffectError('Bootstrap requires explicit approval of the plan, downloads/build and root WSL execution; no provisioning was started.')
    const plan = typeof args.plan === 'string' ? this.plans.get(args.plan) : undefined
    if (!plan || plan.sessionId !== context.sessionId || Date.now() - plan.createdAt > 15 * 60_000) throw new ToolNoEffectError('Bootstrap plan is missing, expired or belongs to another session. Obtain a fresh plan and approval.')
    let reference: YieldReference
    try { reference = parseYieldReference(args.approval) } catch { throw new ToolNoEffectError('Bootstrap requires the recorded owner decision reference from ask; flags alone do not authorize provisioning.') }
    if (!this.verifyApproval || reference.sessionId !== context.sessionId || !await this.verifyApproval(approvalQuestion(plan), reference, context)) throw new ToolNoEffectError('The recorded decision does not approve this exact bootstrap plan. Deferred, custom, foreign, invalidated or unrelated answers do not authorize provisioning.')
    context.signal.throwIfAborted()
    if (this.admitting) throw new ToolNoEffectError('A LayerFS bootstrap is already being admitted; inspect bootstrap_status instead of replaying.')
    const lease = this.managed.acquireSetup()
    let retained = false
    this.admitting = true
    try {
      const previous = await this.journal()
      if (previous && !['blocked', 'recovered'].includes(previous.phase) || await this.managed.configured()) throw new ToolNoEffectError('LayerFS already has an installation or bootstrap attempt. Inspect connect/bootstrap_status; do not replay provisioning.')
      context.signal.throwIfAborted()
      if (previous) await this.archive(previous)
      await mkdir(this.directory, { recursive: true, mode: 0o700 })
      context.signal.throwIfAborted()
      const controller = new AbortController(), execution = Promise.withResolvers<string>()
      const key = randomBytes(16).toString('hex')
      const state: Journal = { version: 1, projectId: this.projectId, sessionId: context.sessionId, phase: 'running', step: 'admitted', provisioningStarted: false, key, distribution: plan.distribution, executionId: '', approval: reference }
      const taskId = this.background.runPromiseTask({ kind: 'tool', title: 'LayerFS approved first-run bootstrap', sessionId: context.sessionId, inputId: context.messageId,
        onCancel: async () => {
          controller.abort(new Error('LayerFS bootstrap cancelled'))
          // BackgroundTaskManager treats a successful hook as confirmed cleanup.
          // Propagate the actual bootstrap failure/uncertainty instead of hiding it.
          await execution.promise
          throw new Error('LayerFS bootstrap already completed; its runtime/artifacts remain. Cancellation did not roll them back.')
        },
        observe: () => JSON.stringify({ phase: state.phase, step: state.step, code: state.code, distribution: state.distribution }),
        callback: { sessionId: context.sessionId, replyTo: { channel: context.channel, chatId: context.chatId }, isGroup: false, senderName: 'LayerFS setup',
          contentPrefix: 'LayerFS bootstrap result for the original request. If ready, continue that request using connect and a credential-safe source; readiness is not a passing sandbox/isolation test. Do not retry failed or uncertain provisioning.' },
      }, execution.promise)
      state.executionId = backgroundExecutionId(taskId)
      try { this.save(state) } catch (error) { execution.reject(new Error('LayerFS bootstrap admission could not be saved; no provisioning started.')); throw error }
      this.plans.delete(plan.id)
      void this.build(state, controller.signal, lease.token).then(
        result => { lease.release(); execution.resolve(result) },
        error => { lease.release(); execution.reject(error) },
      )
      retained = true
      return { status: 'running', executionId: state.executionId, next: 'Wait for the background completion event; bootstrap_status/v:bg are for inspection, not polling or reissuing setup.' }
    } finally { this.admitting = false; if (!retained) lease.release() }
  }
  private async build(state: Journal, signal: AbortSignal, owner: symbol): Promise<string> {
    const staging = join(this.directory, state.key), output = join(staging, 'api-root')
    const step = (value: string) => { state.step = value; delete state.diagnostic; this.save(state) }
    const runStep = async (name: string, command: BootstrapCommand): Promise<BootstrapReceipt> => {
      signal.throwIfAborted()
      step(name)
      const log = (stdout: Buffer, stderr: Buffer) => writePrivateFile(join(staging, `${name}.log`), JSON.stringify({
        command: { file: command.file, args: command.args, hasInput: command.input !== undefined },
        diagnostic: state.diagnostic, stdout: decodeInventory(stdout), stderr: decodeInventory(stderr),
      }))
      try {
        const result = await this.run(command, signal)
        state.diagnostic = result.diagnostic
        try { log(result.stdout, result.stderr) } catch { state.evidenceWriteFailed = true }
        return result
      } catch (error) {
        if (error instanceof BootstrapCommandError) {
          state.diagnostic = error.diagnostic
          try { log(error.stdout, error.stderr) } catch { state.evidenceWriteFailed = true }
        }
        throw error
      }
    }
    try {
      signal.throwIfAborted()
      // The script reserves the output leaf exclusively; only its parent is made here.
      await mkdir(staging, { recursive: true, mode: 0o700 })
      const prefix = ['--distribution', state.distribution, '--user', 'root', '--exec']
      const ready = await runStep('wsl_ready', { file: 'wsl.exe', args: [...prefix, '/bin/true'], timeoutMs: 120000 })
      if (ready.code !== 0) throw new Error('WSL_READY_EXIT_NONZERO')
      const mapped = await runStep('resolve_paths', { file: 'wsl.exe', args: [...prefix, 'wslpath', '-a', '-u', output], timeoutMs: 30000 })
      if (mapped.code !== 0) throw new Error('PATH_MAPPING_EXIT_NONZERO')
      const linuxOutput = mapped.stdout.toString('utf8').trim()
      if (!linuxOutput.startsWith('/') || linuxOutput.includes('\0') || /[\r\n]/.test(linuxOutput) || linuxOutput.split('/').includes('..')) throw new Error('INVALID_PATH_MAPPING')
      signal.throwIfAborted()
      // Persist the irreversible boundary BEFORE dispatch. A crash here must never
      // make a possibly started source build look like a recoverable path probe.
      state.provisioningStarted = true
      const built = await runStep('source_build', { file: 'wsl.exe', args: [...prefix, 'bash', '-s', '--', state.key, linuxOutput], input: bootstrapScript, timeoutMs: 60 * 60_000 })
      try { writePrivateFile(join(staging, 'build-tail.log'), built.stdout.toString('utf8') + '\n[stderr]\n' + built.stderr.toString('utf8')) }
      catch { state.evidenceWriteFailed = true }
      const lines = built.stdout.toString('utf8').split(/\r?\n/)
      if (built.code !== 0) {
        const refusal = lines.find(line => line.startsWith('SHADOW_LAYERFS_BOOTSTRAP_BLOCKED=') || line.startsWith('SHADOW_LAYERFS_BOOTSTRAP_FAILED='))
        if (refusal) {
          try {
            const data = z.object({ code: z.string().regex(/^[A-Z][A-Z0-9_]{0,63}$/), phase: z.string().regex(/^[a-z][a-z0-9_-]{0,63}$/).optional(), state: z.enum(['not_started', 'unknown']).optional() }).strict().parse(JSON.parse(refusal.slice(refusal.indexOf('=') + 1)))
            const blocked = refusal.startsWith('SHADOW_LAYERFS_BOOTSTRAP_BLOCKED=')
            const earlyRefusal = data.state === undefined && ['INVALID_ARGUMENTS', 'PYTHON3_REQUIRED'].includes(data.code)
            if (blocked ? data.state !== 'not_started' && !earlyRefusal : data.state !== 'unknown') throw new Error('invalid phase attestation')
            if (data.phase) state.step = 'source_build:' + data.phase
            throw new BuildRefusal(blocked ? 'blocked' : 'uncertain', data.code)
          } catch (error) { if (error instanceof BuildRefusal) throw error }
        }
        throw new ToolOutcomeUnknownError('LayerFS source build failed without a trusted phase receipt; inspect retained resources before manual recovery.')
      }
      const receipts = lines.filter(line => line.startsWith('SHADOW_LAYERFS_BOOTSTRAP_RESULT='))
      if (receipts.length !== 1) throw new ToolOutcomeUnknownError('LayerFS build completed without one valid installation receipt; inspect retained state.')
      let parsed: z.infer<typeof resultSchema>
      try { parsed = resultSchema.parse(JSON.parse(receipts[0]!.slice('SHADOW_LAYERFS_BOOTSTRAP_RESULT='.length))) }
      catch { throw new ToolOutcomeUnknownError('LayerFS installation receipt is invalid; do not replay provisioning.') }
      const root = `/var/lib/shadow-layerfs-bootstrap/${state.key}/`
      if (!parsed.bundle.startsWith(root) || !parsed.node.startsWith(root) || [parsed.bundle, parsed.node].some(path => path.includes('\0') || path.split('/').includes('..'))) throw new ToolOutcomeUnknownError('LayerFS build returned paths outside its private root; activation refused.')
      const installation: LayerFSInstallation = { apiRoot: output, bundle: parsed.bundle, node: parsed.node, image: parsed.image, distribution: state.distribution }
      state.installation = installation
      step('connect_worker')
      const connected = await this.managed.setup(installation, signal, owner)
      if (!z.object({ ready: z.literal(true), sandboxVerified: z.literal(false) }).passthrough().safeParse(connected).success) throw new Error('RUNTIME_NOT_READY')
      state.phase = 'ready'; state.step = 'complete'; this.save(state)
      return JSON.stringify({ status: 'ready', runtime: connected, sourceRevision: bootstrapPins.revision, evidenceWriteFailed: state.evidenceWriteFailed, next: 'Continue the original request. Review source import safety, then create/fork/mount/test; bootstrap imported no repository.' })
    } catch (error) {
      const unknown = error instanceof ToolOutcomeUnknownError || signal.aborted
      const probe = state.provisioningStarted === false && probeSteps.has(state.step)
      state.phase = probe ? 'probe_failed' : unknown ? 'uncertain' : error instanceof BuildRefusal ? error.phase : 'failed'
      state.code = error instanceof BootstrapCommandError
        ? `${state.step === 'wsl_ready' ? 'WSL_READY' : state.step === 'resolve_paths' ? 'PATH_MAPPING' : 'BUILD_COMMAND'}_${error.diagnostic.reason.toUpperCase()}`
        : unknown ? 'OUTCOME_UNKNOWN' : error instanceof BuildRefusal ? error.code : error instanceof Error && /^[A-Z][A-Z0-9_]{0,63}$/.test(error.message) ? error.message : 'BOOTSTRAP_FAILED'
      this.save(state)
      throw new Error(`LayerFS bootstrap ${state.phase} at ${state.step} (${state.code}). ${probe ? 'The provisioning script was not dispatched. Use bootstrap_status and guarded bootstrap_recover; do not clear state.' : 'Artifacts and private build evidence are retained. Inspect bootstrap_status; do not automatically retry or clear state.'} No source repository was imported.`)
    }
  }
}
