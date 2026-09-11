import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import type { LLMProvider } from '../providers/provider.ts'
import { Bus } from '../bus/bus.ts'
import { EphemeralSession } from '../sessions/ephemeral-session.ts'
import { channelMessageInput } from '../sessions/input.ts'
import { JsonlSessionStore } from '../sessions/session-store-jsonl.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { initializeNodeTelemetry } from './runtime.ts'
import { OtelStore } from './store.ts'

test('session loop annotates live chat/tool spans without changing tool execution or pairing', async () => {
  await withTempWorkspace(async (workspace) => {
    const telemetryStore = new OtelStore(':memory:')
    const telemetry = initializeNodeTelemetry(telemetryStore)
    const historyStore = new JsonlSessionStore(join(workspace, 'sessions'))
    await historyStore.init()
    try {
      const sessionId = 'test:trace'
      const state = { sessionId, segmentIndex: 2, lastKnownTokens: 0 }
      const model = 'fixture-model'
      const tools = new Tools(workspace)
      let toolExecutions = 0
      tools.register({
        name: 'fixture_echo',
        description: 'Synthetic echo',
        parameters: { type: 'object', properties: { text: { type: 'string' } } },
        execute: async (args, context) => {
          toolExecutions++
          assert.equal(context.sessionId, sessionId)
          assert.equal(args.text, 'synthetic tool input')
          const spans = telemetryStore.querySessionSpans({ sessionId }).entries
          const tool = spans.find((entry) => entry.name === 'agent.tool')
          assert(tool?.live)
          assert.deepEqual(tool.attributes, {
            sessionId, physicalSessionId: session.physicalSessionId,
            iteration: '0', 'tool.call_id': 'fixture-call', 'tool.name': 'fixture_echo',
            tool_name: 'fixture_echo', args: '{"text":"synthetic tool input"}',
          })
          assert.equal(tool.parentSpanId, spans.find((entry) => entry.name === 'agent.loop')?.spanId)
          return 'synthetic tool output'
        },
      })
      let chatCalls = 0
      const provider: LLMProvider = {
        name: 'fixture',
        listModels: () => [model],
        chat: async (messages, _tools, options) => {
          assert.equal(options?.model, model)
          const spans = telemetryStore.querySessionSpans({ sessionId }).entries
          const chat = spans.find((entry) => entry.name === 'agent.chat' && entry.live)
          const loop = spans.find((entry) => entry.name === 'agent.loop' && entry.live)
          assert(chat)
          assert(loop)
          assert.deepEqual(chat.attributes, {
            sessionId, physicalSessionId: session.physicalSessionId,
            iteration: String(chatCalls), model,
          })
          assert.equal(chat.parentSpanId, loop.spanId)
          assert.equal(loop.attributes.iteration, String(chatCalls))
          chatCalls++
          if (chatCalls === 1) {
            return {
              content: null,
              toolCalls: [{ id: 'fixture-call', name: 'fixture_echo', arguments: { text: 'synthetic tool input' } }],
            }
          }
          const toolMessage = messages.at(-1)
          assert(toolMessage?.timestamp && Number.isFinite(Date.parse(toolMessage.timestamp)))
          assert.deepEqual(toolMessage, {
            role: 'tool', content: 'synthetic tool output',
            tool_call_id: 'fixture-call', name: 'fixture_echo',
            timestamp: toolMessage.timestamp,
          })
          return { content: 'Finished', toolCalls: [] }
        },
      }
      const session = new EphemeralSession(
        workspace, sessionId, state, [], provider,
        new SessionTools(tools, workspace), new Bus(), historyStore,
      )
      session.dispatch(channelMessageInput({
        channel: 'test', chatId: 'trace', senderId: 'fixture-user',
        messageId: 'fixture-message', content: 'Synthetic prompt',
        timestamp: '2026-09-10T00:00:00.000Z',
      }), { model, contextWindow: 128_000, temperature: 0 })
      await session.completion
      assert.equal(chatCalls, 2)
      assert.equal(toolExecutions, 1)
      const completed = telemetryStore.querySessionSpans({ sessionId }).entries
      assert(completed.every((entry) => !entry.live && entry.id !== null))
      assert.equal(completed.filter((entry) => entry.name === 'agent.chat').length, 2)
      assert.equal(completed.filter((entry) => entry.name === 'agent.loop').length, 2)
      assert.equal(completed.filter((entry) => entry.name === 'agent.tool').length, 1)
      assert.equal(session.history.at(-1)?.content, 'Finished')
      assert.equal(telemetryStore.querySessionSpans({ sessionId: 'foreign' }).entries.length, 0)
    } finally {
      await telemetry.shutdown()
      telemetryStore.close()
    }
  })
})
