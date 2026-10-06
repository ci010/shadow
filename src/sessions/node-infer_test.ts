import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { Bus } from '../bus/bus.ts'
import { EventService } from '../events/service.ts'
import { BackgroundTaskManager } from '../agent/background-task.ts'
import { ContextBuilder } from '../agent/context/builder.ts'
import { AgentTypesManager } from '../agent/types/manager.ts'
import { IdentityManager } from '../agent/identity.ts'
import type { ChatMessage, LLMProvider } from '../providers/provider.ts'
import { INFER_SYSTEM_PROMPT } from '../script-runtime/infer.ts'
import { Tools } from '../tools/registry.ts'
import { ExecTool } from '../tools/shell.ts'
import { CommandHandlerManager } from '../tools/shell-commands/command-handler.ts'
import { ProcessManager } from '../execution/processes/manager.ts'
import { SessionManager } from './session-manager.ts'
import { HandoffManager } from './handoff/manager.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import type { SessionStore } from './session-store.ts'
import { withTempWorkspace } from '../testing/workspace.ts'

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: real Node exec inherits infer without a tool and charges the next parent prompt`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const bus = new Bus()
      const events = new EventService(workspace, bus, async () => { throw new Error('No event expected') })
      const backgroundTasks = new BackgroundTaskManager(bus, events)
      const agentTypes = new AgentTypesManager(workspace)
      await agentTypes.load()
      const builder = new ContextBuilder(workspace)
      builder.register({ name: 'fixture', getPromptSection: () => 'Parent-private-context' })
      const parentRequests: ChatMessage[][] = []
      let nested = 0
      const provider: LLMProvider = {
        name: 'fixture', listModels: () => ['fixture'],
        async chat(messages, definitions, options) {
          assert.equal(options.model, 'fixture')
          if (String(messages[0]?.content).startsWith(INFER_SYSTEM_PROMPT)) {
            nested++
            assert.deepEqual(definitions, [])
            assert.doesNotMatch(JSON.stringify(messages), /Parent-private-context|private-user-history/)
            assert.equal(messages[1].content, '{"evidence":"local fragment"}')
            return { content: '{"choice":"unknown"}', toolCalls: [],
              usage: { promptTokens: 10, completionTokens: 5, totalTokens: 15 } }
          }
          assert.ok(definitions.some(d => d.function.name === 'exec'))
          assert.ok(!definitions.some(d => d.function.name === 'infer'))
          parentRequests.push(structuredClone(messages))
          if (parentRequests.length % 2 === 0) {
            assert.match(JSON.stringify(messages.at(-1)), /unknown/)
            assert.match(String(messages[0].content), /98 inference requests including this one/)
            return { content: 'Done', toolCalls: [] }
          }
          assert.match(String(messages[0].content), /100 inference requests including this one/)
          return { content: null, toolCalls: [{ id: `exec-${parentRequests.length}`, name: 'exec', arguments: {
            shell: 'node', timeout_ms: 15000,
            script: `console.log(await infer({instructions:"Classify this fragment, unknown is allowed",
              input:{evidence:"local fragment"},schema:{type:"object",properties:{choice:{enum:["unknown"]}},
              required:["choice"],additionalProperties:false}}))`,
          } }] }
        },
      }
      const tools = new Tools(workspace)
      tools.register(new ExecTool(workspace, 15000, new CommandHandlerManager(), new ProcessManager(), 'node', backgroundTasks))
      const sessions = new SessionManager({
        workspace, store, provider, bus, events, backgroundTasks, agentTypes, context: builder, tools,
        handoffManager: new HandoffManager(provider, 100000, { autoHandoff: false }, workspace, store),
        identity: new IdentityManager(workspace),
        getLlmRuntimeConfig: () => ({ model: 'fixture', contextWindow: 100000, temperature: 0 }),
      })
      try {
        await sessions.start()
        for (let turn = 0; turn < 2; turn++) {
          const finished = Promise.withResolvers<void>()
          const subscription = bus.on('session.turn.finished', fact => {
            assert.equal(fact.status, 'completed')
            finished.resolve()
          })
          await sessions.deliver('web:infer', {
            kind: 'message', id: `input-${turn}`, timestamp: new Date().toISOString(),
            content: 'private-user-history', policy: 'queue',
            source: { kind: 'user', sender: { channel: 'web', chatId: 'infer', senderId: 'owner', messageId: `input-${turn}` } },
          })
          await finished.promise
          bus.off(subscription)
        }
        assert.equal(nested, 2)
        assert.equal(parentRequests.length, 4)
        assert.equal(tools.has('infer'), false)
        assert.equal(parentRequests.at(-1)!.filter(m => m.role === 'tool').length, 2)
      } finally {
        await sessions.stop()
        await backgroundTasks.stop()
        await events.stop()
        bus.stopAll()
        store.close?.()
      }
    })
  })
}
