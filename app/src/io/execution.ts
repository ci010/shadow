import { t } from '../i18n.ts'
import { IO_FINALIZE_MS, IO_LEASE_MS, IO_TERMINAL, parseIoDefinition, parseIoUi, type IoArtifact, type IoPacket, type IoRelayUpdate, type IoRun, type IoUiNode } from '../../../src/io/contracts.ts'
import type { DesktopMediaCaptureApi } from '../../../desktop/src/media-capture-contract.ts'
import { acquireIoSources, type CaptureSet } from './adapters.ts'
import { IoEventQueue, type IoCredentials } from './channel.ts'
import { desktopCapabilities, desktopIoIssue, desktopMediaBridge, desktopSourceIssue } from './desktop.ts'
import { decodeOutput, IoBudget, ioRequest } from './transport.ts'
import { withinIoFinalization } from './lifecycle.ts'
import { mobileCaptureIssue } from './mobile-policy.ts'

export type IoGrant = IoCredentials
export interface IoPreview { mime: string; url?: string; text?: string; bytes: number }
export interface IoExecutionOptions {
  base: string
  run: IoRun
  grant: IoGrant
  change(): void
  acquire?: typeof acquireIoSources
  request?: typeof ioRequest
  eventRequest?: typeof fetch
  desktop?: DesktopMediaCaptureApi
  hasUserActivation?: () => boolean
}
export function validateIoNodes(value: unknown, sources: ReadonlySet<string>): IoUiNode[] {
  const nodes = parseIoUi(value)
  const visit = (list: IoUiNode[]) => {
    for (const node of list) {
      if (node.sourceId && !sources.has(node.sourceId)) {
        throw new Error(t('Backend view node "{id}" refers to undeclared source "{sourceId}". Omit sourceId for standalone controls or declare the source in a new request.', { id: node.id, sourceId: node.sourceId }))
      }
      if (node.children) visit(node.children)
    }
  }
  visit(nodes)
  return nodes
}
export function playableMime(mime: string): 'image' | 'audio' | 'video' | 'text' | undefined {
  if (/^image\/(?:jpeg|png|webp|gif)$/.test(mime)) return 'image'
  if (/^audio\/(?:webm|mp4|mpeg|wav|ogg)(?:;|$)/.test(mime)) return 'audio'
  if (/^video\/(?:webm|mp4|ogg)(?:;|$)/.test(mime)) return 'video'
  if (/^(?:text\/plain|application\/json)(?:;|$)/.test(mime)) return 'text'
  return undefined
}

/** Owns browser devices and an authenticated relay connection, not a script runtime. */
export class IoExecution {
  readonly run: IoRun
  readonly budget: IoBudget
  nodes: IoUiNode[]
  phase: 'ready' | 'starting' | 'recording' | 'draining' | 'processing' | 'closed' = 'ready'
  error = ''
  notice = ''
  preview?: IoPreview
  captures?: CaptureSet
  private readonly request: typeof ioRequest
  private readonly queue: IoEventQueue
  private readonly sources: Set<string>
  private readonly control = new AbortController()
  private duration?: ReturnType<typeof setTimeout>
  private heartbeat?: ReturnType<typeof setInterval>
  private updates?: ReturnType<typeof setInterval>
  private desktop?: DesktopMediaCaptureApi
  private sourceDeadline = 0
  private lastHeartbeat = 0
  private lastSnapshot = 0
  private cursor = 0
  private polling = false
  private pulseBusy = false
  private connected = false
  private finishing?: Promise<void>
  private cancelling?: Promise<void>
  private audioInputDevices: Record<string, string> = {}

  constructor(private readonly options: IoExecutionOptions) {
    this.run = { ...structuredClone(options.run), definition: parseIoDefinition(options.run.definition) }
    this.sources = new Set(this.run.definition.sources.map(source => source.id))
    this.nodes = validateIoNodes(this.run.ui ?? this.run.definition.ui, this.sources)
    this.budget = new IoBudget(this.run.definition.limits.maxBytes)
    this.request = options.request ?? ioRequest
    this.queue = new IoEventQueue(options.base, this.run.id, options.grant, options.eventRequest)
  }
  connect() {
    if (this.connected || this.phase === 'closed') return
    this.connected = true
    this.lastHeartbeat = performance.now()
    this.heartbeat = setInterval(() => { void this.pulse() }, 5000)
    this.updates = setInterval(() => { void this.refresh() }, 250)
    void this.refresh(true)
  }
  private path(suffix: string) { return `/runs/${encodeURIComponent(this.run.id)}${suffix}` }
  private changed() { this.options.change() }

