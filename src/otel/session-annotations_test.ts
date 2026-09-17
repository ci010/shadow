import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import type { LLMProvider } from '../providers/provider.ts'
import { Bus } from '../bus/bus.ts'
import { EphemeralSession } from '../sessions/ephemeral-session.ts'
import { channelMessageInput } from '../sessions/input.ts'
import { JsonlSessionStore } from '../sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../sessions/session-store-sqlite.ts'
import type { SessionStore } from '../sessions/session-store.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { initializeNodeTelemetry } from './runtime.ts'
import { OtelStore } from './store.ts'

async function verifyModelResponses(Store: typeof JsonlSessionStore | typeof SqliteSessionStore) {
  await withTempWorkspace(async (workspace) => {
    const telemetryStore = new OtelStore(':memory:')
    const telemetry = initializeNodeTelemetry(telemetryStore)
    const historyStore: SessionStore = new Store(join(workspace, 'sessions'))
    await historyStore.init()
    try {
      const sessionId = 'test:trace'
      const state = { sessionId, segmentIndex: 2, lastKnownTokens: 0 }
      const model = 'fixture-model'
      const finalContent = `Finished ${'synthetic long response '.repeat(1000)}`
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
            'tool.call_id': 'fixture-call', 'tool.name': 'fixture_echo',
            tool_name: 'fixture_echo', args: '{"text":"synthetic tool input"}',
          })
          assert.equal(tool.parentSpanId, spans.find((entry) => entry.name === 'agent.tools')?.spanId)
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
          return {
            content: finalContent, toolCalls: [], reasoningText: 'Synthetic visible reasoning',
            usage: { promptTokens: 10, completionTokens: 20, totalTokens: 30 },
            providerState: { provider: 'copilot', model, reasoning: [{ type: 'reasoning', encrypted_content: 'synthetic-private-continuity', summary: [] }] },
          }
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
      assert.equal(session.history.at(-1)?.content, finalContent)
      const chats = completed.filter(entry => entry.name === 'agent.chat').sort((a, b) => a.startTime - b.startTime)
      const toolResponse = JSON.parse(chats[0].events.find(event => event.name === 'model.response')!.attributes.message)
      assert.equal(toolResponse.content, null)
      assert.deepEqual(toolResponse.tool_calls, [{
        id: 'fixture-call', type: 'function', function: { name: 'fixture_echo', arguments: '{"text":"synthetic tool input"}' },
      }])
      const finalResponseJson = chats[1].events.find(event => event.name === 'model.response')!.attributes.message
      const finalResponse = JSON.parse(finalResponseJson)
      assert.equal(finalResponse.content, finalContent, 'Response snapshots are not truncated')
      assert.equal(finalResponse.reasoning_text, 'Synthetic visible reasoning')
      assert.deepEqual(finalResponse.usage, { promptTokens: 10, completionTokens: 20, totalTokens: 30 })
      assert.equal(finalResponseJson.includes('synthetic-private-continuity'), false)
      assert.equal(finalResponse.provider_state, undefined)
      const records: Record<string, unknown>[] = []
      for await (const message of historyStore.readSessionLog(session.physicalSessionId)) records.push(message)
      assert.equal(records.at(-1)?.content, finalResponse.content, 'Trace and persisted message have the same returned text')
      assert.equal(telemetryStore.querySessionSpans({ sessionId: 'foreign' }).entries.length, 0)
    } finally {
      await telemetry.shutdown()
      telemetryStore.close()
      historyStore.close?.()
    }
  })
}

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: session loop records model responses without changing tool execution or pairing`, () => verifyModelResponses(Store))
}
