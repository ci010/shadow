import { createHash, randomUUID } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import type { Hono } from 'hono'
import { z } from 'zod'
import type { ChannelAddress } from '../bus/events.ts'
import type { AgentAuthoringService } from './service.ts'
import { validateToolArguments } from './service.ts'
import type { AgentCredentialStore } from './credentials.ts'
import type { AuthoringChanges } from './changes.ts'
import { PrivateDocument } from './private-document.ts'
import { probeApprovedTool, readOnlyGrants } from './read-only-probe.ts'
import { redactAuthoringEvidence } from './evidence.ts'
import {
  ProbeDecisionSchema, ProbeRequestSchema, parseProbeRequest,
  type ProbeRequest, type ProbeDecisionResult,
} from './probe-request-contract.ts'

const documentSchema = z.object({
  version: z.literal(1), projectId: z.string().min(1),
  requests: z.array(ProbeRequestSchema).max(200),
}).strict()

export class ProbeRequestError extends Error {
  constructor(readonly status: 400 | 404 | 409 | 503, message: string) { super(message) }
}

export class AuthoringProbeRequests {
  private readonly document: PrivateDocument<z.infer<typeof documentSchema>>
  private readonly running = new Map<string, AbortController>()
  private readonly inflight = new Set<Promise<ProbeDecisionResult>>()
  private stopped = false

  constructor(private readonly options: {
    projectId: string
    directory: string
    changes: AuthoringChanges
    service: AgentAuthoringService
    credentials: AgentCredentialStore
    canAuthor: (sessionId: string) => boolean
    notify: (request: ProbeRequest) => Promise<void>
    now?: () => number
  }) {
    this.document = new PrivateDocument({
      projectId: options.projectId, directory: options.directory, filename: 'probe-requests.json',
      initial: { version: 1, projectId: options.projectId, requests: [] },
      parse: value => {
        const document = documentSchema.parse(value)
        if (document.projectId !== options.projectId) throw new Error('Probe store belongs to another Project.')
        for (const request of document.requests) parseProbeRequest(request, options.projectId)
        if (new Set(document.requests.map(request => request.id)).size !== document.requests.length) throw new Error('Duplicate probe requests.')
        return document
      },
      maxBytes: 8 * 1024 * 1024,
    })
    const document = this.document.read()
    if (document.requests.some(request => request.status === 'running')) {
      document.requests = document.requests.map(request => request.status === 'running'
        ? { ...request, status: 'failed', error: 'Probe interrupted by restart. It was not replayed; request a new review to run again.' } : request)
      this.document.write(document)
    }
  }

  list(): ProbeRequest[] { return this.document.read().requests }

