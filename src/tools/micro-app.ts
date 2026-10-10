import { z } from 'zod'
import { lstat, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ToolNoEffectError, type Tool, type ToolParameters } from './tool.ts'
import type { ExecutionContext } from './context.ts'
import type { MicroApps } from '../microapps/service.ts'
import { appId, revisionId, appManifestSchema, appTestReportSchema, microAppCapabilities, MicroAppError, type AppManifest } from '../microapps/contracts.ts'
import type { ImportTool } from './load-tool.ts'
import { localAppDirectory } from '../microapps/store.ts'
import { AppReportValidationError } from '../microapps/acceptance.ts'
import { toolEvidenceQuerySchema } from '../sessions/decision-brief.ts'
import type { WorkStamp } from '../initiatives/work-contract.ts'

const inputSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('capabilities') }).strict(),
  z.object({ action: z.literal('list') }).strict(),
  z.object({ action: z.literal('get'), id: appId }).strict(),
  z.object({ action: z.literal('check'), directory: z.string().min(1), id: appId, revision: revisionId }).strict(),
  z.object({ action: z.literal('publish'), directory: z.string().min(1), id: appId.optional(), revision: revisionId.optional() }).strict(),
  z.object({ action: z.literal('start'), id: appId }).strict(),
  z.object({ action: z.literal('stop'), id: appId }).strict(),
  z.object({ action: z.literal('test'), id: appId, revision: revisionId }).strict(),
  z.object({ action: z.literal('evidence'), id: appId, revision: revisionId, sources: toolEvidenceQuerySchema }).strict(),
  z.object({ action: z.literal('report'), id: appId, revision: revisionId, report: appTestReportSchema }).strict(),
])

export function microAppReceipt(record: ReturnType<MicroApps['get']>) {
  const acceptance = record.acceptance
  return {
    id: record.id, revision: record.revision, name: record.manifest.name, createdBy: record.createdBy,
    status: record.status, approval: record.approval ?? null, calls: record.calls, llm: record.manifest.llm,
    lastRun: record.lastRun, cleanupPending: record.cleanupPending, acceptanceAvailable: record.acceptanceAvailable,
    workRefs: record.work?.map(work => ({ key: work.key, revision: work.revision, acceptanceCount: work.acceptance.length })),
    acceptanceSummary: acceptance ? {
      id: acceptance.id, revision: acceptance.revision, status: acceptance.status, decision: acceptance.decision,
      error: acceptance.error, authorTurn: acceptance.authorTurn, sequence: acceptance.sequence,
      reportSaved: !!acceptance.report, observationsTruncated: acceptance.observationsTruncated,
    } : null,
    uiPath: record.uiPath, detail: { action: 'get', id: record.id },
  }
}

