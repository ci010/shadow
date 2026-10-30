import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { readFileSync, writeFileSync } from 'node:fs'
import { Hono } from 'hono'
import { PromptCaptureStore, createPromptCaptureStore } from './prompt-capture.ts'
import type { ChatMessage, LLMProvider, LLMProviderOptions } from '../providers/provider.ts'
import { transientToolResult, type ToolDefinition } from '../tools/tool.ts'
import type { PromptCapture } from './prompt-capture.ts'
import { ContextBuilder } from '../agent/context/builder.ts'
import { AgentTypesManager } from '../agent/types/manager.ts'
import { IdentityManager } from '../agent/identity.ts'
import { BackgroundTaskManager } from '../agent/background-task.ts'
import { Bus } from '../bus/bus.ts'
import { EventService } from '../events/service.ts'
import { Tools } from '../tools/registry.ts'
import { HandoffManager } from './handoff/manager.ts'
import { SessionManager, type SessionManagerDeps } from './session-manager.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import type { SessionStore } from './session-store.ts'
import { sessionsApiPlugin } from './routes.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { FolderError } from '../folders/registry.ts'

const captureContext = {
  projectId: 'project-a', sessionId: 'web:one', physicalSessionId: 'web_one__0',
  turnId: 'turn-one', iteration: 0, provider: 'fixture',
}
const definition: ToolDefinition = {
  type: 'function',
  function: { name: 'example', description: 'Example', parameters: { type: 'object', properties: {} } },
}

test('capture defaults on in development, off elsewhere, and respects explicit flags', () => {
  assert.ok(createPromptCaptureStore('p', { NODE_ENV: 'development' }))
  assert.equal(createPromptCaptureStore('p', { NODE_ENV: 'development', SHADOW_DEBUG_PROMPTS: '0' }), undefined)
  assert.equal(createPromptCaptureStore('p', { NODE_ENV: 'production' }), undefined)
  assert.equal(createPromptCaptureStore('p', { NODE_ENV: 'test' }), undefined)
  assert.equal(createPromptCaptureStore('p', {}), undefined)
  assert.equal(createPromptCaptureStore('p', { SHADOW_DEBUG_PROMPTS: '0' }), undefined)
  assert.ok(createPromptCaptureStore('p', { SHADOW_DEBUG_PROMPTS: '1' }))
  assert.throws(() => createPromptCaptureStore('p', { SHADOW_DEBUG_PROMPTS: 'yes' }), /0 or 1/)
  assert.throws(() => createPromptCaptureStore('p', { SHADOW_DEBUG_PROMPTS: '1', NODE_ENV: 'production' }), /production/)
})

test('capture freezes only system messages, tool schemas and safe model options', () => {
  const captures = new PromptCaptureStore('project-a')
  const messages: ChatMessage[] = [
    { role: 'system', content: 'Actual system', provider_state: { provider: 'copilot', model: 'model', reasoning: [] } },
    { role: 'user', content: 'Private body must not be retained' },
  ]
  const tools = [structuredClone(definition)]
  captures.capture(captureContext, messages, tools, { model: 'model', signal: new AbortController().signal, temperature: 0 })
  messages[0].content = 'Changed after capture'
  tools[0].function.name = 'Changed tool'
  const [entry] = captures.list('web:one')
  assert.equal(entry.source, 'captured')
  assert.equal(entry.boundary, 'provider-input')
  assert.deepEqual(entry.systemMessages, [{ role: 'system', content: 'Actual system' }])
  assert.equal(entry.tools?.[0].function.name, 'example')
  assert.equal(entry.options.temperature, 0)
  assert.equal(Object.hasOwn(entry.options, 'signal'), false)
  assert.equal(entry.messageCount, 2)
  assert.equal(JSON.stringify(entry).includes('Private body'), false)
  entry.systemMessages![0].content = 'Mutated result'
  assert.equal(captures.list('web:one')[0].systemMessages?.[0].content, 'Actual system')
  assert.deepEqual(captures.list('web:other'), [])
  assert.throws(() => captures.capture({ ...captureContext, projectId: 'project-b' }, [], [], { model: 'm' }), /binding mismatch/)
})

