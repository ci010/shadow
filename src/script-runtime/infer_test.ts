import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import { InferenceBudget } from '../agent/context/execution-budget.ts'
import type { LLMProvider, LLMResponse } from '../providers/provider.ts'
import { createNodeInference, INFER_SYSTEM_PROMPT } from './infer.ts'
import { executeScript, ScriptExecutionError, startScript } from './runtime.ts'
import { bindScriptTools, EvalBridgeRuntime } from './bridge.ts'
import { createProjectScope, getProjectScope } from '../projects/scope.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { initializeNodeTelemetry } from '../otel/runtime.ts'
import { OtelStore } from '../otel/store.ts'
import { activeSpan } from '../otel/tracing.ts'

const origin = { sessionId: 'session', physicalSessionId: 'physical', inputId: 'input', outerToolCallId: 'exec-1' }
const request = { instructions: 'Classify the input.', input: { text: 'ambiguous' },
  schema: { type: 'string', enum: ['yes', 'no', 'unknown'] } }
const signal = () => new AbortController().signal
const response = (content = '"unknown"'): LLMResponse => ({
  content, toolCalls: [], usage: { promptTokens: 20, completionTokens: 3, totalTokens: 23 },
})
const provider = (chat: LLMProvider['chat']): LLMProvider => ({ name: 'fixture', listModels: () => ['fixture'], chat })
const capability = (chat: LLMProvider['chat'], budget = new InferenceBudget()) => createNodeInference({
  provider: provider(chat), budget, llm: { model: 'fixture', reasoningEffort: 'medium', maxTokens: 1024 }, turnId: 'turn',
})

test('infer sends only explicit context without tools and validates typed values without coercion', async () => {
  const calls: Array<Parameters<LLMProvider['chat']>> = []
  const infer = capability(async (...args) => { calls.push(args); return response() })
  assert.equal(await infer(request, signal(), origin), 'unknown')
  const [messages, tools, options] = calls[0]
  assert.equal(messages.length, 2)
  assert.ok(String(messages[0].content).startsWith(INFER_SYSTEM_PROMPT))
  assert.equal(messages[1].content, JSON.stringify(request.input))
  assert.deepEqual(tools, [])
  assert.equal(options.model, 'fixture')
  assert.equal(options.maxTokens, 1024)
  assert.equal(options.reasoningEffort, 'medium')
  await infer({ ...request, model: 'another@configured', maxTokens: 128, reasoningEffort: 'low' }, signal(), origin)
  assert.equal(calls[1][2].model, 'another@configured')
  assert.equal(calls[1][2].maxTokens, 128)
  assert.equal(calls[1][2].reasoningEffort, 'low')
  const object = capability(async () => response('{"ok":true}'))
  assert.deepEqual(await object({ ...request, schema: { type: 'object', properties: { ok: { type: 'boolean' } },
    required: ['ok'], additionalProperties: false } }, signal(), origin), { ok: true })
})

test('infer rejects invalid inputs and schemas before spending shared request budget', async () => {
  const budget = new InferenceBudget()
  let calls = 0
  const infer = capability(async () => { calls++; return response() }, budget)
  for (const raw of [
    { ...request, instructions: '' }, { ...request, maxTokens: 4097 },
    { ...request, unexpected: true }, { instructions: 'x', schema: {} },
    { ...request, input: 'x'.repeat(65536) }, { ...request, schema: { description: 'x'.repeat(16384) } },
    { ...request, schema: { type: 'not-a-type' } },
    { ...request, schema: { $ref: 'https://invalid.example/schema' } },
  ]) await assert.rejects(infer(raw, signal(), origin))
  assert.equal(calls, 0)
  assert.equal(budget.remaining, 100)
})

