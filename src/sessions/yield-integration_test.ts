import { ReplyTool } from '../tools/reply.ts'
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { decisionBrief } from '../testing/decision.ts'
import { setTimeout as delay } from 'node:timers/promises'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import { ContextBuilder } from '../agent/context/builder.ts'
import { HandoffManager } from './handoff/manager.ts'
import { Tools } from '../tools/registry.ts'
import { AskTool } from '../tools/ask.ts'
import { ToolsSchema } from '../config/schema.ts'
import { createConfigCommand } from '../slash-commands/handlers/config.ts'
import { createReplyCommand } from '../slash-commands/handlers/reply.ts'
import type { SlashCommandContext } from '../slash-commands/index.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import type { ChatMessage, LLMProvider, LLMResponse } from '../providers/provider.ts'
import { SessionManager, type SessionManagerDeps } from './session-manager.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import { sessionsApiPlugin } from './routes.ts'
import type { AcceptedSessionInput, SessionMessageInput, SessionTurnFact } from './input.ts'
import type { SessionStore } from './session-store.ts'
import type { YieldPolicy } from './yield-contract.ts'
import { channelMessageInput } from './input.ts'
import type { OutboundMessage } from '../bus/events.ts'

const question = { question: 'Which approach?', options: ['Continue', 'Change approach', 'Stop'], default_option: 'Continue' }
const llm = { model: 'fixture', contextWindow: 128_000, temperature: 0 }
const done = (): LLMResponse => ({ content: 'Finished', toolCalls: [] })
const ask = (input = question, brief = decisionBrief): LLMResponse => ({ content: '', toolCalls: [{ id: 'ask-call', name: 'ask', arguments: { kind: 'decision', ...input, brief } }] })
const message = (id: string): SessionMessageInput => ({
  kind: 'message', id, content: 'Start', timestamp: new Date().toISOString(), policy: 'queue',
  source: { kind: 'event', eventId: id, type: 'test', source: 'fixture' },
})
async function waitFor(predicate: () => boolean) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    assert.ok(Date.now() < deadline, 'Timed out waiting for yield integration')
    await delay(2)
  }
}

function fixture(workspace: string, store: SessionStore, deliverYield?: (message: OutboundMessage) => Promise<void>) {
  const calls: Array<{ sessionId: string; messages: ChatMessage[]; toolCount: number; resolve: (response: LLMResponse) => void }> = []
  const provider: LLMProvider = {
    name: 'fixture', listModels: () => ['fixture'],
    async chat(messages, _tools, options) {
      const pending = Promise.withResolvers<LLMResponse>()
      const signal = options?.signal
      assert.ok(signal)
      const abort = () => pending.reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      calls.push({ sessionId: String(messages[0]?.content).split('\n')[0], messages: structuredClone(messages), toolCount: _tools?.length ?? 0, resolve: pending.resolve })
      try { signal.throwIfAborted(); return await pending.promise }
      finally { signal.removeEventListener('abort', abort) }
    },
  }
  const bus = new Bus()
  const facts: SessionTurnFact[] = []
  const outbound: string[] = []
  const accepted: AcceptedSessionInput[] = []
  bus.on('session.turn.finished', fact => { facts.push(fact) })
  bus.on('message.outbound', event => { outbound.push(event.content) })
  bus.on('session.input.accepted', event => { accepted.push(event) })
  const tools = new Tools(workspace)
  const context = new ContextBuilder(workspace)
  context.register({ name: 'fixture', getPromptSection: ctx => ctx.sessionId })
  let globalPolicy: YieldPolicy = { timeoutMs: null }
  const sessions = new SessionManager({
    workspace, store, bus, provider, tools, context,
    handoffManager: new HandoffManager(provider, llm.contextWindow, { autoHandoff: false }, workspace, store),
    getLlmRuntimeConfig: () => llm,
    getYieldPolicy: () => globalPolicy,
    deliverYield,
    agentTypes: {
      resolve: (name: string) => ({
        name, description: '', prompt: '', source: 'builtin', defaultMode: name === 'ephemeral' ? 'task' : 'session',
        ...(name === 'blocked' ? { allowedTools: ['read', 'subagent'] } : {}),
      }),
    },
    events: { emit: async () => {} },
  } as unknown as SessionManagerDeps)
  tools.register(new AskTool(sessions.yields, sessions.inputs))
  tools.register(new ReplyTool(sessions.yields, sessions.inputs))
  const app = new Hono()
  sessionsApiPlugin(sessions)(app)
  return { sessions, app, calls, facts, outbound, accepted, tools, setGlobal: (policy: YieldPolicy) => { globalPolicy = policy } }
}

