import assert from 'node:assert/strict'
import test from 'node:test'
import { inlineYieldDecisions, decisionStatusLabel, parseDecisionRecords } from './yield-history.ts'
import { groupToolActivity, type ToolActivityMessage } from './tool-activity.ts'
import type { YieldRequest } from '../../src/sessions/yield-contract.ts'

const args = { question: 'May we increase the experiment budget?', options: ['Allow six runs', 'Keep four runs'], default_option: 'Keep four runs' }
const call = (id = 'ask'): ToolActivityMessage => ({
  event: 'tool_call', content: '', toolCallId: id, toolCall: { name: 'ask', arguments: args },
})
const receipt = (fields = {}) => ({
  requestId: 'request-1', option: 'Keep four runs', answeredBy: 'user', answeredAt: '2026-09-21T10:00:00Z', ...fields,
})
const result = (value: unknown, id = 'ask'): ToolActivityMessage => ({
  event: 'tool_result', content: JSON.stringify(value), toolCallId: id,
})
const pending: YieldRequest = {
  id: 'request-1', sessionId: 'web:owner', question: args.question,
  options: ['Allow six runs', 'Keep four runs'], defaultOption: args.default_option,
  recipient: { kind: 'user', sessionId: 'web:owner' }, createdAt: '2026-09-21T09:59:00Z', deadline: null,
}

test('a revised answer receipt displays the question actually answered, even before journal history loads', () => {
  const revisedQuestion = { question: 'Cap retries instead?', options: ['Cap', 'Stop'], defaultOption: 'Stop' }
  const entry = inlineYieldDecisions([call(), result(receipt({ requestId: 'revised', option: 'Cap', revisedQuestion }))]).entries.get(0)!
  assert.equal(entry.question, revisedQuestion.question)
  assert.deepEqual(entry.options, revisedQuestion.options)
  assert.equal(entry.status, 'user')
  assert.equal(entry.requestId, 'revised')
})

test('yield records separate human, parent, timeout and custom answers from generic tool activity', () => {
  for (const answeredBy of ['user', 'parent', 'timeout']) {
    const messages = [call(), { content: 'Other output' }, result(receipt({ answeredBy }))]
    const decisions = inlineYieldDecisions(messages)
    assert.equal(decisions.entries.get(0)?.status, answeredBy)
    assert.equal(decisions.entries.get(0)?.answer?.option, args.default_option)
    assert.deepEqual([...decisions.excluded], [0, 2])
    assert.equal(groupToolActivity(messages, decisions.excluded).size, 0)
  }
  const custom = inlineYieldDecisions([call(), result(receipt({ option: 'Investigate the retry cap first', custom: true }))])
  assert.equal(custom.entries.get(0)?.answer?.custom, true)
  assert.match(decisionStatusLabel('timeout'), /timeout/)
  assert.notEqual(decisionStatusLabel('timeout'), decisionStatusLabel('user'))
})

test('only an authoritative pending request marks a decision as waiting', () => {
  assert.equal(inlineYieldDecisions([call()]).entries.get(0)?.status, 'unknown')
  const decisions = inlineYieldDecisions([call()], pending)
  assert.equal(decisions.entries.size, 1)
  assert.equal(decisions.entries.get(0)?.status, 'waiting-user')
  assert.equal(decisions.entries.get(0)?.timestamp, pending.createdAt)
  assert.equal(inlineYieldDecisions([call()], {
    ...pending, recipient: { kind: 'parent', sessionId: 'web:parent' },
  }).entries.get(0)?.status, 'waiting-parent')
})

test('non-approval receipts remain closed before journal loads and obsolete premises preserve old answers', () => {
  for (const disposition of ['investigation', 'deferred', 'invalidated']) {
    const continuation = { requestId: pending.id, approved: false, disposition,
      reason: 'Inspect the existing pipeline first.', blocked: ['Scope expansion'], unaffected: ['Read existing docs'] }
    const view = inlineYieldDecisions([call(), result(continuation)], pending)
    assert.equal(view.entries.size, 1)
    assert.equal(view.entries.get(0)?.status, disposition)
    assert.equal(view.entries.get(0)?.answer, undefined)
    assert.equal(inlineYieldDecisions([call(), result({ ...continuation, ...receipt() })]).entries.get(0)?.status, 'unknown')
  }
  const reference = { sessionId: pending.sessionId, physicalId: 'segment', requestId: pending.id }
  const records = parseDecisionRecords([{ request: { ...pending, origin: { physicalId: 'segment', toolCallId: 'ask' } },
    answer: receipt(), invalidated: { reference, at: pending.createdAt, reason: 'Premise disproven' } }])
  const view = inlineYieldDecisions([call()], pending, records)
  assert.equal(view.entries.size, 1)
  assert.equal(view.entries.get(0)?.status, 'invalidated')
  assert.equal(view.entries.get(0)?.answer?.option, args.default_option)
})

