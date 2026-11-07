import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { BaseSession } from './base-session.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import { Bus } from '../bus/bus.ts'
import type { OutboundMessage } from '../bus/events.ts'
import { ProviderTransportError, type LLMProvider } from '../providers/provider.ts'
import { Tools, SessionTools } from '../tools/registry.ts'
import { InvokeTool } from '../tools/invoke-tool.ts'
import { ToolOutcomeUnknownError } from '../tools/tool.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import type { SessionInput } from './input.ts'

class ErrorSession extends BaseSession {
  run(input: SessionInput, signal = new AbortController().signal) {
    return this.processInput(input, { model: 'fixture', contextWindow: 128_000, temperature: 0 }, signal)
  }
}
const input: SessionInput = { kind: 'message', id: 'original', content: 'Synthetic request',
  timestamp: new Date().toISOString(), policy: 'queue',
  source: { kind: 'user', sender: { channel: 'web', chatId: 'error-fixture', senderId: 'fixture', messageId: 'original' } } }

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  for (const mode of ['session', 'task', 'call'] as const) {
    for (const failure of ['tool-unknown', 'tool-known', 'provider-transport', 'provider-similar-text'] as const) {
      test(`${Store.name}: ${mode} handles ${failure} at the correct boundary`, async t => {
        await withTempWorkspace(async workspace => {
          const store = new Store(join(workspace, 'sessions'))
          await store.init()
          try {
            const log = t.mock.method(console, 'error', () => {})
            class SyntheticLayerFSError extends ToolOutcomeUnknownError {}
            const error = failure === 'tool-unknown' ? new SyntheticLayerFSError('LayerFS worker reply was lost')
              : failure === 'tool-known' ? new Error('Invalid input')
              : failure === 'provider-transport' ? new ProviderTransportError('response', 'UND_ERR_SOCKET')
              : new Error('Tool outcome unknown: LayerFS worker reply was lost')
            const toolFailure = failure.startsWith('tool-')
            let effects = 0, inspections = 0, providerCalls = 0
            const tools = new Tools(workspace)
            tools.register({ name: 'fixture_layerfs', description: 'Synthetic only', parameters: { type: 'object', properties: {} },
              async execute() { effects++; throw error } })
            tools.register({ name: 'fixture_status', description: 'Read only', readonly: true, parameters: { type: 'object', properties: {} },
              async execute() { inspections++; return 'State inspected; outcome remains uncertain' } })
            const provider: LLMProvider = {
              name: 'fixture', listModels: () => ['fixture'], async chat(options) {
                providerCalls++
                if (!toolFailure) throw error
                if (providerCalls === 1) return { content: null, toolCalls: [{ id: 'uncertain-call', name: 'fixture_layerfs', arguments: { a: 1, b: 2 } }] }
                const results = options.filter(message => message.role === 'tool')
                if (failure === 'tool-known') {
                  assert.match(String(results[0].content), /Error executing fixture_layerfs: Invalid input/)
                  return { content: 'Explained definite tool failure', toolCalls: [] }
                }
                const receipt = JSON.parse(String(results[0].content))
                assert.equal(receipt.status, 'outcome_unknown')
                assert.equal(receipt.message, error.message)
                assert.equal(receipt.retryAllowed, false)
                assert.match(receipt.guidance, /may have completed.*partially changed state.*still be running/)
                if (providerCalls === 2) return { content: null, toolCalls: [{ id: 'repeat', name: 'fixture_layerfs', arguments: { b: 2, a: 1 } }] }
                assert.equal(JSON.parse(String(results[1].content)).status, 'replay_blocked')
                if (providerCalls === 3) return { content: null, toolCalls: [{ id: 'inspection', name: 'fixture_status', arguments: {} }] }
                assert.match(String(results[2].content), /State inspected/)
                return { content: 'Explained uncertain effects without retrying', toolCalls: [] }
              },
            }
            const bus = new Bus(), outbound: OutboundMessage[] = []
            bus.on('message.outbound', message => { outbound.push(message) })
            const sessionId = 'web:error-fixture'
            const session = new ErrorSession(workspace, sessionId, { sessionId, segmentIndex: 0, mode }, [],
              provider, new SessionTools(tools, workspace), bus, store)
            const fact = await session.run(input)
            const terminal = outbound.filter(message => message.done)
            assert.equal(terminal.length, 1)
            assert.equal(terminal[0].event, 'response')
            assert.equal(terminal[0].channel, 'web')
            assert.equal(terminal[0].chatId, 'error-fixture')
            const saved = await store.getState(sessionId)
            const records = await Array.fromAsync(store.readSessionLog(session.physicalSessionId))
            if (toolFailure) {
              assert.equal(fact?.status, 'completed', 'The conversational turn completes, not necessarily the operation')
              assert.equal(saved?.executionStatus, 'completed')
              assert.equal(saved?.recovery, undefined)
              assert.equal(effects, 1)
              assert.equal(inspections, failure === 'tool-unknown' ? 1 : 0)
              assert.equal(providerCalls, failure === 'tool-unknown' ? 4 : 2)
              assert.equal(log.mock.calls.length, 0)
              assert.notEqual(terminal[0].inferenceError, true)
              assert.match(terminal[0].content, /^Explained/)
              const results = records.filter(record => record.role === 'tool')
              assert.equal(results.length, failure === 'tool-unknown' ? 3 : 1)
              assert.equal(outbound.filter(message => message.event === 'tool_result').length, results.length)
              assert.equal(results[0].tool_call_id, 'uncertain-call')
            } else {
              assert.equal(fact?.status, 'failed')
              assert.equal(fact?.error, error.message)
              assert.equal(saved?.executionStatus, 'failed')
              assert.equal(providerCalls, 1)
              assert.equal(log.mock.calls.length, 1)
              assert.equal(log.mock.calls[0].arguments[1], 'LLM provider error')
              assert.equal(terminal[0].inferenceError, true)
              assert.equal(terminal[0].content, `⚠️ Request failed: ${error.message}`)
              assert.equal(effects, 0)
              if (mode === 'session') assert.equal(saved?.recovery?.providerFailure, failure === 'provider-transport' ? 'network' : 'request')
            }
          } finally { store.close?.() }
        })
      })
    }
  }
  test(`${Store.name}: cancellation is not converted into permission to continue inference`, async () => {
    await withTempWorkspace(async workspace => {
      const store = new Store(join(workspace, 'sessions')); await store.init()
      try {
        const controller = new AbortController(), tools = new Tools(workspace)
        let providerCalls = 0
        tools.register({ name: 'fixture_cancel', description: '', parameters: { type: 'object', properties: {} },
          async execute() { controller.abort(); throw new ToolOutcomeUnknownError('cancelled with unknown effects') } })
        const provider: LLMProvider = { name: 'fixture', listModels: () => [], async chat() {
          providerCalls++; return { content: null, toolCalls: [{ id: 'cancel-call', name: 'fixture_cancel', arguments: {} }] }
        } }
        const sessionId = 'web:error-fixture'
        const session = new ErrorSession(workspace, sessionId, { sessionId, segmentIndex: 0, mode: 'session' }, [],
          provider, new SessionTools(tools, workspace), new Bus(), store)
        assert.equal((await session.run(input, controller.signal))?.status, 'cancelled')
        assert.equal(providerCalls, 1)
        const saved = await store.getState(sessionId)
        assert.equal(saved?.recovery?.reason, 'stopped')
        assert.equal(saved?.recovery?.pendingToolCalls, 1)
      } finally { store.close?.() }
    })
  })
}

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  for (const failPersistence of [false, true]) {
    test(`${Store.name}: nested invoke_tool uncertainty is durable before inference; persistence failure=${failPersistence}`, async t => {
      await withTempWorkspace(async workspace => {
        const store = new Store(join(workspace, 'sessions')); await store.init()
        try {
          t.mock.method(console, 'error', () => {})
          const append = store.appendMessages.bind(store)
          t.mock.method(store, 'appendMessages', async (id: string, messages: Parameters<typeof store.appendMessages>[1]) => {
            if (failPersistence && messages.some(message => message.role === 'tool')) throw new Error('synthetic disk failure')
            await append(id, messages)
          })
          let effects = 0, callbacks = 0, providerCalls = 0
          const tools = new Tools(workspace); tools.register(new InvokeTool())
          const overlay = new SessionTools(tools, workspace)
          overlay.registerDynamic({ name: 'fixture_dynamic', description: '', parameters: { type: 'object', properties: {} },
            async execute(_args, context) {
              effects++; context.afterToolResultPublished?.(() => { callbacks++ })
              throw new ToolOutcomeUnknownError('Nested effect evidence missing')
            } })
          const provider: LLMProvider = { name: 'fixture', listModels: () => [], async chat(messages) {
            providerCalls++
            if (providerCalls === 1) return { content: null, toolCalls: [{ id: 'nested', name: 'invoke_tool', arguments: { name: 'fixture_dynamic', args: {} } }] }
            const result = messages.find(message => message.tool_call_id === 'nested')!
            assert.equal(JSON.parse(String(result.content)).status, 'outcome_unknown')
            const durable = await Array.fromAsync(store.readSessionLog(session.physicalSessionId))
            assert.equal(durable.filter(message => message.tool_call_id === 'nested').length, 1)
            if (providerCalls === 2) return { content: null, toolCalls: [{ id: 'direct-retry', name: 'fixture_dynamic', arguments: {} }] }
            assert.equal(JSON.parse(String(messages.find(message => message.tool_call_id === 'direct-retry')!.content)).status, 'replay_blocked')
            return { content: 'Explained nested failure', toolCalls: [] }
          } }
          const sessionId = 'web:error-fixture'
          const session = new ErrorSession(workspace, sessionId, { sessionId, segmentIndex: 0, mode: 'session' }, [], provider, overlay, new Bus(), store)
          const fact = await session.run(input)
          assert.equal(effects, 1)
          assert.equal(callbacks, 0, 'Unknown outcomes must not publish deferred success effects')
          assert.equal(providerCalls, failPersistence ? 1 : 3)
          assert.equal(fact?.status, failPersistence ? 'failed' : 'completed')
          if (failPersistence) assert.match(fact?.error ?? '', /uncertain tool result persistence failure/)
        } finally { store.close?.() }
      })
    })
  }
}