async function answer(app: Hono, sessionId: string, requestId: string, option: string) {
  return app.request(`/api/sessions/${encodeURIComponent(sessionId)}/ask`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId, option }),
  })
}

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: ordinary input uses the request route and preserves paired tool history without decision records`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      try {
        await f.sessions.start()
        await f.sessions.buildSession('web:input', undefined, { agentType: 'general' })
        await f.sessions.buildSession('web:other', undefined, { agentType: 'general' })
        await f.sessions.deliver('web:input', message('input-turn'))
        await waitFor(() => f.calls.length === 1)
        f.calls[0].resolve({ content: '', toolCalls: [
          { id: 'input-call', name: 'ask', arguments: { kind: 'input', question: 'Which path?' } },
        ] })
        await waitFor(() => !!f.sessions.inputs.get('web:input'))
        const { request } = await (await f.app.request('/api/sessions/web:input/ask')).json()
        assert.equal(request.kind, 'input')
        assert.equal(f.sessions.yields.get('web:input'), null)
        const send = (id: string, text: unknown) => f.app.request(`/api/sessions/${id}/ask`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: request.id, text }),
        })
        await f.sessions.inputs.settled()
        assert.equal((await send('web:other', 'not yours')).status, 403)
        assert.equal((await send('web:input', '')).status, 400)
        const answered = await send('web:input', 'fixture-path')
        assert.equal(answered.status, 200)
        assert.equal((await answered.json()).answer.text, 'fixture-path')
        await waitFor(() => f.calls.length === 2)
        assert.equal(JSON.parse(String(f.calls[1].messages.find(message => message.tool_call_id === 'input-call')?.content)).text, 'fixture-path')
        f.calls[1].resolve(done())
        await waitFor(() => f.facts.length === 1)
        const history = await f.sessions.getHistory('web:input', { shallow: true })
        assert.ok(history.messages.some(message => message.role === 'tool' && String(message.content).includes('fixture-path')))
        assert.deepEqual(await f.sessions.getYieldRecords('web:input'), [])
        assert.equal((await f.app.request('/api/sessions/web:input/yield')).status, 404)
      } finally { await f.sessions.stop(); await store.close?.() }
    })
  })

  test(`${Store.name}: reporting ownership and non-answer follow-up use normal session execution without granting peer answer rights`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      try {
        await f.sessions.start()
        await f.sessions.prepareCommandSession('web:coordinator')
        await f.sessions.prepareCommandSession('web:worker')
        const owner = await f.app.request('/api/sessions/web%3Aworker/decisions/owner', { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ reportingSessionId: 'web:coordinator' }) })
        assert.equal(owner.status, 200)
        assert.equal((await store.getState('web:worker'))?.decisionOwnerSessionId, 'web:coordinator')
        const goal = "Run fresh Off/On using Herman's existing grader pipeline, within four runs."
        await f.sessions.deliver('web:worker', channelMessageInput({ channel: 'web', chatId: 'worker', senderId: 'alice',
          messageId: 'scoped-work', content: goal, timestamp: new Date().toISOString(), isGroup: false }))
        await waitFor(() => f.calls.length === 1)
        const evidence = (await f.sessions.decisionContext('web:worker')).userInputs[0]!
        assert.equal(evidence.quote, goal)
        f.calls[0]!.resolve(ask(question, { ...decisionBrief, claims: [
          { kind: 'user_constraint', text: goal, evidence }, { kind: 'proposal', text: 'Consider a v6 adapter, only if no existing path works.' },
        ] }))
        await waitFor(() => !!f.sessions.yields.get('web:worker'))
        await waitFor(() => f.calls.length === 2)
        const request = f.sessions.yields.get('web:worker')!
        assert.equal(request.reportingSessionId, 'web:coordinator')
        assert.deepEqual(request.recipient, { kind: 'user', sessionId: 'web:worker' })
        assert.match(JSON.stringify(f.calls[1]!.messages), /human-selected reporting owner/)
        assert.match(JSON.stringify(f.calls[1]!.messages), /user_constraint/)
        assert.equal((await f.sessions.decisionContext('web:coordinator')).userInputs.length, 0, 'Session reports never become human-input evidence')
        assert.throws(() => f.sessions.yields.answerParent('web:coordinator', request.id, 'Continue'), /stored parent/)
        f.calls[1]!.resolve(done())
        const response = await f.app.request('/api/sessions/web%3Aworker/ask/follow-up', { method: 'POST',
          headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: request.id, kind: 'investigation', reason: 'Check the existing pipeline instead of expanding scope.' }) })
        assert.equal(response.status, 200)
        assert.equal((await response.json()).continuation.approved, false)
        await waitFor(() => f.calls.length === 3)
        const result = JSON.parse(String(f.calls[2]!.messages.find(item => item.tool_call_id === 'ask-call')?.content))
        assert.equal(result.disposition, 'investigation')
        assert.equal(result.option, undefined)
        assert.deepEqual(result.unaffected, decisionBrief.unaffected)
        f.calls[2]!.resolve(done())
        await waitFor(() => f.facts.some(fact => fact.sessionId === 'web:worker'))
        await f.sessions.stop()
        await f.sessions.start()
        await f.sessions.deliver('web:worker', message('continue-independent'))
        await waitFor(() => f.calls.length === 4)
        assert.match(String(f.calls[3]!.messages[0]?.content), /Recorded decision restrictions/)
        assert.match(String(f.calls[3]!.messages[0]?.content), /investigation/)
        f.calls[3]!.resolve(done())
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  for (const operation of ['stop', 'delete'] as const) test(`${Store.name}: ${operation} aborts and drains a running explanation without resuming its owner`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      try {
        await f.sessions.start()
        await f.sessions.deliver('web:review-stop', message('review-stop'))
        await waitFor(() => f.calls.length === 1)
        f.calls[0]!.resolve(ask())
        await waitFor(() => !!f.sessions.yields.get('web:review-stop'))
        const request = f.sessions.yields.get('web:review-stop')!
        const review = await f.sessions.yieldDiscussions.start('web:review-stop', request.id, randomUUID(), 'clarify', 'Explain')
        await waitFor(() => f.calls.length === 2)
        if (operation === 'stop') {
          await f.sessions.stop()
          assert.equal((await f.sessions.yieldDiscussions.read(review.reference))[0]?.status, 'failed')
          assert.equal((await f.sessions.getYieldRecords('web:review-stop'))[0]?.answer, undefined)
        } else {
          const deleted = await f.sessions.deleteSession('web:review-stop')
          assert.ok(deleted.includes(review.sessionId), 'Owner deletion also removes its drained explanation trace')
          assert.equal(f.sessions.getSessionState(review.sessionId), null)
        }
        assert.equal(f.sessions.yieldDiscussions.active, false)
        assert.equal(f.calls.length, 2)
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: HTTP discussions use a tool-free session while the original tool waits for the revised answer`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      try {
        await f.sessions.start()
        await f.sessions.deliver('web:review', message('review-input'))
        await waitFor(() => f.calls.length === 1)
        f.calls[0]!.resolve(ask())
        await waitFor(() => !!f.sessions.yields.get('web:review'))
        const original = f.sessions.yields.get('web:review')!
        const post = (kind: string, requestId = original.id) => f.app.request('/api/sessions/web%3Areview/ask/reviews', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id: randomUUID(), requestId, kind, question: 'Explain the original constraint and remove the expansion assumption.' }),
        })
        const response = await post('clarify')
        assert.equal(response.status, 202)
        const review = (await response.json()).review
        await waitFor(() => f.calls.length === 2)
        assert.equal(f.calls[1]!.toolCount, 0)
        assert.match(String(f.calls[1]!.messages[0]!.content), /Neither clarification nor revision is approval/)
        f.calls[1]!.resolve({ content: '', toolCalls: [{ id: 'not-available', name: 'reply', arguments: { request_id: original.id, text: 'Continue' } }] })
        await waitFor(() => f.calls.length === 3)
        assert.equal(f.sessions.yields.get('web:review')?.id, original.id)
        assert.equal(f.calls[2]!.toolCount, 0)
        f.calls[2]!.resolve({ content: 'The expansion was an agent suggestion, not a user requirement.', toolCalls: [] })
        await waitFor(() => !f.sessions.yieldDiscussions.active)
        const history = await f.app.request(`/api/sessions/web%3Areview/decisions/reviews?physicalId=${encodeURIComponent(review.reference.physicalId)}&requestId=${original.id}`)
        assert.equal(history.status, 200)
        assert.equal((await history.json()).reviews[0].status, 'completed')
        assert.equal(f.calls.length, 3, 'Explanation must not resume the original model')
        assert.equal(f.sessions.yields.get('web:review')?.timeoutPaused, true)
        assert.equal((await post('revise')).status, 202)
        await waitFor(() => f.calls.length === 4)
        assert.match(JSON.stringify(f.calls[3]!.messages), /The expansion was an agent suggestion, not a user requirement/,
          'Follow-up discussion must retain the earlier explanation without treating it as user instruction')
        f.calls[3]!.resolve({ content: JSON.stringify({ question: 'Keep the existing budget?', options: ['Keep it', 'Stop'], brief: decisionBrief,
          defaultOption: 'Stop', explanation: 'Removed the unsupported assumption.' }), toolCalls: [] })
        await waitFor(() => !f.sessions.yieldDiscussions.active)
        const revised = f.sessions.yields.get('web:review')!
        assert.notEqual(revised.id, original.id)
        assert.equal((await answer(f.app, 'web:review', original.id, 'Continue')).status, 404)
        assert.equal((await answer(f.app, 'web:review', revised.id, 'Keep it')).status, 200)
        await waitFor(() => f.calls.length === 5)
        const result = f.calls[4]!.messages.find(item => item.tool_call_id === 'ask-call')
        assert.equal(JSON.parse(String(result?.content)).revisedQuestion.question, 'Keep the existing budget?')
        f.calls[4]!.resolve(done())
        await waitFor(() => f.facts.some(fact => fact.sessionId === 'web:review'))
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: custom HTTP and channel replies resume and persist the same tool call`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      const customText = 'A different approach\nwith a focused check.'
      try {
        await f.sessions.start()
        await f.sessions.deliver('web:custom', message('custom-input'))
        await waitFor(() => f.calls.length === 1)
        f.calls[0]!.resolve(ask({ question: 'Continue?', options: ['Yes', 'No'], default_option: 'No' }))
        await waitFor(() => !!f.sessions.yields.get('web:custom'))
        const requestId = f.sessions.yields.get('web:custom')!.id
        const post = (body: unknown) => f.app.request('/api/sessions/web:custom/ask', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })
        for (const body of [
          { requestId }, { requestId, customText: '' }, { requestId, customText: ' \n ' },
          { requestId, customText: 'x'.repeat(4001) }, { requestId, customText: 1 },
          { requestId, customText, option: 'Yes' }, { requestId, customText, unknown: true },
          { requestId, customText, option: null }, { requestId, option: 'Yes', customText: null },
        ]) assert.equal((await post(body)).status, 400)
        assert.equal(f.sessions.yields.get('web:custom')?.id, requestId)
        const response = await post({ requestId, customText: `  ${customText}  ` })
        assert.equal(response.status, 200)
        const receipt = (await response.json()).answer
        assert.equal(receipt.option, customText)
        assert.equal(receipt.custom, true)
        assert.equal(receipt.answeredBy, 'user')
        assert.equal((await post({ requestId, customText })).status, 404)
        await waitFor(() => f.calls.length === 2)
        const results = f.calls[1]!.messages.filter(item => item.tool_call_id === 'ask-call')
        assert.equal(results.length, 1)
        assert.deepEqual(JSON.parse(String(results[0]!.content)), receipt)
        f.calls[1]!.resolve(done())
        await waitFor(() => f.facts.length === 1)

        const msg = { channel: 'qq', chatId: 'room', senderId: 'alice', content: 'Start', messageId: 'custom-channel', timestamp: new Date().toISOString(), isGroup: true }
        await f.sessions.deliver('qq:room', channelMessageInput(msg))
        await waitFor(() => f.calls.length === 3)
        f.calls[2]!.resolve(ask({ question: 'Continue?', options: ['Yes', 'No'], default_option: 'No' }))
        await waitFor(() => !!f.sessions.yields.get('qq:room'))
        const channelId = f.sessions.yields.get('qq:room')!.id
        const command = createReplyCommand(f.sessions)
        const ctx: SlashCommandContext = { sessionId: 'qq:room', msg, admin: false, llm }
        assert.match(f.outbound.at(-1)!, /text <your response>/)
        assert.match(await command.execute({ ...ctx, msg: { ...msg, senderId: 'bob' } }, `${channelId} text ${customText}`), /Only the user/)
        assert.match(await command.execute(ctx, `${channelId} text`), /1 to 4000/)
        assert.equal(await command.execute(ctx, `${channelId} text ${customText}`), `Answered: ${customText}`)
        await waitFor(() => f.calls.length === 4)
        const channelResult = f.calls[3]!.messages.find(item => item.tool_call_id === 'ask-call')!
        assert.equal(JSON.parse(String(channelResult.content)).option, customText)
        assert.equal(JSON.parse(String(channelResult.content)).custom, true)
        f.calls[3]!.resolve(done())
        await waitFor(() => f.facts.length === 2)
      } finally { await f.sessions.stop(); store.close?.() }
      const reopened: SessionStore = new Store(join(workspace, 'sessions'))
      await reopened.init()
      const restored = fixture(workspace, reopened)
      try {
        await restored.sessions.start()
        for (const sessionId of ['web:custom', 'qq:room']) {
          const history = await restored.sessions.getHistory(sessionId)
          const results = history.messages.filter(item => item.tool_call_id === 'ask-call')
          assert.equal(results.length, 1)
          assert.equal(JSON.parse(String(results[0]!.content)).option, customText)
          assert.equal(JSON.parse(String(results[0]!.content)).custom, true)
        }
      } finally { await restored.sessions.stop(); reopened.close?.() }
    })
  })

  test(`${Store.name}: binary channel turns preserve decision sender, paired history and structured delivery`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const deliveries: OutboundMessage[] = []
      const f = fixture(workspace, store, async message => { deliveries.push(message) })
      const msg = {
        channel: 'discord', chatId: 'room', senderId: 'alice', content: 'Start',
        messageId: 'human-input', timestamp: new Date().toISOString(), isGroup: true,
      }
      try {
        await f.sessions.start()
        await f.sessions.deliver('discord:room', channelMessageInput(msg))
        await waitFor(() => f.calls.length === 1)
        f.calls[0]!.resolve(ask({ question: 'Continue?', options: ['Yes', 'No'], default_option: 'No' }))
        await waitFor(() => deliveries.length === 1)
        const request = f.sessions.yields.get('discord:room')!
        assert.equal(deliveries[0]?.yieldRequest?.id, request.id)
        assert.equal(deliveries[0]?.done, true)
        assert.match(deliveries[0]!.content, /<1\|2\|cancel>/)
        const command = createReplyCommand(f.sessions)
        const ctx: SlashCommandContext = { sessionId: 'discord:room', msg, admin: false, llm }
        assert.match(await command.execute({ ...ctx, msg: { ...msg, senderId: 'bob' } }, `${request.id} 1`), /Only the user/)
        assert.match(await command.execute(ctx, `${request.id} 3`), /choose one of the options/)
        assert.match(await command.execute(ctx, `${request.id} 2`), /Selected: No/)
        await waitFor(() => f.calls.length === 2)
        f.calls[1]!.resolve(done())
        await waitFor(() => f.facts.length === 1)
        const history = await f.sessions.getHistory('discord:room')
        const results = history.messages.filter(item => item.tool_call_id === 'ask-call')
        assert.equal(results.length, 1)
        assert.equal(JSON.parse(String(results[0]?.content)).option, 'No')
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: root yield blocks the loop, HTTP answers resume the same paired tool call`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      try {
        await f.sessions.start()
        await f.sessions.buildSession('web:root')
        f.setGlobal({ timeoutMs: 20 })
        await f.sessions.applySessionConfigPatch('web:root', { set: { yield: { timeoutMs: null } }, unset: [] })
        await f.sessions.deliver('web:root', message('root-input'))
        await waitFor(() => f.calls.length === 1)
        f.calls[0]!.resolve(ask())
        await waitFor(() => !!f.sessions.yields.get('web:root'))
        const request = f.sessions.yields.get('web:root')!
        assert.equal(request.origin?.toolCallId, 'ask-call')
        assert.deepEqual(await (await f.app.request('/api/sessions/web:root/decisions')).json(), { records: [{ request }] })
        assert.equal((await f.app.request('/api/sessions/web:root/decisions?physicalId=foreign-segment')).status, 404)
        await delay(35)
        assert.equal(f.calls.length, 1, 'Explicit infinite session policy overrides a finite global default')
        assert.equal(request.deadline, null)
        assert.deepEqual(await (await f.app.request('/api/sessions/web:root/ask')).json(), { request })
        assert.deepEqual(await (await f.app.request('/api/sessions/web:root/stage')).json(), { stage: 'waiting' })
        assert.equal((await answer(f.app, 'web:root', request.id, 'invalid')).status, 400)
        assert.equal(f.sessions.yields.get('web:root')?.id, request.id)
        assert.equal((await answer(f.app, 'web:root', request.id, 'Change approach')).status, 200)
        const recorded = (await (await f.app.request('/api/sessions/web:root/decisions')).json()).records
        assert.equal(recorded[0]?.answer?.option, 'Change approach', 'HTTP success includes a durable answer even before the ordinary tool receipt')
        assert.deepEqual(recorded[0]?.answer?.reference, {
          sessionId: request.sessionId, physicalId: request.origin!.physicalId, requestId: request.id,
        }, 'Resolved decisions supply a complete reference for later escalation')
        assert.equal((await answer(f.app, 'web:root', request.id, 'Stop')).status, 404)
        await waitFor(() => f.calls.length === 2)
        const result = f.calls[1]!.messages.find(item => item.role === 'tool' && item.tool_call_id === 'ask-call')
        assert.ok(result)
        assert.equal(JSON.parse(String(result.content)).option, 'Change approach')
        assert.equal(JSON.parse(String(result.content)).answeredBy, 'user')
        f.calls[1]!.resolve(done())
        await waitFor(() => f.facts.length === 1)
        assert.equal(f.facts[0]?.status, 'completed')
        const history = await f.sessions.getHistory('web:root')
        assert.equal(history.messages.filter(item => item.tool_call_id === 'ask-call').length, 1)
      } finally { await f.sessions.stop(); store.close?.() }
      const reopened: SessionStore = new Store(join(workspace, 'sessions'))
      await reopened.init()
      try { assert.deepEqual((await reopened.getState('web:root'))?.config?.yield, { timeoutMs: null }) }
      finally { reopened.close?.() }
    })
  })

  test(`${Store.name}: ephemeral child asks its actual parent, not reportTo, and resumes after unified-tool answer`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      try {
        await f.sessions.start()
        await f.sessions.buildSession('web:parent')
        await f.sessions.buildSession('web:verifier')
        await f.sessions.buildSession('virtual:child', { id: 'web:parent' }, { agentType: 'ephemeral', reportTo: 'web:verifier' })
        await f.sessions.deliver('virtual:child', message('child-input'))
        await waitFor(() => f.calls.length === 1)
        f.calls[0]!.resolve(ask())
        await waitFor(() => f.calls.length === 2)
        const request = f.sessions.yields.get('virtual:child')!
        assert.deepEqual(request.recipient, { kind: 'parent', sessionId: 'web:parent' })
        assert.equal(f.calls[1]?.sessionId, 'web:parent')
        assert.equal((await answer(f.app, 'virtual:child', request.id, 'Continue')).status, 403)
        assert.equal((await f.app.request('/api/sessions/virtual:child/ask', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ requestId: request.id, customText: 'Not the parent' }),
        })).status, 403)
        f.calls[1]!.resolve({
          content: '', toolCalls: [{ id: 'answer-call', name: 'reply', arguments: { request_id: request.id, text: 'Change approach',
          } }],
        })
        await waitFor(() => f.calls.length === 4)
        const child = f.calls.slice(2).find(call => call.sessionId === 'virtual:child')!
        assert.ok(child)
        const result = child.messages.find(item => item.tool_call_id === 'ask-call')!
        assert.equal(JSON.parse(String(result.content)).answeredBy, 'parent')
        assert.equal(JSON.parse(String(result.content)).option, 'Change approach')
        for (const call of f.calls.slice(2)) call.resolve(done())
        await waitFor(() => f.facts.length === 2)
        assert.equal(f.sessions.yields.get('virtual:child'), null)
        assert.ok(f.facts.every(fact => fact.status === 'completed'))
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: cancel HTTP leaves the unanswered tool pending and Continue resumes it without new context`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      try {
        await f.sessions.start()
        await f.sessions.deliver('web:root', message('cancel-input'))
        await waitFor(() => f.calls.length === 1)
        f.calls[0]!.resolve(ask())
        await waitFor(() => !!f.sessions.yields.get('web:root'))
        const request = f.sessions.yields.get('web:root')!
        const response = await f.app.request('/api/sessions/web:root/ask', {
          method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ requestId: request.id }),
        })
        assert.equal(response.status, 200)
        await waitFor(() => f.facts.length === 1)
        assert.equal(f.facts[0]?.status, 'cancelled')
        assert.equal(f.calls.length, 1)
        assert.equal(f.sessions.yields.get('web:root'), null)
        const history = await f.sessions.getHistory('web:root')
        const results = history.messages.filter(item => item.tool_call_id === 'ask-call')
        assert.equal(results.length, 0, 'An unanswered question has no tool result')
        assert.equal(history.messages.filter(item => item.role === 'assistant' && item.tool_calls?.some(call => call.id === 'ask-call')).length, 1)
        await waitFor(() => !!f.sessions.getSessionRecovery('web:root'))
        await f.sessions.resumeSession('web:root', f.sessions.getSessionRecovery('web:root')!.id)
        await waitFor(() => !!f.sessions.yields.get('web:root'))
        const resumed = f.sessions.yields.get('web:root')!
        assert.notEqual(resumed.id, request.id)
        assert.equal(f.calls.length, 1, 'Continue resumes the pending tool before another model request')
        assert.equal((await answer(f.app, 'web:root', request.id, 'Continue')).status, 404)
        assert.equal((await answer(f.app, 'web:root', resumed.id, 'Change approach')).status, 200)
        await waitFor(() => f.calls.length === 2)
        assert.deepEqual(f.calls[1].messages.map(item => item.role), ['system', 'user', 'assistant', 'tool'])
        assert.equal(f.calls[1].messages.at(-1)?.tool_call_id, 'ask-call')
        assert.equal(JSON.parse(String(f.calls[1].messages.at(-1)?.content)).option, 'Change approach')
        f.calls[1].resolve(done())
        await waitFor(() => f.facts.length === 2)
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: session policy PATCH validates atomically, persists, and unset restores global policy`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      try {
        await f.sessions.start()
        await f.sessions.buildSession('web:root')
        f.setGlobal({ timeoutMs: 90_000 })
        assert.deepEqual(f.sessions.getYieldPolicy('web:root'), { timeoutMs: 90_000 })
        const initialConfig = structuredClone(f.sessions.getSessionConfig('web:root'))
        for (const value of ['wait', {}, { timeoutMs: 0 }, { timeoutMs: -1 }, { timeoutMs: 1.5 }, { timeoutMs: '1000' }, { timeoutMs: null, extra: true }]) {
          const response = await f.app.request('/api/sessions/web:root/config', {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ yield: value }),
          })
          assert.equal(response.status, 400)
          assert.deepEqual(f.sessions.getSessionConfig('web:root'), initialConfig)
        }
        for (const value of [{ timeoutMs: null }, { timeoutMs: 1000 }, null]) {
          assert.equal((await f.app.request('/api/sessions/web:root/config', {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ yield: value }),
          })).status, 200)
          assert.deepEqual(f.sessions.getYieldPolicy('web:root'), value ?? { timeoutMs: 90_000 })
          assert.deepEqual((await store.getState('web:root'))?.config?.yield, value ?? undefined)
        }
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })
}

