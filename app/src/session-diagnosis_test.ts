import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  correlateModelSpans, correlateToolSpans, eventMatches, fetchDiagnosisJson, formatTraceDuration, mergeTraceSpans, parseDiagnosisHistory, parseTracePage, recordedModelResponse, traceKey,
  DEFAULT_TRACE_WINDOW_MS, fitTraceWindow, latestTraceWindow, spanDuration, spanMatches, stackTimelineItems, traceDuration, type SessionTraceSpan,
} from './session-diagnosis.ts'

function span(overrides: Partial<SessionTraceSpan> = {}): SessionTraceSpan {
  return { id: 1, traceId: 'trace-a', spanId: 'span-a', name: 'agent.chat', startTime: 1000, endTime: 2000, live: false, attributes: {}, events: [], ...overrides }
}

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
