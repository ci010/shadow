import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { access } from 'node:fs/promises'
import { join } from 'node:path'
import { Bus } from '../bus/bus.ts'
import { OtelStore } from '../otel/store.ts'
import { initializeNodeTelemetry } from '../otel/runtime.ts'
import type { ChatMessage, LLMProvider, LLMResponse } from '../providers/provider.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import { evaluateAuthoringScenario } from './authoring-evaluation.ts'

const llm = { model: 'project-model@configured', contextWindow: 128_000, temperature: 0.2, maxTokens: 8000 }
const workspace = join(process.cwd(), '.test-artifacts', `nonexistent-evaluation-${randomUUID()}`)
function tools() { return new SessionTools(new Tools(workspace), workspace, []) }
function provider(chat: LLMProvider['chat']): LLMProvider {
  return { name: 'configured-fixture', listModels: () => { throw new Error('Unexpected model discovery') }, chat }
}
const done: LLMResponse = { content: 'Synthetic response', toolCalls: [] }

test('evaluation uses exact candidate, configured model and private memory-only history', async () => {
  const bus = new Bus()
  let publicEvents = 0
  bus.on('message.outbound', () => { publicEvents++ })
  bus.on('session.turn.finished', () => { publicEvents++ })
  const originalHistory: ChatMessage[] = [{ role: 'user', content: 'normal history' }]
  const prompt = 'Candidate\n\n---\n\nExact assembled policy.'
  let captured: ChatMessage[] = []
  const registry = tools()
  let resets = 0
  registry.onReset(() => { resets++ })
  const result = await evaluateAuthoringScenario({
    workspace, projectId: 'scenario-project', llm, tools: registry,
    prompt, input: 'Synthetic question', signal: new AbortController().signal,
    provider: provider(async (messages, definitions, options) => {
      captured = structuredClone(messages)
      assert.deepEqual(definitions, [])
      assert.equal(options.model, llm.model)
      assert.equal(options.maxTokens, 4096)
      assert.equal(options.temperature, llm.temperature)
      return done
    }),
  })
  assert.equal(result.status, 'completed')
  assert.equal(result.modelRounds, 1)
  assert.equal(result.llmExecuted, true)
  assert.equal(result.syntheticTools, true)
  assert.equal(result.result?.content, done.content)
  assert.match(result.sessionId, /^authoring-scenario:/)
  assert.deepEqual(captured.map(({ role, content }) => ({ role, content })), [
    { role: 'system', content: prompt }, { role: 'user', content: 'Synthetic question' },
  ])
  assert.equal(result.messages.length, 3)
  assert.equal(resets, 1)
  assert.equal(publicEvents, 0)
  assert.deepEqual(originalHistory, [{ role: 'user', content: 'normal history' }])
  await assert.rejects(access(workspace), { code: 'ENOENT' })
})

test('caller abort settles even when configured provider ignores its signal', async () => {
  const controller = new AbortController()
  const started = Promise.withResolvers<void>()
  let providerSignal: AbortSignal | undefined
  const pending = evaluateAuthoringScenario({
    workspace, projectId: 'scenario-project', llm, tools: tools(), prompt: 'Prompt', input: 'Question',
    signal: controller.signal,
    provider: provider(async (_messages, _definitions, options) => {
      providerSignal = options.signal
      started.resolve()
      return new Promise<LLMResponse>(() => {})
    }),
  })
  await started.promise
  controller.abort()
  const result = await pending
  assert.equal(result.status, 'cancelled')
  assert.equal(providerSignal?.aborted, true)
  assert.equal(result.modelRounds, 1)
})

test('already aborted scenarios do not invoke the model', async () => {
  const controller = new AbortController()
  controller.abort()
  const result = await evaluateAuthoringScenario({
    workspace, projectId: 'scenario-project', llm, tools: tools(), prompt: 'Prompt', input: 'Question',
    signal: controller.signal, provider: provider(async () => { throw new Error('Model must not execute') }),
  })
  assert.equal(result.status, 'cancelled')
  assert.equal(result.llmExecuted, false)
})

test('deadline cancels the ordinary loop and reports timeout as failure', async () => {
  const result = await evaluateAuthoringScenario({
    workspace, projectId: 'scenario-project', llm, tools: tools(), prompt: 'Prompt', input: 'Question',
    signal: new AbortController().signal, timeoutMs: 15,
    provider: provider(async () => new Promise<LLMResponse>(() => {})),
  })
  assert.equal(result.status, 'failed')
  assert.match(result.error!, /timed out/)
})

test('model loop cannot exceed twelve rounds', async () => {
  const base = new Tools(workspace)
  base.register({ name: 'fixture', description: 'Synthetic', parameters: { type: 'object', properties: {} }, execute: async () => 'receipt' })
  let calls = 0
  const result = await evaluateAuthoringScenario({
    workspace, projectId: 'scenario-project', llm, tools: new SessionTools(base, workspace),
    prompt: 'Prompt', input: 'Question', signal: new AbortController().signal,
    provider: provider(async () => ({
      content: null, toolCalls: [{ id: `call-${++calls}`, name: 'fixture', arguments: {} }],
    })),
  })
  assert.equal(result.status, 'failed')
  assert.equal(calls, 12)
  assert.equal(result.modelRounds, 12)
  assert.match(result.error!, /12 model rounds/)
  assert.equal(result.messages.filter(message => message.role === 'tool').length, 12)
})

test('scenario contents and provider logs do not enter the global telemetry store', async () => {
  const store = new OtelStore(':memory:')
  const telemetry = initializeNodeTelemetry(store)
  try {
    const result = await evaluateAuthoringScenario({
      workspace, projectId: 'scenario-project', llm, tools: tools(), prompt: 'PRIVATE_CANDIDATE', input: 'PRIVATE_INPUT',
      signal: new AbortController().signal,
      provider: provider(async () => {
        console.info('PRIVATE_PROVIDER_LOG')
        return { content: 'PRIVATE_RESPONSE', toolCalls: [] }
      }),
    })
    assert.equal(result.status, 'completed')
    assert.equal(store.querySpans().length, 0)
    assert.equal(store.queryLogs().length, 0)
  } finally {
    await telemetry.shutdown()
    store.close()
  }
})

test('rejects excessive input before calling a provider', async () => {
  await assert.rejects(evaluateAuthoringScenario({
    workspace, projectId: 'scenario-project', llm, tools: tools(), prompt: 'Prompt',
    input: 'x'.repeat(32 * 1024 + 1), signal: new AbortController().signal,
    provider: provider(async () => { throw new Error('Model must not execute') }),
  }), /Scenario input/)
})
