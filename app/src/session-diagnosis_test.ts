import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  diagnosisBatchColor, correlateModelSpans, correlateToolSpans, eventMatches, fetchDiagnosisJson, formatTraceDuration, mergeTraceSpans, parseDiagnosisHistory, parseTracePage, recordedModelResponse, traceKey,
  DEFAULT_TRACE_WINDOW_MS, fitTraceWindow, latestTraceWindow, spanDuration, spanMatches, stackTimelineItems, traceDuration, type SessionTraceSpan,
} from './session-diagnosis.ts'

function span(overrides: Partial<SessionTraceSpan> = {}): SessionTraceSpan {
  return { id: 1, traceId: 'trace-a', spanId: 'span-a', name: 'agent.chat', startTime: 1000, endTime: 2000, live: false, attributes: {}, events: [], ...overrides }
}

test('trace distinguishes delegated input from humans without losing raw evidence or turn boundaries', () => {
  const tag = '<sender id="web:chat-admin" name="Admin &amp; admin" source="session" intent="handoff" />'
  const { events } = parseDiagnosisHistory({ messages: [
    { role: 'user', content: 'Human request' },
    { role: 'user', name: 'admin', content: [{ type: 'text', text: tag }, { type: 'text', text: 'Delegated work' }] },
    { role: 'assistant', content: 'Worker response' },
    { role: 'user', content: '<event type="cron-tick" source="cron" />Background check' },
    { role: 'user', content: [{ type: 'text', text: '<sender id="human" chat="direct" />' },
      { type: 'text', text: 'Literal <sender source="session" /> content' },
      { type: 'image_url', image_url: { url: 'data:image/png;base64,fixture' } }] },
  ] })
  assert.deepEqual(events.map(event => [event.kind, event.turn]), [['USER', 1], ['SESSION', 2], ['ASSISTANT', 2], ['CONTEXT', 2], ['USER', 3]])
  assert.equal(events[1].title, 'Received handoff')
  assert.equal(events[1].content, 'Delegated work')
  assert.equal(events[1].rawContent, `${tag}\nDelegated work`)
  assert.equal(events[1].sessionSource?.id, 'web:chat-admin')
  assert.equal(eventMatches(events[1], 'Admin & admin', 'SESSION'), true)
  assert.equal(eventMatches(events[1], 'web:chat-admin', 'USER'), false)
  assert.equal(events[3].content, 'Background check')
  assert.match(events[3].rawContent!, /^<event /)
  assert.match(events[4].content, /^Literal <sender source="session" \/> content/)
  assert.match(events[4].content, /\[image\]/)
  assert.doesNotMatch(events[4].content, /base64/)
  assert.deepEqual(events[4].images, ['data:image/png;base64,fixture'])
})

test('history preserves genuine turns and distinguishes system and compaction context', () => {
  const { events, physicalId } = parseDiagnosisHistory({ currentPhysicalId: 'physical-a', messages: [
    { role: 'system', content: 'Historical system prompt' },
    { role: 'user', name: '__compaction_summary__', content: 'Summary' },
    { role: 'user', content: [{ type: 'text', text: '<event type="cron"/>Wake up' }] },
    { role: 'user', content: [{ type: 'text', text: 'Inspect the code' }], timestamp: '2026-04-21T12:00:00.000Z' },
    { role: 'assistant', content: 'Answer', reasoning_text: 'Reasoning', usage: { totalTokens: 12 } },
  ] })
  assert.equal(physicalId, 'physical-a')
  assert.deepEqual(events.map(event => [event.kind, event.turn]), [['SYSTEM', 0], ['CONTEXT', 0], ['CONTEXT', 0], ['USER', 1], ['ASSISTANT', 1]])
  assert.equal(events[3].content, 'Inspect the code')
  assert.equal(events[3].timestamp, Date.parse('2026-04-21T12:00:00.000Z'))
  assert.equal(events[4].timestamp, undefined)
  assert.equal(events[4].reasoning, 'Reasoning')
  assert.match(events[4].usage!, /12/)
})