test('provider/output failures spend one request, never retry or execute returned tool calls', async () => {
  for (const output of [
    response('```json\n"yes"\n```'), response('{"ok":true}'), response('1e999'),
    response('x'.repeat(65537)),
    { ...response(), content: null },
    { ...response(), toolCalls: [{ id: 'bad', name: 'exec', arguments: { script: 'never' } }] },
    new Error('transport failed'),
  ]) {
    let calls = 0
    const budget = new InferenceBudget()
    const infer = capability(async () => { calls++; if (output instanceof Error) throw output; return output }, budget)
    await assert.rejects(infer(request, signal(), origin))
    assert.equal(calls, 1)
    assert.equal(budget.remaining, 99)
  }
})

test('concurrent inference shares a parent budget and keeps its last request available', async () => {
  const budget = new InferenceBudget(4)
  budget.take()
  const infer = capability(async () => response(), budget)
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => infer(request, signal(), origin)))
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 2)
  assert.equal(budget.remaining, 1)
  budget.take()
  assert.equal(budget.remaining, 0)
  assert.throws(() => budget.take(), /exhausted/)
  assert.throws(() => budget.take(-1), /reservation/)
})

test('aborted inference never starts, and a late provider response is not accepted', async () => {
  const budget = new InferenceBudget()
  let calls = 0
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  const infer = capability(async () => { calls++; return response() }, budget)
  await assert.rejects(infer(request, controller.signal, origin), /cancelled/)
  assert.equal(calls, 0)
  const pending = new AbortController()
  const late = capability(async (_messages, _tools, options) => {
    assert.equal(options.signal, pending.signal)
    pending.abort(new Error('cancelled while running'))
    return response()
  }, budget)
  await assert.rejects(late(request, pending.signal, origin), /cancelled while running/)
  assert.equal(budget.remaining, 99)
})

test('Node infer uses separate RPC and composes real tools without a registered infer tool', async () => {
  const seen: string[] = []
  const result = await executeScript({
    code: `const input = await read({path:'fixture'}); const result = await infer({instructions:'classify',input,schema:{type:'string'}});
      console.log(await write({path:'result',content:result}));`,
    args: {}, entry: 'script', filename: 'exec.mts', policy: { kind: 'host' }, signal: signal(),
    toolNames: ['read', 'write'],
    callModule: async (name, input) => { seen.push(name); return name === 'read' ? 'evidence' : input.content },
    infer: async input => { seen.push('infer-rpc'); assert.equal(input.input, 'evidence'); return 'judgment' },
  })
  assert.deepEqual(seen, ['read', 'infer-rpc', 'write'])
  assert.match(result.stdout, /judgment/)
  for (const policy of [{ kind: 'host' }, { kind: 'restricted', imports: [] }] as const) {
    const result = await executeScript({ code: 'export const run = () => typeof infer', args: {},
      entry: 'run', policy, signal: signal() })
    assert.equal(result.value, 'undefined')
    assert.throws(() => startScript({ code: '', args: {}, entry: 'run', policy,
      signal: signal(), infer: async () => null }), /only in host/)
  }
  assert.throws(() => startScript({ code: '', args: {}, entry: 'script', policy: { kind: 'host' },
    signal: signal(), toolNames: ['infer'] }), /not a tool/)
})

test('worker cancellation aborts infer and uncaught RPC failures fail the outer script', async () => {
  await assert.rejects(executeScript({ code: 'await infer({})', args: {}, entry: 'script', policy: { kind: 'host' },
    signal: signal(), infer: async () => { throw new Error('semantic validation failed') } }),
  error => error instanceof ScriptExecutionError && /semantic validation failed/.test(error.message))
  await assert.rejects(executeScript({ code: 'await read({}); await infer({})', args: {},
    entry: 'script', policy: { kind: 'host' }, toolNames: ['read'], callModule: async () => null,
    signal: signal(), infer: async () => { throw new Error('after a tool') } }),
  error => error instanceof Error && !(error instanceof ScriptExecutionError) && /after a tool/.test(error.message))
  const entered = Promise.withResolvers<AbortSignal>()
  const run = startScript({
    code: 'await infer({})', args: {}, entry: 'script', policy: { kind: 'host' }, signal: signal(),
    infer: async (_input, signal) => {
      entered.resolve(signal)
      await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }))
      return null
    },
  })
  const completion = assert.rejects(run.completion, /aborted/)
  const childSignal = await entered.promise
  run.cancel()
  await completion
  assert.equal(childSignal.aborted, true)
})

