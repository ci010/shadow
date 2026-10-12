import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { openaiResponses } from './openai-responses.ts'
import {
  ProviderHttpError,
  TokenLimitExceededError,
  type ChatMessage,
  type ResponsesOutputItem,
  type ResponsesProviderState,
} from './provider.ts'
import type { ToolDefinition } from '../tools/tool.ts'

const defaults = {
  url: 'https://synthetic.invalid/responses', apiKey: 'synthetic-key',
  model: 'gpt-6-astra', providerName: 'copilot', messages: [], tools: [],
}
const opaque: ResponsesProviderState['reasoning'][number] = {
  type: 'reasoning', id: 'rs_1', encrypted_content: 'synthetic-opaque-reasoning',
  summary: [{ type: 'summary_text', text: 'Need to inspect the file.' }],
}
const state: ResponsesProviderState = { provider: 'copilot', model: defaults.model, reasoning: [opaque] }
const call: Extract<ResponsesOutputItem, { type: 'function_call' }> = {
  type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'inspect', arguments: '{"path":"file.txt"}',
}
const message = (text: string): Extract<ResponsesOutputItem, { type: 'message' }> => ({
  type: 'message', id: 'msg_1', role: 'assistant', status: 'completed',
  content: [{ type: 'output_text', text, annotations: [] }],
})
const completed = (output: unknown[] = [message('Done')]) => ({
  id: 'resp_1', status: 'completed', model: defaults.model, output,
  usage: { input_tokens: 10, output_tokens: 4, total_tokens: 14 },
})
function harness(t: TestContext, responses: Array<Response | Error>) {
  const calls: Array<{ url: string; init: RequestInit; body: Record<string, unknown> }> = []
  t.mock.method(globalThis, 'fetch', async (url: string, init: RequestInit) => {
    calls.push({ url: String(url), init, body: JSON.parse(init.body as string) })
    const next = responses.shift()
    assert.ok(next, 'Unexpected network request')
    if (next instanceof Error) throw next
    return next
  })
  return calls
}
function sseText(text: string, width = 3): Response {
  const bytes = new TextEncoder().encode(text)
  let offset = 0
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset === bytes.length) { controller.close(); return }
      controller.enqueue(bytes.slice(offset, offset += width))
    },
  }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } })
}
function sse(events: unknown[], width = 3): Response {
  return sseText(events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join(''), width)
}

test('maps stateless messages, images, encrypted tool history and flat function schemas without local fields', async (t) => {
  const tool: ToolDefinition = {
    type: 'function', optIn: true,
    function: {
      name: 'inspect', description: 'Read a file',
      parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    },
  }
  const messages: ChatMessage[] = [
    { role: 'system', content: 'Instructions' },
    { role: 'user', content: [
      { type: 'text', text: 'Inspect this' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,c3ludGhldGlj', detail: 'high' } },
      { type: 'image_url', image_url: { url: 'https://synthetic.invalid/image.png' } },
    ] },
    {
      role: 'assistant', content: 'Checking', provider_state: state,
      tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'inspect', arguments: call.arguments } }],
      reasoning_text: 'display-only', reasoning_content: 'other-protocol-only', timestamp: 'local-date',
      usage: { promptTokens: 1, completionTokens: 2, totalTokens: 3 },
      responseContext: { version: 1, turnId: 'private-turn', responseId: 'private-response',
        source: { kind: 'session', sessionId: 'web:peer' }, userInvolved: false },
    },
    { role: 'tool', tool_call_id: 'call_1', name: 'inspect', content: '{"ok":true}' },
    { role: 'assistant', content: null, tool_calls: [
      { id: 'call_2', type: 'function', function: { name: 'inspect', arguments: '{}' } },
    ] },
    { role: 'tool', tool_call_id: 'call_2', content: 'Second result' },
    { role: 'user', content: 'Continue' },
  ]
  const before = structuredClone(messages)
  const calls = harness(t, [Response.json(completed())])
  const signal = new AbortController().signal
  await openaiResponses({
    ...defaults, messages, tools: [tool], headers: { 'x-synthetic': 'value' }, signal,
    maxTokens: 123, thinking: { type: 'enabled' }, reasoningEffort: 'max',
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].url, defaults.url)
  assert.equal(calls[0].init.signal, signal)
  assert.equal(calls[0].init.method, 'POST')
  assert.equal(new Headers(calls[0].init.headers).get('authorization'), 'Bearer synthetic-key')
  assert.equal(new Headers(calls[0].init.headers).get('x-synthetic'), 'value')
  assert.deepEqual(calls[0].body, {
    model: defaults.model, stream: true, store: false, include: ['reasoning.encrypted_content'],
    max_output_tokens: 123, reasoning: { effort: 'max' },
    tools: [{ type: 'function', ...tool.function, strict: false }],
    input: [
      { type: 'message', role: 'system', content: [{ type: 'input_text', text: 'Instructions' }] },
      { type: 'message', role: 'user', content: [
        { type: 'input_text', text: 'Inspect this' },
        { type: 'input_image', image_url: 'data:image/png;base64,c3ludGhldGlj', detail: 'high' },
        { type: 'input_image', image_url: 'https://synthetic.invalid/image.png', detail: 'auto' },
      ] },
      opaque,
      { type: 'message', role: 'assistant', content: 'Checking' },
      { type: 'function_call', call_id: 'call_1', name: 'inspect', arguments: call.arguments },
      { type: 'function_call_output', call_id: 'call_1', output: '{"ok":true}' },
      { type: 'function_call', call_id: 'call_2', name: 'inspect', arguments: '{}' },
      { type: 'function_call_output', call_id: 'call_2', output: 'Second result' },
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue' }] },
    ],
  })
  assert.deepEqual(messages, before)
})

