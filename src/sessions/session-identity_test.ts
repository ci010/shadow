import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { mkdir } from 'node:fs/promises'
import { Bus } from '../bus/bus.ts'
import { channelSessionId } from '../bus/events.ts'
import { ContextBuilder } from '../agent/context/builder.ts'
import { IdentityManager } from '../agent/identity.ts'
import { BackgroundTaskManager } from '../agent/background-task.ts'
import { AgentTypesManager } from '../agent/types/manager.ts'
import { EventService } from '../events/service.ts'
import { Tools } from '../tools/registry.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { newPhysicalSessionId } from '../utils/paths.ts'
import type { ChatMessage, LLMProvider } from '../providers/provider.ts'
import { HandoffManager } from './handoff/manager.ts'
import { SessionManager } from './session-manager.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import { physicalSessionId, SessionIdentityError } from './session-identity.ts'
import type { SessionState, SessionStore } from './session-store.ts'
import type { SessionTurnFact } from './input.ts'
import { sessionsApiPlugin } from './routes.ts'
import { Hono } from 'hono'

const projectId = '11111111-1111-4111-8111-111111111111'
const botInstanceId = '22222222-2222-4222-8222-222222222222'
const address = (conversationId: string) => ({ projectId, botInstanceId, platform: 'qq', conversationId })
const direct = channelSessionId(address('c2c:PRIVATE_USER'))
const group = channelSessionId(address('group:PUBLIC_GROUP'))
const llm = { model: 'fixture', contextWindow: 128_000, temperature: 0 }

test('versioned physical IDs retain the complete bot address and survive lossy filename normalization', () => {
  assert.equal(newPhysicalSessionId(direct, 0, 1), newPhysicalSessionId(group, 0, 1), 'Reproduce the legacy DM/group collision')
  assert.notEqual(newPhysicalSessionId(direct, 0), newPhysicalSessionId(group, 0))
  const ids = [direct, group, channelSessionId(address('group:SECOND_GROUP')), 'web:a:b', 'web:a_b']
  const physical = ids.flatMap(sessionId => [0, 1].map(segmentIndex =>
    physicalSessionId({ sessionId, segmentIndex, physicalIdVersion: 2 })))
  assert.equal(new Set(physical).size, ids.length * 2)
  for (const id of physical) assert.match(id, /^[a-zA-Z0-9_-]+-v2-[a-f0-9]{64}-[01]$/)
  assert.equal(physicalSessionId({ sessionId: direct, segmentIndex: 0 }), newPhysicalSessionId(direct, 0, 1))
})

test('JSONL deletion tolerates missing files but does not hide filesystem failures', async () => {
  await withTempWorkspace(async workspace => {
    const directory = join(workspace, 'sessions')
    const store = new JsonlSessionStore(directory)
    await store.init()
    await store.deleteState('web:missing')
    await store.deleteSessionLog('missing-0')
    await mkdir(join(directory, 'web_blocked.json'))
    await mkdir(join(directory, 'blocked-0.jsonl'))
    await assert.rejects(store.deleteState('web:blocked'))
    await assert.rejects(store.deleteSessionLog('blocked-0'))
  })
})

