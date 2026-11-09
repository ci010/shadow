import assert from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { openaiResponses } from '../providers/openai-responses.ts'
import { Bus } from '../bus/bus.ts'
import type { AgentTypesManager } from '../agent/types/manager.ts'
import type { ChatMessage, LLMProvider, LLMResponse } from '../providers/provider.ts'
import { ProviderHttpError } from '../providers/provider.ts'
import { Tools, SessionTools } from '../tools/registry.ts'
import { pngFixture } from '../testing/image.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { imageFromBytes } from '../utils/image-input.ts'
import { HandoffManager, type CompactResult } from './handoff/manager.ts'
import { SessionManager, type SessionManagerDeps } from './session-manager.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import type { SessionStore } from './session-store.ts'
import type { SessionMessageInput, SessionTurnFact } from './input.ts'
import { EphemeralSession } from './ephemeral-session.ts'
import { physicalSessionId } from './session-identity.ts'

const llm = { model: 'fixture', contextWindow: 1_000_000, temperature: 0 }
const pixels = pngFixture()
const image = imageFromBytes(pixels).part
const done: LLMResponse = { content: 'Recovered', toolCalls: [] }
function timeout(overrides: { wireBodyBytes?: number; imageCount?: number; rejected?: boolean; exhausted?: boolean } = {}) {
  const error = new ProviderHttpError(408, 'Provider rejected request (HTTP 408)', 'user_request_timeout', {
    provider: 'copilot', rejectedRequest: overrides.rejected ?? true,
    requestStats: { bodyBytes: 8_605_107, wireBodyBytes: overrides.wireBodyBytes ?? 6_393_457,
      contentEncoding: 'gzip', imageCount: overrides.imageCount ?? 5, imageBase64Bytes: 8_000_000 },
  })
  // The actual HTTP retry classifier is covered by provider tests. A session
  // receives only the terminal rejection after those transport attempts.
  error.timeoutAttempts = 3
  error.timeoutRetryExhausted = overrides.exhausted ?? true
  return error
}
class Handoff extends HandoffManager {
  calls = 0
  inputs: ChatMessage[][] = []
  started = Promise.withResolvers<void>()
  waitForAbort = false
  override async create(...args: Parameters<HandoffManager['create']>): Promise<CompactResult> {
    this.calls++; this.inputs.push(structuredClone(args[3])); this.started.resolve()
    if (this.waitForAbort) {
      const signal = args[8]!
      await new Promise<void>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true })
        if (signal.aborted) reject(signal.reason)
      })
    }
    return { targetSessionId: args[2], timestamp: new Date().toISOString(), prompt: 'Continue the authorized synthetic task.',
      context: { summary: 'Synthetic task and completed tools retained.', currentObjective: 'Finish', recentTranscript: [] } }
  }
}
function fixture(workspace: string, store: SessionStore, respond: (messages: ChatMessage[], index: number) => LLMResponse) {
  const bus = new Bus()
  const requests: ChatMessage[][] = []
  const provider: LLMProvider = { name: 'fixture', listModels: () => ['fixture'], async chat(messages) {
    requests.push(structuredClone(messages)); return respond(messages, requests.length)
  } }
  const tools = new Tools(workspace)
  let toolsRun = 0
  tools.register({ name: 'work_once', description: 'Synthetic side effect counter', parameters: { type: 'object', properties: {} },
    execute: async () => { toolsRun++; return 'Already completed work.' } })
  const handoff = new Handoff(provider, llm.contextWindow, { autoHandoff: false }, workspace, store)
  const sessions = new SessionManager({ workspace, store, provider, bus, tools, handoffManager: handoff,
    agentTypes: { resolve: (name: string) => ({ name, description: '', prompt: '', source: 'builtin', defaultMode: 'session' }),
      allNames: () => ['general'] } as unknown as AgentTypesManager,
    context: { buildSystemPrompt: async () => 'Synthetic recovery policy.' }, getLlmRuntimeConfig: () => llm,
  } as unknown as SessionManagerDeps)
  const id = 'web:timeout-recovery'
  async function send() {
    const input: SessionMessageInput = { kind: 'message', id: crypto.randomUUID(), timestamp: new Date().toISOString(),
      content: 'Finish the existing task.', media: [image.image_url.url], policy: 'queue',
      source: { kind: 'user', sender: { channel: 'web', chatId: 'timeout-recovery', senderId: 'fixture', messageId: crypto.randomUUID() } } }
    const finished = Promise.withResolvers<SessionTurnFact>()
    const off = bus.on('session.turn.finished', fact => { if (fact.inputId === input.id) finished.resolve(fact) })
    try { await sessions.deliver(id, input); return await finished.promise } finally { bus.off(off) }
  }
  return { sessions, store, requests, handoff, send, id, provider, tools, bus, toolsRun: () => toolsRun }
}
async function records(store: SessionStore, physical: string) { return await Array.fromAsync(store.readSessionLog(physical)) }

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: exhausted image 408 compacts below token threshold, keeps snapshots and never replays completed tools`, { timeout: 15000 }, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions')); await store.init()
      const f = fixture(workspace, store, (_messages, index) => {
        if (index === 1) return { content: '', toolCalls: [{ id: 'once', name: 'work_once', arguments: {} }] }
        if (index === 2) throw timeout()
        return done
      })
      try {
        await f.sessions.start()
        const result = await f.send()
        assert.equal(result.status, 'completed', result.error)
        assert.equal(f.handoff.calls, 1)
        assert.equal(f.requests.length, 3)
        assert.equal(f.toolsRun(), 1)
        assert.equal(f.sessions.getSessionState(f.id)?.segmentIndex, 1)
        const summary = f.requests[2].find(m => typeof m.content === 'string' && m.content.includes('Retained image snapshots'))?.content
        assert.equal(typeof summary, 'string')
        const path = (summary as string).split('\n').find(line => line.startsWith('- "'))
        assert(path)
        assert.deepEqual(await readFile(JSON.parse(path.slice(2))), pixels)
        assert(!f.requests[2].some(m => Array.isArray(m.content) && m.content.some(p => p.type === 'image_url')))
        const state = f.sessions.getSessionState(f.id)!
        const first = await records(store, physicalSessionId(state, 0))
        const second = await records(store, physicalSessionId(state))
        const phases = [...first, ...second].flatMap(record => record.provider_recovery ? [(record.provider_recovery as { phase: string }).phase] : [])
        assert.deepEqual(phases, ['retry-exhausted', 'compact-completed', 'recovered'])
        assert.equal((first.find(record => record.provider_recovery)?.provider_recovery as { attempts: number }).attempts, 3)
        assert.equal(second.filter(record => record.previous_physical_id).length, 1)
      } finally { await f.sessions.stop(); await f.handoff.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: repeated failure after compact stops after one recovery instead of looping`, { timeout: 15000 }, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions')); await store.init()
      const f = fixture(workspace, store, () => { throw timeout() })
      try {
        await f.sessions.start(); const result = await f.send()
        assert.equal(result.status, 'failed'); assert.equal(f.requests.length, 2); assert.equal(f.handoff.calls, 1)
        const rows = await records(store, physicalSessionId(f.sessions.getSessionState(f.id)!))
        const phases = rows.flatMap(record => record.provider_recovery ? [(record.provider_recovery as { phase: string }).phase] : [])
        assert(phases.includes('post-compact-failed')); assert(phases.includes('recovery-limit-reached'))
      } finally { await f.sessions.stop(); await f.handoff.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: small, imageless, uncertain and non-exhausted HTTP408 never trigger compact`, { timeout: 15000 }, async () => {
    await withTempWorkspace(async workspace => {
      for (const options of [{ wireBodyBytes: 1024 }, { imageCount: 0 }, { rejected: false }, { exhausted: false }]) {
        const store: SessionStore = new Store(join(workspace, crypto.randomUUID())); await store.init()
        const f = fixture(workspace, store, () => { throw timeout(options) })
        try {
          await f.sessions.start(); const result = await f.send()
          assert.equal(result.status, 'failed'); assert.equal(f.handoff.calls, 0); assert.equal(f.requests.length, 1)
        } finally { await f.sessions.stop(); await f.handoff.stop(); store.close?.() }
      }
    })
  })

  test(`${Store.name}: cancellation during timeout compact prevents new context publication and request`, { timeout: 15000 }, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions')); await store.init()
      const f = fixture(workspace, store, () => { throw timeout() }); f.handoff.waitForAbort = true
      try {
        await f.sessions.start(); const pending = f.send()
        await f.handoff.started.promise
        await f.sessions.stop()
        const result = await pending
        assert.equal(result.status, 'cancelled'); assert.equal(f.requests.length, 1)
        assert.equal(f.sessions.getSessionState(f.id)?.segmentIndex, 0)
      } finally { await f.sessions.stop(); await f.handoff.stop(); store.close?.() }
    })
  })
}

class Leaf extends EphemeralSession {
  executeLoop() {
    const signal = new AbortController().signal
    return this.runLlmLoop({ sessionId: this.id, physicalSessionId: this.physicalSessionId, channel: 'web', chatId: 'leaf',
      senderId: 'fixture', messageId: 'fixture', tools: this.tools, signal }, llm, signal)
  }
}
test('ephemeral execution reports compact unsupported rather than acquiring a new lifecycle', async () => {
  await withTempWorkspace(async workspace => {
    const store = new JsonlSessionStore(join(workspace, 'sessions')); await store.init()
    let calls = 0
    const provider: LLMProvider = { name: 'fixture', listModels: () => [], async chat() { calls++; throw timeout() } }
    const state = { sessionId: 'virtual:leaf', mode: 'call' as const, segmentIndex: 0 }
    const leaf = new Leaf(workspace, state.sessionId, state, [{ role: 'user', content: 'Synthetic' }], provider,
      new SessionTools(new Tools(workspace), workspace), new Bus(), store)
    try {
      await assert.rejects(leaf.executeLoop(), error => error instanceof ProviderHttpError && error.status === 408)
      assert.equal(calls, 1); assert.equal(state.segmentIndex, 0)
      const rows = await records(store, leaf.physicalSessionId)
      assert(rows.some(record => (record.provider_recovery as { phase?: string } | undefined)?.phase === 'compact-unsupported'))
    } finally { leaf.stop(); store.close?.() }
  })
})

test('real handoff loop propagates an external recovery cancellation into its provider call', { timeout: 10000 }, async () => {
  await withTempWorkspace(async workspace => {
    const store = new JsonlSessionStore(join(workspace, 'sessions')); await store.init()
    const started = Promise.withResolvers<void>()
    const controller = new AbortController()
    const provider: LLMProvider = { name: 'fixture', listModels: () => [], async chat(_messages, _tools, options) {
      started.resolve()
      return await new Promise<LLMResponse>((_resolve, reject) => {
        options.signal!.addEventListener('abort', () => reject(options.signal!.reason), { once: true })
        if (options.signal!.aborted) reject(options.signal!.reason)
      })
    } }
    const handoff = new HandoffManager(provider, llm.contextWindow, { autoHandoff: false }, workspace, store)
    try {
      const pending = handoff.create('web:cancel-summary', 'source', 'target', [{ role: 'user', content: 'Keep existing progress.' }],
        'fixture', undefined, undefined, llm.contextWindow, controller.signal)
      await started.promise
      const reason = new Error('Cancel recovery summary'); controller.abort(reason)
      await assert.rejects(pending, error => error === reason)
    } finally { await handoff.stop(); store.close?.() }
  })
})

test('a hard inference budget prevents timeout compact from acquiring extra model work', async () => {
  await withTempWorkspace(async workspace => {
    const store = new JsonlSessionStore(join(workspace, 'sessions')); await store.init()
    const tools = new SessionTools(new Tools(workspace), workspace); tools.inferenceRequestLimit = 1
    let calls = 0
    const provider: LLMProvider = { name: 'fixture', listModels: () => [], async chat() { calls++; throw timeout() } }
    const state = { sessionId: 'virtual:budget', mode: 'call' as const, segmentIndex: 0 }
    const leaf = new Leaf(workspace, state.sessionId, state, [{ role: 'user', content: 'Synthetic' }], provider, tools, new Bus(), store)
    try {
      await assert.rejects(leaf.executeLoop(), error => error instanceof ProviderHttpError && error.status === 408)
      assert.equal(calls, 1)
      const rows = await records(store, leaf.physicalSessionId)
      assert(rows.some(record => (record.provider_recovery as { phase?: string } | undefined)?.phase === 'recovery-limit-reached'))
    } finally { leaf.stop(); store.close?.() }
  })
})

test('real Responses adapter retries rejected large gzip bodies without reserializing or changing bytes', { timeout: 10000 }, async t => {
  // Incompressible synthetic bytes keep gzip above the 1 MiB wire threshold.
  // This is a mocked transport fixture, not an actual image/model request.
  const url = `data:image/png;base64,${randomBytes(1_200_000).toString('base64')}`
  const bodies: BodyInit[] = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    assert.equal(new Headers(init.headers).get('content-encoding'), 'gzip')
    bodies.push(init.body!)
    return bodies.length < 3
      ? Response.json({ error: { code: 'user_request_timeout' } }, { status: 408 })
      : Response.json({ id: 'resp_fixture', status: 'completed', output: [] })
  })
  const result = await openaiResponses({ url: 'https://synthetic.invalid/responses', apiKey: 'fixture', model: 'fixture',
    providerName: 'copilot', requestCompression: 'gzip', tools: [],
    messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url } }] }] })
  assert.equal(result.toolCalls.length, 0)
  assert.equal(bodies.length, 3)
  assert(Buffer.isBuffer(bodies[0]))
  assert.strictEqual(bodies[0], bodies[1]); assert.strictEqual(bodies[1], bodies[2])
})
