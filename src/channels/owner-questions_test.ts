import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ownerQuestionCommand } from './owner-questions.ts'
import { YieldManager } from '../sessions/yield.ts'
import { InputRequests } from '../sessions/input-requests.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import type { SessionState } from '../sessions/session-store.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { BotInstance } from './bot-store.ts'
import type { InboundMessage } from '../bus/events.ts'

function fixture() {
  const states: Record<string, SessionState> = Object.fromEntries(['web:root', 'virtual:root', 'virtual:child', 'web:other'].map(sessionId =>
    [sessionId, { sessionId, segmentIndex: 0, projectId: sessionId === 'web:other' ? 'other' : 'p', mode: 'session',
      ...(sessionId === 'virtual:child' ? { createdBySessionId: 'web:root' } : {}) }]))
  const yields = new YieldManager({ getState: id => states[id], getPolicy: () => ({ timeoutMs: null }),
    notifyUser: async () => {}, notifyParent: async () => {} })
  const inputs = new InputRequests({ getState: id => states[id], assertAccess: () => {}, hasDecision: id => !!yields.get(id),
    timeout: () => null, changed: () => {}, write: async () => {}, notify: async () => {} })
  const manager = { listSessions: () => Object.values(states), getSessionState: (id: string) => states[id], yields, inputs } as unknown as SessionManager
  const bot = { id: 'b', projectId: 'p', platform: 'qq', purpose: 'personal', enabled: true,
    verifiedOwner: { senderId: 'owner', chatId: 'dm', verifiedAt: 'now' } } as BotInstance
  const address = { projectId: 'p', botInstanceId: 'b', platform: 'qq', conversationId: 'dm' }
  const message = { channel: 'qq', senderId: 'owner', chatId: 'dm', isGroup: false, content: '/shadow-requests' } as InboundMessage
  const command = (content: string) => ownerQuestionCommand(manager, bot, { ...message, content }, address)
  return { states, manager, yields, inputs, bot, address, message, command }
}

test('verified direct owner discovers exact context and answers original decision once', async () => {
  const f = fixture()
  const waiting = f.yields.ask('web:root', { question: 'Proceed?', options: ['Yes', 'No'], defaultOption: 'No' }, new AbortController().signal)
  const request = f.yields.get('web:root')!
  const listing = await f.command('/shadow-requests')
  assert.match(listing!, /Proceed\?/)
  assert.match(listing!, new RegExp(request.id))
  await assert.rejects(f.command(`/shadow-reply ${request.id} yes`), /exactly match/)
  await f.command(`/shadow-reply ${request.id} Yes`)
  assert.equal((await waiting).option, 'Yes')
  assert.equal(f.yields.get('web:root'), null)
  await assert.rejects(f.command(`/shadow-reply ${request.id} Yes`), /no longer pending/)
})

test('input remains information and cancelled/stale ids cannot be answered', async () => {
  const f = fixture()
  const controller = new AbortController()
  const waiting = f.inputs.ask('Which path?', { sessionId: 'virtual:root', signal: controller.signal } as ExecutionContext)
  await new Promise(resolve => setImmediate(resolve))
  const id = f.inputs.get('virtual:root')!.id
  await f.command(`/shadow-reply ${id} some input`)
  assert.equal((await waiting).text, 'some input')
  await assert.rejects(f.command(`/shadow-reply ${id} more`), /no longer pending/)
  const cancelled = f.inputs.ask('Again?', { sessionId: 'virtual:root', signal: controller.signal } as ExecutionContext)
  void cancelled.catch(() => {})
  await new Promise(resolve => setImmediate(resolve))
  const staleId = f.inputs.get('virtual:root')!.id
  controller.abort()
  await assert.rejects(cancelled)
  await assert.rejects(f.command(`/shadow-reply ${staleId} answer`), /no longer pending/)
})

test('rejects non-owner, groups, service bots, forged bot messages and cross-project addresses', async () => {
  const f = fixture()
  for (const patch of [{ senderId: 'stranger' }, { isGroup: true }, { chatId: 'elsewhere' }, { displayMetadata: { author: { bot: true } } }]) {
    await assert.rejects(ownerQuestionCommand(f.manager, f.bot, { ...f.message, ...patch }, f.address), /Verified QQ/)
  }
  await assert.rejects(ownerQuestionCommand(f.manager, { ...f.bot, purpose: 'service' }, f.message, f.address), /Verified QQ/)
  await assert.rejects(ownerQuestionCommand(f.manager, f.bot, f.message, { ...f.address, projectId: 'other' }), /Verified QQ/)
})

test('does not expose or answer internal roots or another Project requests', async () => {
  const f = fixture()
  for (const id of ['virtual:child', 'web:other']) {
    const waiting = f.yields.ask(id, { question: 'Private?', options: ['A', 'B'], defaultOption: 'B' }, new AbortController().signal)
    void waiting.catch(() => {})
    const request = f.yields.get(id)!
    assert.doesNotMatch((await f.command('/shadow-requests'))!, new RegExp(request.id))
    await assert.rejects(f.command(`/shadow-reply ${request.id} A`), /not eligible/)
    f.yields.cancelSession(id)
    await assert.rejects(waiting)
  }
})


test('delegated, task, automated and channel-bound roots cannot borrow owner authority', async () => {
  for (const patch of [{ mode: 'task' as const }, { automation: { id: 'auto' } },
    { parentSessionId: 'web:root', parent: { id: 'web:root' } }, { channelBoundary: {} }]) {
    const f = fixture()
    f.states['virtual:root'] = { ...f.states['virtual:root'], ...patch } as SessionState
    const waiting = f.yields.ask('virtual:root', { question: 'Private?', options: ['A', 'B'], defaultOption: 'B' }, new AbortController().signal)
    void waiting.catch(() => {})
    const request = f.yields.get('virtual:root')!
    assert.doesNotMatch((await f.command('/shadow-requests'))!, new RegExp(request.id))
    await assert.rejects(f.command(`/shadow-reply ${request.id} A`), /not eligible/)
    f.yields.cancelSession('virtual:root')
    await assert.rejects(waiting)
  }
})

test('concurrent human replies settle only once and lineage changes revoke eligibility', async () => {
  const f = fixture()
  const waiting = f.yields.ask('web:root', { question: 'Choose?', options: ['A', 'B'], defaultOption: 'B' }, new AbortController().signal)
  const id = f.yields.get('web:root')!.id
  const results = await Promise.allSettled([f.command(`/shadow-reply ${id} A`), f.command(`/shadow-reply ${id} B`)])
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1)
  assert.equal((await waiting).option, 'A')
  const next = f.yields.ask('web:root', { question: 'Next?', options: ['A', 'B'], defaultOption: 'B' }, new AbortController().signal)
  void next.catch(() => {})
  const nextId = f.yields.get('web:root')!.id
  f.states['web:root']!.createdBySessionId = 'agent'
  await assert.rejects(f.command(`/shadow-reply ${nextId} A`), /not eligible/)
  f.yields.cancelSession('web:root')
  await assert.rejects(next)
})
