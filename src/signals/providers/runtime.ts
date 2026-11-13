import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { projectStoragePath } from '../../utils/data-paths.ts'
import type { WorkflowRuntime } from '../../workflows/runtime.ts'
import { ExternalAction, FirstBatch, type Definition as WorkflowDefinition } from '../../workflows/contracts.ts'
import { writePrivateFile } from '../../config/store.ts'
import { CapabilityBroker, CapabilityError, validateJsonSchema } from '../../execution/grants.ts'
import { executeGrantedScript } from '../../script-runtime/granted-script.ts'
import { Collection, Definition, Name, HttpDeclaration, validateDefinition, canonical, digest, type SignalSourceProvider, type ProviderDefinition } from './contracts.ts'
import { githubProvider } from './github.ts'
import type { ProviderBrowserAccess } from '../../browser/provider-fetch.ts'

const builtins = [githubProvider]
const builtinDefinitions = builtins.map(provider => provider.definition)
const normalizers = new Map(builtins.map(provider => [provider.definition.id, provider.normalize]))

export const ProviderTransport = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('native') }).strict(),
  z.object({ kind: z.literal('browser'), instance: z.string().uuid(), targetId: z.string().regex(/^[A-Za-z0-9_-]{1,128}$/) }).strict(),
]).default({ kind: 'native' })
const Origin = z.string().url().refine(value => { const url = new URL(value); return url.protocol === 'https:' && url.origin === value && !url.username && !url.password }, 'Canonical HTTPS origin required')
const Instance = z.object({ id: Name, owner: z.string(), provider: Name, purpose: z.string().min(1).max(240).optional(), version: z.number().int(), secretRef: Name.optional(), transport: ProviderTransport, origin: Origin, binding: HttpDeclaration.optional(), enabled: z.boolean(), nextAt: z.number(), error: z.enum(['collection_failed', 'browser_context_unavailable', 'browser_fetch_failed', 'browser_cleanup_unconfirmed']).optional() }).strict()
const Demand = z.object({ mode: z.enum(['snapshot', 'delta']), checkpoint: z.unknown() }).strict()
const State = z.object({ format: z.literal(4), projectId: z.string().min(1), definitions: z.array(Definition).max(64), instances: z.array(Instance).max(32), demands: z.record(Demand) }).strict()
type StateData = z.infer<typeof State>
type InstanceData = z.infer<typeof Instance>

