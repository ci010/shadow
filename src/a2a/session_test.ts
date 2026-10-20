import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { Hono } from 'hono'
import { GetTaskRequest, SendMessageRequest, TaskState } from '@a2a-js/sdk'
import { ServerCallContext } from '@a2a-js/sdk/server'
import { withTempWorkspace } from '../testing/workspace.ts'
import { Bus } from '../bus/bus.ts'
import { AgentTypesManager } from '../agent/types/manager.ts'
import { IdentityManager } from '../agent/identity.ts'
import { ContextBuilder } from '../agent/context/builder.ts'
import { BackgroundTaskManager } from '../agent/background-task.ts'
import { EventService } from '../events/service.ts'
import { HandoffManager } from '../sessions/handoff/manager.ts'
import { SessionManager } from '../sessions/session-manager.ts'
import { JsonlSessionStore } from '../sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../sessions/session-store-sqlite.ts'
import type { SessionStore } from '../sessions/session-store.ts'
import type { LLMProvider } from '../providers/provider.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import { AskTool } from '../tools/ask.ts'
import { A2aConfigSchema } from './config.ts'
import { A2aStore } from './store.ts'
import { A2aService } from './service.ts'
import { createA2aRuntime, sessionA2aRunner } from './runtime.ts'

for (const storage of ['jsonl', 'sqlite'] as const) {
  test(`A2A runs through real SessionManager, preserves history and cancels (${storage})`, { timeout: 15_000 }, async t => {
    await withTempWorkspace(async root => {
      const workspace = join(root, 'home')
      const store: SessionStore = storage === 'jsonl'
        ? new JsonlSessionStore(join(workspace, '.sessions'))
        : new SqliteSessionStore(join(workspace, '.sessions'))
      await store.init()
      const bus = new Bus()
      const tokenName = 'SHADOW_A2A_RUNTIME_FIXTURE_TOKEN'
      const previousToken = process.env[tokenName]
      delete process.env[tokenName]
      t.after(() => {
        if (previousToken === undefined) delete process.env[tokenName]
        else process.env[tokenName] = previousToken
      })
      const agentTypes = new AgentTypesManager(workspace)
      await agentTypes.load()
      const entered = Promise.withResolvers<void>()
      let blocked = false
      let asking = false
      let inputRound = 0
      const prompts: string[][] = []
      const provider: LLMProvider = {
        name: 'fixture', listModels: () => [],
        async chat(messages, tools, options) {
          if (asking) {
            assert.deepEqual(tools.map(tool => tool.function.name), ['ask'])
            if (inputRound++ % 2 === 0) return { content: '', toolCalls: [
              { id: `input-${inputRound}`, name: 'ask', arguments: { kind: 'input', question: 'Which language?' } },
            ] }
            const answer = messages.findLast(message => message.role === 'tool')
            assert.equal(JSON.parse(String(answer?.content)).text, 'TypeScript')
            return { content: 'Selected TypeScript', toolCalls: [] }
          }
          assert.equal(tools.length, 0, 'The external text role must have no tools')
          prompts.push(messages.filter(message => message.role === 'user').map(message => typeof message.content === 'string'
            ? message.content : message.content?.filter(part => part.type === 'text').map(part => part.text).join('\n') ?? ''))
          if (blocked) {
            entered.resolve()
            assert(options?.signal)
            const aborted = Promise.withResolvers<never>()
            const abort = () => aborted.reject(options.signal!.reason)
            options.signal.addEventListener('abort', abort, { once: true })
            try {
              options.signal.throwIfAborted()
              return await aborted.promise
            } finally { options.signal.removeEventListener('abort', abort) }
          }
          return { content: 'Fixture reply', toolCalls: [] }
        },
      }
      const events = new EventService(workspace, bus, async () => { throw new Error('Unexpected event delivery') })
      const backgroundTasks = new BackgroundTaskManager(bus, events)
      const handoffManager = new HandoffManager(provider, 100000, {}, workspace, store)
      const context = new ContextBuilder(workspace)
      context.register({ name: 'agent', getPromptSection: context => context.agent.prompt })
      const tools = new Tools(workspace)
      const sessions = new SessionManager({
        projectId: 'p', workspace, store, bus, provider, events, backgroundTasks, handoffManager, agentTypes,
        identity: new IdentityManager(workspace), context, tools,
        getLlmRuntimeConfig: () => ({ model: 'fixture', temperature: 0, contextWindow: 100000 }),
      })
      tools.register(new AskTool(sessions.yields, sessions.inputs))
      const taskStore = new A2aStore(join(workspace, '.a2a')); taskStore.init()
      const server = A2aConfigSchema.parse({ server: {
        url: 'http://127.0.0.1/projects/p/a2a', agentType: 'a2a-text', callers: { alice: 'TOKEN' },
      } }).server!
      const service = new A2aService('p', server, taskStore, sessionA2aRunner(sessions, bus, agentTypes, 'a2a-text'))
      const caller = new ServerCallContext({ user: { isAuthenticated: true, userName: 'alice' }, requestedVersion: '1.0' })
      const send = (text: string, contextId?: string) => service.sendMessage(SendMessageRequest.fromJSON({
        message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: [{ text }], contextId },
      }), caller)
      try {
        await sessions.start()
        const first = await send('First input')
        assert.equal(first.status?.state, TaskState.TASK_STATE_COMPLETED)
        const second = await send('Second input', first.contextId)
        assert.equal(second.status?.state, TaskState.TASK_STATE_COMPLETED)
        assert(prompts[1].some(content => content.includes('First input')))
        assert(prompts[1].some(content => content.includes('Second input')))
        const record = taskStore.inbound.get(first.id)!
        assert.equal((await store.getState(record.sessionId))?.projectId, 'p')
        assert.equal((await store.getState(record.sessionId))?.agentType, 'a2a-text')
        const resolve = agentTypes.resolve.bind(agentTypes)
        const textRole = resolve('a2a-text')!
        const mockRole = t.mock.method(agentTypes, 'resolve', (name: string) => name === 'a2a-input'
          ? { ...textRole, name: 'a2a-input', allowedTools: ['ask'] } : resolve(name))
        const inputService = new A2aService('p', { ...server, agentType: 'a2a-input' }, taskStore,
          sessionA2aRunner(sessions, bus, agentTypes, 'a2a-input'))
        asking = true
        try {
          const start = () => inputService.sendMessage(SendMessageRequest.fromJSON({
            message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: [{ text: 'Ask for language' }] },
          }), caller)
          const waiting = await start()
          assert.equal(waiting.status?.state, TaskState.TASK_STATE_INPUT_REQUIRED)
          assert.equal(waiting.status.message?.parts[0].content?.value, 'Which language?')
          const reply = SendMessageRequest.fromJSON({ message: {
            messageId: crypto.randomUUID(), taskId: waiting.id, contextId: waiting.contextId,
            role: 'ROLE_USER', parts: [{ text: 'TypeScript' }],
          } })
          await assert.rejects(inputService.sendMessage(reply, new ServerCallContext({
            user: { isAuthenticated: true, userName: 'other' }, requestedVersion: '1.0',
          })), /not found/i)
          const completed = await inputService.sendMessage(reply, caller)
          assert.equal(completed.id, waiting.id)
          assert.equal(completed.status?.state, TaskState.TASK_STATE_COMPLETED)
          assert.equal(completed.artifacts[0].parts[0].content?.value, 'Selected TypeScript')
          assert.equal((await inputService.sendMessage(reply, caller)).id, waiting.id)
          assert.equal(inputRound, 2)
          const state = sessions.getSessionState(taskStore.inbound.get(waiting.id)!.sessionId)!
          const records: unknown[] = []
          for await (const row of store.readSessionLog(SessionManager.currentPhysicalId(state))) if (row.input_request) records.push(row.input_request)
          assert.equal(records.length, 2, 'Both stores persist input request and answer facts')
          assert.equal((records[1] as { answer: { text: string } }).answer.text, 'TypeScript')
          const history = await sessions.getHistory(state.sessionId, { shallow: true })
          assert.ok(history.messages.some(message => message.role === 'tool' && String(message.content).includes('TypeScript')))
          const cancelled = await start()
          assert.equal(cancelled.status?.state, TaskState.TASK_STATE_INPUT_REQUIRED)
          assert.equal((await inputService.cancelTask({ id: cancelled.id, tenant: '', metadata: undefined }, caller)).status?.state, TaskState.TASK_STATE_CANCELED)
          assert.equal(sessions.inputs.get(taskStore.inbound.get(cancelled.id)!.sessionId), null)
        } finally { asking = false; await inputService.close(); mockRole.mock.restore() }
        t.mock.method(globalThis, 'fetch', async (url: URL, options: RequestInit) => {
          if (url.href.endsWith('/card')) return Response.json({
            supportedInterfaces: [{ url: 'https://peer.invalid/a2a', protocolBinding: 'JSONRPC', protocolVersion: '1.0' }],
          })
          const rpc = JSON.parse(String(options.body))
          return Response.json({ jsonrpc: '2.0', id: rpc.id, result: { task: {
            id: crypto.randomUUID(), contextId: crypto.randomUUID(), status: { state: 'TASK_STATE_COMPLETED' },
          } } })
        })
        const outbound = createA2aRuntime({
          projectId: 'p', workspace, sessions, bus, agentTypes, app: new Hono(),
          config: A2aConfigSchema.parse({ server: { ...server, callers: { alice: tokenName } }, agents: { peer: {
            cardUrl: 'https://peer.invalid/card', endpointUrl: 'https://peer.invalid/a2a',
          } } }),
        })
        const notified = Promise.withResolvers<void>()
        const subscription = bus.on('session.turn.finished', fact => {
          if (fact.source.kind === 'event' && fact.source.type === 'a2a-task-update') {
            assert.equal(fact.sessionId, record.sessionId)
            assert.equal(fact.source.source, 'a2a')
            notified.resolve()
          }
        })
        const timeout = setTimeout(() => notified.reject(new Error('A2A automatic notification was not delivered')), 6000)
        try {
          outbound.validate()
          await outbound.tools.find(tool => tool.name === 'a2a_send')!.execute({ agent: 'peer', message: 'explicit remote input' }, {
            projectId: 'p', sessionId: record.sessionId, physicalSessionId: 'fixture_0', messageId: 'remote',
            toolCallId: 'send', signal: new AbortController().signal,
            channel: 'a2a', chatId: 'fixture', senderId: 'alice', tools: new SessionTools(new Tools(workspace), workspace),
          })
          await notified.promise
        } finally { clearTimeout(timeout); bus.off(subscription); await outbound.close() }
        blocked = true
        const pending = await service.sendMessage(SendMessageRequest.fromJSON({
          message: { messageId: crypto.randomUUID(), role: 'ROLE_USER', parts: [{ text: 'Cancel me' }] },
          configuration: { returnImmediately: true },
        }), caller)
        await entered.promise
        const canceled = await service.cancelTask({ id: pending.id, tenant: '', metadata: undefined }, caller)
        assert.equal(canceled.status?.state, TaskState.TASK_STATE_CANCELED)
        const id = taskStore.inbound.get(pending.id)!.sessionId
        assert.equal(sessions.getActiveSession(id), undefined)
        assert.equal((await store.getState(id))?.executionStatus, 'cancelled')
        const read = await service.getTask(GetTaskRequest.fromJSON({ id: first.id }), caller)
        assert.equal(read.artifacts[0].parts[0].content?.value, 'Fixture reply')
        const disabledApp = new Hono()
        const disabled = createA2aRuntime({ projectId: 'p', workspace, sessions, bus, agentTypes, app: disabledApp })
        assert.equal((await disabledApp.request('/a2a/.well-known/agent-card.json')).status, 404)
        assert.ok(disabled.tools.some(tool => tool.name === 'a2a_setup'))
        assert.ok(disabled.sessions)
        await disabled.close()
        const warnings: string[] = []
        const warning = t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args.map(String).join(' ')) })
        const token = 'synthetic-a2a-runtime-fixture-token-0001'
        try {
          for (const scenario of ['missing', 'short', 'whitespace', 'duplicate', 'role', 'allowlist', 'path'] as const) {
            if (scenario === 'missing') delete process.env[tokenName]
            else process.env[tokenName] = scenario === 'short' ? 'short' : scenario === 'whitespace' ? `${token}\n` : token
            const scoped = new Hono()
            const runtime = createA2aRuntime({
              projectId: 'p', workspace, sessions, bus, agentTypes, app: scoped,
              config: A2aConfigSchema.parse({ server: {
                ...server, callers: scenario === 'duplicate' ? { alice: tokenName, bob: tokenName } : { alice: tokenName },
                agentType: scenario === 'role' ? 'missing-role-fixture' : scenario === 'allowlist' ? 'general' : 'a2a-text',
                url: scenario === 'path' ? 'http://127.0.0.1/projects/other/a2a' : server.url,
              } }),
            })
            try {
              assert.doesNotThrow(() => runtime.validate(), scenario)
              assert.equal(runtime.authorize(new Request(server.url, {
                method: 'POST', headers: { authorization: `Bearer ${token}` },
              })), false, 'Unavailable inbound cannot grant a host authentication exception')
              for (const [path, method] of [['/a2a', 'POST'], ['/a2a/.well-known/agent-card.json', 'GET']]) {
                const response = await scoped.request(path, { method, headers: { authorization: `Bearer ${token}` } })
                assert.equal(response.status, 503, scenario)
                assert.equal(response.headers.get('cache-control'), 'no-store')
                const body = await response.json()
                assert.equal(body.error, 'a2a_unavailable')
                assert.doesNotMatch(JSON.stringify(body), new RegExp(tokenName))
              }
              process.env[tokenName] = token
              runtime.validate()
              assert.equal(runtime.authorize(new Request(server.url, {
                method: 'POST', headers: { authorization: `Bearer ${token}` },
              })), false, 'Credential changes do not silently activate the disabled runtime')
            } finally { await runtime.close() }
          }
          assert.equal(warnings.length, 7)
          assert.ok(warnings.some(line => line.includes(tokenName)))
          assert.ok(warnings.every(line => line.includes('Inbound service disabled') && !line.includes(token)))
          const configuredApp = new Hono()
          const configured = createA2aRuntime({
            projectId: 'p', workspace, sessions, bus, agentTypes, app: configuredApp,
            config: A2aConfigSchema.parse({ server: { ...server, callers: { alice: tokenName } } }),
          })
          try {
            configured.validate()
            const headers = { authorization: `Bearer ${token}` }
            assert.equal(configured.authorize(new Request(server.url, { method: 'POST', headers })), true)
            assert.equal(configured.authorize(new Request('http://127.0.0.1/projects/other/a2a', { method: 'POST', headers })), false)
            assert.equal((await configuredApp.request('/a2a/.well-known/agent-card.json', { headers })).status, 200)
            assert.equal((await configuredApp.request('/a2a/.well-known/agent-card.json')).status, 401)
            assert.equal(warnings.length, 7)
          } finally { await configured.close() }
        } finally { warning.mock.restore() }
      } finally {
        await service.close()
        await sessions.stop()
        await handoffManager.stop()
        await backgroundTasks.stop()
        await events.stop()
        bus.stopAll()
        await store.close?.()
      }
    })
  })
}