test('peer decision references give context without granting parent answer authority', async () => {
  await withTempWorkspace(async workspace => {
    const store = new JsonlSessionStore(join(workspace, 'sessions'))
    await store.init()
    const f = fixture(workspace, store)
    try {
      await f.sessions.start()
      for (const id of ['web:worker', 'web:coordinator']) await f.sessions.buildSession(id)
      const input = { question: question.question, options: ['Continue', 'Stop'] as [string, string], defaultOption: 'Stop' }
      const first = f.sessions.yields.ask('web:worker', input, new AbortController().signal)
      await waitFor(() => !!f.sessions.yields.get('web:worker'))
      const source = f.sessions.yields.get('web:worker')!
      const sources = [{ sessionId: source.sessionId, physicalId: source.origin!.physicalId, requestId: source.id }]
      const next = f.sessions.yields.ask('web:coordinator', { ...input, sources }, new AbortController().signal)
      await waitFor(() => !!f.sessions.yields.get('web:coordinator'))
      const coordinator = f.sessions.yields.get('web:coordinator')!
      assert.deepEqual(coordinator.recipient, { kind: 'user', sessionId: 'web:coordinator' })
      assert.throws(() => f.sessions.yields.answerParent('web:coordinator', source.id, 'Stop'), /stored parent/)
      await f.sessions.yields.answerUser('web:coordinator', coordinator.id, 'Stop')
      await next
      assert.equal(f.sessions.yields.get('web:worker')?.id, source.id, 'A linked decision is not implicitly answered')
      const cancelled = assert.rejects(first, { name: 'AbortError' })
      await f.sessions.yields.cancelUser('web:worker', source.id)
      await cancelled
      const records = await f.sessions.getYieldRecords('web:coordinator')
      assert.deepEqual(records[0]?.request.sources, sources)
      assert.equal((await f.sessions.getYieldRecords('web:worker'))[0]?.closed?.reason, 'cancelled')
    } finally { await f.sessions.stop() }
  })
})