export class MicroAppTool implements Tool {
  readonly name = 'micro_app'
  readonly readonly = (args: Record<string, unknown>) => ['capabilities', 'list', 'get', 'check', 'evidence'].includes(String(args.action))
  readonly description = 'Publish and manage reusable Project Web apps, with optional local Node/Python backend and owner-approved LLM calls. Read v:skills/micro-app and action:capabilities for runtime limits. publish/check return compact receipts; get returns full manifest, requirements and acceptance evidence. check compares source bytes, not runtime acceptance. After owner review and the testing question, test opens the exact version in an isolated browser; evidence resolves your recorded tool IDs and exact excerpts into canonical references; report saves version-bound assessments. This tool cannot approve or issue model credentials. No automatic install.'
  readonly parameters: ToolParameters = {
    type: 'object', properties: {
      action: { type: 'string', enum: ['capabilities', 'list', 'get', 'check', 'publish', 'start', 'stop', 'test', 'evidence', 'report'] },
      directory: { type: 'string', description: 'publish/check: local workdir-relative directory containing shadow-app.json and its explicitly listed files.' },
      id: { type: 'string', description: 'App UUID. Omit on first publish.' },
      revision: { type: 'string', description: 'Required for check, test, evidence, report and publish updates: exact revision from get. Stop before publishing; updates invalidate approval and testing permission.' },
      sources: { type: 'array', minItems: 1, maxItems: 12, items: { type: 'object',
        properties: { id: { type: 'string' }, quote: { type: 'string' } }, required: ['id', 'quote'], additionalProperties: false },
        description: 'evidence only: 1-12 {id: recorded tool call ID, quote: exact receipt excerpt (1-2000 chars)}. Returns canonical {sessionId,physicalId,kind,id,quote} references from your own historical/current segments. Copy into report; never guess physicalId. Unknown/ambiguous IDs and inexact excerpts are rejected.' },
      report: { type: 'object', description: 'report only: {checks:[{category:startup|state|recovery|reopen|business|device,result:passed|failed|blocked|not_tested,basis:runtime|fixture|not_tested,summary,observations:[IDs from get.acceptance],evidence:[canonical references from action:evidence]}],requirements:[{workKey,workRevision,criterion,result,basis,summary,observations,evidence}]}. First four categories required; cover each published Work criterion exactly once (zero-based). Passes need recorded tool excerpts. ANY runtime basis needs nonempty observations, including blocked/failed. Runtime state: state_saved then same-version state_read on another run; reopen: stopped then sdk_connected on another run, not full Shadow restart; recovery: model/backend failed/cancelled then same-kind completed. Repair cited fields, preserving unrelated results/evidence. Candidates never prove business success.' },
    }, required: ['action'], additionalProperties: false,
  }
  constructor(private service: MicroApps, private assertSession: (id: string) => void, private browser?: Pick<ImportTool, 'openApp'>,
    private workBasis?: (sessionId: string) => WorkStamp[]) {}
  workAdmission(args: Record<string, unknown>): 'cleanup' | undefined {
    const input = inputSchema.safeParse(args)
    return input.success && input.data.action === 'stop' ? 'cleanup' : undefined
  }
  async execute(args: Record<string, unknown>, context: ExecutionContext) {
    if (context.projectId !== this.service.projectId || context.remoteWorkdir) throw new MicroAppError('local_project_required', 'Micro Apps require their owning local Project', 403)
    this.assertSession(context.sessionId)
    context.signal.throwIfAborted()
    const parsed = inputSchema.safeParse(args)
    if (!parsed.success) throw new ToolNoEffectError(`Invalid Micro App arguments: ${parsed.error.message}`, { cause: parsed.error })
    const input = parsed.data
    if (input.action === 'capabilities') return JSON.stringify(microAppCapabilities)
    if (input.action === 'list') return JSON.stringify({ apps: this.service.list() })
    if (input.action === 'get') return JSON.stringify(this.service.get(input.id))
    if (input.action === 'publish' || input.action === 'check') {
      const work = input.action === 'publish' ? this.workBasis?.(context.sessionId) ?? context.workStamps : undefined
      let directory: string, manifest: AppManifest
      try {
        if (!context.cwd) throw new MicroAppError('workdir_required', 'A local workdir is required')
        directory = await localAppDirectory(context.cwd, input.directory)
        const stat = await lstat(join(directory, 'shadow-app.json'))
        if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) throw new MicroAppError('invalid_manifest', 'Manifest must be a regular file of at most 64 KiB')
        const bytes = await readFile(join(directory, 'shadow-app.json'), { signal: context.signal })
        if (bytes.length > 64 * 1024) throw new MicroAppError('manifest_too_large', 'App manifest exceeds 64 KiB', 413)
        manifest = appManifestSchema.parse(JSON.parse(bytes.toString('utf8')))
      } catch (error) {
        context.signal.throwIfAborted()
        if (!(error instanceof Error)) throw error
        throw new ToolNoEffectError(`Micro App source validation failed before publication: ${error.message}`, { cause: error })
      }
      if (input.action === 'check') {
        const result = await this.service.checkPublication(input.id, input.revision, directory, manifest, context.signal)
        return JSON.stringify({ ...microAppReceipt(result), publicationCheck: result.publicationCheck })
      }
      return JSON.stringify(microAppReceipt(
        await this.service.publish(directory, manifest, context.sessionId, context.signal, input.id, input.revision, work)))
    }
    try {
      const record = this.service.get(input.id)
      if (record.createdBy !== context.sessionId) throw new MicroAppError('not_app_author', 'Only the author session or the Project owner can control this app', 403)
      if (context.tools.executionMode === 'call' || context.tools.dynamicOwner !== context.tools) throw new MicroAppError('not_app_author', 'Only the owning session may control app runs', 403)
      if (input.action === 'test' || input.action === 'report' || input.action === 'evidence') {
        const acceptanceId = this.service.acceptance.authorize(input.id, input.revision, context.sessionId)
        if (context.inputSource === 'event' && context.messageId?.startsWith('microapp-test:') &&
          context.messageId !== `microapp-test:${acceptanceId}`) {
          throw new MicroAppError('acceptance_changed', 'This testing event belongs to an older request. Read the current app and wait for its own author event.', 409)
        }
      }
      if (input.action === 'test' && !this.browser) throw new MicroAppError('browser_unavailable', 'Managed browser acceptance is unavailable', 409)
      if (input.action === 'start' && record.acceptance) throw new MicroAppError('use_test', 'Use test with the exact revision for author-owned acceptance; owner openings remain in Apps', 409)
      if (input.action === 'evidence') return JSON.stringify(await this.service.acceptance.evidence(input.id, input.revision, context.sessionId, input.sources, context.signal))
    } catch (error) {
      context.signal.throwIfAborted()
      if (!(error instanceof Error)) throw error
      throw new ToolNoEffectError(`Micro App control rejected before execution: ${error.message}`, { cause: error })
    }
    if (input.action === 'test' || input.action === 'report') {
      if (input.action === 'report') {
        try { return JSON.stringify(await this.service.acceptance.report(input.id, input.revision, context.sessionId, input.report, context.signal)) }
        catch (error) {
          context.signal.throwIfAborted()
          if (error instanceof AppReportValidationError) throw new ToolNoEffectError(error.message, { cause: error })
          throw error
        }
      }
      let openedRunId: string | undefined
      try {
        const browser = await this.browser!.openApp(context, input,
          async () => {
            const opened = await this.service.openTest(input.id, input.revision, context.sessionId, context.signal)
            openedRunId = this.service.get(input.id).lastRun?.id
            return opened
          })
        return JSON.stringify({ ...this.service.get(input.id), browser,
          notice: 'Approved app opened in an isolated author-owned browser. Inspect and exercise the actual UI/SDK. Save report with recorded tool evidence; startup is not functional acceptance. Stop the app and close the browser when finished.' })
      } catch (error) {
        if (context.signal.aborted && openedRunId && this.service.get(input.id).lastRun?.id === openedRunId) await this.service.stop(input.id)
        throw error
      }
    }
    if (input.action === 'stop') return JSON.stringify(await this.service.stopFromAuthor(input.id, context.sessionId))
    return JSON.stringify(await this.service[input.action](input.id))
  }
}
