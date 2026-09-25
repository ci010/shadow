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
      const agentTypes = new AgentTypesManager(workspace)
      await agentTypes.load()
      const entered = Promise.withResolvers<void>()
      let blocked = false
      const prompts: string[][] = []
      const provider: LLMProvider = {
        name: 'fixture', listModels: () => [],
        async chat(messages, tools, options) {
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
      const sessions = new SessionManager({
        projectId: 'p', workspace, store, bus, provider, events, backgroundTasks, handoffManager, agentTypes,
        identity: new IdentityManager(workspace), context, tools: new Tools(workspace),
        getLlmRuntimeConfig: () => ({ model: 'fixture', temperature: 0, contextWindow: 100000 }),
      })
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
          config: A2aConfigSchema.parse({ agents: { peer: {
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
        assert.equal(disabled.tools.length, 0)
        await disabled.close()
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
