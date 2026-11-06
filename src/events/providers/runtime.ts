import { mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { projectStoragePath } from '../../utils/data-paths.ts'
import { writePrivateFile } from '../../config/store.ts'
import { CapabilityBroker, CapabilityError, validateJsonSchema } from '../../execution/grants.ts'
import { executeGrantedScript } from '../../script-runtime/granted-script.ts'
import type { DeliverInput } from '../../sessions/input.ts'
import { Collection, Definition, Drafts, Name, HttpDeclaration, validateDefinition, assertReadQuery, canonical, digest, type EventSourceProvider, type ProviderDefinition } from './contracts.ts'
import { githubDefinition } from './github.ts'

import type { ProviderBrowserAccess } from '../../browser/provider-fetch.ts'

export const ProviderTransport = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('native') }).strict(),
  z.object({ kind: z.literal('browser'), instance: z.string().uuid(), targetId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }).strict(),
]).default({ kind: 'native' })
const Origin = z.string().url().refine(value => { const url = new URL(value); return url.protocol === 'https:' && url.origin === value && !url.username && !url.password }, 'Canonical HTTPS origin required').default('https://api.github.com')
const Instance = z.object({ id: Name, owner: z.string(), provider: Name, version: z.number().int(), secretRef: Name.optional(), transport: ProviderTransport, origin: Origin, binding: HttpDeclaration.optional(), allowedSubscribers: z.array(z.string().min(1)).max(128).default([]), enabled: z.boolean(), nextAt: z.number() }).strict()
const Subscription = z.object({ id: Name, instance: Name, owner: z.string(), demand: z.unknown(), processor: z.string().max(64000) }).strict()
const Demand = z.object({ mode: z.enum(['snapshot', 'delta']).default('snapshot'), checkpoint: z.unknown(), seen: z.array(z.string()).max(4096), baseline: z.boolean() }).strict()
const Job = z.object({ id: z.string(), subscription: Name, event: z.object({ id: z.string(), data: z.unknown() }), attempts: z.number(), nextAt: z.number(), drafts: Drafts.optional(), delivered: z.number(), timestamp: z.string() }).strict()
const State = z.object({ format: z.literal(1), definitions: z.array(Definition).max(64), instances: z.array(Instance).max(32), subscriptions: z.array(Subscription).max(128), demands: z.record(Demand), jobs: z.array(Job).max(2000) }).strict()
type StateData = z.infer<typeof State>
type InstanceData = z.infer<typeof Instance>