test('completed JSON preserves usage, call IDs, display summaries and separately scoped opaque state', async (t) => {
  harness(t, [Response.json(completed([opaque, call, message('Done')]))])
  const result = await openaiResponses(defaults)
  assert.deepEqual(result, {
    content: 'Done', reasoningText: 'Need to inspect the file.', reasoningContent: null,
    toolCalls: [{ id: 'call_1', name: 'inspect', arguments: { path: 'file.txt' } }],
    model: defaults.model, usage: { promptTokens: 10, completionTokens: 4, totalTokens: 14 },
    providerState: { ...state, outputItems: [opaque, call, message('Done')] },
  })
  assert.ok(!result.reasoningText?.includes(opaque.encrypted_content))
})

test('opaque state replays only for the same provider and requested model; extras never leak', async (t) => {
  const foreign = { ...state, provider: 'other' } as unknown as ResponsesProviderState
  const calls = harness(t, Array.from({ length: 3 }, () => Response.json(completed([opaque]))))
  for (const providerName of ['copilot', 'other', undefined]) {
    await openaiResponses({
      ...defaults, providerName, messages: [
        { role: 'assistant', content: 'A', provider_state: { ...state, model: 'different' } },
        { role: 'assistant', content: 'B', provider_state: foreign },
        { role: 'assistant', content: 'C', provider_state: {
          ...state, reasoning: [{ ...opaque, private_field: 'never-forward' } as typeof opaque],
        } },
      ],
    })
  }
  const first = calls[0].body.input as Array<Record<string, unknown>>
  assert.deepEqual(first.filter((item) => item.type === 'reasoning'), [opaque])
  for (const request of calls.slice(1)) {
    assert.ok(!JSON.stringify(request.body).includes(opaque.encrypted_content))
  }
  assert.ok(!JSON.stringify(calls).includes('private_field'))
})