test('trace pairs visual tool results without dumping encoded image bytes into text', () => {
  const image = 'data:image/png;base64,aW1hZ2U='
  const { events } = parseDiagnosisHistory({ messages: [
    { role: 'assistant', content: null, tool_calls: [{ id: 'image', function: { name: 'read', arguments: '{"path":"x.png"}' } }] },
    { role: 'tool', tool_call_id: 'image', content: [
      { type: 'text', text: 'Screenshot 10 x 10' }, { type: 'image_url', image_url: { url: image } },
    ] },
  ] })
  const tool = events.find(event => event.callId === 'image')
  assert(tool)
  assert.equal(tool.kind, 'TOOL')
  assert.equal(tool.result, 'Screenshot 10 x 10\n[image]')
  assert.deepEqual(tool.images, [image])
})

test('parallel tool results are paired by ID rather than adjacent position or name', () => {
  const { events } = parseDiagnosisHistory({ messages: [
    { role: 'user', content: 'Read two files' },
    { role: 'assistant', content: '', tool_calls: [
      { id: 'first', function: { name: 'read', arguments: '{"path":"a"}' } },
      { id: 'second', function: { name: 'read', arguments: '{"path":"b"}' } },
    ] },
    { role: 'tool', name: 'read', tool_call_id: 'second', content: 'B' },
    { role: 'tool', name: 'read', tool_call_id: 'first', content: 'A' },
    { role: 'tool', name: 'read', tool_call_id: 'orphan', content: 'No matching call' },
    { role: 'assistant', content: 'Done' },
  ] })
  assert.equal(events.filter(event => event.kind === 'TOOL').length, 3)
  assert.equal(events[1].result, 'A')
  assert.deepEqual(JSON.parse(events[1].toolCall!), { id: 'first', function: { name: 'read', arguments: '{"path":"a"}' } })
  assert.equal(events[2].result, 'B')
  assert.equal(events[3].callId, 'orphan')
  assert.equal(events[4].kind, 'ASSISTANT')
})

test('tool calls without results or timestamps remain explicitly incomplete', () => {
  const { events } = parseDiagnosisHistory({ messages: [
    { role: 'assistant', content: '', timestamp: 'invalid', tool_calls: [{ id: 'pending', function: { name: 'read', arguments: '{malformed' } }] },
  ] })
  assert.equal(events[0].result, undefined)
  assert.equal(events[0].timestamp, undefined)
  assert.equal(events[0].arguments, '{malformed')
  assert.equal(JSON.parse(events[0].toolCall!).function.arguments, '{malformed')
})

test('search includes reasoning, arguments, results and errors without changing event classification', () => {
  const { events } = parseDiagnosisHistory({ messages: [
    { role: 'assistant', content: '', tool_calls: [{ id: 'call-1', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }] },
    { role: 'tool', content: 'folder instructions', tool_call_id: 'call-1' },
  ] })
  assert.equal(eventMatches(events[0], 'readme', 'TOOL'), true)
  assert.equal(eventMatches(events[0], 'tool readme instructions'), true)
  assert.equal(eventMatches(events[0], 'instructions'), true)
  assert.equal(eventMatches(events[0], 'instructions', 'USER'), false)
  assert.equal(spanMatches(span({ events: [{ name: 'exception', time: 1000, attributes: { message: 'permission denied' } }] }), 'DENIED'), true)
})

test('duration uses actual execution intervals without double-counting nested or parallel spans', () => {
  assert.equal(traceDuration([span({ startTime: 1000, endTime: 3000 }), span({ startTime: 1500, endTime: 2500 }), span({ startTime: 10000, endTime: 11000 })], 0), 3000)
  assert.equal(traceDuration([], 0), undefined)
  assert.equal(spanDuration(span({ endTime: undefined }), 20000), undefined)
  assert.equal(spanDuration(span({ endTime: 500 }), 20000), undefined)
  assert.equal(spanDuration(span({ endTime: undefined, live: true }), 3500), 2500)
  assert.equal(formatTraceDuration(undefined), 'Unavailable')
  assert.equal(formatTraceDuration(0), '0 ms')
})