test('pending decisions remain visible before the tool call loads and never attach to an older different question', () => {
  assert.equal(inlineYieldDecisions([], pending).entries.get(0)?.status, 'waiting-user')
  const changed = { ...pending, question: 'A new question' }
  const decisions = inlineYieldDecisions([call()], changed)
  assert.equal(decisions.entries.get(0)?.status, 'unknown')
  assert.equal(decisions.entries.get(1)?.question, changed.question)
  const repeated = inlineYieldDecisions([call('old'), call('current')], pending)
  assert.equal(repeated.entries.get(0)?.status, 'unknown')
  assert.equal(repeated.entries.get(1)?.status, 'waiting-user')
  assert.equal(inlineYieldDecisions([call(), result(receipt())], pending).entries.size, 1, 'A stale endpoint snapshot must not duplicate a resolved request')
})

test('invalid and failed receipts remain explicit, inspectable, and never become approvals', () => {
  for (const value of [
    {}, receipt({ requestId: '' }), receipt({ answeredBy: 'agent' }), receipt({ answeredAt: 'bad' }),
    receipt({ option: 'Not offered' }), receipt({ custom: false }),
    receipt({ custom: true, answeredBy: 'parent' }), receipt({ custom: true, answeredBy: 'timeout' }),
    receipt({ option: 'Allow six runs', answeredBy: 'timeout' }),
  ]) {
    const decision = inlineYieldDecisions([call(), result(value)]).entries.get(0)!
    assert.equal(decision.status, 'unknown')
    assert.equal(decision.answer, undefined)
    assert.equal(decision.result, JSON.stringify(value))
  }
  const failed = inlineYieldDecisions([call(), {
    event: 'tool_result', toolCallId: 'ask', content: 'Error: Yield cancelled by user.',
  }]).entries.get(0)!
  assert.equal(failed.status, 'failed')
  assert.match(failed.result!, /cancelled/)
  const malformed: ToolActivityMessage = { event: 'tool_call', content: 'yield({broken)' }
  const fallback = inlineYieldDecisions([malformed])
  assert.equal(fallback.excluded.size, 0)
  assert.equal(groupToolActivity([malformed], fallback.excluded).size, 1)
})

test('legacy calls and receipts retain their pairing; parent responses require matching confirmation', () => {
  const legacy = { event: 'tool_call', content: `ask(${JSON.stringify(args)})` }
  assert.equal(inlineYieldDecisions([legacy, { event: 'tool_result', content: JSON.stringify(receipt()) }]).entries.get(0)?.status, 'user')
  const answer: ToolActivityMessage = { event: 'tool_call', content: '', toolCallId: 'answer',
    toolCall: { name: 'reply', arguments: { request_id: 'request-1', text: 'Keep four runs' } } }
  for (const fields of [{}, { answeredBy: 'parent', requestId: 'different' }, { answeredBy: 'parent', option: 'Allow six runs' }]) {
    assert.equal(inlineYieldDecisions([answer, result(receipt(fields), 'answer')]).entries.get(0)?.status, 'unknown')
  }
  assert.equal(inlineYieldDecisions([answer, result(receipt({ answeredBy: 'parent' }), 'answer')]).entries.get(0)?.status, 'parent')
  const reference = { sessionId: 'web:child', physicalId: 'child-0', requestId: 'request-1' }
  assert.deepEqual(inlineYieldDecisions([answer, result(receipt({ answeredBy: 'parent', reference }), 'answer')])
    .entries.get(0)?.sources, [reference], 'Parent answer cards retain a link to the actual child question')
  assert.equal(inlineYieldDecisions([call(), result(receipt(), 'another-call')]).entries.get(0)?.status, 'unknown')
  const threeOptions = { ...args, options: [...args.options, 'Pause'] }
  const wrapped: ToolActivityMessage = { ...call(), toolCall: { name: 'invoke_tool', arguments: { name: 'ask', args: threeOptions } } }
  const legacyDecision = inlineYieldDecisions([wrapped, result(receipt({ option: 'Pause' }))]).entries.get(0)!
  assert.deepEqual(legacyDecision.options, threeOptions.options)
  assert.equal(legacyDecision.status, 'user')
  const invalidAction: ToolActivityMessage = { ...call(), toolCall: { name: 'ask', arguments: { ...args, action: null } } }
  assert.equal(inlineYieldDecisions([invalidAction]).entries.size, 0)
})