/** Project-local, single writer runtime. Atomic snapshots separate collection, transform and inbox acceptance. */
export class EventProviderRuntime {
  private state: StateData = { format: 1, definitions: [], instances: [], subscriptions: [], demands: {}, jobs: [] }
  private path: string
  private timer?: ReturnType<typeof setInterval>
  private active?: Promise<void>
  private controller = new AbortController()
  private stopped = true
  private reloading = false
  private reloadDone?: Promise<void>
  private accepted = new Map<string, number>()
  private errors = new Map<string, string>()
  private browsers = new Map<string, ProviderBrowserAccess>()
  private browserCleanupFailure?: CapabilityError
  /** Re-admit only the persisted exact identity, never replace/expand it. */
  bindBrowser(owner: string, id: string, access: ProviderBrowserAccess): void {
    this.authorize(owner)
    const instance = this.state.instances.find(i => i.id === id && i.owner === owner)
    if (!instance || instance.transport.kind !== 'browser' || instance.transport.instance !== access.binding.instance || instance.transport.targetId !== access.binding.targetId) throw new Error('Browser binding identity mismatch')
    access.assertCurrent()
    this.browsers.set(id, access)
  }
  constructor(workspace: string, private broker: Pick<CapabilityBroker, 'execute'>, private deliver: DeliverInput,
    private canUse: (sessionId: string) => boolean, private hasCredential: (ref: string) => boolean) {
    const directory = projectStoragePath(workspace, '.events')
    mkdirSync(directory, { recursive: true, mode: 0o700 })
    this.path = join(directory, 'providers-v1.json')
  }
  start(): void {
    if (!this.stopped) return
    try { this.state = State.parse(JSON.parse(readFileSync(this.path, 'utf8'))) } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    for (const definition of this.state.definitions) this.validate(definition)
    if (this.state.instances.some(i => !i.binding)) this.update(state => {
      for (const instance of state.instances) instance.binding ??= this.policy(this.definition(instance.provider, instance.version), instance.origin)
    })
    this.stopped = false
    this.controller = new AbortController()
    this.timer = setInterval(() => { void this.run().catch(() => this.errors.set('runtime', 'cycle_failed')) }, 15000)
    this.timer.unref()
  }
  async stop(): Promise<void> {
    this.stopped = true
    clearInterval(this.timer)
    this.controller.abort()
    await this.active?.catch(() => undefined)
    await this.reloadDone?.catch(() => undefined)
    this.browsers.clear()
    this.flushAccepted()
    if (this.browserCleanupFailure) throw this.browserCleanupFailure
  }
  private flushAccepted(): void {
    if (!this.accepted.size) return
    this.update(state => { for (const [id, delivered] of this.accepted) { const job = state.jobs.find(j => j.id === id); if (job) job.delivered = Math.max(job.delivered, delivered) } })
    this.accepted.clear()
  }
  private update(change: (state: StateData) => void): void {
    const next = structuredClone(this.state)
    change(next)
    State.parse(next)
    if (Buffer.byteLength(JSON.stringify(next)) > 16 * 1024 * 1024) throw new Error('Event state capacity exceeded; collection not advanced')
    writePrivateFile(this.path, JSON.stringify(next))
    this.state = next
  }
  private authorize(owner: string): void {
    if (this.stopped || this.reloading || !this.canUse(owner)) throw new Error('Provider access requires an available durable local owner in this Project')
  }
  private definition(id: string, version: number): ProviderDefinition {
    const definition = [githubDefinition, ...this.state.definitions].find(item => item.id === id && item.version === version)
    if (!definition) throw new Error('Provider revision not found')
    return definition
  }
  private validate(definition: ProviderDefinition): void {
    validateDefinition(definition)
    if (definition.id === 'github-issues' && (definition.http || canonical(definition.queries) !== canonical(githubDefinition.queries))) throw new Error('Builtin GitHub requires its fixed read-only queries')
    definition.queries.forEach(assertReadQuery)
    definition.http?.readOnlyGraphqlQueries?.forEach(assertReadQuery)
    if (!definition.http && !definition.queries.length) throw new Error('Declare http capability or fixed legacy queries')
    for (const example of definition.examples) {
      validateJsonSchema(definition.demandSchema, example.demand)
      validateJsonSchema(definition.eventSchema, example.event.data)
    }
  }
  private policy(definition: ProviderDefinition, origin = 'https://api.github.com'): z.infer<typeof HttpDeclaration> {
    return definition.http ?? { origin, credential: { header: 'Authorization', prefix: 'Bearer ' },
      readOnlyGraphqlQueries: definition.queries, routes: [{ method: 'POST', path: '/graphql' }] }
  }
  private bound(instance: InstanceData): z.infer<typeof HttpDeclaration> {
    return instance.binding ?? this.policy(this.definition(instance.provider, instance.version), instance.origin)
  }
  private assertBound(declared: z.infer<typeof HttpDeclaration>, binding: z.infer<typeof HttpDeclaration>): void {
    if (declared.origin !== binding.origin || canonical(declared.credential ?? null) !== canonical(binding.credential ?? null) ||
      declared.routes.some(route => !binding.routes.some(allowed => canonical(route) === canonical(allowed))) ||
      (binding.readOnlyGraphqlQueries && (!declared.readOnlyGraphqlQueries || declared.readOnlyGraphqlQueries.some(q => !binding.readOnlyGraphqlQueries!.includes(q))))) {
      throw new Error('Provider capability expansion exceeds authorized instance binding; create a separately authorized instance')
    }
  }
  discover(owner: string) {
    this.authorize(owner)
    return { providers: [githubDefinition, ...this.state.definitions].map(({ code: _code, queries: _queries, ...info }) => info),
      instances: this.state.instances.filter(i => i.owner === owner),
      sharedInstances: this.state.instances.filter(i => i.owner !== owner && i.allowedSubscribers.includes(owner) && this.canUse(i.owner)).map(i => ({ id: i.id, provider: i.provider, version: i.version, enabled: i.enabled })), subscriptions: this.state.subscriptions.filter(s => s.owner === owner),
      pending: this.state.jobs.filter(j => this.state.subscriptions.some(s => s.id === j.subscription && s.owner === owner)).map(j => ({ id: j.id, subscription: j.subscription, attempts: j.attempts, stage: j.drafts ? 'delivery' : 'processor', nextAt: j.nextAt })),
      errors: Object.fromEntries([...this.errors].filter(([id]) => this.state.instances.some(i => i.id === id && i.owner === owner))) }
  }
  inspect(owner: string, id: string, version: number): ProviderDefinition {
    this.authorize(owner)
    return structuredClone(this.definition(id, version))
  }
  publish(owner: string, raw: unknown): void {
    this.authorize(owner)
    const definition = Definition.parse(raw)
    this.validate(definition)
    if ([githubDefinition, ...this.state.definitions].some(d => d.id === definition.id && d.version === definition.version)) throw new Error('Immutable provider revision already exists')
    // Publishing is project-wide discovery only, never a credential grant.
    this.update(state => { state.definitions.push(definition) })
  }
  /** Edit code then reload: host drains the old generation, probes restricted code, and atomically repins only this owner's instances. */
  reload(owner: string, raw: unknown): Promise<void> {
    this.authorize(owner)
    const candidateInput = Definition.omit({ version: true }).parse(raw)
    const input = candidateInput
    this.validate({ ...input, version: 1 })
    const owned = this.state.instances.filter(i => i.owner === owner && i.provider === input.id)
    if (owned.some(i => this.definition(i.provider, i.version).stateVersion !== input.stateVersion)) throw new Error('Checkpoint stateVersion incompatible; create a new instance/provider ID for a fresh silent baseline')
    for (const instance of owned) this.assertBound(this.policy({ ...input, version: 1 }, instance.origin), this.bound(instance))
    const version = Math.max(0, ...[githubDefinition, ...this.state.definitions].filter(d => d.id === input.id).map(d => d.version)) + 1
    const candidate = Definition.parse({ ...input, version })
    this.reloading = true
    this.controller.abort()
    const operation = (async () => {
      try {
        await this.active?.catch(() => undefined)
        if (this.browserCleanupFailure) throw this.browserCleanupFailure
        // Host-owned receipts from already-started inbox calls are reconciled after draining,
        // not committed by stale provider code. Graceful reload must not replay accepted drafts.
        this.flushAccepted()
        if (this.stopped) throw new Error('Runtime stopped during reload')
        this.controller = new AbortController()
        const probe = await executeGrantedScript({ code: candidate.code, args: { demands: [], queries: candidate.queries }, signal: this.controller.signal,
          imports: ['@shadow/fetch', '@shadow/html'], allowedModules: ['@shadow/fetch', '@shadow/html'], callModule: async () => { throw new Error('Empty-demand reload probe cannot invoke capabilities') } })
        if (canonical(probe) !== '{}') throw new Error('Provider must return {} without IO for an empty demand list')
        this.controller.signal.throwIfAborted()
        if (this.stopped || !this.canUse(owner)) throw new Error('Reload authorization revoked')
        this.update(state => {
          state.definitions.push(candidate)
          for (const instance of state.instances.filter(i => i.owner === owner && i.provider === input.id)) instance.version = version
          // Keep the four latest authoring snapshots plus every actively pinned revision.
          const recent = state.definitions.filter(d => d.id === input.id).map(d => d.version).sort((a, b) => b - a).slice(0, 4)
          state.definitions = state.definitions.filter(d => d.id !== input.id || recent.includes(d.version) || state.instances.some(i => i.provider === d.id && i.version === d.version))
        })
      } finally {
        // Failed validation leaves prior definitions/pins/checkpoints intact. All old work is already drained.
        if (!this.stopped) this.controller = new AbortController()
        this.reloading = false
      }
    })()
    this.reloadDone = operation.finally(() => { this.reloadDone = undefined })
    return this.reloadDone
  }
  create(owner: string, raw: unknown, browser?: ProviderBrowserAccess): void {
    this.authorize(owner)
    const input = z.object({ id: Name, provider: Name, version: z.number().int().positive(), secretRef: Name.optional(), transport: ProviderTransport, origin: Origin, binding: HttpDeclaration.optional(), allowedSubscribers: z.array(z.string().min(1)).max(128).default([]) }).strict().parse(raw)
    if (input.provider === 'github-issues' && input.origin !== 'https://api.github.com') throw new Error('Builtin GitHub provider requires api.github.com')
    const definition = this.definition(input.provider, input.version)
    const declared = this.policy(definition, input.origin)
    const binding = input.binding ?? declared
    this.assertBound(declared, binding)
    if (input.transport.kind === 'browser') {
      if (binding.credential || input.secretRef || input.provider === 'github-issues') throw new Error('Browser transport requires cookie-only HTTP policy; no secretRef/credential or builtin GitHub')
      if (!browser || browser.binding.instance !== input.transport.instance || browser.binding.targetId !== input.transport.targetId) throw new Error('Explicit authorized browser context required; no native fallback')
      browser.assertCurrent()
    } else if (browser) throw new Error('Native transport cannot bind a browser')
    if (binding.credential && !input.secretRef) throw new Error('Credential binding requires secretRef')
    if (!binding.credential && input.secretRef) throw new Error('Public binding must not include secretRef')
    this.validateSubscribers(input.allowedSubscribers)
    if (input.secretRef && !this.hasCredential(input.secretRef)) throw new Error('Provision this credential reference with credential_request first')
    if (this.state.instances.some(i => i.id === input.id)) throw new Error('Instance ID already exists')
    this.update(state => { state.instances.push({ ...input, origin: binding.origin, binding, owner, enabled: true, nextAt: 0 }) })
    if (browser) this.browsers.set(input.id, browser)
  }
  subscribe(owner: string, raw: unknown): void {
    this.authorize(owner)
    const input = z.object({ id: Name, instance: Name, demand: z.unknown(), processor: z.string().min(1).max(64000) }).strict().parse(raw)
    const instance = this.state.instances.find(i => i.id === input.instance)
    if (!instance || !this.member(instance, owner)) throw new Error('Instance subscription not authorized')
    if (this.state.subscriptions.some(s => s.id === input.id)) throw new Error('Subscription ID already exists; revisions require a new ID')
    const demand = this.provider(instance).normalize(input.demand)
    if (Buffer.byteLength(canonical(demand)) > 8192) throw new Error('Demand too large')
    this.update(state => { state.subscriptions.push({ ...input, demand, owner }) })
  }
  private validateSubscribers(ids: string[]): void {
    if (new Set(ids).size !== ids.length || ids.some(id => !this.canUse(id))) throw new Error('Subscribers must be explicit available durable local sessions in this Project')
  }
  private member(instance: InstanceData, owner: string): boolean {
    const live = this.state.instances.find(i => i.id === instance.id)
    return !!live && this.canUse(live.owner) && this.canUse(owner) && (live.owner === owner || live.allowedSubscribers.includes(owner))
  }
  /** Replace the allowlist. Revoked pending work is discarded, never replayed on regrant. */
  share(owner: string, raw: unknown): void {
    this.authorize(owner)
    const input = z.object({ id: Name, allowedSubscribers: z.array(z.string().min(1)).max(128) }).strict().parse(raw)
    this.validateSubscribers(input.allowedSubscribers)
    if (!this.state.instances.some(i => i.id === input.id && i.owner === owner)) throw new Error('Instance not owned by this session')
    this.update(state => {
      state.instances.find(i => i.id === input.id)!.allowedSubscribers = input.allowedSubscribers
      const revoked = state.subscriptions.filter(s => s.instance === input.id && s.owner !== owner && !input.allowedSubscribers.includes(s.owner))
      state.jobs = state.jobs.filter(j => !revoked.some(s => s.id === j.subscription))
    })
  }
  unsubscribe(owner: string, id: string): void {
    this.authorize(owner)
    if (!this.state.subscriptions.some(s => s.id === id && s.owner === owner)) throw new Error('Subscription not owned by this session')
    this.update(state => { state.subscriptions = state.subscriptions.filter(s => s.id !== id); state.jobs = state.jobs.filter(j => j.subscription !== id) })
  }
  pause(owner: string, id: string, enabled: boolean): void {
    this.authorize(owner)
    if (!this.state.instances.some(i => i.id === id && i.owner === owner)) throw new Error('Instance not owned by this session')
    this.update(state => { state.instances.find(i => i.id === id)!.enabled = enabled })
  }
  private provider(instance: InstanceData): EventSourceProvider {
    const definition = this.definition(instance.provider, instance.version)
    return { definition,
      normalize: demand => definition.id === 'github-issues'
        ? z.object({ repository: z.string().regex(/^[A-Za-z0-9_-]+\/[A-Za-z0-9_.-]+$/).transform(s => s.toLowerCase()) }).strict().parse(demand)
        : (() => { const normalized = JSON.parse(canonical(demand)); validateJsonSchema(definition.demandSchema, normalized); return normalized })(),
      collect: async (demands, request, signal) => {
        const pending = new Set<Promise<unknown>>()
        let output: unknown
        let hostFailure: CapabilityError | undefined
        try {
          output = await executeGrantedScript({ code: definition.code, args: { demands, queries: definition.queries }, signal,
            imports: ['@shadow/fetch', '@shadow/html'], allowedModules: ['@shadow/fetch', '@shadow/html'],
            callModule: (name, input, callSignal) => {
              const invoke = async () => {
                if (name !== 'fetch') throw new Error('Unknown capability')
                if (definition.http) return request(input, callSignal)
                const parsed = z.object({ query: z.string(), variables: z.record(z.unknown()) }).strict().parse(input)
                if (!definition.queries.includes(parsed.query)) throw new Error('Query text not approved in provider revision')
                return request({ query: parsed.query, variables: parsed.variables }, callSignal)
              }
              const task = invoke().catch(error => {
                if (error instanceof CapabilityError && ['browser_fetch_failed', 'browser_cleanup_unconfirmed'].includes(error.code)) hostFailure = error
                if (error instanceof CapabilityError && error.code === 'browser_cleanup_unconfirmed') this.browserCleanupFailure = error
                throw error
              })
              pending.add(task)
              void task.then(() => pending.delete(task), () => pending.delete(task))
              return task
            } })
        } catch (error) {
          throw hostFailure ?? error
        } finally {
          // Script teardown revokes callSignal, but its child lifecycle does not
          // drain host calls. Do that here before stop/reload can swap generations.
          await Promise.allSettled([...pending])
          if (this.browserCleanupFailure) throw this.browserCleanupFailure
        }
        return z.record(Collection).parse(output)
      } }
  }
  run(): Promise<void> {
    if (this.stopped || this.reloading) return Promise.reject(new Error('Provider runtime stopped or reloading'))
    if (this.active) return this.active
    this.active = this.cycle().finally(() => { this.active = undefined })
    return this.active
  }
  private current(instance: InstanceData, generation: AbortController): void {
    generation.signal.throwIfAborted()
    if (this.browserCleanupFailure) throw this.browserCleanupFailure
    if (instance.transport.kind === 'browser') {
      const browser = this.browsers.get(instance.id)
      if (!browser) throw new CapabilityError('browser_context_unavailable', 'Explicit same-identity browser rebind required; no native fallback')
      try { browser.assertCurrent() } catch { throw new CapabilityError('browser_context_unavailable', 'Browser authorization unavailable; no native fallback') }
    }
    if (generation !== this.controller) throw new Error('Stale provider generation')
    if (this.stopped || this.reloading || !this.canUse(instance.owner) || (!!instance.secretRef && !this.hasCredential(instance.secretRef)) || !this.state.instances.some(i => i.id === instance.id && i.enabled && i.version === instance.version)) throw new Error('Instance permission unavailable')
  }
  private async collect(instance: InstanceData): Promise<void> {
    const generation = this.controller
    this.current(instance, generation)
    const provider = this.provider(instance)
    const subscriptions = this.state.subscriptions.filter(s => s.instance === instance.id && this.member(instance, s.owner))
    for (const subscription of subscriptions) provider.normalize(subscription.demand)
    const unique = new Map(subscriptions.map(s => { const key = digest([instance.id, s.demand]); return [key, { key, demand: s.demand, checkpoint: this.state.demands[key]?.checkpoint ?? null }] }))
    if (!unique.size) return
    // Reserve capacity before external IO. Backpressure never advances a cursor.
    if (this.state.jobs.length > 1500) throw new Error('Processing backlog full')
    let requests = 0
    const output = await provider.collect([...unique.values()], async (input, callSignal) => {
      this.current(instance, generation)
      if (++requests > 40 || Buffer.byteLength(canonical(input)) > 32768) throw new Error('Collection request bound exceeded')
      const definition = provider.definition
      const declared = this.policy(definition, instance.origin)
      this.assertBound(declared, this.bound(instance))
      const legacy = !definition.http
      let raw = input
      let policy = declared
      if (legacy) {
        const parsed = z.object({ query: z.string(), variables: z.record(z.unknown()) }).strict().parse(input)
        if (!definition.queries.includes(parsed.query)) throw new Error('Query not declared')
        raw = { method: 'POST', path: '/graphql', body: parsed }
        // Preserve the exact body schema as well as broker-enforced read semantics.
        policy = { ...declared, routes: [{ method: 'POST', path: '/graphql', bodySchema: { type: 'object', required: ['query', 'variables'], additionalProperties: false,
          properties: { query: { const: parsed.query }, variables: { type: 'object' } } } }] }
      }
      const { credential, ...network } = policy
      const grant = { ...network, id: 'fetch', kind: 'http' as const,
        ...(credential && instance.secretRef ? { credential: { ...credential, secretRef: instance.secretRef } } : {}) }
      const response = await this.broker.execute(grant, raw, {
        sessionId: instance.owner, inputId: `provider:${instance.id}`, toolCallId: `provider:${instance.id}`, bindingKey: `provider:${instance.id}`, revision: digest(provider.definition),
        signal: AbortSignal.any([generation.signal, callSignal]), assertCurrent: () => this.current(instance, generation),
        ...(instance.transport.kind === 'browser' ? { browserRequest: this.browsers.get(instance.id)!.request } : {}),
      }) as { status: number; body: unknown }
      this.current(instance, generation)
      if (!legacy) return response
      const body = response.body as { data?: unknown; errors?: unknown } | null
      if (response.status !== 200 || !body || body.errors !== undefined || !body.data) throw new Error('GraphQL response failed or partial')
      return body.data
    }, generation.signal)
    this.current(instance, generation)
    if (canonical(Object.keys(output).sort()) !== canonical([...unique.keys()].sort())) throw new Error('Provider must return every exact demand and no others')
    this.update(state => {
      for (const [key, data] of Object.entries(output)) {
        if (Buffer.byteLength(canonical(data)) > 1024 * 1024 || Buffer.byteLength(canonical(data.checkpoint)) > 65536) throw new Error('Collection output bound exceeded')
        for (const event of data.events) validateJsonSchema(provider.definition.eventSchema, event.data)
        const ids = data.events.map(e => e.id)
        if (new Set(ids).size !== ids.length) throw new Error('Duplicate event IDs')
        const old = state.demands[key]
        if (old && old.mode !== data.mode) throw new Error('Collection semantics changed; use a new instance/stateVersion')
        if (old?.baseline) for (const event of data.events.filter(e => !old.seen.includes(e.id))) {
          for (const subscription of subscriptions.filter(s => state.subscriptions.some(live => live.id === s.id) && this.member(instance, s.owner) && digest([instance.id, s.demand]) === key)) {
            const id = digest([instance.id, subscription.id, event.id])
            if (!state.jobs.some(j => j.id === id)) state.jobs.push({ id, subscription: subscription.id, event, attempts: 0, nextAt: 0, delivered: 0, timestamp: new Date().toISOString() })
          }
        }
        // Delta retains a bounded FIFO ID window across polls/restarts. Evicted IDs may replay;
        // sources must provide monotonic cursors and stable revision IDs, not unlimited history replay.
        const seen = data.mode === 'delta' ? [...new Set([...(old?.seen ?? []), ...ids])].slice(-4096) : ids
        state.demands[key] = { mode: data.mode, checkpoint: data.checkpoint, seen, baseline: true }
      }
    })
  }
  private async process(): Promise<void> {
    const generation = this.controller
    for (const pending of [...this.state.jobs].filter(j => j.nextAt <= Date.now()).slice(0, 64)) {
      const subscription = this.state.subscriptions.find(s => s.id === pending.subscription)
      const instance = this.state.instances.find(i => i.id === subscription?.instance)
      if (!subscription || !instance || !this.member(instance, subscription.owner) || (!!instance.secretRef && !this.hasCredential(instance.secretRef))) {
        this.update(state => { state.jobs = state.jobs.filter(j => j.id !== pending.id) }); continue
      }
      if (!instance.enabled) continue
      const authorized = () => {
        this.current(instance, generation)
        if (!this.member(instance, subscription.owner) || !this.state.subscriptions.some(s => s.id === subscription.id) || !this.state.jobs.some(j => j.id === pending.id)) throw new Error('Subscription revoked')
      }
      try {
        authorized()
        let job = this.state.jobs.find(j => j.id === pending.id)!
        if (!job.drafts) {
          const drafts = Drafts.parse(await executeGrantedScript({ code: subscription.processor, args: { event: structuredClone(job.event) }, signal: generation.signal,
            imports: ['@shadow/html'], allowedModules: ['@shadow/html'], callModule: async () => { throw new Error('Processors have no capabilities') } }))
          authorized()
          this.update(state => { state.jobs.find(j => j.id === job.id)!.drafts = drafts })
          job = this.state.jobs.find(j => j.id === pending.id)!
        }
        for (let index = job.delivered; index < job.drafts!.length; index++) {
          authorized()
          const id = digest([job.id, index])
          const receipt = await this.deliver(subscription.owner, { id, kind: 'message', timestamp: job.timestamp, policy: 'queue', content: job.drafts![index].content,
            source: { kind: 'event', eventId: job.event.id, type: 'provider.message', source: `provider:${instance.id}` } })
          if (receipt.status !== 'accepted' || receipt.disposition === 'filtered' || receipt.sessionId !== subscription.owner || receipt.inputId !== id) throw new Error('Inbox acceptance not confirmed')
          this.accepted.set(job.id, index + 1)
          authorized()
          this.flushAccepted()
        }
        authorized()
        this.update(state => { state.jobs = state.jobs.filter(j => j.id !== job.id) })
      } catch {
        if (this.stopped || this.reloading || this.controller.signal.aborted) return
        // Persisted failures are metadata only. External error bodies may contain secrets.
        this.update(state => { const job = state.jobs.find(j => j.id === pending.id); if (!job) return; job.attempts++; job.nextAt = Date.now() + Math.min(3600000, 15000 * 2 ** Math.min(job.attempts, 8)) })
      }
    }
  }
  private async cycle(): Promise<void> {
    this.flushAccepted()
    for (const instance of [...this.state.instances]) {
      if (this.stopped || this.reloading || this.controller.signal.aborted) return
      if (!instance.enabled || instance.nextAt > Date.now() || !this.canUse(instance.owner)) continue
      // Persist rate reservation even on failure/restart; no catch-up bursts.
      this.update(state => { state.instances.find(i => i.id === instance.id)!.nextAt = Date.now() + 60000 })
      try { await this.collect(instance); this.errors.delete(instance.id) } catch (error) {
        this.errors.set(instance.id, error instanceof CapabilityError && ['browser_context_unavailable', 'browser_fetch_failed', 'browser_cleanup_unconfirmed'].includes(error.code) ? error.code : 'collection_failed')
      }
    }
    await this.process()
  }
}