test('refresh replaces live spans with completed spans and preserves loaded older history', () => {
  const old = span({ id: 1, spanId: 'old', startTime: 10 })
  const live = span({ id: null, spanId: 'live', live: true, endTime: undefined })
  const lost = span({ id: null, spanId: 'gone', live: true, endTime: undefined })
  const completed = { ...live, id: 5, live: false, endTime: 5000 }
  assert.deepEqual(mergeTraceSpans([old, live, lost], [completed], true), [old, completed])
  assert.equal(mergeTraceSpans([old, completed], [old]).length, 2)
  assert.equal(mergeTraceSpans([old], [span({ traceId: 'different', spanId: 'old' })]).length, 2)
})

test('trace parser enforces session and physical-segment correlation and safe pagination', () => {
  const page = { sessionId: 'session-a', physicalSessionId: 'physical-a', entries: [span()], hasMore: true, nextBeforeId: 1 }
  assert.equal(parseTracePage(page, 'session-a', 'physical-a').entries.length, 1)
  assert.throws(() => parseTracePage(page, 'session-b', 'physical-a'), /Invalid session trace/)
  assert.throws(() => parseTracePage(page, 'session-a', 'physical-b'), /Invalid session trace/)
  assert.throws(() => parseTracePage({ ...page, nextBeforeId: undefined }, 'session-a', 'physical-a'), /Invalid session trace/)
  assert.throws(() => parseTracePage({ ...page, entries: [span({ startTime: NaN })] }, 'session-a', 'physical-a'), /Invalid session trace span/)
  assert.throws(() => parseTracePage({ ...page, entries: [{ ...span(), events: [{}] }] }, 'session-a', 'physical-a'), /Invalid session trace event/)
  assert.throws(() => parseDiagnosisHistory({ messages: [null] }), /Invalid session history message/)
  assert.throws(() => parseDiagnosisHistory({}), /Invalid session history response/)
})

test('timeline zoom and panning stay inside recorded data and parallel calls remain individually selectable', () => {
  assert.deepEqual(fitTraceWindow({ start: -100, end: 100 }, { start: 0, end: 1000 }), { start: 0, end: 200 })
  assert.deepEqual(fitTraceWindow({ start: 900, end: 1100 }, { start: 0, end: 1000 }), { start: 800, end: 1000 })
  assert.deepEqual(fitTraceWindow({ start: -100, end: 2000 }, { start: 0, end: 1000 }), { start: 0, end: 1000 })
  assert.deepEqual(stackTimelineItems([{ start: 0, end: 100 }, { start: 10, end: 50 }, { start: 110, end: 200 }]).map(item => item.track), [0, 1, 0])
})

test('default trace window shows exactly the latest five minutes, not the whole conversation', () => {
  const start = Date.parse('2026-09-17T00:00:00Z')
  const end = start + 6 * 60 * 60 * 1000
  assert.equal(DEFAULT_TRACE_WINDOW_MS, 300_000)
  assert.deepEqual(latestTraceWindow({ start, end }), { start: end - 300_000, end })
  assert.deepEqual(latestTraceWindow({ start, end: start + 1000 }), { start, end: start + 1000 })
  assert.deepEqual(latestTraceWindow({ start, end: start }), { start, end: start })
  assert.deepEqual(latestTraceWindow({ start: 0, end: 0 }), { start: 0, end: 0 })
  const manual = { start: start + 600_000, end: start + 900_000 }
  assert.deepEqual(fitTraceWindow(manual, { start: start - 600_000, end: end + 600_000 }), manual)
  assert.deepEqual(latestTraceWindow({ start, end: end + 600_000 }), { start: end + 300_000, end: end + 600_000 })
})