  start(audioInputDevices: Record<string, string> = {}): Promise<void> {
    if (this.phase !== 'ready' || this.run.backendStatus !== 'ready') return Promise.reject(new Error(t('Connect a ready backend before starting input.')))
    const mobileIssue = mobileCaptureIssue(this.run.definition.sources)
    if (mobileIssue) return this.fail(new Error(mobileIssue))
    this.audioInputDevices = { ...audioInputDevices }
    this.phase = 'starting'
    this.sourceDeadline = performance.now() + this.run.definition.limits.durationMs
    this.run.startedAt = new Date().toISOString()
    this.scheduleDeadline()
    this.changed()
    const issue = desktopIoIssue(this.run.definition)
    if (issue) return this.fail(new Error(issue))
    const bridge = this.options.desktop ?? desktopMediaBridge()
    if (bridge && desktopCapabilities(this.run.definition).length) return this.armDesktop(bridge)
    return this.acquireAndStart()
  }
  private scheduleDeadline() {
    clearTimeout(this.duration)
    this.duration = setTimeout(() => {
      void (this.phase === 'recording' ? this.finish() : this.cancel('cancelled', t('Input duration elapsed before permission or start acknowledgement.')))
    }, Math.max(0, this.sourceDeadline - performance.now()))
  }
  private armDesktop(bridge: DesktopMediaCaptureApi): Promise<void> {
    const issue = desktopSourceIssue(this.run.definition)
    if (issue) return this.fail(new Error(issue))
    this.desktop = bridge
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const pending = bridge.arm({ runId: this.run.id, capabilities: desktopCapabilities(this.run.definition), durationMs: this.run.definition.limits.durationMs })
      void pending.then(() => { if (this.control.signal.aborted) void bridge.revoke({ runId: this.run.id }).catch(() => {}) }).catch(() => {})
      const timeout = new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error(t('Desktop permission arming timed out. Open a new request and retry.'))), 5000) })
      return Promise.race([pending, timeout]).finally(() => clearTimeout(timer)).then(grant => {
        if (this.control.signal.aborted) return
        if (!Number.isFinite(grant.expiresAt) || grant.expiresAt <= Date.now()) throw new Error(t('Desktop media grant expired.'))
        if (!(this.options.hasUserActivation?.() ?? navigator.userActivation?.isActive)) throw new Error(t('The Start gesture expired. No devices were opened; open a new request to retry.'))
        this.sourceDeadline = Math.min(this.sourceDeadline, performance.now() + grant.expiresAt - Date.now())
        this.scheduleDeadline()
        return this.acquireAndStart()
      }).catch(error => this.fail(error))
    } catch (error) { clearTimeout(timer); return this.fail(error) }
  }
  private acquireAndStart(): Promise<void> {
    if (this.control.signal.aborted || performance.now() >= this.sourceDeadline) return this.cancel('cancelled', t('Input deadline elapsed.'))
    // Browser acquisition begins before the first backend await.
    try { this.captures = (this.options.acquire ?? acquireIoSources)(this.run.definition.sources, { audioInputDevices: this.audioInputDevices }) }
    catch (error) { return this.fail(error) }
    void this.captures.ready.catch(error => {
      if (!this.control.signal.aborted) void this.fail(error)
    })
    return this.acknowledgeStart()
  }
  private async acknowledgeStart() {
    try {
      const result = await this.request<{ run: IoRun }>(this.options.base, this.path('/start'), { ...this.options.grant, revision: this.run.revision }, AbortSignal.any([this.control.signal, AbortSignal.timeout(10_000)]))
      if (this.control.signal.aborted) return
      this.applySnapshot(result.run)
      if (this.phase === 'closed') return
      await this.captures!.ready
      if (this.control.signal.aborted) return
      if (performance.now() >= this.sourceDeadline) { await this.cancel('cancelled', t('Input deadline elapsed before devices were ready.')); return }
      this.lastHeartbeat = performance.now()
      this.phase = 'recording'
      await this.queue.send({ type: 'start' })
      if (this.control.signal.aborted || this.phase !== 'recording') return
      await this.captures!.start(async (packet, bytes) => {
        if (this.control.signal.aborted) return
        this.assertLease()
        this.budget.consume(bytes + this.valueBytes(packet.value))
        await this.queue.send(packet)
        this.changed()
      }, error => { void this.fail(error) })
      this.changed()
    } catch (error) { if (!this.control.signal.aborted) await this.fail(error) }
  }
  private valueBytes(value: unknown) {
    return value === undefined ? 0 : new TextEncoder().encode(typeof value === 'string' ? value : JSON.stringify(value)).byteLength
  }
  async switchAudioInput(sourceId: string, deviceId: string): Promise<void> {
    if (this.phase !== 'recording' || !this.captures?.switchAudioInput) throw new Error(t('Audio input can only be changed during active capture.'))
    if (!this.sources.has(sourceId)) throw new Error(t('Unknown input source.'))
    try { this.assertLease() } catch (error) { await this.fail(error); throw error }
    if (performance.now() >= this.sourceDeadline) {
      await this.finish()
      throw new Error(t('The recording time limit has been reached.'))
    }
    await this.captures.switchAudioInput(sourceId, deviceId)
    if (!this.control.signal.aborted) this.changed()
  }
  async event(packet: IoPacket) {
    if (this.phase !== 'recording') return
    if (performance.now() >= this.sourceDeadline) { await this.finish(); return }
    try {
      this.assertLease()
      if (packet.sourceId && !this.sources.has(packet.sourceId)) throw new Error(t('Unknown input source.'))
      this.budget.consume(this.valueBytes(packet.value))
      await this.queue.send(packet)
    } catch (error) { await this.fail(error) }
  }
  finish(): Promise<void> {
    if (this.finishing) return this.finishing
    if (this.phase !== 'recording') return Promise.resolve()
    this.phase = 'draining'
    clearTimeout(this.duration)
    this.changed()
    const deadline = performance.now() + IO_FINALIZE_MS
    this.finishing = (async () => {
      try {
        await withinIoFinalization(async () => {
          await this.captures?.finish()
          await this.queue.send({ type: 'end' })
          await this.queue.drain()
        })
        this.releaseDevices()
        if (this.control.signal.aborted) return
        const result = await this.request<{ run: IoRun }>(this.options.base, this.path('/stop'), { status: 'completed' },
          AbortSignal.any([this.control.signal, AbortSignal.timeout(Math.max(1, Math.floor(deadline - performance.now())))]))
        if (this.control.signal.aborted) return
        this.applySnapshot(result.run)
        if (this.phase !== 'closed') this.phase = 'processing'
        this.changed()
        await this.refresh(true)
      } catch (error) { if (!this.control.signal.aborted) await this.fail(error) }
    })()
    return this.finishing
  }
  private assertLease() {
    if (performance.now() - this.lastHeartbeat >= IO_LEASE_MS) throw new Error(t('Connection lease expired. Input cannot resume silently; open a new I/O request.'))
  }
  private async pulse() {
    if (this.pulseBusy || this.control.signal.aborted) return
    this.pulseBusy = true
    try {
      this.assertLease()
      await this.request(this.options.base, this.path('/heartbeat'), this.options.grant, AbortSignal.any([this.control.signal, AbortSignal.timeout(5000)]))
      this.lastHeartbeat = performance.now()
    } catch { if (!this.control.signal.aborted) await this.fail(new Error(t('Connection lost. Devices stopped. Check the local service and open a new request.'))) }
    finally { this.pulseBusy = false }
  }
  invalidate() { this.lastSnapshot = 0 }
  async refresh(forceSnapshot = false): Promise<void> {
    if (forceSnapshot) this.lastSnapshot = 0
    if (this.polling || this.control.signal.aborted) return
    this.polling = true
    try {
      await this.pullUpdates()
      if (performance.now() - this.lastSnapshot >= 1000 || forceSnapshot) {
        this.lastSnapshot = performance.now()
        const snapshot = await this.request<IoRun>(this.options.base, this.path(''), undefined, AbortSignal.any([this.control.signal, AbortSignal.timeout(5000)]))
        if (IO_TERMINAL.has(snapshot.status)) {
          this.phase = 'closed'
          this.releaseDevices()
          // Collect effects that arrived between the preceding updates read and backend completion.
          try { await this.pullUpdates() }
          catch { this.notice = t('The backend finished, but its last transient preview could not be loaded. Registered artifacts remain available.') }
          finally { this.applySnapshot(snapshot) }
        } else this.applySnapshot(snapshot)
      }
      this.changed()
    } catch (error) { if (!this.control.signal.aborted) await this.fail(error) }
    finally { this.polling = false }
  }
  private async pullUpdates() {
    const batch = await this.request<{ updates: IoRelayUpdate[]; cursor: number; reset?: boolean }>(this.options.base, this.path(`/updates?after=${this.cursor}`), undefined, AbortSignal.any([this.control.signal, AbortSignal.timeout(5000)]))
    if (!Array.isArray(batch.updates) || batch.updates.length > 256 || !Number.isSafeInteger(batch.cursor) || batch.cursor < 0) throw new Error(t('Backend update cursor is invalid.'))
    if (batch.reset) {
      const snapshot = await this.request<IoRun>(this.options.base, this.path(''), undefined, this.control.signal)
      this.nodes = validateIoNodes(snapshot.ui ?? snapshot.definition.ui, this.sources)
      this.run.artifacts = snapshot.artifacts
      this.run.message = snapshot.message
      this.clearPreview()
      this.notice = t('Reconnected to the latest backend view. Some transient previews may have been missed.')
      this.cursor = 0
    }
    for (const update of batch.updates) {
      if (!Number.isSafeInteger(update.sequence) || update.sequence <= this.cursor) continue
      const { method, args } = update.effect
      if (!Array.isArray(args)) throw new Error(t('Backend view update is invalid.'))
      if (method === 'ui.render') {
        this.nodes = validateIoNodes(args[0], this.sources)
        this.run.ui = this.nodes
      } else if (method === 'status') {
        if (typeof args[0] !== 'string') throw new Error(t('Backend status is invalid.'))
        this.run.message = args[0].slice(0, 4000)
      } else if (method === 'preview') {
        const { mime, bytes } = decodeOutput(args[0])
        this.clearPreview()
        this.preview = playableMime(mime) === 'text'
          ? { mime, bytes: bytes.byteLength, text: new TextDecoder().decode(bytes).slice(-16_000) }
          : { mime, bytes: bytes.byteLength, ...(playableMime(mime) ? { url: URL.createObjectURL(new Blob([bytes as BlobPart], { type: mime })) } : {}) }
      } else if (method === 'artifact') {
        const artifact = args[0] as IoArtifact
        if (!artifact || typeof artifact.id !== 'string' || typeof artifact.name !== 'string' || typeof artifact.mime !== 'string' || !Number.isSafeInteger(artifact.size) || artifact.size < 0) throw new Error(t('Backend artifact metadata is invalid.'))
        const index = this.run.artifacts.findIndex(item => item.id === artifact.id)
        if (index < 0) this.run.artifacts.push(artifact)
        else this.run.artifacts[index] = artifact
      } else throw new Error(t('Unsupported backend view update.'))
      this.cursor = update.sequence
    }
    this.cursor = batch.cursor
  }
  private applySnapshot(snapshot: IoRun) {
    if (snapshot.id !== this.run.id || snapshot.revision !== this.run.revision) throw new Error(t('The I/O session changed. Open its new request before continuing.'))
    Object.assign(this.run, snapshot)
    if (snapshot.ui) this.nodes = validateIoNodes(snapshot.ui, this.sources)
    if (IO_TERMINAL.has(snapshot.status)) {
      this.phase = 'closed'
      this.shutdown()
    } else if (snapshot.status === 'stopping' && this.phase !== 'draining') {
      this.releaseDevices()
      this.phase = 'processing'
    }
  }
  fail(error: unknown): Promise<void> {
    const status = error instanceof Error && error.name === 'NotAllowedError' ? 'denied'
      : error instanceof Error && error.name === 'AbortError' ? 'cancelled' : 'failed'
    const detail = error instanceof Error
      ? `${error.name && error.name !== 'Error' ? `${error.name}: ` : ''}${error.message || t('I/O operation failed.')}`
      : String(error)
    return this.cancel(status, detail)
  }
  cancel(status: 'cancelled' | 'failed' | 'denied' = 'cancelled', error?: string): Promise<void> {
    if (this.cancelling) return this.cancelling
    if (this.phase === 'closed') return Promise.resolve()
    this.error = (error ?? '').slice(0, 2000)
    if (this.error) this.run.error = this.error
    this.phase = 'closed'
    this.shutdown()
    this.changed()
    this.cancelling = (async () => {
      try {
        const result = await this.request<{ run: IoRun }>(this.options.base, this.path('/stop'), { status, ...(this.error ? { error: this.error } : {}) })
        Object.assign(this.run, result.run)
        if (result.run.status === 'completed') this.error = ''
      } catch (cause) {
        this.run.status = status
        this.notice = t('Input stopped locally, but the server could not confirm the stop: {value1}. The server lease will expire; check the connection before retrying.', { value1: cause instanceof Error ? cause.message : String(cause) }).slice(0, 2000)
      }
      this.changed()
    })()
    return this.cancelling
  }
  private releaseDevices() {
    clearTimeout(this.duration)
    this.captures?.close()
    this.captures?.streams.clear()
    this.queue.close()
    void this.desktop?.revoke({ runId: this.run.id }).catch(() => {})
  }
  private shutdown() {
    this.releaseDevices()
    this.control.abort()
    clearInterval(this.heartbeat)
    clearInterval(this.updates)
  }
  clearPreview() {
    if (this.preview?.url) URL.revokeObjectURL(this.preview.url)
    this.preview = undefined
  }
  dispose() { this.shutdown(); this.clearPreview() }
}
