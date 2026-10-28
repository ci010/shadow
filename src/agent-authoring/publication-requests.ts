import { randomUUID } from 'node:crypto'
import type { Hono } from 'hono'
import { z } from 'zod'
import type { AgentAuthoringService } from './service.ts'
import { conversationBindingKey, type ResourceSnapshot } from './contracts.ts'
import { parseFrontmatter } from '../utils/frontmatter.ts'
import { PrivateDocument } from './private-document.ts'
import {
  PublicationDecisionSchema, parsePublicationRequest,
  type PublicationRequest, type PublicationResult,
} from './publication-contract.ts'

export interface PublicationOptions {
  service: AgentAuthoringService
  retire: (matches: (sessionId: string) => boolean) => Promise<void>
  validateLive: (snapshot: ResourceSnapshot) => Promise<void>
  directory?: string
  /** Check the owning Change's revision/base/lifecycle; throw stale_request to invalidate its review. */
  validateRequest?: (request: PublicationRequest) => void
}

/** Retirement hooks throw this only for known active or queued conversation work. */
export class PublicationBusyError extends Error {}

export interface PublicationProposal {
  snapshot: ResourceSnapshot
  change: NonNullable<PublicationRequest['change']>
  checks: NonNullable<PublicationRequest['checks']>
}

/** Safe phase attribution without returning provider or configuration error messages. */
export class PublicationValidationError extends Error {
  constructor(readonly stage: 'request' | 'live', cause: unknown) {
    super(cause instanceof Error ? cause.message : 'Publication validation failed', { cause })
    this.name = 'PublicationValidationError'
  }
}