test('reused provider call IDs never attach another turn timing or result to a trace span', () => {
  const message = (id: string) => ({ role: 'assistant', tool_calls: [{ id, function: { name: 'read', arguments: '{}' } }] })
  const { events } = parseDiagnosisHistory({ messages: [message('reused'), { role: 'tool', tool_call_id: 'reused', content: 'first' }, message('reused'), { role: 'tool', tool_call_id: 'reused', content: 'second' }, message('unique')] })
  const spans = [span({ name: 'agent.tool', attributes: { 'tool.call_id': 'reused' } }), span({ name: 'agent.tool', spanId: 'unique', attributes: { 'tool.call_id': 'unique' } })]
  assert.equal(events[0].result, 'first')
  assert.equal(events[1].result, 'second')
  assert.deepEqual([...correlateToolSpans(events, spans).keys()], [events[2].id])
  assert.equal(correlateToolSpans(events, [...spans, { ...spans[1], spanId: 'duplicate' }]).size, 0)
})

test('an older running backend gives an actionable trace upgrade message', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => new Response('{}', { status: 404 }))
  await assert.rejects(fetchDiagnosisJson(new URL('http://localhost/v1/query/session-spans'), new AbortController().signal), /Restart Shadow/)
  await assert.rejects(fetchDiagnosisJson(new URL('http://localhost/api/sessions/missing'), new AbortController().signal), /HTTP 404/)
})

test('model response snapshots display returned content, reasoning, usage and tool-only messages', () => {
  const message = {
    role: 'assistant', content: 'Final model response', reasoning_text: 'Visible reasoning',
    usage: { totalTokens: 12 },
    tool_calls: [{ id: 'call-1', function: { name: 'read', arguments: '{"path":"fixture.txt"}' } }],
  }
  const model = span({ events: [{ name: 'model.response', time: 2000, attributes: { message: JSON.stringify(message) } }] })
  const detail = recordedModelResponse(model)!
  assert.equal(detail.source, 'recorded')
  assert.equal(detail.event.content, message.content)
  assert.equal(detail.event.reasoning, message.reasoning_text)
  assert.deepEqual(JSON.parse(detail.event.toolCalls!), message.tool_calls)
  assert.deepEqual(JSON.parse(detail.event.usage!), message.usage)
  assert.equal(recordedModelResponse({ ...model, name: 'agent.tool' }), undefined)
  assert.equal(recordedModelResponse(span()), undefined)
  assert.equal(recordedModelResponse({ ...model, events: [{ name: 'model.response', time: 2000, attributes: { message: JSON.stringify({ ...message, content: null, reasoning_text: undefined }) } }] })?.event.content, '')
  assert.throws(() => recordedModelResponse(span({ events: [{ name: 'model.response', time: 0, attributes: { message: '{invalid' } }] })), /invalid message JSON/)
  assert.throws(() => recordedModelResponse(span({ events: [{ name: 'model.response', time: 0, attributes: {} }] })), /missing its message/)
})