test('capture retention bounds entries and bytes, reports oversized payloads, and deletes session data', () => {
  const captures = new PromptCaptureStore('project-a', 2, 256)
  const record = (sessionId: string, content: string) => captures.capture(
    { ...captureContext, sessionId }, [{ role: 'system', content }], [], { model: 'm' },
  )
  record('one', 'a')
  record('two', 'b')
  record('three', 'c')
  assert.deepEqual(captures.list('one'), [])
  record('large', 'x'.repeat(300))
  const [large] = captures.list('large')
  assert.equal(large.payload, 'omitted-size-limit')
  assert.equal(large.systemMessages, undefined)
  assert.ok(large.payloadBytes > 256)
  captures.deleteSession('large')
  assert.deepEqual(captures.list('large'), [])
  captures.clear()
  assert.deepEqual(captures.list('three'), [])
  const byteLimited = new PromptCaptureStore('project-a', 20, 150)
  for (let iteration = 0; iteration < 10; iteration++) {
    byteLimited.capture({ ...captureContext, iteration }, [{ role: 'system', content: 'a'.repeat(40) }], [], { model: 'm' })
  }
  assert.equal(byteLimited.list('web:one').length, 1)
  assert.equal(byteLimited.list('web:one')[0].iteration, 9)
})

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: preview, live history and captured requests remain distinct and project authorized`, async () => {
    await withTempWorkspace(async workspace => {
      const bus = new Bus()
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const context = new ContextBuilder(workspace)
      let prompt = 'First actual prompt'
      context.register({ name: 'fixture', getPromptSection: () => `  ${prompt}  ` })
      context.register({ name: 'empty', getPromptSection: () => ' ' })
      const captures = new PromptCaptureStore('project-a', 20, 16 * 1024 * 1024, { directory: join(workspace, 'audit'), debugEnabled: true })
      let providerCalls = 0
      let expectedSessionId = 'web:one'
      const observed: Array<{ sessionId: string; messages: ChatMessage[]; tools: ToolDefinition[]; options: Omit<LLMProviderOptions, 'signal'>; capture: PromptCapture }> = []
      let folderRevoked = false
      const provider: LLMProvider = {
        name: 'fixture', listModels: () => ['fixture'],
        async chat(messages, tools, options) {
          const { signal: _signal, ...safeOptions } = options
          observed.push(structuredClone({ sessionId: expectedSessionId, messages, tools, options: safeOptions, capture: captures.list(expectedSessionId)[0] }))
          providerCalls++
          if (providerCalls === 1 || providerCalls === 3) return {
            content: '', toolCalls: [{ id: 'refresh', name: 'refresh_context', arguments: {} }],
          }
          return { content: 'Done', toolCalls: [] }
        },
      }
      const events = new EventService(workspace, bus, async () => { throw new Error('No event delivery expected') })
      const agentTypes = new AgentTypesManager(workspace)
      await agentTypes.load()
      const handoffManager = new HandoffManager(provider, 100000, { autoHandoff: false }, workspace, store)
      const backgroundTasks = new BackgroundTaskManager(bus, events)
      const tools = new Tools(workspace)
      tools.register({
        name: 'refresh_context', description: 'Refresh fixture context',
        parameters: { type: 'object', properties: {} },
        execute: async () => {
          prompt = 'Updated before next iteration'
          sessions.invalidateSystemPrompts()
          return expectedSessionId === 'web:task'
            ? transientToolResult([{ type: 'text', text: 'exact transient provider evidence' }], 'durable summary only')
            : 'Updated'
        },
      })
      const deps: SessionManagerDeps = {
        projectId: 'project-a', workspace, store, context, provider, promptCaptures: captures, bus, events,
        handoffManager, backgroundTasks, agentTypes, identity: new IdentityManager(workspace),
        tools,
        assertSessionFolder: () => {
          if (folderRevoked) throw new FolderError('folder_access_revoked', 'Synthetic revoked folder', 409)
        },
        getLlmRuntimeConfig: () => ({ model: 'fixture', contextWindow: 100000, temperature: 0 }),
      }
      const sessions = new SessionManager(deps)
      let authorized = true
      const app = new Hono()
      sessionsApiPlugin(sessions, { authorizeContext: () => authorized })(app)
      const endpoint = '/api/sessions/web%3Aone/context'
      try {
        await sessions.start()
        await sessions.buildSession('web:one')
        const preview = await sessions.getContext({ sessionId: 'web:one', preview: true })
        assert.equal(preview.source, 'preview')
        assert.deepEqual(preview.sections, [{ name: 'fixture', content: prompt, characters: prompt.length }])
        assert.equal(preview.systemPrompt, prompt)
        assert.deepEqual(sessions.getPromptCaptures('web:one'), [])
        const finished = Promise.withResolvers<void>()
        bus.on('session.turn.finished', fact => {
          assert.equal(captures.list(fact.sessionId)[0].turnId, fact.turnId)
          finished.resolve()
        })
        await sessions.deliver('web:one', {
          kind: 'message', id: 'input-one', timestamp: new Date().toISOString(), content: 'Synthetic user text', policy: 'queue',
          source: { kind: 'user', sender: { channel: 'web', chatId: 'one', senderId: 'fixture', messageId: 'input-one' } },
        })
        await finished.promise
        assert.equal(providerCalls, 2, 'ordinary turn completed both provider iterations')
        for (const call of observed) {
          assert.ok(call.capture, 'capture exists before provider starts')
          assert.equal(call.capture.messages, undefined, 'ordinary input not expanded')
          assert.deepEqual(call.capture.systemMessages, call.messages.filter(m => m.role === 'system'))
          assert.deepEqual(call.capture.tools, call.tools)
          assert.equal(call.capture.options.model, call.options.model)
        }
        prompt = 'New preview, not sent'
        assert.equal((await sessions.getContext({ sessionId: 'web:one' })).source, 'active-history')
        assert.equal((await sessions.getContext({ sessionId: 'web:one' })).systemPrompt, 'First actual prompt')
        assert.equal((await sessions.getContext({ sessionId: 'web:one', preview: true })).systemPrompt, prompt)
        const captured = await app.request(`${endpoint}?view=captured`)
        assert.equal(captured.headers.get('Cache-Control'), 'no-store')
        const body = await captured.json()
        assert.equal(body.captures.length, 2)
        assert.deepEqual(body.captures[0].systemMessages, [{ role: 'system', content: 'First actual prompt' }])
        assert.deepEqual(body.captures[1].systemMessages, body.captures[0].systemMessages)
        assert.equal(body.captures[0].iteration, 1)
        assert.equal(body.captures[1].iteration, 0)
        assert.equal(body.captures[0].turnId, body.captures[1].turnId)
        assert.notEqual(body.captures[0].requestId, body.captures[1].requestId)
        assert.equal(body.captures[0].projectId, 'project-a')
        assert.equal(body.captures[0].physicalSessionId, sessions.getActiveSession('web:one')?.physicalSessionId)
        folderRevoked = true
        const revoked = await app.request(endpoint + '?view=captured')
        assert.equal(revoked.status, 409)
        assert.equal((await revoked.json()).error, 'folder_access_revoked')
        folderRevoked = false
        const noAuth = new Hono()
        sessionsApiPlugin(sessions)(noAuth)
        assert.equal((await noAuth.request(endpoint + '?view=captured')).status, 403)
        for (const query of ['?view=invalid', '?view=preview&view=captured']) {
          assert.equal((await app.request(endpoint + query)).status, 400)
        }
        assert.equal((await app.request('/api/sessions/web%3Aforeign/context?view=captured')).status, 404)
        authorized = false
        for (const query of ['', '?view=preview', '?view=captured']) {
          const denied = await app.request(endpoint + query)
          assert.equal(denied.status, 401)
          assert.equal(denied.headers.get('Cache-Control'), 'no-store')
        }
        authorized = true
        await sessions.deleteSession('web:one')
        assert.deepEqual(captures.list('web:one'), [])
        assert.equal((await app.request(endpoint + '?view=captured')).status, 404)
        expectedSessionId = 'web:task'
        await sessions.startSession({
          channel: 'web', chatId: 'task', agentType: 'general', mode: 'task',
          task: 'Synthetic successful learning task', waitForCompletion: true,
          automation: { jobId: 'learning:reflector', name: 'Synthetic learning', runId: 'fixture', startedAt: new Date().toISOString(), contextMode: 'fresh', config: { source: 'learning', schedule: 'fixture' } },
        })
        assert.equal(sessions.getSessionState('web:task')?.executionStatus, 'completed', 'provider assertion failures must not masquerade as expected failure')
        assert.equal(providerCalls, 4, 'learning executes tool call and successful final inference')
        const learningCalls = observed.filter(call => call.sessionId === 'web:task')
        assert.equal(learningCalls.length, 2)
        const allowed = new Set(['role', 'content', 'name', 'tool_calls', 'tool_call_id', 'reasoning_content', 'reasoning_text'])
        for (const call of learningCalls) {
          assert.ok(call.capture)
          assert.equal(call.capture.scope, 'learning-inference-messages-and-tools')
          const expected = call.messages.map(message => Object.fromEntries(Object.entries(message).filter(([field]) => allowed.has(field))))
          assert.deepEqual(call.capture.messages, expected, 'allowlisted actual input matches exactly')
          const omitted = call.messages.flatMap((message, index) => Object.entries(message).filter(([field, value]) => !allowed.has(field) && value !== undefined).map(([field]) => ({ message: index, reason: 'field-not-retained', field })))
          assert.deepEqual(call.capture.omissions, omitted)
          assert.equal(call.capture.payload, omitted.length ? 'partial-fields-omitted' : 'complete')
          assert.deepEqual(call.capture.tools, call.tools)
          assert.deepEqual(call.capture.options, call.options)
        }
        const last = learningCalls[1]
        const transient = last.messages.find(message => message.role === 'tool')
        assert.deepEqual(transient?.content, [{ type: 'text', text: 'exact transient provider evidence' }])
        assert.deepEqual(last.capture.messages?.find(message => message.role === 'tool')?.content, transient?.content)
        const durable = []
        for await (const record of store.readSessionLog(last.capture.physicalSessionId)) durable.push(record)
        assert.ok(JSON.stringify(durable).includes('durable summary only'))
        assert.equal(JSON.stringify(durable).includes('exact transient provider evidence'), false, 'full transient evidence is not durable history')
        assert.equal(sessions.getActiveSession('web:task'), undefined)
        assert.equal(captures.list('web:task')[0].messages?.[0].content, 'New preview, not sent')
        const retained = await app.request('/api/sessions/web%3Atask/context?view=captured')
        assert.equal(retained.status, 200)
        assert.equal((await retained.json()).captures.length, 2)
        await sessions.stop()
        assert.deepEqual(captures.list('web:task'), [])
        const disabledSessions = new SessionManager({ ...deps, promptCaptures: undefined })
        try {
          await disabledSessions.start()
          const disabledApp = new Hono()
          sessionsApiPlugin(disabledSessions, { authorizeContext: () => true })(disabledApp)
          const disabled = await disabledApp.request('/api/sessions/web%3Atask/context?view=captured')
          assert.equal(disabled.status, 404)
          assert.equal((await disabled.json()).error, 'prompt_capture_disabled')
          assert.equal(disabled.headers.get('Cache-Control'), 'no-store')
          const previewOnly = await disabledApp.request('/api/sessions/web%3Atask/context?view=preview')
          assert.equal(previewOnly.status, 200)
          assert.equal((await previewOnly.json()).source, 'preview')
        } finally { await disabledSessions.stop() }
      } finally {
        await sessions.stop()
        handoffManager.stop()
        backgroundTasks.stop()
        bus.stopAll()
        store.close?.()
      }
    })
  })
}

test('learning audit is explicit, project private, survives restart, expires and reports bounded eviction', async () => {
  await withTempWorkspace(async workspace => {
    let now = Date.parse('2026-01-01T00:00:00Z')
    const audit = { directory: join(workspace, 'audit'), debugEnabled: false, now: () => now, ttlMs: 1000 }
    const captures = new PromptCaptureStore('project-a', 2, 4096, audit)
    assert.equal(captures.capture(captureContext, [{ role: 'user', content: 'ordinary private body' }], [], { model: 'm' }), undefined)
    const messages: ChatMessage[] = [
      { role: 'system', content: 'dynamic context' },
      { role: 'user', content: 'learning question' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'tc', type: 'function', function: { name: 'example', arguments: '{"x":1}' } }] },
      { role: 'tool', content: 'actual transient tool result', tool_call_id: 'tc' },
    ]
    const options = { model: 'fixture', maxTokens: 123, temperature: 0.4, thinking: { type: 'disabled' } as const, reasoningEffort: 'high' as const }
    const id = captures.capture(captureContext, messages, [definition], options, true)
    assert.deepEqual(captures.list('web:one')[0].messages, messages)
    assert.deepEqual(captures.list('web:one')[0].options, options)
    messages[3].content = 'mutated'
    captures.close()
    captures.close() // runtime cleanup and SessionManager shutdown may both close
    const restored = new PromptCaptureStore('project-a', 2, 4096, audit)
    assert.equal(restored.list('web:one')[0].requestId, id)
    assert.equal(restored.list('web:one')[0].messages?.[3].content, 'actual transient tool result')
    restored.capture({ ...captureContext, sessionId: 'other' }, [], [], { model: 'm' }, true)
    restored.capture({ ...captureContext, sessionId: 'third' }, [], [], { model: 'm' }, true)
    assert.deepEqual(restored.list('web:one'), [])
    assert.equal(restored.status('web:one').recentLosses[0].reason, 'capacity')
    now += 1001
    assert.equal(restored.list('third').length, 0)
    assert.equal(restored.status('third').recentLosses[0].reason, 'expired')
    const expired = new PromptCaptureStore('project-a', 2, 4096, audit)
    assert.equal(expired.list('third').length, 0)
    assert.throws(() => new PromptCaptureStore('other-project', 2, 4096, audit), /could not be loaded/)
  })
})

test('learning audit omits media explicitly, bounds payloads, and honors independent production control', async () => {
  await withTempWorkspace(async workspace => {
    const captures = createPromptCaptureStore('project-a', { NODE_ENV: 'production', SHADOW_DEBUG_PROMPTS: '0', SHADOW_LEARNING_AUDIT: '1' }, join(workspace, 'audit'))!
    assert.equal(captures.status('web:one').debugEnabled, false)
    assert.equal(captures.capture(captureContext, [], [], { model: 'm' }), undefined)
    captures.capture(captureContext, [{ role: 'user', content: [
      { type: 'text', text: 'attachment context' },
      { type: 'image_url', image_url: { url: 'https://private.example/image?secret=token' } },
    ] }], [], { model: 'm' }, true)
    const entry = captures.list('web:one')[0]
    assert.equal(entry.payload, 'partial-media-omitted')
    assert.equal(entry.omissions?.[0].sha256?.length, 64)
    assert.equal(JSON.stringify(entry).includes('secret=token'), false)
    captures.deleteSession('web:one')
    assert.equal(new PromptCaptureStore('project-a', 500, 32 * 1024 * 1024, { directory: join(workspace, 'audit') }).list('web:one').length, 0)
    assert.throws(() => createPromptCaptureStore('p', { SHADOW_LEARNING_AUDIT: 'true' }), /0 or 1/)
    assert.throws(() => createPromptCaptureStore('p', { SHADOW_LEARNING_AUDIT: '1' }), /directory/)
    const small = new PromptCaptureStore('project-a', 2, 50, { directory: join(workspace, 'small'), debugEnabled: false })
    small.capture(captureContext, [{ role: 'user', content: 'x'.repeat(100) }], [], { model: 'm' }, true)
    assert.equal(small.list('web:one')[0].payload, 'omitted-size-limit')
    assert.equal(small.list('web:one')[0].messages, undefined)
  })
})

test('learning quota is isolated from high-frequency development debug and opaque state is omitted', async () => {
  await withTempWorkspace(async workspace => {
    const directory = join(workspace, 'audit')
    const captures = createPromptCaptureStore('project-a', { NODE_ENV: 'development', SHADOW_LEARNING_AUDIT: '1' }, directory)!
    const id = captures.capture(captureContext, [{ role: 'assistant', content: 'inspectable', provider_state: {
      provider: 'copilot', model: 'm', reasoning: [{ type: 'reasoning', encrypted_content: 'opaque-secret', summary: [] }],
    } }], [], { model: 'm' }, true)
    for (let i = 0; i < 600; i++) captures.capture({ ...captureContext, sessionId: 'ordinary', iteration: i }, [{ role: 'system', content: 'debug' }], [], { model: 'm' })
    const [entry] = captures.list('web:one')
    assert.equal(entry.requestId, id)
    assert.equal(entry.payload, 'partial-fields-omitted')
    assert.deepEqual(entry.omissions, [{ message: 0, field: 'provider_state', reason: 'field-not-retained' }])
    assert.equal(JSON.stringify(entry).includes('opaque-secret'), false)
    assert.equal(captures.list('ordinary').length, 20)
    captures.close()
    const restored = createPromptCaptureStore('project-a', { NODE_ENV: 'development', SHADOW_LEARNING_AUDIT: '1' }, directory)!
    assert.equal(restored.list('web:one')[0].requestId, id)
    assert.equal(restored.list('ordinary').length, 0)
  })
})

test('learning audit rejects forged byte declarations, payload shapes and unexpected opaque fields on restart', async () => {
  await withTempWorkspace(async workspace => {
    const directory = join(workspace, 'audit')
    const captures = new PromptCaptureStore('project-a', 2, 4096, { directory })
    captures.capture(captureContext, [{ role: 'user', content: 'actual payload' }], [], { model: 'm' }, true)
    captures.close()
    const path = join(directory, 'provider-input.json')
    const original = JSON.parse(readFileSync(path, 'utf8'))
    for (const corrupt of [
      (e: any) => { e.payloadBytes = 1 },
      (e: any) => { e.messages[0].content = 123 },
      (e: any) => { e.messages[0].provider_state = { encrypted_content: 'opaque' } },
      (e: any) => { e.tools = 'invalid' },
      (e: any) => { e.payload = 'omitted-size-limit' },
      (e: any) => { e.options.headers = { authorization: 'not-allowed' } },
    ]) {
      const saved = structuredClone(original)
      corrupt(saved.entries[0])
      writeFileSync(path, JSON.stringify(saved))
      assert.throws(() => new PromptCaptureStore('project-a', 2, 4096, { directory }), /could not be loaded/)
    }
  })
})