  request(input: {
    changeId: string; revision: string; sourceSessionId: string
    address: ChannelAddress; toolName: string; args: Record<string, unknown>
  }): ProbeRequest {
    this.assertRunning()
    const change = this.options.changes.get(input.changeId)
    this.options.changes.authorize(change.id, input.sourceSessionId)
    if (change.closed || !this.options.canAuthor(input.sourceSessionId) || change.snapshot.revision !== input.revision ||
      input.address.projectId !== this.options.projectId) throw new ProbeRequestError(409, 'Source or authoring scope changed.')
    const policy = this.options.service.options.store.preview(input.address, change.snapshot)
    if (!policy) throw new ProbeRequestError(400, 'Choose an enabled Change binding.')
    const tool = policy.tools.find(tool => tool.name === input.toolName)
    if (!tool) throw new ProbeRequestError(400, 'Tool is not selected by this binding.')
    validateToolArguments(tool.parameters, input.args)
    const grants = readOnlyGrants(policy, tool.name)
    if (!grants.length) throw new ProbeRequestError(400, 'This tool has no HTTP GET grants to review.')
    const reviewMaterial = { code: tool.code, arguments: input.args, grants }
    const safeMaterial = redactAuthoringEvidence(reviewMaterial, this.options.credentials)
    if (!isDeepStrictEqual(safeMaterial, reviewMaterial)) throw new ProbeRequestError(400, 'Probe source and arguments must not contain stored credentials.')
    const now = this.now()
    const request = parseProbeRequest({
      id: randomUUID(), projectId: this.options.projectId, changeId: change.id,
      title: change.title, revision: input.revision, sourceSessionId: input.sourceSessionId,
      accessRevision: change.accessRevision,
      createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 10 * 60_000).toISOString(),
      toolName: tool.name, sourceHash: `sha256:${createHash('sha256').update(tool.code).digest('hex')}`,
      source: { path: `skills/${tool.skill}/${tool.source}`, code: tool.code },
      address: input.address, arguments: input.args, grants, maxCalls: 8, status: 'pending',
    }, this.options.projectId)
    const document = this.document.read()
    const existing = document.requests.find(other => other.status === 'pending' &&
      other.changeId === request.changeId && other.revision === request.revision &&
      other.accessRevision === request.accessRevision &&
      other.sourceSessionId === request.sourceSessionId && other.toolName === request.toolName &&
      Date.parse(other.expiresAt) > now && isDeepStrictEqual(other.address, request.address) &&
      isDeepStrictEqual(other.arguments, request.arguments))
    if (existing) return existing
    if (document.requests.length >= 200) throw new ProbeRequestError(409, 'Probe review history limit reached (200 requests). No new request was created.')
    this.document.write({ ...document, requests: [...document.requests, request] })
    return request
  }

  submit(id: string, decision: { revision: string }): Promise<ProbeDecisionResult> {
    const execution = this.execute(id, decision)
    this.inflight.add(execution)
    execution.then(() => this.inflight.delete(execution), () => this.inflight.delete(execution))
    return execution
  }

  private async execute(id: string, decision: { revision: string }): Promise<ProbeDecisionResult> {
    const request = this.requirePending(id, decision)
    const policy = this.currentPolicy(request)
    const controller = new AbortController()
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)])
    this.update({ ...request, status: 'running' })
    this.running.set(id, controller)
    let outcome: ProbeRequest
    try {
      const result = await probeApprovedTool({
        broker: this.options.service.options.broker, policy, approvalId: request.id,
        maxCalls: request.maxCalls, assertCurrent: () => { this.currentPolicy(request); signal.throwIfAborted() },
      }, { toolName: request.toolName, args: request.arguments }, {
        sessionId: request.sourceSessionId, messageId: `probe:${request.id}`, toolCallId: request.id, signal,
      })
      const run = this.options.changes.recordRun(request.changeId, {
        revision: request.revision, kind: 'probe',
        status: result.execution === 'failed' ? 'failed' : 'completed',
        result: redactAuthoringEvidence({ ...result, approvalId: request.id }, this.options.credentials),
      })
      outcome = {
        ...request, status: result.execution === 'failed' ? 'failed' : 'completed', runId: run.id,
        ...(result.error ? { error: `Probe failed: ${result.error.code}. Inspect run ${run.id}.` } : {}),
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error)
      const safe = redactAuthoringEvidence({ error: detail.slice(0, 1000) }, this.options.credentials)
      const run = this.options.changes.recordRun(request.changeId, {
        revision: request.revision, kind: 'probe', status: 'failed',
        result: { approvalId: request.id, interrupted: signal.aborted, detail: safe },
      })
      outcome = { ...request, status: 'failed', runId: run.id, error: `Probe did not complete. Inspect run ${run.id}; it will not be retried automatically.` }
    } finally {
      this.running.delete(id)
    }
    this.update(outcome)
    return this.result(await this.notify(outcome))
  }

  private async notify(outcome: ProbeRequest): Promise<ProbeRequest> {
    try { await this.options.notify(outcome) } catch (error) {
      console.warn('[authoring-probe] Result notification failed', { requestId: outcome.id, error: error instanceof Error ? error.name : 'Error' })
      outcome = { ...outcome, error: `${outcome.error ?? `Probe ${outcome.status}.`} The author notification was not delivered; reload the saved status.` }
      this.update(outcome)
    }
    return outcome
  }

  async cancel(id: string, decision: { revision: string }): Promise<ProbeDecisionResult> {
    const request = this.requirePending(id, decision)
    const outcome: ProbeRequest = { ...request, status: 'cancelled' }
    this.update(outcome)
    return this.result(await this.notify(outcome))
  }

  invalidateChange(changeId: string): void {
    const document = this.document.read()
    const requests = document.requests.map(request => {
      if (request.changeId !== changeId || !['pending', 'running'].includes(request.status)) return request
      this.running.get(request.id)?.abort(new Error('Authoring scope or source changed.'))
      return { ...request, status: 'cancelled' as const, error: 'The Change or its delegation changed. Request a new review.' }
    })
    if (!isDeepStrictEqual(requests, document.requests)) this.document.write({ ...document, requests })
  }

  async stop(): Promise<void> {
    this.stopped = true
    for (const controller of this.running.values()) controller.abort(new Error('Project is stopping.'))
    const outcomes = await Promise.allSettled(this.inflight)
    const failures = outcomes.filter(outcome => outcome.status === 'rejected').map(outcome => outcome.reason)
    if (failures.length) throw new AggregateError(failures, 'Could not finish saving interrupted authoring probes.')
  }

  private currentPolicy(request: ProbeRequest) {
    this.assertRunning()
    if (this.now() >= Date.parse(request.expiresAt)) throw new ProbeRequestError(409, 'Probe approval expired. Request a new review.')
    if (!this.options.canAuthor(request.sourceSessionId)) throw new ProbeRequestError(409, 'The authoring session is no longer available.')
    const change = this.options.changes.get(request.changeId)
    this.options.changes.authorize(change.id, request.sourceSessionId)
    if (change.closed || change.snapshot.revision !== request.revision ||
      change.accessRevision !== request.accessRevision) throw new ProbeRequestError(409, 'The reviewed Change was edited, closed, or its authoring scope changed.')
    const policy = this.options.service.options.store.preview(request.address, change.snapshot)
    const tool = policy?.tools.find(tool => tool.name === request.toolName)
    if (!policy || !tool || `sha256:${createHash('sha256').update(tool.code).digest('hex')}` !== request.sourceHash ||
      !isDeepStrictEqual(readOnlyGrants(policy, request.toolName), request.grants)) {
      throw new ProbeRequestError(409, 'The reviewed source or GET scope changed.')
    }
    return policy
  }

  private requirePending(id: string, decision: { revision: string }): ProbeRequest {
    this.assertRunning()
    const parsed = ProbeDecisionSchema.parse(decision)
    const request = this.list().find(request => request.id === id)
    if (!request || request.revision !== parsed.revision || request.status !== 'pending') {
      throw new ProbeRequestError(409, 'This exact-version probe request is no longer pending.')
    }
    return request
  }

  private result(request: ProbeRequest): ProbeDecisionResult {
    if (request.status === 'pending' || request.status === 'running') throw new Error('Probe has no terminal decision.')
    return { requestId: request.id, revision: request.revision, status: request.status,
      ...(request.runId ? { runId: request.runId } : {}), ...(request.error ? { error: request.error } : {}) }
  }

  private update(request: ProbeRequest): void {
    const document = this.document.read()
    this.document.write({ ...document, requests: document.requests.map(item => item.id === request.id ? request : item) })
  }

  private now(): number { return this.options.now?.() ?? Date.now() }
  private assertRunning(): void { if (this.stopped) throw new ProbeRequestError(503, 'Authoring probes are stopped.') }
}

