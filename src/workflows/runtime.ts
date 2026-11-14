import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { projectStoragePath } from '../utils/data-paths.ts'
import { writePrivateFile } from '../utils/private-file.ts'
import { executeGrantedScript } from '../script-runtime/granted-script.ts'
import { canonical, digest } from './json.ts'
import type { DeliverInput } from '../sessions/input.ts'
import { AuthorDefinition, MappingConflict, revisionTime, Drafts, Observation, WorkflowDefinition, WorkflowState, type Definition, type Run, type SignalObservation, type State, type WorkMapNode, type WorkMapping, type GitHubNotifyNode } from './contracts.ts'

class WorkflowAuthorityError extends Error {}

const terminal = (run: Run) => run.status === 'completed' || run.status === 'cancelled'
const safe = (run: Run) => { const node = run.definition.nodes[run.cursor]; return node?.kind !== 'github-notify' && node?.kind !== 'schedule-action' && !(node?.kind === 'host-action' && node.replay === 'confirm') }

/** One host per Project; sync atomic commits serialize admission, per-flow lanes serialize effects. */
export class WorkflowRuntime {
  private state: State
  private path: string
  private stopped = true
  private executionReady = false
  private runtimeError?: 'persistence_failed' | 'cycle_failed'
  private controller = new AbortController()
  private active = new Map<string, Promise<void>>()
  private timer?: ReturnType<typeof setInterval>
  private schedule?: { execute(job: unknown, signal: AbortSignal): Promise<void | { sessionId: string }>; current(job: unknown): boolean }
  private github?: { current(node: GitHubNotifyNode): boolean; execute(node: GitHubNotifyNode, observation: SignalObservation, signal: AbortSignal): Promise<void> }
  bindGitHub(adapter: NonNullable<WorkflowRuntime['github']>) { this.github = adapter }
  private botEpoch = new Map<string, number>()
  private botAvailable?: (id: string) => boolean
  bindBots(available: (id: string) => boolean) { this.botAvailable = available }
  /** Reference only: BOT.md owns addresses/filters. No input is enqueued into
   * recoverable Workflow runs; receipt/arrival guards stay in the channel path. */
  botExecution(id: string): { enabled: boolean; generation: string } {
    const refs = this.state.definitions.filter(d => d.source.kind === 'bot' && d.source.id === id)
    return { enabled: !this.stopped && refs.every(d => d.enabled && !!d.owner && this.host.canUse(d.owner)), generation: digest([this.botEpoch.get(id) ?? 0, refs.map(d => [d.id, d.revision, d.enabled])]) }
  }