test('bridge scopes infer to exec, limits attempts/concurrency, revokes and drains on shutdown', async () => {
  const scope = createProjectScope('infer-project')
  const runtime = new EvalBridgeRuntime({ projectId: scope.projectId, scope })
  const tools = new SessionTools(new Tools('.'), '.')
  const release = Promise.withResolvers<void>()
  const active: AbortSignal[] = []
  const ctx: ExecutionContext = {
    projectId: scope.projectId, evalBridge: runtime, tools,
    sessionId: origin.sessionId, physicalSessionId: 'current-physical', messageId: origin.inputId,
    channel: 'test', chatId: 'chat', senderId: 'owner', signal: signal(), toolCallId: origin.outerToolCallId, toolCallName: 'exec',
    infer: async (_input, signal, actualOrigin) => {
      assert.equal(getProjectScope(), scope)
      assert.equal(actualOrigin.physicalSessionId, 'current-physical')
      assert.equal(actualOrigin.outerToolCallId, 'exec-1')
      active.push(signal)
      await release.promise
      return 'result'
    },
  }
  const noInfer = bindScriptTools(ctx)
  const binding = bindScriptTools(ctx, { infer: true })
  assert.equal(noInfer.infer, undefined)
  assert.deepEqual(binding.names, [])
  const one = binding.infer!(request, signal()), two = binding.infer!(request, signal())
  await assert.rejects(binding.infer!(request, signal()), /at most 2/)
  let stopped = false
  const stopping = runtime.shutdown().then(() => { stopped = true })
  await new Promise<void>(resolve => setImmediate(resolve))
  assert.equal(stopped, false)
  assert.ok(active.every(s => s.aborted))
  await assert.rejects(binding.infer!(request, signal()), /closed/)
  release.resolve()
  await Promise.all([one, two, stopping])
  scope.close()
  const standalone = bindScriptTools({ ...ctx, projectId: undefined, evalBridge: undefined,
    infer: async () => 'ok' }, { infer: true })
  try {
    for (let i = 0; i < 8; i++) assert.equal(await standalone.infer!(request, signal()), 'ok')
    await assert.rejects(standalone.infer!(request, signal()), /8 calls/)
  } finally { await standalone.cleanup() }
})

test('infer persists usage and owning exec identity even for invalid model output', async () => {
  const store = new OtelStore(':memory:')
  const telemetry = initializeNodeTelemetry(store)
  try {
    await activeSpan('agent.tool', async () => {
      await assert.rejects(capability(async () => response('invalid'))(request, signal(), origin), /invalid JSON/)
    })
    const spans = z.array(z.object({
      name: z.string(), span_id: z.string(), parent_span_id: z.string().nullable(),
      status_code: z.number(), attributes: z.string(),
    })).parse(store.querySpans())
    const child = spans.find(s => s.name === 'script.infer')!
    assert.equal(child.parent_span_id, spans.find(s => s.name === 'agent.tool')!.span_id)
    assert.equal(child.status_code, 2)
    const attrs = z.array(z.object({ key: z.string(), value: z.object({
      stringValue: z.string().optional(), intValue: z.union([z.number(), z.string()]).optional(),
    }).passthrough() })).parse(JSON.parse(child.attributes))
    assert.equal(attrs.find(a => a.key === 'outerToolCallId')?.value.stringValue, 'exec-1')
    assert.equal(Number(attrs.find(a => a.key === 'infer.usage.total_tokens')?.value.intValue), 23)
  } finally { await telemetry.shutdown(); store.close() }
})