export class PublicationRequestError extends Error {
  constructor(readonly code: string, readonly status: 409 | 503, message: string) {
    super(message)
  }
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`
  if (value && typeof value === 'object') return `{${Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(',')}}`
  return JSON.stringify(value) ?? 'undefined'
}

function impact(base: ResourceSnapshot, next: ResourceSnapshot): NonNullable<PublicationRequest['impact']> {
  const different = (a: unknown, b: unknown) => canonical(a) !== canonical(b)
  const before = new Map(base.bundle.bindings.map(binding => [conversationBindingKey(binding), binding]))
  const after = new Map(next.bundle.bindings.map(binding => [conversationBindingKey(binding), binding]))
  const changed = new Set([...Object.keys(base.bundle.files), ...Object.keys(next.bundle.files)]
    .filter(path => base.bundle.files[path] !== next.bundle.files[path]))
  const affectedBindings = [...new Set([...before.keys(), ...after.keys()])].filter(key => {
    const a = before.get(key)
    const b = after.get(key)
    if (different(a, b)) return true
    return [a, b].some(binding => binding && [...changed].some(path =>
      path === `agents/${binding.agent}/AGENT.md` || binding.skills.some(skill => path.startsWith(`skills/${skill}/`))))
  }).sort()
  const permissions = (binding: ResourceSnapshot['bundle']['bindings'][number] | undefined) => binding && ({
    enabled: binding.enabled, agent: binding.agent, skills: binding.skills,
    allowFrom: binding.allowFrom, readFolders: binding.readFolders, grants: binding.grants,
  })
  let permissionsChanged = affectedBindings.some(key => different(permissions(before.get(key)), permissions(after.get(key))))
  let promptsChanged = affectedBindings.some(key =>
    different(before.get(key)?.agent, after.get(key)?.agent) ||
    different(before.get(key)?.skills, after.get(key)?.skills))
  let toolsChanged = affectedBindings.some(key => different(before.get(key)?.skills, after.get(key)?.skills))
  for (const path of changed) {
    if (/\.(?:js|ts)$/.test(path)) { toolsChanged = true; continue }
    const a = base.bundle.files[path] === undefined ? undefined : parseFrontmatter(base.bundle.files[path])
    const b = next.bundle.files[path] === undefined ? undefined : parseFrontmatter(next.bundle.files[path])
    promptsChanged ||= different(a?.body, b?.body)
    if (path.startsWith('agents/')) {
      for (const field of ['allowedTools', 'blockedTools', 'allowedModules']) {
        permissionsChanged ||= different(a?.frontmatter[field], b?.frontmatter[field])
        if (field !== 'allowedModules') toolsChanged ||= different(a?.frontmatter[field], b?.frontmatter[field])
      }
    } else {
      toolsChanged ||= different(a?.frontmatter.tools, b?.frontmatter.tools)
      const imports = (fm: typeof a) => Object.entries((fm?.frontmatter.tools ?? {}) as Record<string, {
        imports?: string[]; capabilities?: string[]
      }>).sort(([a], [b]) => a.localeCompare(b)).map(([name, tool]) => ({ name, imports: tool.imports ?? tool.capabilities ?? [] }))
      permissionsChanged ||= different(imports(a), imports(b))
    }
  }
  return { affectedBindings, permissionsChanged, promptsChanged, toolsChanged }
}

function retirement(options: PublicationOptions, snapshot: ResourceSnapshot): () => Promise<void> {
  const affected = new Set(impact(options.service.options.store.snapshot(), snapshot).affectedBindings)
  return () => options.retire(id => {
    const address = options.service.address(id)
    return !!address && affected.has(conversationBindingKey(address))
  })
}

/** Both owner entry points use the same admission guard, retirement and live validation. */
export async function publishAgentResources(
  options: PublicationOptions,
  revision: string,
  baseRevision: string,
  assertPending?: () => void,
): Promise<ResourceSnapshot> {
  const { service } = options
  const store = service.options.store
  assertPending?.()
  if (store.draft().revision !== revision || store.snapshot().revision !== baseRevision) {
    throw new PublicationRequestError('stale_request', 409, 'The draft or published revision changed. Review the current draft again.')
  }
  const validation = store.validate()
  if (!validation.valid) throw new Error(validation.errors.join('\n'))
  return service.changePublished(
    retirement(options, store.draft()),
    () => store.publish(revision, {
      baseRevision, validateLive: options.validateLive, assertPending,
    }),
  )
}

/** Nonblocking review metadata; only the authenticated owner route may submit it. */
export class PublicationRequests {
  private entries: Array<{ request: PublicationRequest; snapshot: ResourceSnapshot; approved: boolean }>
  private readonly document: PrivateDocument<typeof this.entries>
  private readonly reviewHistory: PrivateDocument<Array<{id:string; revision:string; status:'applied'|'cancelled'; decidedAt:string}>>
  private submitting = false
  private stopped = false
  private generation = 0
  private publicationGeneration = 0
  private readonly unsubscribe: () => void

  constructor(private readonly options: PublicationOptions) {
    const store = options.service.options.store
    this.document = new PrivateDocument({
      projectId: options.service.options.projectId,
      directory: options.directory ?? store.storageDirectory, filename: 'publication-requests.json',
      initial: [],
      parse: value => {
        const entries = z.array(z.object({
          request: z.unknown(), snapshot: z.unknown(), approved: z.boolean(),
        }).strict()).max(100).parse(value).map(entry => {
          const request = parsePublicationRequest(entry.request, options.service.options.projectId)
          const raw = z.object({ revision: z.string(), bundle: z.unknown() }).strict().parse(entry.snapshot)
          const snapshot = store.candidate(raw.bundle as ResourceSnapshot['bundle'])
          if (snapshot.revision !== raw.revision || snapshot.revision !== request.revision ||
            canonical(snapshot.bundle.bindings) !== canonical(request.bindings)) {
            throw new Error('Publication candidate does not match its reviewed revision.')
          }
          const validation = store.validate(snapshot)
          if (!validation.valid) throw new Error(validation.errors.join('\n'))
          const base = store.snapshot()
          if (base.revision === request.baseRevision) {
            const files = [...new Set([...Object.keys(base.bundle.files), ...Object.keys(snapshot.bundle.files)])].sort()
              .filter(path => base.bundle.files[path] !== snapshot.bundle.files[path])
              .map(path => ({ path, before: base.bundle.files[path] ?? null, after: snapshot.bundle.files[path] ?? null }))
            if (canonical(files) !== canonical(request.files) ||
              canonical(base.bundle.bindings) !== canonical(request.previousBindings) ||
              (request.impact && canonical(impact(base, snapshot)) !== canonical(request.impact))) {
              throw new Error('Publication review does not match its candidate and base.')
            }
          }
          if (request.status === 'waiting' && !entry.approved) throw new Error('Waiting publication has no owner approval.')
          return { request, snapshot, approved: entry.approved }
        })
        if (new Set(entries.map(entry => entry.request.id)).size !== entries.length ||
          new Set(entries.map(entry => entry.request.change?.id ?? null)).size !== entries.length) {
          throw new Error('Duplicate publication requests.')
        }
        return entries
      },
    })
    this.reviewHistory = new PrivateDocument({
      projectId: options.service.options.projectId,
      directory: options.directory ?? store.storageDirectory, filename:'publication-review-history.json', initial:[],
      parse: value => z.array(z.object({id:z.string(),revision:z.string(),status:z.enum(['applied','cancelled']),decidedAt:z.string().datetime()}).strict()).parse(value),
    })
    this.entries = this.document.read().map(entry => entry.approved
      ? { ...entry, request: { ...entry.request, status: 'waiting' } } : entry)
    let draft = store.draft().revision
    let published = store.snapshot().revision
    this.unsubscribe = store.onChange(() => {
      this.generation++
      const nextDraft = store.draft().revision
      const nextPublished = store.snapshot().revision
      const publication = nextPublished !== published || nextDraft === draft
      if (publication) this.publicationGeneration++
      const entries = publication ? [] : this.entries.filter(entry => !!entry.request.change)
      draft = nextDraft
      published = nextPublished
      if (entries.length !== this.entries.length) this.save(entries)
    })
  }

  async propose(input: PublicationProposal | undefined, expectedDraftRevision: string | undefined, sessionId: string, expectedBaseRevision?: string): Promise<PublicationRequest> {
    this.assertRunning()
    if (this.submitting) throw new PublicationRequestError('publication_in_progress', 409, 'Publication is already in progress.')
    const store = this.options.service.options.store
    const generation = this.generation
    const publicationGeneration = this.publicationGeneration
    const proposal = input === undefined ? undefined : structuredClone(input)
    const draft = proposal?.snapshot ?? store.draft()
    const base = store.snapshot()
    if (expectedBaseRevision !== undefined && base.revision !== expectedBaseRevision) throw this.stale()
    if (expectedDraftRevision !== undefined && draft.revision !== expectedDraftRevision) throw this.stale()
    const validation = store.validate(draft)
    if (!validation.valid) throw new Error(validation.errors.join('\n'))
    const paths = [...new Set([...Object.keys(base.bundle.files), ...Object.keys(draft.bundle.files)])].sort()
    const request = parsePublicationRequest({
      id: randomUUID(), projectId: this.options.service.options.projectId,
      sessionId: proposal?.change.sourceSessionId ?? sessionId, revision: draft.revision, baseRevision: base.revision,
      createdAt: new Date().toISOString(),
      files: paths.filter(path => base.bundle.files[path] !== draft.bundle.files[path])
        .map(path => ({ path, before: base.bundle.files[path] ?? null, after: draft.bundle.files[path] ?? null })),
      previousBindings: base.bundle.bindings, bindings: draft.bundle.bindings,
      impact: impact(base, draft),
      ...(proposal ? { change: proposal.change, checks: proposal.checks } : {}),
    }, this.options.service.options.projectId)
    try { this.options.validateRequest?.(structuredClone(request)) } catch (error) {
      if (error instanceof PublicationRequestError) throw error
      throw new PublicationValidationError('request', error)
    }
    try { await this.options.validateLive(structuredClone(draft)) } catch (error) {
      if (error instanceof PublicationRequestError) throw error
      throw new PublicationValidationError('live', error)
    }
    this.assertRunning()
    if (this.submitting || this.publicationGeneration !== publicationGeneration || store.snapshot().revision !== base.revision ||
      (!proposal && generation !== this.generation)) throw this.stale()
    this.options.validateRequest?.(structuredClone(request))
    const existing = this.list().find(item => item.sessionId === request.sessionId && item.change?.id === request.change?.id &&
      item.change?.accessRevision === request.change?.accessRevision && item.revision === request.revision)
    if (existing) return existing
    this.save([...this.entries.filter(entry => entry.request.change?.id !== request.change?.id),
      { request, snapshot: draft, approved: false }])
    return structuredClone(request)
  }

  pending(): PublicationRequest | null {
    return this.list()[0] ?? null
  }

  list(): PublicationRequest[] {
    if (this.stopped) return []
    const store = this.options.service.options.store
    const terminal = this.reviewHistory.read()
    const entries = this.entries.filter(entry => {
      const request = entry.request
      if (terminal.some(item => item.id === request.id && item.revision === request.revision)) return false
      if (request.baseRevision !== store.snapshot().revision ||
        (!request.change && request.revision !== store.draft().revision)) return false
      try { this.options.validateRequest?.(structuredClone(request)) } catch (error) {
        if (error instanceof PublicationRequestError && error.code === 'stale_request') return false
        throw error
      }
      return true
    })
    if (entries.length !== this.entries.length) this.save(entries)
    return this.entries.map(entry => structuredClone(entry.request))
  }

  invalidateChange(changeId: string): void {
    this.assertRunning()
    this.save(this.entries.filter(entry => entry.request.change?.id !== changeId))
  }

  async submit(id: string, decision: { revision: string; baseRevision: string }): Promise<PublicationResult> {
    const entry = this.requirePending(id, decision)
    const originalRequest = entry.request
    const request = {...originalRequest,approvedAt:originalRequest.approvedAt ?? new Date().toISOString()}
    this.submitting = true
    const wasWaiting = entry.approved
    try {
      entry.approved = true
      entry.request = request
      try { this.save(this.entries) } catch (error) { entry.approved = wasWaiting; entry.request = originalRequest; throw error }
      const assertPending = () => {
        this.assertRunning()
        if (!this.entries.includes(entry) ||
          this.options.service.options.store.snapshot().revision !== request.baseRevision) throw this.stale()
        this.options.validateRequest?.(structuredClone(request))
        // Recheck disk CAS after every async boundary, including external cancellation.
        this.document.assertCurrent()
      }
      const store = this.options.service.options.store
      if (request.change) {
        assertPending()
        await this.options.validateLive(structuredClone(entry.snapshot))
        assertPending()
        await this.options.service.changePublished(
          retirement(this.options, entry.snapshot),
          () => store.publishSnapshot(entry.snapshot, {
            baseRevision: request.baseRevision, validateLive: this.options.validateLive, assertPending,
          }),
        )
      } else {
        await publishAgentResources(this.options, request.revision, request.baseRevision, assertPending)
      }
      this.finishReview(request, 'applied')
      if (this.entries.includes(entry)) this.save(this.entries.filter(item => item !== entry))
      return { requestId: request.id, revision: request.revision, status: 'published' }
    } catch (error) {
      if (!this.stopped && this.entries.includes(entry)) {
        if (error instanceof PublicationBusyError) {
          entry.request = { ...request, status: 'waiting' }
          delete entry.request.error
          this.save(this.entries)
          return { requestId: request.id, revision: request.revision, status: 'waiting' }
        }
        entry.approved = false
        entry.request = { ...originalRequest, status: 'error', error: {
          code: 'publication_failed', message: 'Publication failed. Review the current configuration before explicitly retrying.',
        } }
        this.save(this.entries)
      }
      throw error
    } finally { this.submitting = false }
  }

  /** Called explicitly after runtime initialization or when affected work becomes idle. No timers. */
  async retryWaiting(): Promise<PublicationResult[]> {
    this.assertRunning()
    const results: PublicationResult[] = []
    for (const request of this.list().filter(request => request.status === 'waiting')) {
      const result = await this.submit(request.id, { revision: request.revision, baseRevision: request.baseRevision })
      results.push(result)
      if (result.status === 'published') break
    }
    return results
  }

  cancel(id: string, decision: { revision: string; baseRevision: string }): PublicationResult {
    const entry = this.requirePending(id, decision)
    const request = entry.request
    this.finishReview(request, 'cancelled')
    this.save(this.entries.filter(item => item !== entry))
    return { requestId: request.id, revision: request.revision, status: 'cancelled' }
  }

  /** Durable terminal receipts are separate from the actionable request queue. */
  reviewStatus(request: PublicationRequest): {status:'pending'|'waiting'|'error'|'applied'|'cancelled'|'stale'|'unavailable'; decidedAt?:string} {
    const terminal = this.reviewHistory.read().find(item => item.id === request.id && item.revision === request.revision)
    if (terminal) return {status:terminal.status, decidedAt:terminal.decidedAt}
    const pending = this.list().find(item => item.id === request.id && item.revision === request.revision)
    if (pending) return {status:pending.status ?? 'pending',...(pending.approvedAt ? {decidedAt:pending.approvedAt} : {})}
    // An equal release is not proof this particular request was approved.
    if (this.options.service.options.store.snapshot().revision === request.revision) return {status:'unavailable'}
    return {status:'stale'}
  }

  private finishReview(request: PublicationRequest, status:'applied'|'cancelled'): void {
    const records = this.reviewHistory.read()
    if (records.some(item => item.id === request.id)) return
    this.reviewHistory.write([...records,{id:request.id,revision:request.revision,status,decidedAt:status === 'applied' ? request.approvedAt ?? new Date().toISOString() : new Date().toISOString()}])
  }

  stop(): void {
    this.stopped = true
    this.unsubscribe()
  }

  private save(entries: typeof this.entries): void {
    this.document.write(entries)
    this.entries = entries
  }

  private requirePending(id: string, decision: { revision: string; baseRevision: string }): typeof this.entries[number] {
    this.assertRunning()
    const parsed = PublicationDecisionSchema.parse(decision)
    if (this.submitting) throw new PublicationRequestError('publication_in_progress', 409, 'Publication is already in progress.')
    this.list()
    const entry = this.entries.find(entry => entry.request.id === id)
    const request = entry?.request
    if (!request || request.id !== id || request.revision !== parsed.revision ||
      request.baseRevision !== parsed.baseRevision) throw this.stale()
    return entry!
  }

  private assertRunning(): void {
    if (this.stopped) throw new PublicationRequestError('stopped', 503, 'Publication requests are stopped.')
  }

  private stale(): PublicationRequestError {
    return new PublicationRequestError('stale_request', 409, 'This review is no longer current. Propose and review the current candidate again.')
  }
}

export function authoringPublicationPlugin(
  requests: PublicationRequests,
  authorize: (request: Request) => boolean | Promise<boolean>,
) {
  return (app: Hono) => {
    app.use('/api/agent-resources/publication-requests*', async (context, next) => {
      context.header('Cache-Control', 'no-store')
      await next()
    })
    app.get('/api/agent-resources/publication-requests', async context => {
      if (!await authorize(context.req.raw)) return context.json({ error: 'Unauthorized' }, 401)
      try {
        const pending = requests.list()
        return context.json({ request: pending[0] ?? null, requests: pending })
      } catch (error) {
        if (error instanceof PublicationRequestError) return context.json({ error: error.code, message: error.message }, error.status)
        return context.json({ error: 'publication_unavailable', message: 'Publication reviews could not be validated.' }, 500)
      }
    })
    for (const method of ['post', 'delete'] as const) {
      app[method]('/api/agent-resources/publication-requests/:id', async context => {
        if (!await authorize(context.req.raw)) return context.json({ error: 'Unauthorized' }, 401)
        try {
          const text = await context.req.text()
          if (text.length > 1000) return context.json({ error: 'Publication decision is too large.' }, 413)
          const decision = PublicationDecisionSchema.parse(JSON.parse(text))
          const id = context.req.param('id')
          const result = method === 'post' ? await requests.submit(id, decision) : requests.cancel(id, decision)
          return context.json({ result })
        } catch (error) {
          if (error instanceof PublicationRequestError) return context.json({ error: error.code, message: error.message }, error.status)
          if (error instanceof z.ZodError || error instanceof SyntaxError) return context.json({ error: 'Invalid publication decision.' }, 400)
          return context.json({ error: 'publication_failed', message: 'Agent resources were not published. Check live configuration and active conversation work before explicitly retrying.' }, 500)
        }
      })
    }
  }
}