test('journal identities restore context without restoring waits and survive repeated tool-call execution', () => {
  const sources = [{ sessionId: 'web:worker', physicalId: 'web_worker-0', requestId: 'worker-question' }]
  const request = { ...pending, origin: { physicalId: 'web_owner-0', toolCallId: 'ask' }, sources }
  const records = parseDecisionRecords([{ request }])
  const restored = inlineYieldDecisions([call()], null, records).entries.get(0)!
  assert.equal(restored.status, 'unknown')
  assert.equal(restored.requestId, pending.id)
  assert.deepEqual(restored.sources, sources)
  const answered = parseDecisionRecords([{ request, answer: receipt() }])
  assert.equal(inlineYieldDecisions([], pending, answered).entries.get(0)?.status, 'user')
  const cancelled = { request, closed: { at: pending.createdAt, reason: 'cancelled' as const, message: 'Cancelled by user' } }
  assert.equal(inlineYieldDecisions([call()], request, [cancelled]).entries.get(0)?.status, 'cancelled', 'A stale poll cannot reopen a durably closed request')
  const replacement = { ...request, id: 'replacement' }
  const decisions = inlineYieldDecisions([call()], replacement, [cancelled, { request: replacement }]).entries
  assert.equal(decisions.get(0)?.requestId, 'replacement')
  assert.equal(decisions.get(0)?.status, 'waiting-user')
  assert.equal(decisions.get(1)?.requestId, pending.id)
  assert.equal(decisions.get(1)?.status, 'cancelled')
  assert.equal(inlineYieldDecisions([], replacement, records).entries.size, 2, 'Identical text cannot merge distinct identities')
  assert.throws(() => parseDecisionRecords({}), TypeError)
})

test('proposal decisions use recorded identity rather than missing question arguments', () => {
  const request = { ...pending, origin: { physicalId: 'web_owner-0', toolCallId: 'ask' } }
  const proposal = { kind: 'decision', proposal: { key: 'work:fixture', id: 'proposal' }, brief: {} }
  for (const toolCall of [
    { name: 'ask', arguments: proposal },
    { name: 'invoke_tool', arguments: { name: 'ask', args: proposal } },
  ]) {
    const messages = [ { ...call(), toolCall }, result(receipt()), { content: 'Later conversation' } ]
    const records = parseDecisionRecords([{ request, answer: receipt() }])
    const view = inlineYieldDecisions(messages, null, records)
    assert.equal(view.entries.get(0)?.requestId, request.id)
    assert.equal(view.entries.get(0)?.question, request.question)
    assert.equal(view.entries.get(0)?.status, 'user')
    assert.equal(view.entries.size, 1)
    assert.deepEqual([...view.excluded], [0, 1])
    assert.equal(view.unlinked.length, 0)
    assert.equal(view.after.size, 0)
    const waiting = inlineYieldDecisions(messages.slice(0, 1), request)
    assert.equal(waiting.entries.get(0)?.status, 'waiting-user')
    const unavailable = inlineYieldDecisions(messages)
    assert.equal(unavailable.entries.size, 0, 'Without the generated request, do not invent a question or permission')
    assert.equal(unavailable.excluded.size, 0)
  }
})

test('unbound historical revisions stay beside their original ask, including invalidated decisions', () => {
  const request = { ...pending, origin: { physicalId: 'web_owner-0', toolCallId: 'ask' } }
  const replacement = { ...request, id: 'replacement' }
  const reference = { sessionId: request.sessionId, physicalId: request.origin.physicalId, requestId: request.id }
  const invalidated = { reference, at: request.createdAt, reason: 'The task agreement changed.' }
  const records = parseDecisionRecords([{ request, answer: receipt(), invalidated }, { request: replacement }])
  const messages = [call(), { content: 'Later conversation' }]
  const view = inlineYieldDecisions(messages, replacement, records)
  assert.equal(view.entries.get(0)?.requestId, replacement.id)
  assert.equal(view.entries.get(0)?.status, 'waiting-user')
  assert.deepEqual(view.after.get(0)?.map(([index, decision]) => [index, decision.requestId, decision.status]),
    [[2, request.id, 'invalidated']])
  assert.deepEqual(view.unlinked, [])
  assert.equal(view.after.get(0)?.[0][1].answer?.option, receipt().option)
})

test('receipt identities locate decisions without call origins but missing or ambiguous asks stay explicitly unlinked', () => {
  const records = parseDecisionRecords([{ request: { ...pending, origin: { physicalId: 'web_owner-0' } }, answer: receipt() }])
  const proposal = { ...call(), toolCall: { name: 'ask', arguments: { kind: 'decision', proposal: { key: 'work:fixture', id: 'proposal' } } } }
  assert.equal(inlineYieldDecisions([proposal, result(receipt())], null, records).entries.get(0)?.requestId, pending.id)
  const missing = inlineYieldDecisions([{ content: 'Current segment only' }], null, records)
  assert.deepEqual(missing.unlinked.map(([index, decision]) => [index, decision.requestId]), [[1, pending.id]])
  const withOrigin = parseDecisionRecords([{ request: { ...pending, origin: { physicalId: 'web_owner-0', toolCallId: 'ask' } } }])
  const ambiguous = inlineYieldDecisions([proposal, proposal], null, withOrigin)
  assert.equal(ambiguous.unlinked.length, 1)
  assert.equal(ambiguous.after.size, 0)
  const resolved = inlineYieldDecisions([proposal, { ...proposal, toolCallId: 'another' }, result(receipt())], null, withOrigin)
  assert.equal(resolved.entries.get(0)?.requestId, pending.id)
})