test('legacy model responses match original message positions and completion intervals, including tool-only returns', () => {
  const messages = [
    { role: 'user', content: 'Start', timestamp: new Date(500).toISOString() },
    { role: 'assistant', content: null, timestamp: new Date(2000).toISOString(), tool_calls: [{ id: 'call-1', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call-1', content: 'result', timestamp: new Date(2200).toISOString() },
    { role: 'assistant', content: 'Finished', timestamp: new Date(4000).toISOString() },
  ]
  const chats = [
    span({ endTime: 2000.5, attributes: { 'llm.input_messages': '2' } }),
    span({ spanId: 'second', startTime: 3000, endTime: 4000, attributes: { 'llm.input_messages': '4' } }),
  ]
  for (const history of [messages, [{ role: 'system', content: 'System' }, ...messages]]) {
    const { events, modelResponses } = parseDiagnosisHistory({ messages: history })
    assert.equal(events.filter(event => event.kind === 'ASSISTANT').length, 1, 'Tool-only replies do not add duplicate recorded events')
    assert.equal(modelResponses.length, 2)
    const matched = correlateModelSpans(modelResponses, chats)
    assert.equal(matched.get(traceKey(chats[0]))?.source, 'history')
    assert.equal(JSON.parse(matched.get(traceKey(chats[0]))!.event.toolCalls!)[0].id, 'call-1')
    assert.equal(matched.get(traceKey(chats[1]))?.event.content, 'Finished')
  }
  const { modelResponses } = parseDiagnosisHistory({ messages })
  assert.equal(correlateModelSpans(modelResponses, [span({ attributes: {} })]).size, 0)
  assert.equal(correlateModelSpans(modelResponses, [{ ...chats[0], live: true }]).size, 0)
  assert.equal(correlateModelSpans(modelResponses, [{ ...chats[0], statusCode: 2 }]).size, 0)
  assert.equal(correlateModelSpans(modelResponses, [{ ...chats[0], endTime: 2100 }]).size, 0)
  assert.equal(correlateModelSpans(modelResponses, [{ ...chats[0], endTime: 800 }, { ...chats[0], spanId: 'retry' }]).size, 1, 'Earlier abandoned attempt cannot steal a retry response')
  assert.equal(correlateModelSpans([...modelResponses, { ...modelResponses[0], id: 'ambiguous' }], chats).size, 1, 'Ambiguous positions are not guessed')
})

test('batch identity belongs to the original assistant record, not filtered rows or reused tool IDs', () => {
  const call = (id: string) => ({ id, function: { name: 'read', arguments: '{}' } })
  const parsed = parseDiagnosisHistory({ currentPhysicalId: 'physical-1', messages: [
    { role: 'user', content: 'request' },
    { role: 'assistant', content: 'Third output text', tool_calls: [call('a'), call('b')] },
    { role: 'tool', tool_call_id: 'b', content: 'second result' },
    { role: 'tool', tool_call_id: 'a', content: 'first result' },
    { role: 'assistant', content: '', tool_calls: [call('a')] },
  ] })
  const first = parsed.events.filter(event => event.batchNumber === 1)
  assert.equal(first.length, 3)
  assert.equal(new Set(first.map(event => event.batchId)).size, 1)
  assert(first.every(event => event.batchSize === 3))
  assert.deepEqual(first.map(event => event.result), [undefined, 'first result', 'second result'])
  const filtered = parsed.events.filter(event => event.kind === 'TOOL')
  assert.deepEqual(filtered.map(event => event.batchNumber), [1, 1, 2])
  assert.notEqual(filtered[0].batchId, filtered[2].batchId)
  assert.equal(filtered[2].batchSize, 1)
  assert.equal(parsed.events[0].batchId, undefined)
})

test('batch palette uses stable ordinals, cycles and leaves non-batch events uncolored', () => {
  const events = parseDiagnosisHistory({ messages: [
    { role: 'user', content: 'input' },
    { role: 'assistant', content: 'first', tool_calls: [{ id: 'a', function: { name: 'read', arguments: '{}' } }] },
    { role: 'assistant', content: 'second' },
    { role: 'user', content: '<event type="tick" />context' },
    { role: 'tool', tool_call_id: 'orphan', content: 'orphan' },
  ] }).events
  assert.deepEqual(events.map(diagnosisBatchColor), [undefined, 'batch-color-0', 'batch-color-0', 'batch-color-1', undefined, undefined])
  assert.deepEqual(events.filter(e => eventMatches(e, '', 'TOOL')).map(diagnosisBatchColor), ['batch-color-0', undefined])
  assert.equal(diagnosisBatchColor({ batchId: 'six', batchNumber: 6 }), 'batch-color-0')
  for (const batchNumber of [0, -1, 1.5, NaN, undefined]) assert.equal(diagnosisBatchColor({ batchId: 'bad', batchNumber }), undefined)
})