test('full ordered output replays reasoning, commentary, tool calls and final phase instead of reconstructed history', async (t) => {
  const secondCall = { ...call, id: 'fc_2', call_id: 'call_2', arguments: '{}' }
  const output: ResponsesOutputItem[] = [
    { ...opaque, status: 'completed' },
    { ...message('First commentary'), phase: 'commentary' as const },
    { ...call, status: 'completed' },
    { ...opaque, id: 'rs_2', encrypted_content: 'synthetic-second-ciphertext' },
    { ...message('Second commentary'), id: 'msg_2', phase: 'commentary' as const },
    secondCall,
    { ...message('Final answer'), id: 'msg_3', phase: 'final_answer' as const },
  ]
  const calls = harness(t, [Response.json(completed(output)), Response.json(completed())])
  const result = await openaiResponses(defaults)
  assert.deepEqual(result.providerState?.outputItems, output)
  assert.equal(result.providerState?.reasoning.length, 2)
  const history: ChatMessage[] = [
    { role: 'user', content: 'Original question' },
    {
      role: 'assistant', content: 'Do not send reconstructed text',
      provider_state: result.providerState,
      reasoning_text: 'Do not send display reasoning',
      tool_calls: [{ id: 'wrong_synthetic_call', type: 'function', function: { name: 'wrong_synthetic_tool', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call_1', content: 'First result' },
    { role: 'tool', tool_call_id: 'call_2', content: 'Second result' },
    { role: 'user', content: 'Continue' },
  ]
  const before = structuredClone(history)
  await openaiResponses({ ...defaults, messages: history })
  assert.deepEqual(calls[1].body.input, [
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Original question' }] },
    ...output,
    { type: 'function_call_output', call_id: 'call_1', output: 'First result' },
    { type: 'function_call_output', call_id: 'call_2', output: 'Second result' },
    { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Continue' }] },
  ])
  assert.deepEqual(history, before)
  assert.ok(!JSON.stringify(calls[1].body).includes('wrong_synthetic'))
})

test('ordered state preserves supported content, annotations and explicit phase while stripping unknown fields', async (t) => {
  const cited: Extract<ResponsesOutputItem, { type: 'message' }> = {
    ...message('Cited text'), phase: null,
    content: [
      { type: 'output_text', text: 'Cited text', annotations: [
        { type: 'file_citation', file_id: 'file_1', filename: 'one.txt', index: 0 },
        { type: 'url_citation', url: 'https://synthetic.invalid/', title: 'Synthetic', start_index: 0, end_index: 5 },
        { type: 'container_file_citation', container_id: 'container_1', file_id: 'file_2', filename: 'two.txt', start_index: 0, end_index: 5 },
        { type: 'file_path', file_id: 'file_3', index: 0 },
      ] },
      { type: 'refusal', refusal: 'A restricted detail is omitted.' },
    ],
  }
  const output: ResponsesOutputItem[] = [cited]
  const decorated = JSON.parse(JSON.stringify(output))
  decorated[0].credentials = 'never-forward'
  decorated[0].content[0].private_content = 'never-forward'
  decorated[0].content[0].annotations[0].private_annotation = 'never-forward'
  const calls = harness(t, [Response.json(completed(decorated)), Response.json(completed())])
  const result = await openaiResponses(defaults)
  assert.deepEqual(result.providerState, { ...state, reasoning: [], outputItems: output })
  await openaiResponses({
    ...defaults, messages: [{
      role: 'assistant', content: 'Synthetic text',
      provider_state: { ...state, outputItems: decorated },
    }],
  })
  assert.deepEqual(calls[1].body.input, output)
  assert.ok(!JSON.stringify(result).includes('never-forward'))
  assert.ok(!JSON.stringify(calls[1].body).includes('never-forward'))
})

test('ordered message-only state uses the requested model scope, not the returned model alias', async (t) => {
  const output: ResponsesOutputItem[] = [{ ...message('Done'), phase: 'final_answer' as const }]
  const calls = harness(t, [
    Response.json({ ...completed(output), model: 'resolved-model-alias' }), Response.json(completed()),
  ])
  const result = await openaiResponses(defaults)
  assert.equal(result.model, 'resolved-model-alias')
  assert.deepEqual(result.providerState, { provider: 'copilot', model: defaults.model, reasoning: [], outputItems: output })
  await openaiResponses({ ...defaults, messages: [{ role: 'assistant', content: 'Done', provider_state: result.providerState }] })
  assert.deepEqual(calls[1].body.input, output)
})

test('foreign ordered provider/model state is neither validated nor forwarded', async (t) => {
  const calls = harness(t, [Response.json(completed())])
  const badItems = [{ type: 'untrusted', secret: 'foreign-private-state' }]
  await openaiResponses({
    ...defaults, messages: [
      { role: 'assistant', content: 'A', provider_state: { ...state, model: 'other', outputItems: badItems } as unknown as ResponsesProviderState },
      { role: 'assistant', content: 'B', provider_state: { ...state, provider: 'other', outputItems: badItems } as unknown as ResponsesProviderState },
    ],
  })
  assert.deepEqual(calls[0].body.input, [
    { type: 'message', role: 'assistant', content: 'A' },
    { type: 'message', role: 'assistant', content: 'B' },
  ])
})

const invalidOutputStates: unknown[] = [
  {},
  [null],
  [{ type: 'unknown_tool' }],
  [{ ...message('Bad phase'), phase: 'malicious-private-phase' }],
  [{ ...message('Missing ID'), id: undefined }],
  [{ ...message('Wrong role'), role: 'user' }],
  [{ ...message('Incomplete'), status: 'incomplete' }],
  [{ ...message('Bad content'), content: [{ type: 'input_text', text: 'wrong type' }] }],
  [{ ...message('Bad annotations'), content: [{ type: 'output_text', text: 'A', annotations: {} }] }],
  [{ ...message('Bad annotation'), content: [{ type: 'output_text', text: 'A', annotations: [{ type: 'unknown' }] }] }],
  [{ ...call, arguments: '[]' }],
  [{ ...call, id: 7 }],
  [{ ...opaque, summary: [{ type: 'wrong', text: 'wrong type' }] }],
  [{ ...opaque, encrypted_content: {} }],
]
for (const [index, outputItems] of invalidOutputStates.entries()) {
  test(`malformed persisted ordered state ${index} is rejected before fetch without raw data`, async (t) => {
    const calls = harness(t, [])
    await assert.rejects(openaiResponses({
      ...defaults, messages: [{
        role: 'assistant', content: 'Do not fall back',
        provider_state: { ...state, outputItems } as unknown as ResponsesProviderState,
      }],
    }), (error: Error) => {
      assert.match(error.message, /Invalid Responses payload/)
      assert.ok(!error.message.includes('malicious-private-phase'))
      return true
    })
    assert.equal(calls.length, 0)
  })
}

test('temperature and reasoning effort are optional and enabled thinking does not invent an effort', async (t) => {
  const calls = harness(t, Array.from({ length: 3 }, () => Response.json(completed())))
  await openaiResponses({ ...defaults, temperature: 0, reasoningEffort: 'high' })
  await openaiResponses(defaults)
  await openaiResponses({ ...defaults, thinking: { type: 'enabled' } })
  assert.equal(calls[0].body.temperature, 0)
  assert.deepEqual(calls[0].body.reasoning, { effort: 'high' })
  for (const name of ['temperature', 'reasoning', 'thinking', 'reasoning_effort', 'max_output_tokens', 'tools']) {
    assert.ok(!(name in calls[1].body), name)
    assert.ok(!(name in calls[2].body), name)
  }
})

for (const providerName of ['openai', 'copilot', 'deepseek', 'custom']) {
  test(`${providerName} Responses maps disabled thinking to none ahead of inherited effort`, async (t) => {
    const options = [
      { thinking: { type: 'disabled' as const } },
      { thinking: { type: 'disabled' as const }, reasoningEffort: 'high' as const },
      { thinking: { type: 'enabled' as const }, reasoningEffort: 'high' as const },
      {},
    ]
    const calls = harness(t, options.map(() => Response.json(completed())))
    for (const option of options) await openaiResponses({ ...defaults, providerName, ...option })
    assert.deepEqual(calls.map(call => call.body.reasoning), [
      { effort: 'none' }, { effort: 'none' }, { effort: 'high' },
      providerName === 'deepseek' ? { effort: 'high' } : undefined,
    ])
    assert.ok(calls.every(call => !('thinking' in call.body) && !('reasoning_effort' in call.body)))
  })
}

test('SSE CRLF, UTF-8 chunk boundaries and multiline data use completed output without double counting', async (t) => {
  const output = [opaque, { ...message('Final 🐈'), phase: 'final_answer' }, call]
  const events = [
    { type: 'response.output_item.added', output_index: 1, item: message('') },
    { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'Partial' },
    { type: 'response.output_text.done', output_index: 1, content_index: 0, text: 'Final 🐈' },
    { type: 'response.output_item.done', output_index: 1, item: message('Final 🐈') },
    { type: 'response.output_item.added', output_index: 2, item: { ...call, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"path":' },
    { type: 'response.function_call_arguments.delta', output_index: 2, delta: '"file.txt"}' },
    { type: 'response.function_call_arguments.done', output_index: 2, arguments: call.arguments },
    { type: 'response.output_item.done', output_index: 2, item: call },
  ]
  const text = ': heartbeat\r\n\r\n' +
    events.map((event) => `data: ${JSON.stringify(event)}\r\n\r\n`).join('') +
    `event: response.completed\r\ndata: {"response":\r\ndata: ${JSON.stringify(completed(output))}}\r\n\r\n`
  harness(t, [sseText(text, 1)])
  const result = await openaiResponses(defaults)
  assert.equal(result.content, 'Final 🐈')
  assert.deepEqual(result.toolCalls, [{ id: 'call_1', name: 'inspect', arguments: { path: 'file.txt' } }])
  assert.deepEqual(result.providerState, { ...state, outputItems: output })
  assert.deepEqual(result.usage, { promptTokens: 10, completionTokens: 4, totalTokens: 14 })
})

test('SSE assembles text, summaries and split function arguments when completed omits output', async (t) => {
  const final = { ...completed(), output: undefined }
  harness(t, [sse([
    { type: 'response.output_item.added', output_index: 2, item: { ...call, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 2, delta: '{"path":' },
    { type: 'response.function_call_arguments.delta', output_index: 2, delta: '"file.txt"}' },
    { type: 'response.output_item.added', output_index: 0, item: { ...opaque, summary: [] } },
    { type: 'response.reasoning_summary_part.added', output_index: 0, summary_index: 0, part: { type: 'summary_text', text: '' } },
    { type: 'response.reasoning_summary_text.delta', output_index: 0, summary_index: 0, delta: 'Need to inspect the file.' },
    { type: 'response.reasoning_summary_text.done', output_index: 0, summary_index: 0, text: 'Need to inspect the file.' },
    { type: 'response.output_item.done', output_index: 0, item: opaque },
    { type: 'response.output_item.added', output_index: 1, item: { ...message(''), phase: 'commentary', content: [] } },
    { type: 'response.content_part.added', output_index: 1, content_index: 0, part: { type: 'output_text', text: '' } },
    { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'Hel' },
    { type: 'response.output_text.delta', output_index: 1, content_index: 0, delta: 'lo' },
    { type: 'response.completed', response: final },
  ])])
  const result = await openaiResponses(defaults)
  assert.equal(result.content, 'Hello')
  assert.equal(result.reasoningText, opaque.summary[0].text)
  assert.deepEqual(result.providerState, {
    ...state, outputItems: [opaque, { ...message('Hello'), phase: 'commentary' }, call],
  })
  assert.deepEqual(result.toolCalls[0], { id: 'call_1', name: 'inspect', arguments: { path: 'file.txt' } })
})

test('provisional added-event reasoning ciphertext cannot complete a replayable response', async (t) => {
  harness(t, [sse([
    { type: 'response.output_item.added', output_index: 0, item: opaque },
    { type: 'response.completed', response: { ...completed(), output: undefined } },
  ])])
  await assert.rejects(openaiResponses(defaults), /missing completed reasoning item/)
})

test('completed output is authoritative even when empty', async (t) => {
  harness(t, [sse([
    { type: 'response.output_item.added', output_index: 0, item: message('Ignore me') },
    { type: 'response.completed', response: completed([]) },
  ])])
  assert.equal((await openaiResponses(defaults)).content, null)
})

test('refusals are visible rather than disappearing into an empty successful response', async (t) => {
  const refusal = { ...message(''), content: [{ type: 'refusal', refusal: 'Cannot help with that.' }] }
  harness(t, [Response.json(completed([refusal]))])
  assert.equal((await openaiResponses(defaults)).content, 'Cannot help with that.')
})

test('SSE done items replace provisional content and refusals assemble without duplication', async (t) => {
  harness(t, [sse([
    { type: 'response.output_item.added', output_index: 1, item: { ...call, arguments: '' } },
    { type: 'response.function_call_arguments.delta', output_index: 1, delta: '{"discard":true}' },
    { type: 'response.output_item.done', output_index: 1, item: call },
    { type: 'response.output_item.added', output_index: 0, item: { ...message(''), content: [] } },
    { type: 'response.refusal.delta', output_index: 0, content_index: 0, delta: 'Cannot help.' },
    { type: 'response.refusal.done', output_index: 0, content_index: 0, refusal: 'Cannot help.' },
    { type: 'response.completed', response: { ...completed(), output: undefined } },
  ])])
  const result = await openaiResponses(defaults)
  assert.equal(result.content, 'Cannot help.')
  assert.deepEqual(result.toolCalls[0].arguments, { path: 'file.txt' })
})

for (const args of ['', '{invalid', 'null', '[]', '42', '"string"', 'true']) {
  test(`rejects invalid or non-object tool arguments ${JSON.stringify(args)}`, async (t) => {
    harness(t, [Response.json(completed([{ ...call, arguments: args }]))])
    await assert.rejects(openaiResponses(defaults), /Invalid Responses payload/)
  })
}

test('valid empty object tool arguments are preserved', async (t) => {
  harness(t, [Response.json(completed([{ ...call, arguments: '{}' }]))])
  assert.deepEqual((await openaiResponses(defaults)).toolCalls[0].arguments, {})
})

for (const status of ['failed', 'incomplete', 'cancelled', 'in_progress', undefined]) {
  test(`JSON never returns partial output with non-completed status ${status}`, async (t) => {
    harness(t, [Response.json({ ...completed(), status, incomplete_details: { reason: 'max_output_tokens' } })])
    await assert.rejects(openaiResponses(defaults), /Responses request .*max_output_tokens/)
  })
}

for (const type of ['response.failed', 'response.incomplete', 'response.cancelled', 'response.error', 'error']) {
  test(`SSE ${type} rejects partial output safely`, async (t) => {
    harness(t, [sse([
      { type: 'response.output_item.added', output_index: 0, item: message('Partial') },
      { type, response: { status: type.slice(9), error: { code: 'server_error', message: 'private-prompt' } } },
    ])])
    await assert.rejects(openaiResponses(defaults), (error: Error) => {
      assert.match(error.message, /server_error/)
      assert.ok(!error.message.includes('private-prompt'))
      return true
    })
  })
}

for (const body of [
  '',
  'data: [DONE]\n\n',
  'data: {"type":"response.output_text.delta","delta":"partial"}\n\n',
  'data: {"type":"response.completed","response":{"status":"completed","output":[]}}',
  'data: {"type":"response.completed","response":{"output":[]}}\n\n',
  'data: malformed\n\n',
]) {
  test(`rejects malformed or unterminated SSE ${body.slice(0, 40)}`, async (t) => {
    harness(t, [sseText(body)])
    await assert.rejects(openaiResponses(defaults), /Invalid Responses payload/)
  })
}

test('malformed JSON response and invalid output objects fail safely', async (t) => {
  const calls = harness(t, [
    new Response('secret-not-json', { headers: { 'content-type': 'application/json' } }),
    Response.json({ status: 'completed' }),
    Response.json(completed([{ type: 'function_call', arguments: '{}' }])),
  ])
  for (let i = 0; i < 3; i++) {
    await assert.rejects(openaiResponses(defaults), (error: Error) =>
      /Invalid Responses payload/.test(error.message) && !error.message.includes('secret-not-json'))
  }
  assert.equal(calls.length, 3)
})

test('contradictory completed responses with null output or incomplete tool items fail closed', async (t) => {
  harness(t, [
    sse([{ type: 'response.completed', response: { ...completed(), output: null } }]),
    Response.json(completed([{ ...call, status: 'incomplete' }])),
  ])
  for (let i = 0; i < 2; i++) await assert.rejects(openaiResponses(defaults), /Invalid Responses payload/)
})

test('HTTP 400 is not retried; 401 has a typed status without leaking the response body', async (t) => {
  const calls = harness(t, [
    Response.json({ error: { code: 'unsupported_parameter', message: 'private-body' } }, { status: 400 }),
    new Response('private-body', { status: 401 }),
  ])
  for (const status of [400, 401]) {
    await assert.rejects(openaiResponses(defaults), (error: Error) => {
      assert.ok(error instanceof ProviderHttpError)
      assert.equal(error.status, status)
      assert.ok(!error.message.includes('private-body'))
      assert.ok(!error.message.includes(defaults.apiKey))
      return true
    })
  }
  assert.equal(calls.length, 2)
})

test('HTTP status remains authoritative for missing and unreadable error bodies', async (t) => {
  harness(t, [
    new Response(null, { status: 401 }),
    new Response(new ReadableStream({
      start(controller) { controller.error(new TypeError('Synthetic failed body read')) },
    }), { status: 403 }),
  ])
  for (const status of [401, 403]) {
    await assert.rejects(openaiResponses(defaults), (error) =>
      error instanceof ProviderHttpError && error.status === status)
  }
})

test('context limit errors retain the agent handoff exception on HTTP and stream paths', async (t) => {
  const error = { code: 'model_max_prompt_tokens_exceeded', message: 'private-prompt' }
  harness(t, [
    Response.json({ error }, { status: 400 }),
    sse([{ type: 'error', code: 'context_length_exceeded', message: 'private-prompt' }]),
  ])
  for (let i = 0; i < 2; i++) await assert.rejects(openaiResponses(defaults), TokenLimitExceededError)
})

test('transport errors do not retry a potentially accepted POST', async (t) => {
  const calls = harness(t, [new TypeError('Synthetic connection reset')])
  await assert.rejects(openaiResponses(defaults), /Synthetic connection reset/)
  assert.equal(calls.length, 1)
})

test('already-aborted signal does not make a request', async (t) => {
  const calls = harness(t, [])
  const signal = AbortSignal.abort(new Error('Synthetic abort'))
  await assert.rejects(openaiResponses({ ...defaults, signal }), /Synthetic abort/)
  assert.equal(calls.length, 0)
})

test('abort reaches an in-flight fetch without another POST', async (t) => {
  let started!: () => void
  const fetching = new Promise<void>((resolve) => { started = resolve })
  const controller = new AbortController()
  const mocked = t.mock.method(globalThis, 'fetch', (_url: unknown, init: RequestInit) => {
    assert.equal(init.signal, controller.signal)
    started()
    return new Promise<Response>((_, reject) => {
      init.signal!.addEventListener('abort', () => reject(init.signal!.reason), { once: true })
    })
  })
  const result = openaiResponses({ ...defaults, signal: controller.signal })
  await fetching
  controller.abort()
  await assert.rejects(result, (error) => error === controller.signal.reason)
  assert.equal(mocked.mock.callCount(), 1)
})

for (const contentType of ['text/event-stream', 'application/json']) {
  test(`abort interrupts pending ${contentType} reads and does not await hung cancellation`, { timeout: 2000 }, async (t) => {
    let started!: () => void
    const reading = new Promise<void>((resolve) => { started = resolve })
    let cancelled = false
    const body = new ReadableStream<Uint8Array>({
      pull() { started(); return new Promise<void>(() => {}) },
      cancel() { cancelled = true; return new Promise<void>(() => {}) },
    })
    harness(t, [new Response(body, { headers: { 'content-type': contentType } })])
    const controller = new AbortController()
    const result = openaiResponses({ ...defaults, signal: controller.signal })
    await reading
    const reason = new DOMException('Synthetic abort', 'AbortError')
    controller.abort(reason)
    await assert.rejects(result, (error) => error === reason)
    assert.equal(cancelled, true)
    assert.equal(body.locked, false)
  })
}

test('completed SSE returns promptly and releases an otherwise-open stream', { timeout: 2000 }, async (t) => {
  let cancelled = false
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(
        `data: ${JSON.stringify({ type: 'response.completed', response: completed() })}\n\n`,
      ))
    },
    cancel() { cancelled = true; return new Promise<void>(() => {}) },
  })
  harness(t, [new Response(body, { headers: { 'content-type': 'text/event-stream' } })])
  assert.equal((await openaiResponses(defaults)).content, 'Done')
  assert.equal(cancelled, true)
  assert.equal(body.locked, false)
})


test('HTTP 413 keeps its typed status across proxy body formats without retry', async t => {
  const calls = harness(t, [
    new Response('<html>Request too large</html>', { status: 413 }),
    new Response(null, { status: 413 }),
    new Response(new ReadableStream({ start(controller) { controller.error(new TypeError('body failed')) } }), { status: 413 }),
  ])
  for (let i = 0; i < 3; i++) await assert.rejects(openaiResponses(defaults), error =>
    error instanceof ProviderHttpError && error.status === 413)
  assert.equal(calls.length, 3)
})
