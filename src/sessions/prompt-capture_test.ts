import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { Hono } from 'hono'
import { PromptCaptureStore, createPromptCaptureStore } from './prompt-capture.ts'
import type { ChatMessage, LLMProvider } from '../providers/provider.ts'
import type { ToolDefinition } from '../tools/tool.ts'
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
      const captures = new PromptCaptureStore('project-a')
      let providerCalls = 0
      let expectedSessionId = 'web:one'
      let failProvider = false
      let folderRevoked = false
      const provider: LLMProvider = {
        name: 'fixture', listModels: () => ['fixture'],
        async chat(messages, tools, options) {
          const entry = captures.list(expectedSessionId)[0]
          assert.ok(entry, 'capture must exist before provider starts')
          assert.deepEqual(entry.systemMessages, messages.filter(message => message.role === 'system'))
          assert.deepEqual(entry.tools, tools)
          assert.equal(entry.options.model, options.model)
          if (failProvider) throw new Error('Synthetic provider failure')
          if (++providerCalls === 1) return {
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
          return 'Updated'
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
        failProvider = true
        await sessions.startSession({
          channel: 'web', chatId: 'task', agentType: 'general', mode: 'task',
          task: 'Synthetic failing task', waitForCompletion: true,
        })
        assert.equal(sessions.getSessionState('web:task')?.executionStatus, 'failed')
        assert.equal(sessions.getActiveSession('web:task'), undefined)
        assert.equal(captures.list('web:task')[0].systemMessages?.[0].content, prompt)
        const retained = await app.request('/api/sessions/web%3Atask/context?view=captured')
        assert.equal(retained.status, 200)
        assert.equal((await retained.json()).captures.length, 1)
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