export function authoringProbesPlugin(requests: AuthoringProbeRequests, authorize: (request: Request) => boolean | Promise<boolean>) {
  return (app: Hono) => {
    app.use('/api/agent-resources/probe-requests*', async (context, next) => {
      context.header('Cache-Control', 'no-store')
      await next()
    })
    app.get('/api/agent-resources/probe-requests', async context => {
      if (!await authorize(context.req.raw)) return context.json({ error: 'Unauthorized' }, 401)
      return context.json({ requests: requests.list() })
    })
    for (const method of ['post', 'delete'] as const) {
      app[method]('/api/agent-resources/probe-requests/:id', async context => {
        if (!await authorize(context.req.raw)) return context.json({ error: 'Unauthorized' }, 401)
        try {
          const text = await context.req.text()
          if (text.length > 1000) return context.json({ error: 'Probe decision is too large.' }, 413)
          const decision = ProbeDecisionSchema.parse(JSON.parse(text))
          const id = context.req.param('id')
          return context.json({ result: method === 'post' ? await requests.submit(id, decision) : await requests.cancel(id, decision) })
        } catch (error) {
          if (error instanceof ProbeRequestError) return context.json({ error: error.message }, error.status)
          if (error instanceof z.ZodError || error instanceof SyntaxError) return context.json({ error: 'Invalid probe decision.' }, 400)
          console.error('[authoring-probe] Approval failed', { error: error instanceof Error ? error.name : 'Error' })
          return context.json({ error: 'Probe outcome could not be saved or confirmed. Reload its status before requesting another run.' }, 500)
        }
      })
    }
  }
}