/** Project-local, single writer runtime. Atomic snapshots separate collection, transform and inbox acceptance. */
export class SignalProviderRuntime {
  private state: StateData = { format: 4, projectId: 'unbound', definitions: [], instances: [], demands: {} }
  private path: string
  private legacyPath: string
  private reservedInstances = new Set<string>()
  private timer?: ReturnType<typeof setInterval>
  private active?: Promise<void>
  private controller = new AbortController()
  private stopped = true
  private reloading = false
  private reloadDone?: Promise<void>
  private errors = new Map<string, string>()
  private browsers = new Map<string, ProviderBrowserAccess>()
  private browserCleanupFailure?: CapabilityError
  /** Re-admit only the persisted exact identity, never replace/expand it. */
  bindBrowser(owner: string, id: string, access: ProviderBrowserAccess): void {
    this.authorize(owner)
    const instance = this.state.instances.find(i => i.id === id)
    if (!instance || instance.transport.kind !== 'browser' || instance.transport.instance !== access.binding.instance || instance.transport.targetId !== access.binding.targetId) throw new Error('Browser binding identity mismatch')
    access.assertCurrent()
    this.browsers.set(id, access)
  }
  constructor(workspace: string, private broker: Pick<CapabilityBroker, 'execute'>, private workflows: WorkflowRuntime,
    private canUse: (sessionId: string) => boolean, private hasCredential: (ref: string) => boolean) {
    this.state.projectId = workflows.projectId
    this.path = projectStoragePath(workspace, '.signals', 'sources-v4.json')
    this.legacyPath = projectStoragePath(workspace, '.signals', 'sources-v3.json')
    workflows.bindSourceStatus(() => this.state.instances.map(i => ({ kind: 'external', id: i.id, enabled: !this.stopped && i.enabled, error: i.error, nextAt: i.nextAt })))
    workflows.bindSourceAuthorizer((owner, definition) => {
      this.authorize(owner)
      const instance = this.state.instances.find(i => i.id === definition.source.id)
      if (!instance || !this.member(instance, owner)) throw new Error('Source binding not authorized in this Project')
      this.current(instance, this.controller)
      const demand = this.provider(instance).normalize(definition.binding?.demand)
      if (Buffer.byteLength(canonical(demand)) > 8192) throw new Error('Demand too large')
      return { ...definition, binding: { demand } }
    })
    workflows.bindExternal(definition => this.workflowCurrent(definition))
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
  }
  start(): void {
    if (!this.stopped) return
    try {
      const stored = JSON.parse(readFileSync(this.path, 'utf8'))
      this.state = State.parse(stored)
      if (this.state.projectId !== this.workflows.projectId) throw new Error('Source state belongs to another Project')
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
    // Reserve identities only. Never load old code, credentials, checkpoints or subscriptions.
    try {
      const raw = readFileSync(this.legacyPath, 'utf8')
      if (Buffer.byteLength(raw) > 16 * 1024 * 1024) throw new Error('Legacy source state too large; inspect it manually')
      const legacy = z.object({ instances: z.array(z.object({ id: Name }).passthrough()) }).passthrough().parse(JSON.parse(raw))
      this.reservedInstances = new Set(legacy.instances.map(i => i.id))
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    for (const instance of this.state.instances) if (instance.error) this.errors.set(instance.id, instance.error)
    for (const definition of this.state.definitions) this.validate(definition)
    if (this.state.instances.some(i => !i.binding)) this.update(state => {
      for (const instance of state.instances) instance.binding ??= this.policy(this.definition(instance.provider, instance.version))
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
    await this.workflows.settle(this.subscriptions().map(s => s.workflow))
    await this.reloadDone?.catch(() => undefined)
    this.browsers.clear()
    if (this.browserCleanupFailure) throw this.browserCleanupFailure
  }
  private update(change: (state: StateData) => void): void {
    const next = structuredClone(this.state)
    change(next)
    State.parse(next)
    if (Buffer.byteLength(JSON.stringify(next)) > 16 * 1024 * 1024) throw new Error('Signal state capacity exceeded; collection not advanced')
    writePrivateFile(this.path, JSON.stringify(next))
    this.state = next
  }
  authorize(owner: string): void {
    if (this.stopped || this.reloading || !this.canUse(owner)) throw new Error('Provider access requires an available durable local owner in this Project')
  }
  private definition(id: string, version: number): ProviderDefinition {
    const definition = [...builtinDefinitions, ...this.state.definitions].find(item => item.id === id && item.version === version)
    if (!definition) throw new Error('Provider revision not found')
    return definition
  }
  private validate(definition: ProviderDefinition): void {
    validateDefinition(definition)
    for (const example of definition.examples) {
      validateJsonSchema(definition.demandSchema, example.demand)
      validateJsonSchema(definition.signalSchema, example.signal.data)
    }
  }
  private policy(definition: ProviderDefinition): z.infer<typeof HttpDeclaration> {
    return definition.http
  }
  private bound(instance: InstanceData): z.infer<typeof HttpDeclaration> {
    return instance.binding ?? this.policy(this.definition(instance.provider, instance.version))
  }
  private assertBound(declared: z.infer<typeof HttpDeclaration>, binding: z.infer<typeof HttpDeclaration>): void {
    if (declared.origin !== binding.origin || canonical(declared.credential ?? null) !== canonical(binding.credential ?? null) ||
      declared.routes.some(route => !binding.routes.some(allowed => canonical(route) === canonical(allowed)))) {
      throw new Error('Provider capability expansion exceeds authorized instance binding; create a separately authorized instance')
    }
  }
  canRead(owner: string): boolean { return this.canUse(owner) }
  /** Generated Project view; never resolves credentials or exposes external error bodies. */
  snapshot(owner: string) {
    // Reading immutable state neither invokes capabilities nor changes reload lifecycle.
    if (!this.canRead(owner)) throw new Error('Provider views require an available durable local session in this Project')
    return structuredClone({ providers: [...builtinDefinitions, ...this.state.definitions],
      instances: this.state.instances, subscriptions: this.subscriptions(),
      pending: this.subscriptions().flatMap(s => this.workflows.pending(s.workflow).map(r => ({ ...r, subscription: s.id }))),
      errors: Object.fromEntries(this.errors) })
  }
  publish(owner: string, raw: unknown): void {
    this.authorize(owner)
    const definition = Definition.parse(raw)
    this.validate(definition)
    if ([...builtinDefinitions, ...this.state.definitions].some(d => d.id === definition.id && d.version === definition.version)) throw new Error('Immutable provider revision already exists')
    // Publishing is project-wide discovery only, never a credential grant.
    this.update(state => { state.definitions.push(definition) })
  }
  /** Edit code then reload: host drains the old generation, probes restricted code, and atomically repins all matching Project instances. */
  reload(owner: string, raw: unknown): Promise<void> {
    this.authorize(owner)
    const candidateInput = Definition.omit({ version: true }).parse(raw)
    const input = candidateInput
    this.validate({ ...input, version: 1 })
    const instances = this.state.instances.filter(i => i.provider === input.id)
    if (instances.some(i => this.definition(i.provider, i.version).stateVersion !== input.stateVersion)) throw new Error('Checkpoint stateVersion incompatible; create a new instance/provider ID and explicitly select the Workflow first-batch policy')
    for (const instance of instances) this.assertBound(this.policy({ ...input, version: 1 }), this.bound(instance))
    const version = Math.max(0, ...[...builtinDefinitions, ...this.state.definitions].filter(d => d.id === input.id).map(d => d.version)) + 1
    const candidate = Definition.parse({ ...input, version })
    this.reloading = true
    this.controller.abort()
    const operation = (async () => {
      try {
        await this.active?.catch(() => undefined)
        await this.workflows.settle(this.subscriptions().map(s => s.workflow))
        if (this.browserCleanupFailure) throw this.browserCleanupFailure
        if (this.stopped) throw new Error('Runtime stopped during reload')
        this.controller = new AbortController()
        const probe = await executeGrantedScript({ code: candidate.code, args: { demands: [] }, signal: this.controller.signal,
          imports: ['@shadow/fetch', '@shadow/html'], allowedModules: ['@shadow/fetch', '@shadow/html'], callModule: async () => { throw new Error('Empty-demand reload probe cannot invoke capabilities') } })
        if (canonical(probe) !== '{}') throw new Error('Provider must return {} without IO for an empty demand list')
        this.controller.signal.throwIfAborted()
        if (this.stopped || !this.canUse(owner)) throw new Error('Reload authorization revoked')
        this.update(state => {
          state.definitions.push(candidate)
          for (const instance of state.instances.filter(i => i.provider === input.id)) instance.version = version
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
    const input = z.object({ id: Name, provider: Name, purpose: z.string().min(1).max(240).optional(), version: z.number().int().positive(), secretRef: Name.optional(), transport: ProviderTransport, origin: Origin.optional(), binding: HttpDeclaration.optional() }).strict().parse(raw)
    if (input.origin !== undefined && input.origin !== this.definition(input.provider, input.version).http.origin) throw new Error('Instance origin must match provider HTTP origin')
    const definition = this.definition(input.provider, input.version)
    const declared = this.policy(definition)
    const binding = input.binding ?? declared
    this.assertBound(declared, binding)
    if (input.transport.kind === 'browser') {
      if (binding.credential || input.secretRef) throw new Error('Browser transport requires cookie-only HTTP policy; no secretRef/credential or builtin GitHub')
      if (!browser || browser.binding.instance !== input.transport.instance || browser.binding.targetId !== input.transport.targetId) throw new Error('Explicit authorized browser context required; no native fallback')
      browser.assertCurrent()
    } else if (browser) throw new Error('Native transport cannot bind a browser')
    if (binding.credential && !input.secretRef) throw new Error('Credential binding requires secretRef')
    if (!binding.credential && input.secretRef) throw new Error('Public binding must not include secretRef')
    if (input.secretRef && !this.hasCredential(input.secretRef)) throw new Error('Provision this credential reference with credential_request first')
    if (this.reservedInstances.has(input.id) || this.workflows.inspect().definitions.some(d => d.source.kind === 'external' && d.source.id === input.id)) throw new Error('Source identity reserved by historical Workflow/state; create a new instance ID')
    if (this.state.instances.some(i => i.id === input.id)) throw new Error('Instance ID already exists')
    this.update(state => { state.instances.push({ ...input, origin: binding.origin, binding, owner, enabled: true, nextAt: 0 }) })
    if (browser) this.browsers.set(input.id, browser)
  }
  subscribe(owner: string, raw: unknown): void {
    this.authorize(owner)
    const input = z.object({ id: Name, instance: Name, demand: z.unknown(), first: FirstBatch, action: ExternalAction }).strict().parse(raw)
    const instance = this.state.instances.find(i => i.id === input.instance)
    if (!instance || !this.member(instance, owner)) throw new Error('Instance subscription not authorized')
    // This shortcut is the same versioned authoring boundary, never a second store.
    this.workflows.author(owner, { id: `external:${input.id}`, name: input.id, source: { kind: 'external', id: input.instance },
      binding: { demand: input.demand }, gate: { kind: 'revision-dedupe', first: input.first }, enabled: true,
      nodes: input.action.kind === 'notify' ? [{ kind: 'transform', code: input.action.processor }, { kind: 'inbox' }] : [input.action] })
  }
  private subscriptions() {
    return this.workflows.inspect().definitions.filter(d => d.source.kind === 'external' && d.owner && d.binding).map(d => ({
      id: d.id, workflow: d.id, instance: d.source.id, owner: d.owner!,
      demand: d.binding!.demand, ...(d.gate ? { first: d.gate.first } : {}), nodes: d.nodes,
    }))
  }
  private member(instance: InstanceData, owner: string): boolean {
    return this.state.instances.some(i => i.id === instance.id) && this.canUse(owner)
  }
  /** Project collection uses an available subscriber as invocation provenance, not the creator. */
  private invocationSession(instance: InstanceData): string {
    const subscriber = this.subscriptions().find(s => s.instance === instance.id && this.canUse(s.owner))
    if (!subscriber) throw new Error('No available Project subscriber')
    return subscriber.owner
  }
  unsubscribe(owner: string, id: string, expectedRevision: number): void {
    this.authorize(owner)
    this.workflows.retire(owner, `external:${id}`, expectedRevision)
  }
  pause(owner: string, id: string, enabled: boolean): void {
    this.authorize(owner)
    if (!this.state.instances.some(i => i.id === id)) throw new Error('Instance not found')
    this.update(state => { state.instances.find(i => i.id === id)!.enabled = enabled })
  }
  private provider(instance: InstanceData): SignalSourceProvider {
    const definition = this.definition(instance.provider, instance.version)
    return { definition,
      normalize: demand => { const normalized = normalizers.get(definition.id)?.(demand) ?? JSON.parse(canonical(demand)); validateJsonSchema(definition.demandSchema, normalized); return normalized },
      collect: async (demands, request, signal) => {
        const pending = new Set<Promise<unknown>>()
        let output: unknown
        let hostFailure: CapabilityError | undefined
        try {
          output = await executeGrantedScript({ code: definition.code, args: { demands }, signal,
            imports: ['@shadow/fetch', '@shadow/html'], allowedModules: ['@shadow/fetch', '@shadow/html'],
            callModule: (name, input, callSignal) => {
              const invoke = async () => {
                if (name !== 'fetch') throw new Error('Unknown capability')
                return request(input, callSignal)
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
    if (this.stopped || this.reloading || (!!instance.secretRef && !this.hasCredential(instance.secretRef)) || !this.state.instances.some(i => i.id === instance.id && i.enabled && i.version === instance.version)) throw new Error('Instance permission unavailable')
  }
  private async collect(instance: InstanceData): Promise<void> {
    const generation = this.controller
    this.current(instance, generation)
    const provider = this.provider(instance)
    const subscriptions = this.subscriptions().filter(s => s.instance === instance.id && this.member(instance, s.owner))
    for (const subscription of subscriptions) provider.normalize(subscription.demand)
    const unique = new Map(subscriptions.map(s => { const key = digest([instance.id, s.demand]); return [key, { key, demand: s.demand, checkpoint: this.state.demands[key]?.checkpoint ?? null }] }))
    if (!unique.size) return
    // Reserve capacity before external IO. Backpressure never advances a cursor.
    this.workflows.assertCapacity()
    let requests = 0
    const output = await provider.collect([...unique.values()], async (input, callSignal) => {
      this.current(instance, generation)
      if (++requests > 40 || Buffer.byteLength(canonical(input)) > 32768) throw new Error('Collection request bound exceeded')
      const definition = provider.definition
      const declared = this.policy(definition)
      this.assertBound(declared, this.bound(instance))
      const { credential, ...network } = declared
      const grant = { ...network, id: 'fetch', kind: 'http' as const,
        ...(credential && instance.secretRef ? { credential: { ...credential, secretRef: instance.secretRef } } : {}) }
      const response = await this.broker.execute(grant, input, {
        sessionId: this.invocationSession(instance), inputId: `provider:${instance.id}`, toolCallId: `provider:${instance.id}`, bindingKey: `provider:${instance.id}`, revision: digest(provider.definition),
        signal: AbortSignal.any([generation.signal, callSignal]), assertCurrent: () => this.current(instance, generation),
        ...(instance.transport.kind === 'browser' ? { browserRequest: this.browsers.get(instance.id)!.request } : {}),
      }) as { status: number; body: unknown }
      this.current(instance, generation)
      return response
    }, generation.signal)
    this.current(instance, generation)
    if (canonical(Object.keys(output).sort()) !== canonical([...unique.keys()].sort())) throw new Error('Provider must return every exact demand and no others')
    // Validate the complete collector result before admitting any subscriber batch.
    for (const [key, data] of Object.entries(output)) {
      if (Buffer.byteLength(canonical(data)) > 1024 * 1024 || Buffer.byteLength(canonical(data.checkpoint)) > 65536) throw new Error('Collection output bound exceeded')
      for (const signal of data.signals) validateJsonSchema(provider.definition.signalSchema, signal.data)
      if (new Set(data.signals.map(e => e.id)).size !== data.signals.length) throw new Error('Duplicate signal IDs')
      if (this.state.demands[key] && this.state.demands[key].mode !== data.mode) throw new Error('Collection semantics changed; use a new instance/stateVersion')
    }
    this.workflows.admit(subscriptions.filter(s => this.subscriptions().some(live => live.workflow === s.workflow && live.instance === s.instance && live.owner === s.owner && canonical(live.demand) === canonical(s.demand)) && this.member(instance, s.owner)).map(s => ({
      workflow: s.workflow, source: { kind: 'external', id: instance.id }, observations: output[digest([instance.id, s.demand])].signals,
    })))
    // Source checkpoint is only protocol state. A crash here may recollect; Workflow dedupes it.
    this.update(state => {
      for (const [key, data] of Object.entries(output)) state.demands[key] = { mode: data.mode, checkpoint: data.checkpoint }
    })
  }
  private workflowCurrent(definition: WorkflowDefinition): boolean {
    if (this.stopped || this.reloading) return false
    const subscription = this.subscriptions().find(s => s.workflow === definition.id && s.owner === definition.owner && s.instance === definition.source.id)
    const instance = this.state.instances.find(i => i.id === subscription?.instance)
    if (!subscription || !instance || !this.member(instance, subscription.owner)) return false
    try { this.current(instance, this.controller); return true } catch { return false }
  }
  private async cycle(): Promise<void> {
    for (const instance of [...this.state.instances]) {
      if (this.stopped || this.reloading || this.controller.signal.aborted) return
      if (!instance.enabled || instance.nextAt > Date.now()) continue
      // Persist rate reservation even on failure/restart; no catch-up bursts.
      this.update(state => { state.instances.find(i => i.id === instance.id)!.nextAt = Date.now() + 60000 })
      try {
        await this.collect(instance); this.errors.delete(instance.id)
        if (instance.error) this.update(state => { delete state.instances.find(i => i.id === instance.id)!.error })
      } catch (error) {
        const code = error instanceof CapabilityError && ['browser_context_unavailable', 'browser_fetch_failed', 'browser_cleanup_unconfirmed'].includes(error.code) ? error.code as NonNullable<InstanceData['error']> : 'collection_failed'
        this.errors.set(instance.id, code)
        this.update(state => { state.instances.find(i => i.id === instance.id)!.error = code })
      }
    }
    await Promise.all(this.subscriptions().map(s => this.workflows.drain(s.workflow, this.controller.signal)))
  }
}