function fixture(workspace: string, store: SessionStore) {
  const calls: ChatMessage[][] = []
  const provider: LLMProvider = {
    name: 'fixture', listModels: () => ['fixture'],
    async chat(messages) { calls.push(structuredClone(messages)); return { content: 'Synthetic answer', toolCalls: [] } },
  }
  const bus = new Bus()
  const agentTypes = new AgentTypesManager(workspace)
  agentTypes.setWorkspaceType('general', { name: 'general', description: '', prompt: '', source: 'workspace', defaultMode: 'session' })
  const events = new EventService(workspace, bus, (id, input) => sessions.deliver(id, input))
  const backgroundTasks = new BackgroundTaskManager(bus, events)
  const sessions: SessionManager = new SessionManager({
    workspace, projectId, store, bus, provider,
    identity: new IdentityManager(workspace, projectId), events, backgroundTasks, agentTypes,
    tools: new Tools(workspace), context: new ContextBuilder(workspace),
    handoffManager: new HandoffManager(provider, llm.contextWindow, { autoHandoff: false }, workspace, store),
    getLlmRuntimeConfig: () => llm,
  })
  async function send(conversationId: string, content: string) {
    const messageId = crypto.randomUUID()
    const finished = Promise.withResolvers<SessionTurnFact>()
    const subscription = bus.on('session.turn.finished', fact => {
      if (fact.inputId === messageId) finished.resolve(fact)
    })
    try {
      await sessions.dispatch({
        channel: 'qq', chatId: conversationId, channelAddress: address(conversationId),
        senderId: 'synthetic-user', messageId, timestamp: new Date().toISOString(), content,
        isGroup: conversationId.startsWith('group:'),
      }, llm)
      const fact = await finished.promise
      assert.equal(fact.status, 'completed', fact.error)
    } finally { bus.off(subscription) }
  }
  async function close() { await sessions.stop(); await backgroundTasks.stop(); await events.stop() }
  return { sessions, calls, send, close }
}

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: same-bot private and group histories, provider inputs and deletion remain isolated across restart`, { timeout: 15000 }, async () => {
    await withTempWorkspace(async workspace => {
      const directory = join(workspace, 'sessions')
      let store: SessionStore = new Store(directory)
      await store.init()
      let f = fixture(workspace, store)
      try {
        await f.sessions.start()
        await Promise.all([f.send('c2c:PRIVATE_USER', 'DM_ONLY_ALPHA'), f.send('group:PUBLIC_GROUP', 'GROUP_ONLY_BETA')])
        const privateState = f.sessions.getSessionState(direct)!
        const groupState = f.sessions.getSessionState(group)!
        assert.equal(privateState.physicalIdVersion, 2)
        assert.equal(groupState.physicalIdVersion, 2)
        assert.notEqual(physicalSessionId(privateState), physicalSessionId(groupState))
        await f.close()
        store.close?.()
        store = new Store(directory)
        await store.init()
        f = fixture(workspace, store)
        await f.sessions.start()
        await f.send('c2c:PRIVATE_USER', 'DM_FOLLOWUP')
        await f.send('group:PUBLIC_GROUP', 'GROUP_FOLLOWUP')
        assert.match(JSON.stringify(f.calls[0]), /DM_ONLY_ALPHA/)
        assert.doesNotMatch(JSON.stringify(f.calls[0]), /GROUP_ONLY_BETA|GROUP_FOLLOWUP/)
        assert.match(JSON.stringify(f.calls[1]), /GROUP_ONLY_BETA/)
        assert.doesNotMatch(JSON.stringify(f.calls[1]), /DM_ONLY_ALPHA|DM_FOLLOWUP/)
        assert.match((await f.sessions.getFirstUserMessage(direct))!, /DM_ONLY_ALPHA/)
        assert.match((await f.sessions.getFirstUserMessage(group))!, /GROUP_ONLY_BETA/)
        const app = new Hono()
        sessionsApiPlugin(f.sessions)(app)
        const response = await app.request(`/api/sessions/${encodeURIComponent(group)}`)
        assert.equal(response.status, 200)
        const history = await response.json()
        assert.equal(history.currentPhysicalId, physicalSessionId(groupState))
        const before = await Array.fromAsync(store.readSessionLog(physicalSessionId(groupState)))
        await f.sessions.deleteSession(direct)
        assert.deepEqual(await Array.fromAsync(store.readSessionLog(physicalSessionId(groupState))), before)
        assert.match(JSON.stringify(await f.sessions.getHistory(group)), /GROUP_ONLY_BETA/)
      } finally { await f.close(); store.close?.() }
    })
  })

  test(`${Store.name}: deleting a legacy conversation preserves shared logs and recreates an isolated transcript after restart`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      try {
        const child: SessionState = {
          sessionId: 'exec:legacy-owned-child', projectId, segmentIndex: 0, physicalIdVersion: 2,
          mode: 'task', parentSessionId: group, executionStatus: 'completed',
        }
        for (const sessionId of [direct, group]) {
          await store.saveState(sessionId, {
            sessionId, projectId, segmentIndex: 0, mode: 'session',
            ...(sessionId === group ? { children: [child.sessionId] } : {}),
          })
        }
        await store.saveState(child.sessionId, child)
        await store.createSessionLog(physicalSessionId(child), [{ role: 'assistant', content: 'Child result' }])
        const logId = newPhysicalSessionId(direct, 0, 1)
        const original = [
          { previous_physical_id: null, timestamp: '2026-01-01T00:00:00Z' },
          { role: 'user', content: 'POTENTIALLY_MIXED_HISTORY', timestamp: '2026-01-01T00:00:01Z' },
        ]
        await store.createSessionLog(logId, original)
        await store.saveState('web:inherited', {
          sessionId: 'web:inherited', projectId, segmentIndex: 0, mode: 'session',
          parent: { id: channelSessionId(address('group:DELETED_GROUP')), physicalId: logId, index: 1 },
        })
        await f.sessions.start()
        assert.equal(f.sessions.getSessionState(direct)!.physicalIdVersion, undefined)
        assert.equal(f.sessions.getSessionRecovery(direct), undefined)
        assert.match(JSON.stringify(await f.sessions.getHistory(direct)), /POTENTIALLY_MIXED_HISTORY/, 'Owner inspection remains available')
        await assert.rejects(f.send('c2c:PRIVATE_USER', 'do not append'), SessionIdentityError)
        await assert.rejects(f.send('group:PUBLIC_GROUP', 'do not append'), SessionIdentityError)
        await assert.rejects(f.sessions.buildSession('web:fork', { id: group, physicalId: logId, index: 2 }), SessionIdentityError)
        await assert.rejects(f.sessions.resumeSession('web:inherited', 'unused'), SessionIdentityError)
        const app = new Hono()
        sessionsApiPlugin(f.sessions)(app)
        const resume = await app.request(`/api/sessions/${encodeURIComponent(group)}/resume`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ recoveryId: 'unused' }),
        })
        assert.equal(resume.status, 409)
        assert.equal((await resume.json()).error, 'history_conflict')
        assert.equal(f.calls.length, 0)
        assert.deepEqual(await Array.fromAsync(store.readSessionLog(logId)), original)
        const peerBefore = await store.getState(direct)
        const deletion = await app.request(`/api/sessions/${encodeURIComponent(group)}`, { method: 'DELETE' })
        assert.equal(deletion.status, 200)
        assert.deepEqual((await deletion.json()).deleted, [child.sessionId, group])
        assert.equal(await store.getState(group), null)
        assert.equal(await store.getState(child.sessionId), null)
        assert.deepEqual(await Array.fromAsync(store.readSessionLog(physicalSessionId(child))), [])
        assert.deepEqual(await store.getState(direct), peerBefore)
        assert.deepEqual(await Array.fromAsync(store.readSessionLog(logId)), original)
        assert.equal(f.sessions.getSessionState(group), null)
        await f.sessions.stop()
        await f.sessions.start()
        assert.equal(f.sessions.getSessionState(group), null)
        await f.send('group:PUBLIC_GROUP', 'NEW_INDEPENDENT_HISTORY')
        assert.equal(f.sessions.getSessionState(group)!.physicalIdVersion, 2)
        assert.notEqual(physicalSessionId(f.sessions.getSessionState(group)!), logId)
        assert.doesNotMatch(JSON.stringify(f.calls), /POTENTIALLY_MIXED_HISTORY/)
        assert.deepEqual(await Array.fromAsync(store.readSessionLog(logId)), original)
        await assert.rejects(f.send('c2c:PRIVATE_USER', 'still blocked'), SessionIdentityError)
        await f.sessions.deleteSession(direct)
        assert.deepEqual(await Array.fromAsync(store.readSessionLog(logId)), original, 'The last legacy owner cannot prove the log is safe to remove')
        await f.sessions.deleteSession('web:inherited')
        assert.deepEqual(await Array.fromAsync(store.readSessionLog(logId)), original)
      } finally { await f.close(); store.close?.() }
    })
  })

  test(`${Store.name}: failed state deletion is not acknowledged and can be retried`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      const deleteState = store.deleteState.bind(store)
      try {
        await store.saveState(group, { sessionId: group, projectId, segmentIndex: 0, mode: 'session' })
        const logId = newPhysicalSessionId(group, 0, 1)
        await store.createSessionLog(logId, [{ role: 'user', content: 'Preserve on failure' }])
        await f.sessions.start()
        store.deleteState = async () => { throw new Error('Synthetic state removal failure') }
        await assert.rejects(f.sessions.deleteSession(group), /Synthetic state removal failure/)
        assert.ok(f.sessions.getSessionState(group))
        assert.ok(await store.getState(group))
        assert.equal(await store.countSessionLog(logId), 1)
        store.deleteState = deleteState
        assert.deepEqual(await f.sessions.deleteSession(group), [group])
        assert.equal(await store.getState(group), null)
        assert.equal(await store.countSessionLog(logId), 1)
      } finally { store.deleteState = deleteState; await f.close(); store.close?.() }
    })
  })

  test(`${Store.name}: segment chains use their persisted version and legacy short histories remain readable`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const f = fixture(workspace, store)
      try {
        for (const state of [
          { sessionId: 'web:legacy', projectId, segmentIndex: 1, mode: 'session' },
          { sessionId: group, projectId, segmentIndex: 1, mode: 'session', physicalIdVersion: 2 },
        ] satisfies SessionState[]) {
          await store.saveState(state.sessionId, state)
          await store.createSessionLog(physicalSessionId(state, 0), [
            { previous_physical_id: null }, { role: 'user', content: 'Earlier user' },
            { role: 'assistant', content: null, tool_calls: [{ id: 'call-one', type: 'function', function: { name: 'read', arguments: '{}' } }] },
            { role: 'tool', content: 'Earlier receipt', tool_call_id: 'call-one' },
          ])
          await store.createSessionLog(physicalSessionId(state, 1), [
            { previous_physical_id: physicalSessionId(state, 0), summary_context: 'Continuation summary' },
            { role: 'assistant', content: 'Later answer' },
          ])
        }
        await f.sessions.start()
        for (const id of ['web:legacy', group]) {
          const history = await f.sessions.getHistory(id)
          assert.deepEqual(history.messages.map(message => [message.role, message.content]), [['user', 'Continuation summary'], ['assistant', 'Later answer']])
          const state = f.sessions.getSessionState(id)!
          const earlier = await f.sessions.getHistory(id, { physicalId: physicalSessionId(state, 0) })
          assert.deepEqual(earlier.messages.map(message => message.role), ['user', 'assistant', 'tool'])
          const details = await f.sessions.getSessionDetails(id, physicalSessionId(state, 0))
          assert.ok(details)
        }
        await f.sessions.buildSession('web:fork', { id: group, physicalId: physicalSessionId(f.sessions.getSessionState(group)!, 0), index: 4 })
        assert.deepEqual((await f.sessions.getHistory('web:fork')).messages.map(message => message.role), ['user', 'assistant', 'tool'])
      } finally { await f.close(); store.close?.() }
    })
  })

  test(`${Store.name}: unsupported physical ID metadata cannot silently become a legacy address`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      try {
        await assert.rejects(store.saveState('web:bad', {
          sessionId: 'web:bad', segmentIndex: 0,
          // @ts-expect-error Exercise the persistence boundary with invalid wire metadata.
          physicalIdVersion: 3,
        }), /physical ID version/)
      } finally { store.close?.() }
    })
  })
}