  private hosts = new Map<string, { current(): boolean; execute(observation: SignalObservation, signal: AbortSignal): Promise<void | { sessionId: string }> }>()
  private sourceStatus?: () => Array<{ kind: 'external'; id: string; enabled: boolean; error?: string; nextAt?: number }>
  private sourceAuthorizer?: (owner: string, definition: Definition) => Definition
  private external?: (definition: Definition) => boolean
  constructor(directory: string, readonly projectId: string, private host: {
    canUse(owner: string): boolean
    deliver: DeliverInput
    work?: (owner: string, identity: string, node: WorkMapNode, observation: SignalObservation, mapping: WorkMapping, signal: AbortSignal) => Promise<WorkMapping>
    now?: () => number
  }) {
    this.path = projectStoragePath(directory, '.workflows', 'state.json')
    this.state = { format: 1, projectId, definitions: [], dedupe: {}, admitted: {}, runs: [], records: {}, mappings: {} }
  }
  get available(): boolean { return !this.stopped }
  private now() { return this.host.now?.() ?? Date.now() }
  enabled(id: string): boolean | undefined { return this.state.definitions.find(d => d.id === id)?.enabled }
  assertCapacity(): void {
    if (this.state.runs.filter(r => !terminal(r)).length > 1500) throw new Error('Workflow backlog full')
  }
  hasAdmitted(workflow: string): boolean { return this.state.admitted[workflow] === true }
  pending(workflow: string) {
    return this.state.runs.filter(r => r.workflow === workflow && !terminal(r)).map(r => ({
      id: r.id, attempts: r.attempts, status: r.status, nextAt: r.nextAt,
      stage: r.definition.nodes[r.cursor]?.kind === 'inbox' ? 'delivery' : 'processor',
    }))
  }
  bindSourceStatus(status: NonNullable<WorkflowRuntime['sourceStatus']>) { this.sourceStatus = status }
  bindSourceAuthorizer(authorize: NonNullable<WorkflowRuntime['sourceAuthorizer']>) { this.sourceAuthorizer = authorize }
  bindHost(id: string, adapter: { current(): boolean; execute(observation: SignalObservation, signal: AbortSignal): Promise<void | { sessionId: string }> }) { this.hosts.set(id, adapter) }
  async signalHost(id: string, observation: SignalObservation, replay: 'safe' | 'confirm', signal?: AbortSignal): Promise<void> {
    const workflow = `internal:${id}`
    if (this.enabled(workflow) === false) throw new Error('Workflow paused')
    if (this.pending(workflow).length && !this.state.runs.some(r => r.workflow === workflow && r.observation.id === observation.id && !terminal(r))) throw new Error('Workflow already pending or blocked')
    if (!this.pending(workflow).length) {
      this.define({ id: workflow, source: { kind: 'internal', id }, enabled: true, gate: { kind: 'revision-dedupe', first: 'emit' }, nodes: [{ kind: 'host-action', handler: id, replay }] })
      this.admit([{ workflow, source: { kind: 'internal', id }, observations: [observation] }])
    }
    await this.drain(workflow, signal)
    if (this.pending(workflow).length) throw new Error('Workflow pending or blocked; inspect v:workflows')
  }
  bindSchedule(adapter: NonNullable<WorkflowRuntime['schedule']>) { this.schedule = adapter }
  bindExternal(current: NonNullable<WorkflowRuntime['external']>) { this.external = current }
  start(deferExecution = false): void {
    if (!this.stopped) return
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 })
    try {
      const state = WorkflowState.parse(JSON.parse(readFileSync(this.path, 'utf8')))
      if (state.projectId !== this.projectId) throw new Error('Workflow state belongs to another Project')
      this.state = state
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
    this.update(state => {
      // Old states did not separate admission identity from the optional revision window.
      for (const run of state.runs) state.admitted[run.workflow] = true
      for (const flow of state.definitions) {
        if (flow.source.kind === 'schedule' && flow.gate?.first === 'emit' && state.dedupe[flow.id]?.seen.length) state.admitted[flow.id] = true
      }
      for (const run of state.runs.filter(r => r.status === 'running')) {
        run.status = run.started && !safe(run) ? 'blocked' : 'retry'
        run.error = run.status === 'blocked' ? 'interrupted_effect' : 'action_failed'
      }
    })
    this.stopped = false
    this.executionReady = !deferExecution
    this.controller = new AbortController()
    this.timer = setInterval(() => { void this.drain().catch(() => { this.runtimeError ??= 'cycle_failed' }) }, 15000)
    this.timer.unref()
  }
  activate(): void {
    if (this.stopped) throw new Error('Workflow stopped')
    this.executionReady = true
  }
  async stop(): Promise<void> {
    this.stopped = true
    clearInterval(this.timer)
    this.controller.abort()
    const results = await Promise.allSettled(this.active.values())
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'Workflow shutdown failed')
  }
  private update(change: (state: State) => void): void {
    const state = structuredClone(this.state)
    change(state)
    const contents = JSON.stringify(state)
    const validated = WorkflowState.parse(JSON.parse(contents))
    if (Buffer.byteLength(contents) > 16 * 1024 * 1024) throw new Error('Workflow capacity exceeded')
    try { writePrivateFile(this.path, contents) }
    catch (error) { this.runtimeError = 'persistence_failed'; throw error }
    this.state = validated
    this.runtimeError = undefined
  }
  authorize(owner: string): void {
    if (this.stopped || !this.host.canUse(owner)) throw new Error('Workflow requires an available durable local owner in this Project')
  }
  snapshot(owner: string) { this.authorize(owner); return this.inspect() }
  /** Host management only; caller supplies Project router authorization. */
  inspect() { return { ...structuredClone(this.state), runtimeError: this.runtimeError, sources: [
    ...this.sourceStatus?.() ?? [],
    ...this.state.definitions.filter(d => d.source.kind !== 'external').map(d => {
      const node = d.nodes[0]
      const enabled = node.kind === 'bot-reference' ? this.botAvailable?.(node.botId) === true : node.kind === 'github-notify' ? this.github?.current(node) === true : node.kind === 'host-action' ? this.hosts.get(node.handler)?.current() === true : node.kind === 'schedule-action' && this.schedule?.current(node.job) === true && (node.job as { enabled?: boolean })?.enabled !== false
      return { ...d.source, enabled }
    }),
  ] } }
  /** Host source adapters only. External IDs are create-only (even identical replays);
   * every external revision must use author() and its optimistic identity/ownership checks.
   * Schedule/internal host snapshots may change for future runs. */
  define(raw: Omit<Definition, 'revision'> & { revision?: number }): void {
    if (this.stopped) throw new Error('Workflow stopped')
    const definition = WorkflowDefinition.parse(JSON.parse(JSON.stringify(raw)))
    if (definition.owner && ['external', 'bot'].includes(definition.source.kind)) this.authorize(definition.owner)
    if (definition.source.kind === 'external' && (!definition.owner || definition.nodes.some(n => n.kind === 'schedule-action'))) throw new Error('External workflow cannot invoke a schedule action')
    if (definition.source.kind === 'bot') throw new Error('BOT execution references require authenticated versioned authoring')
    const old = this.state.definitions.find(d => d.id === definition.id)
    if (!old && (Object.hasOwn(this.state.dedupe, definition.id) || this.hasAdmitted(definition.id))) throw new Error('Retired Workflow ID; create a new subscription ID')
    if (old && ['external', 'bot'].includes(definition.source.kind)) throw new Error('External Workflow ID already exists; use versioned Workflow authoring to update it')
    if (old && (old.source.kind !== definition.source.kind || old.source.id !== definition.source.id || old.owner !== definition.owner)) throw new Error('Workflow binding cannot change')
    if (old && canonical(old) === canonical(definition)) return
    this.update(state => {
      state.definitions = state.definitions.filter(d => d.id !== definition.id); state.definitions.push(definition)
      // Clear only an active definition's obsolete window. remove() still creates a retirement tombstone.
      if (old && !definition.gate) delete state.dedupe[definition.id]
    })
  }
  /** Direct-user authoring only; binding authorization is supplied by the source runtime. */
  author(owner: string, raw: unknown, expectedRevision?: number, validateOnly = false): Definition {
    this.authorize(owner)
    const input = AuthorDefinition.parse(raw)
    const old = this.state.definitions.find(d => d.id === input.id)
    if (old ? old.owner !== owner || !['external', 'bot'].includes(old.source.kind) || old.revision !== expectedRevision : expectedRevision !== undefined) throw new Error('Workflow owner or revision conflict')
    if (!old && (Object.hasOwn(this.state.dedupe, input.id) || this.hasAdmitted(input.id))) throw new Error('Retired Workflow identity')
    let definition = WorkflowDefinition.parse({ ...input, owner, revision: (old?.revision ?? 0) + 1 })
    if (definition.source.kind === 'bot') {
      if (this.botAvailable?.(definition.source.id) !== true) throw new Error('Referenced BOT is unavailable')
      if (this.state.definitions.some(d => d.id !== definition.id && d.source.kind === 'bot' && d.source.id === definition.source.id)) throw new Error('BOT already has a Workflow execution reference')
    } else {
      if (!this.sourceAuthorizer) throw new Error('Source authorization unavailable')
      definition = this.sourceAuthorizer(owner, definition)
    }
    if (old && (canonical(old.source) !== canonical(definition.source) || canonical(old.binding ?? (old.source.kind === 'bot' ? null : this.sourceAuthorizer!(owner, old).binding)) !== canonical(definition.binding ?? null))) {
      throw new Error('Source/demand identity is immutable; create a new Workflow with an explicit first-batch policy')
    }
    if (old && canonical(old.gate ?? null) !== canonical(definition.gate ?? null)) throw new Error('First-batch policy cannot be changed after creation')
    if (old && (Object.keys(this.state.mappings[old.id] ?? {}).length || this.state.runs.some(r => r.workflow === old.id && r.definition.nodes.some(n => n.kind === 'work-map'))) && canonical(old.nodes.filter(n => n.kind === 'work-map')) !== canonical(definition.nodes.filter(n => n.kind === 'work-map'))) throw new Error('Materialized mapping ownership is immutable; create a new Workflow')
    if (!validateOnly) this.update(state => { state.definitions = state.definitions.filter(d => d.id !== definition.id); state.definitions.push(definition) })
    return structuredClone(definition)
  }
  retire(owner: string, id: string, expectedRevision: number): void {
    this.authorize(owner)
    const definition = this.state.definitions.find(d => d.id === id)
    if (!Number.isInteger(expectedRevision)) throw new Error('expectedRevision required')
    if (definition?.owner !== owner || !['external', 'bot'].includes(definition.source.kind) || definition.revision !== expectedRevision) throw new Error('External Workflow ownership or revision conflict')
    this.remove(id)
  }
  /** Atomic multi-subscriber admission. A failed commit must never advance a source checkpoint. */
  admit(batches: Array<{ workflow: string; source: Definition['source']; observations: SignalObservation[] }>): string[] {
    if (this.stopped) throw new Error('Workflow stopped')
    const admitted: string[] = []
    this.update(state => {
      // History retention is independent of the revision window. Never evict pending or blocked effects.
      const retained = (r: Run) => !terminal(r) || this.active.has(r.workflow)
      const history = state.runs.filter(r => !retained(r)).slice(-500)
      state.runs = [...state.runs.filter(retained), ...history]
      for (const batch of batches) {
        const definition = state.definitions.find(d => d.id === batch.workflow)
        if (!definition || canonical(definition.source) !== canonical(batch.source)) throw new Error('Workflow source binding mismatch')
        if (definition.source.kind === 'bot') throw new Error('BOT references consume live guarded inputs only, never persisted observations')
        // Disabled external definitions still advance their revision window without creating actions.
        if (definition.source.kind === 'external' && definition.owner && !this.host.canUse(definition.owner)) throw new Error('Workflow owner unavailable')
        const observations = batch.observations.map(value => Observation.parse(value))
        if (observations.length > 500 || new Set(observations.map(o => o.id)).size !== observations.length) throw new Error('Invalid observation batch')
        const gate = definition.gate
        const dedupe = gate ? state.dedupe[definition.id] ?? { baseline: false, seen: [] } : undefined
        for (const observation of observations) {
          if (Buffer.byteLength(canonical(observation)) > 1024 * 1024) throw new Error('Observation too large')
          if (definition.enabled && (!gate || dedupe && (dedupe.baseline || gate.first === 'emit') && !dedupe.seen.includes(observation.id))) {
            // No gate means each admission is independent, even for an observation seen before.
            // Recovery drains the persisted run ID; it never re-admits an observation.
            const id = gate ? digest([this.projectId, definition.id, observation.id]) : randomUUID()
            if (!state.runs.some(r => r.id === id)) {
              state.runs.push({ id, workflow: definition.id, definition: structuredClone(definition), observation,
                timestamp: new Date(this.now()).toISOString(), status: 'queued', cursor: 0, attempts: 0, nextAt: 0, started: false, delivered: 0 })
              state.admitted[definition.id] = true
              admitted.push(id)
            }
          }
        }
        if (dedupe) state.dedupe[definition.id] = { baseline: true, seen: [...new Set([...dedupe.seen, ...observations.map(o => o.id)])].slice(-4096) }
      }
      if (state.runs.filter(r => !terminal(r)).length > 2000) throw new Error('Workflow backlog full')
    })
    return admitted
  }
  /** Revocation keeps inspectable history; no accepted effect is rolled back. */
  remove(id: string): void {
    const removed = this.state.definitions.find(d => d.id === id)
    if (removed?.source.kind === 'bot') this.botEpoch.set(removed.source.id, (this.botEpoch.get(removed.source.id) ?? 0) + 1)
    this.update(state => {
      // Retire even an identity removed before its first collection/admission.
      state.dedupe[id] ??= { baseline: true, seen: [] }
      state.definitions = state.definitions.filter(d => d.id !== id)
      for (const run of state.runs.filter(r => r.workflow === id && !terminal(r))) run.status = 'cancelled'
    })
  }
  control(owner: string, id: string, action: 'pause' | 'resume' | 'retry' | 'cancel', acknowledgeReplay = false): void {
    this.authorize(owner)
    const definition = action === 'pause' || action === 'resume'
      ? this.state.definitions.find(d => d.id === id) : this.state.runs.find(r => r.id === id)?.definition
    if (definition?.owner !== owner) throw new Error('Workflow/run not owned by this session')
    this.manage(id, action, acknowledgeReplay)
  }
  /** Host-only control entrypoint; never exported as an agent/script capability. */
  manage(id: string, action: 'pause' | 'resume' | 'retry' | 'cancel', acknowledgeReplay = false): void {
    if (this.stopped) throw new Error('Workflow stopped')
    if (action === 'pause' || action === 'resume') {
      if (!this.state.definitions.some(d => d.id === id)) throw new Error('Unknown workflow')
      this.update(state => { const d = state.definitions.find(d => d.id === id)!; if (d.enabled !== (action === 'resume')) { d.enabled = action === 'resume'; d.revision++ } })
      return
    }
    const run = this.state.runs.find(r => r.id === id)
    if (!run || terminal(run) || this.active.has(run.workflow)) throw new Error('Run is unavailable, terminal or active')
    if (action === 'retry' && run.status === 'blocked' && !acknowledgeReplay) throw new Error('Inspect effects first; acknowledgeReplay is required')
    this.update(state => { const r = state.runs.find(r => r.id === id)!; r.status = action === 'cancel' ? 'cancelled' : 'retry'; r.nextAt = 0; r.error = undefined })
  }
  private current(run: Run): void {
    this.controller.signal.throwIfAborted()
    const live = this.state.definitions.find(d => d.id === run.workflow)
    if (this.stopped || !live?.enabled || this.state.runs.find(r => r.id === run.id)?.status === 'cancelled' ||
      (run.definition.source.kind === 'external' && run.definition.owner && !this.host.canUse(run.definition.owner)) ||
      (run.definition.source.kind === 'external' && !this.external?.(run.definition))) throw new WorkflowAuthorityError('Workflow authority unavailable')
    const node = run.definition.nodes[run.cursor]
    if (node?.kind === 'github-notify' && !this.github?.current(node)) throw new WorkflowAuthorityError('GitHub authority unavailable')
    if (node?.kind === 'host-action' && !this.hosts.get(node.handler)?.current()) throw new WorkflowAuthorityError('Host authority unavailable')
    if (node?.kind === 'schedule-action' && !this.schedule?.current(node.job)) throw new WorkflowAuthorityError('Schedule authority unavailable')
  }
  /** Drain already-started source actions without admitting/starting new work. */
  async settle(workflows: string[]): Promise<void> {
    const results = await Promise.allSettled(workflows.flatMap(id => this.active.get(id) ?? []))
    const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'Workflow source drain failed')
  }
  async drain(workflow?: string, signal?: AbortSignal): Promise<void> {
    if (this.stopped || !this.executionReady) return
    const ids = workflow ? [workflow] : [...new Set(this.state.runs.filter(r => !terminal(r) && r.status !== 'blocked').map(r => r.workflow))]
    // Bounded parallelism between lanes; a model session cannot serialize all external data actions.
    for (let offset = 0; offset < ids.length; offset += 8) await Promise.all(ids.slice(offset, offset + 8).map(id => {
      const existing = this.active.get(id)
      if (existing) return existing
      const pending = Promise.resolve().then(() => this.lane(id, signal)).finally(() => this.active.delete(id))
      this.active.set(id, pending)
      return pending
    }))
  }
  private async lane(id: string, signal?: AbortSignal): Promise<void> {
    const abort = signal ? AbortSignal.any([signal, this.controller.signal]) : this.controller.signal
    for (const candidate of this.state.runs.filter(r => r.workflow === id && !terminal(r)).slice(0, 64)) {
      // A failed outcome write may leave a started effect in memory even without a restart.
      // This lane has no active executor now; never silently replay that uncertain effect.
      if (candidate.status === 'running' && candidate.started && !safe(candidate)) {
        this.update(state => { const run = state.runs.find(r => r.id === candidate.id)!; run.status = 'blocked'; run.error = 'interrupted_effect' })
        return
      }
      // Preserve ordering: a failed or blocked revision cannot be silently overtaken.
      if (candidate.status === 'blocked' || candidate.nextAt > this.now() || !this.state.definitions.find(d => d.id === id)?.enabled) return
      let run = this.state.runs.find(r => r.id === candidate.id)!
      try {
        abort.throwIfAborted()
        this.current(run)
        while (run.cursor < run.definition.nodes.length) {
          this.current(run); abort.throwIfAborted()
          const node = run.definition.nodes[run.cursor]
          this.update(state => { const r = state.runs.find(r => r.id === run.id)!; r.status = 'running'; r.started = true })
          if (node.kind === 'transform') {
            const drafts = Drafts.parse(await executeGrantedScript({ code: node.code, args: { signal: run.observation }, signal: abort,
              imports: ['@shadow/html'], allowedModules: ['@shadow/html'], callModule: async () => { throw new Error('Workflow transforms have no capabilities') } }))
            this.current(run); abort.throwIfAborted()
            this.update(state => { state.runs.find(r => r.id === run.id)!.drafts = drafts })
          } else if (node.kind === 'inbox') {
            if (!run.definition.owner || !run.drafts) throw new Error('Inbox requires transform output and owner')
            for (let index = run.delivered; index < run.drafts.length; index++) {
              this.current(run); abort.throwIfAborted()
              const inputId = digest([run.id, run.cursor, index])
              const receipt = await this.host.deliver(run.definition.owner, { id: inputId, kind: 'message', timestamp: run.timestamp,
                policy: 'queue', content: run.drafts[index].content,
                source: { kind: 'event', eventId: run.observation.id, type: 'workflow.message', source: `workflow:${id}` } })
              if (receipt.status !== 'accepted' || receipt.disposition === 'filtered' || receipt.sessionId !== run.definition.owner || receipt.inputId !== inputId) throw new Error('Inbox acceptance not confirmed')
              // Commit acceptance even if pause/revocation occurred while the inbox call was in flight.
              this.update(state => { state.runs.find(r => r.id === run.id)!.delivered = index + 1 })
            }
          } else if (node.kind === 'github-notify') {
            await this.github!.execute(node, run.observation, abort)
          } else if (node.kind === 'work-map') {
            if (!this.host.work || !run.definition.owner || !run.observation.item) throw new MappingConflict('Work mapping requires an item identity and authorized adapter')
            const item = run.observation.item
            const revision = revisionTime(run.observation, node.revisionField)
            let mapping = this.state.mappings[id]?.[item]
            if (!mapping) {
              this.update(state => { const entries = state.mappings[id] ??= {}; if (Object.keys(entries).length >= 4096) throw new Error('Mapping capacity exceeded'); entries[item] = { initial: run.observation, objective: node.objective } })
              mapping = this.state.mappings[id][item]
            }
            if (mapping.revision && revision <= mapping.revision) {
              this.update(state => { state.runs.find(r => r.id === run.id)!.output = { workKey: mapping!.key, stale: true } })
            } else {
              const result = await this.host.work(run.definition.owner, digest([this.projectId, id, item]), node, run.observation, structuredClone(mapping), abort)
              this.update(state => { state.mappings[id][item] = result; state.runs.find(r => r.id === run.id)!.output = { workKey: result.key } })
            }
          } else if (node.kind === 'host-action') {
            const output = await this.hosts.get(node.handler)!.execute(run.observation, abort)
            if (output) this.update(state => { state.runs.find(r => r.id === run.id)!.output = output })
          } else if (node.kind === 'schedule-action') {
            const output = await this.schedule!.execute(node.job, abort)
            if (output) this.update(state => { state.runs.find(r => r.id === run.id)!.output = output })
          }
          // Record effect + cursor commit are one atomic snapshot. Other effects are at-least-once or blocked.
          this.update(state => {
            const r = state.runs.find(r => r.id === run.id)!
            if (node.kind === 'record') {
              const records = state.records[id] ??= {}
              const key = run.observation.item ?? run.observation.id
              if (!Object.hasOwn(records, key) && Object.keys(records).length >= 4096) throw new Error('Workflow record capacity exceeded')
              const prior = records[key]
              if (!node.revisionField || !prior || revisionTime(run.observation, node.revisionField) > revisionTime(prior, node.revisionField)) Object.defineProperty(records, key, { value: run.observation, enumerable: true, configurable: true, writable: true })
              else r.output = { stale: true }
            }
            r.cursor++; r.started = false; r.delivered = 0; r.attempts = 0; r.error = undefined
            if (r.status !== 'cancelled') r.status = r.cursor === r.definition.nodes.length ? 'completed' : 'queued'
          })
          run = this.state.runs.find(r => r.id === run.id)!
          if (terminal(run)) break
        }
      } catch (error) {
        this.update(state => {
          const r = state.runs.find(r => r.id === run.id)!
          if (r.status === 'cancelled') return
          r.attempts++
          r.status = error instanceof MappingConflict || r.started && !safe(r) ? 'blocked' : 'retry'
          r.error = error instanceof MappingConflict ? 'mapping_conflict' : error instanceof WorkflowAuthorityError ? 'authority_unavailable' : r.status === 'blocked' ? 'interrupted_effect' : 'action_failed'
          r.nextAt = this.now() + Math.min(3600000, 15000 * 2 ** Math.min(r.attempts, 8))
        })
        return
      }
    }
  }
}