test('yield configuration, channel commands and parent-routing edge cases', async t => {
  assert.deepEqual(ToolsSchema.parse({ yield: {} }).yield, { timeoutMs: null })
  for (const value of [{ timeoutMs: 0 }, { timeoutMs: 2_147_483_648 }, { timeoutMs: '1000' }, { timeout: 10 }]) {
    assert.throws(() => ToolsSchema.parse({ yield: value }))
  }
  await withTempWorkspace(async workspace => {
    const store = new JsonlSessionStore(join(workspace, 'sessions'))
    await store.init()
    const f = fixture(workspace, store)
    try {
      await f.sessions.start()
      const ctx: SlashCommandContext = {
        sessionId: 'discord:root', admin: true, llm,
        msg: { channel: 'discord', chatId: 'root', senderId: 'alice', messageId: 'command', content: '', timestamp: new Date().toISOString() },
      }
      const config = createConfigCommand(f.sessions)
      assert.match(await config.execute(ctx, 'set yield 1000'), /Updated/)
      assert.deepEqual(f.sessions.getYieldPolicy(ctx.sessionId), { timeoutMs: 1000 })
      await config.execute(ctx, 'set yield wait')
      assert.deepEqual(f.sessions.getYieldPolicy(ctx.sessionId), { timeoutMs: null })
      const waiting = f.sessions.yields.ask(ctx.sessionId, {
        question: question.question, options: ['Continue', 'Change approach', 'Stop'], defaultOption: 'Continue',
      }, new AbortController().signal, { channel: 'discord', senderId: 'alice' })
      await waitFor(() => !!f.sessions.yields.get(ctx.sessionId))
      const request = f.sessions.yields.get(ctx.sessionId)!
      assert.ok(f.outbound.some(content => content.includes(`/reply ${request.id}`)))
      assert.match(await createReplyCommand(f.sessions).execute(ctx, `${request.id} 2`), /Selected: Change approach/)
      assert.equal((await waiting).answeredBy, 'user')
    } finally { await f.sessions.stop() }
  })

  await t.test('child questions steer into a busy parent at the next tool boundary rather than waiting for the entire turn', async () => {
    await withTempWorkspace(async workspace => {
      const store = new JsonlSessionStore(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      const blocked = Promise.withResolvers<string>()
      let executing = false
      f.tools.register({
        name: 'block', description: 'Controlled fixture tool', parameters: { type: 'object', properties: {} },
        execute: () => { executing = true; return blocked.promise },
      })
      try {
        await f.sessions.start()
        await f.sessions.buildSession('web:parent')
        await f.sessions.buildSession('virtual:child', { id: 'web:parent' }, { agentType: 'ephemeral' })
        await f.sessions.deliver('web:parent', message('original-work'))
        await waitFor(() => f.calls.length === 1)
        f.calls[0]!.resolve({ content: '', toolCalls: [{ id: 'work-call', name: 'block', arguments: {} }] })
        await waitFor(() => executing)
        await f.sessions.deliver('virtual:child', message('child-work'))
        await waitFor(() => f.calls.length === 2)
        f.calls[1]!.resolve(ask())
        await waitFor(() => f.accepted.some(event => event.sessionId === 'web:parent' && event.input.source.kind === 'session'))
        const request = f.sessions.yields.get('virtual:child')!
        assert.equal(f.calls.length, 2, 'The parent must not run a second provider loop while its tool is active')
        blocked.resolve('Work checkpoint')
        await waitFor(() => f.calls.length === 3)
        assert.equal(f.calls[2]?.sessionId, 'web:parent')
        assert.ok(f.calls[2]!.messages.some(item => item.role === 'user' && (typeof item.content === 'string'
          ? item.content : item.content?.flatMap(part => part.type === 'text' ? [part.text] : []).join('\n'))?.includes(request.id)))
        assert.equal(f.facts.length, 0)
        f.calls[2]!.resolve({ content: '', toolCalls: [{ id: 'answer-call', name: 'reply', arguments: { request_id: request.id, text: 'Continue',
        } }] })
        await waitFor(() => f.calls.length === 5)
        for (const call of f.calls.slice(3)) call.resolve(done())
        await waitFor(() => f.facts.length === 2)
        assert.equal(f.facts.find(fact => fact.sessionId === 'web:parent')?.inputId, 'original-work')
      } finally { blocked.resolve('Stopped fixture'); await f.sessions.stop() }
    })
  })

  await t.test('a parent with yield filtered out fails explicitly instead of leaving its child waiting indefinitely', async () => {
    await withTempWorkspace(async workspace => {
      const store = new JsonlSessionStore(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      try {
        await f.sessions.start()
        await f.sessions.buildSession('web:parent', undefined, { agentType: 'blocked' })
        await f.sessions.buildSession('virtual:child', { id: 'web:parent' }, { agentType: 'ephemeral' })
        await f.sessions.deliver('virtual:child', message('blocked-parent'))
        await waitFor(() => f.calls.length === 1)
        f.calls[0]!.resolve(ask())
        await waitFor(() => f.calls.length === 2)
        assert.equal(f.calls[1]?.sessionId, 'virtual:child')
        assert.equal(f.sessions.yields.get('virtual:child'), null)
        assert.match(String(f.calls[1]?.messages.find(item => item.tool_call_id === 'ask-call')?.content), /parent.*reply.*enabled/i)
        f.calls[1]!.resolve(done())
        await waitFor(() => f.facts.length === 1)
      } finally { await f.sessions.stop() }
    })
  })

  await t.test('deleting a parent cancels an unregistered ephemeral child waiter without letting its model continue', async () => {
    await withTempWorkspace(async workspace => {
      const store = new JsonlSessionStore(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      try {
        await f.sessions.start()
        await f.sessions.buildSession('web:parent')
        await f.sessions.buildSession('virtual:child', { id: 'web:parent' }, { agentType: 'ephemeral' })
        await f.sessions.deliver('virtual:child', message('delete-parent'))
        await waitFor(() => f.calls.length === 1)
        f.calls[0]!.resolve(ask())
        await waitFor(() => f.calls.length === 2)
        await f.sessions.deleteSession('web:parent')
        await waitFor(() => f.facts.length === 2)
        assert.equal(f.sessions.yields.get('virtual:child'), null)
        assert.equal(f.facts.find(fact => fact.sessionId === 'virtual:child')?.status, 'cancelled')
        assert.equal(f.calls.length, 2)
      } finally { await f.sessions.stop() }
    })
  })
})
