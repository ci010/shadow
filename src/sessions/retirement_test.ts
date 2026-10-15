import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readFile, writeFile, symlink, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { Bus } from '../bus/bus.ts'
import { ContextBuilder } from '../agent/context/builder.ts'
import { IdentityManager } from '../agent/identity.ts'
import { BackgroundTaskManager } from '../agent/background-task.ts'
import { AgentTypesManager } from '../agent/types/manager.ts'
import { EventService } from '../events/service.ts'
import { Tools } from '../tools/registry.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { sessionWorkspacePath } from '../utils/paths.ts'
import type { LLMProvider } from '../providers/provider.ts'
import { HandoffManager } from './handoff/manager.ts'
import { SessionManager } from './session-manager.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import { physicalSessionId } from './session-identity.ts'
import type { SessionState, SessionStore } from './session-store.ts'
import { inside, inspectDrafts, safeDeliveryName, SessionRetirement } from './retirement.ts'
import { retirementConfigSchema } from './retirement-contract.ts'
import { Hono } from 'hono'
import { registerRetirementRoutes } from './retirement-routes.ts'

const id = 'web:chat-retirement-fixture'
const old = new Date(Date.now() - 6 * 86_400_000).toISOString()
const llm = { model: 'fixture', contextWindow: 128_000, temperature: 0 }
const receipt = { retiredAt: new Date().toISOString(), fingerprint: 'a'.repeat(64), assessorSessionId: 'retirement:fixture', reason: 'Verified completed' }
const completed = { outcome: 'complete', reason: 'No remaining work or useful knowledge', knowledge: 'none', knowledgeFiles: [], files: [] }

async function fixture(workspace: string, store: SessionStore, answer: () => Promise<unknown> = async () => completed) {
  await store.init()
  const state: SessionState = { sessionId: id, segmentIndex: 0, physicalIdVersion: 2,
    projectId: 'default', mode: 'session', executionStatus: 'completed', lastUserMessageAt: old,
    lastActivityAt: new Date().toISOString() }
  await store.saveState(id, state)
  await store.createSessionLog(physicalSessionId(state), [{ role: 'user', content: 'Done task', timestamp: old },
    { role: 'assistant', content: 'Finished', timestamp: new Date().toISOString() }])
  const provider: LLMProvider = {
    name: 'fixture', listModels: () => ['fixture'],
    async chat(_messages, tools) {
      assert.equal(tools?.length ?? 0, 0, 'Closeout assessment must not have executable tools')
      return { content: JSON.stringify(await answer()), toolCalls: [] }
    },
  }
  const bus = new Bus()
  const agentTypes = new AgentTypesManager(workspace)
  await agentTypes.load()
  const context = new ContextBuilder(workspace)
  context.register({ name: 'role', getPromptSection: ctx => ctx.agent.prompt })
  const events = new EventService(workspace, bus, (key, input) => sessions.deliver(key, input))
  const backgroundTasks = new BackgroundTaskManager(bus, events)
  const sessions: SessionManager = new SessionManager({
    workspace, projectId: 'default', store, bus, provider, agentTypes, context,
    tools: new Tools(workspace), events, backgroundTasks, identity: new IdentityManager(workspace, 'default'),
    handoffManager: new HandoffManager(provider, llm.contextWindow, { autoHandoff: false }, workspace, store),
    getLlmRuntimeConfig: () => llm,
  })
  await sessions.start()
  return { sessions, state: sessions.getSessionState(id)!, async close() {
    await sessions.stop(); await backgroundTasks.stop(); await events.stop(); store.close?.()
  } }
}

test('retirement is opt-in with a validated five-day default', () => {
  assert.deepEqual(retirementConfigSchema.parse({}), { enabled: false, inactivityDays: 5 })
  assert.throws(() => retirementConfigSchema.parse({ inactivityDays: 0 }))
})

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: recent assistant activity does not reset human inactivity; stale proposals blocked`, async () => {
    await withTempWorkspace(async workspace => {
      const store = new Store(join(workspace, 'sessions'))
      const f = await fixture(workspace, store)
      try {
        const snapshot = await f.sessions.retirementSnapshot(id, 5)
        assert.ok(snapshot)
        f.state.lastUserMessageAt = new Date().toISOString()
        assert.equal(await f.sessions.retirementSnapshot(id, 5), null)
        await assert.rejects(f.sessions.retireSession(id, snapshot.fingerprint, 5, { ...receipt, fingerprint: snapshot.fingerprint }, async () => {}), /Stale/)
        f.state.lastUserMessageAt = old
        await store.appendRawEvents(physicalSessionId(f.state), [{ role: 'assistant', content: 'changed', timestamp: old }])
        await assert.rejects(f.sessions.retireSession(id, snapshot.fingerprint, 5, { ...receipt, fingerprint: snapshot.fingerprint }, async () => {}), /Stale/)
      } finally { await f.close() }
    })
  })

  test(`${Store.name}: recoverable retirement survives reload and restore, retaining logs`, async () => {
    await withTempWorkspace(async workspace => {
      const store = new Store(join(workspace, 'sessions'))
      const f = await fixture(workspace, store)
      try {
        const snapshot = (await f.sessions.retirementSnapshot(id, 5))!
        await f.sessions.retireSession(id, snapshot.fingerprint, 5, { ...receipt, fingerprint: snapshot.fingerprint }, async () => {})
        assert.equal(f.sessions.listSessions().some(state => state.sessionId === id), false)
        assert.equal(f.sessions.listRetiredSessions().length, 1)
        assert.equal((await store.getState(id))?.retirement?.reason, receipt.reason)
        assert.equal(await store.countSessionLog(physicalSessionId(f.state)), 2)
        await f.sessions.restoreRetiredSession(id)
        assert.equal((await store.getState(id))?.retirement, undefined)
        assert.ok(f.sessions.listSessions().some(state => state.sessionId === id))
      } finally { await f.close() }
    })
  })
}

test('active/waiting/recovery/lineage/system/remote sessions and unknown legacy timing are protected', async () => {
  await withTempWorkspace(async workspace => {
    const f = await fixture(workspace, new JsonlSessionStore(join(workspace, 'sessions')))
    try {
      for (const patch of [
        { executionStatus: 'running' }, { executionStatus: 'waiting' }, { executionStatus: 'pending' },
        { recovery: { id: 'pending', reason: 'interrupted' } }, { initiativeId: 'work' },
        { parentSessionId: 'web:other' }, { sessionKind: 'orchestrator' }, { lastUserMessageAt: undefined },
        { sessionId: 'system:fixture' },
        { workdir: { version: 1, nodeId: 'remote', capabilityId: 'opaque' } },
      ]) {
        const original = structuredClone(f.state)
        Object.assign(f.state, patch)
        assert.equal(await f.sessions.retirementSnapshot(id, 5), null, JSON.stringify(patch))
        for (const key of Object.keys(f.state)) delete (f.state as unknown as Record<string, unknown>)[key]
        Object.assign(f.state, original)
      }
    } finally { await f.close() }
  })
})

test('agent assessment blocks unresolved work; cron gates suppress assessment', async () => {
  await withTempWorkspace(async workspace => {
    let assessed = 0
    const f = await fixture(workspace, new JsonlSessionStore(join(workspace, 'sessions')), async () => {
      assessed++
      return { ...completed, outcome: 'blocked', reason: 'Unfinished user request' }
    })
    let protectedByCron = true
    const service = new SessionRetirement({ sessions: f.sessions, workspace,
      config: () => ({ enabled: true }), protected: () => protectedByCron, folderPath: () => undefined })
    try {
      await service.scan()
      assert.equal(assessed, 0)
      protectedByCron = false
      await service.scan()
      assert.equal(assessed, 1)
      assert.match(service.status.results[0]?.status ?? '', /Unfinished user request/)
      assert.equal(f.state.retirement, undefined)
    } finally { await service.stop(); await f.close() }
  })
})

test('draft inventory rejects traversal and linked paths; safe copies are verified and never overwritten', async () => {
  await withTempWorkspace(async workspace => {
    const root = sessionWorkspacePath(workspace, id)
    const destination = join(workspace, '..', `${workspace.split(/[\\/]/).at(-1)}-delivery`)
    // This explicitly-created sibling simulates a selected user Folder outside Project Home.
    await mkdir(destination)
    await mkdir(root, { recursive: true })
    await writeFile(join(root, 'result.txt'), 'valuable output')
    const output = join(destination, 'result.txt')
    const f = await fixture(workspace, new JsonlSessionStore(join(workspace, 'sessions')), async () => ({
      ...completed, files: [{ source: 'result.txt', destination: output }],
    }))
    const service = new SessionRetirement({ sessions: f.sessions, workspace, config: () => ({ enabled: true }),
      protected: () => false, folderPath: () => destination })
    try {
      assert.equal(inside(root, join(root, '..', 'escape')), false)
      assert.equal(inside(root, join(root, 'result.txt')), true)
      for (const name of ['CON.txt', 'result.txt:stream', '../escape', 'trailing.', 'LPT1.md']) assert.equal(safeDeliveryName(name), false)
      await writeFile(output, 'existing file')
      await service.scan()
      assert.equal(await readFile(output, 'utf8'), 'existing file')
      assert.equal(f.sessions.getSessionState(id)?.retirement, undefined)
      await rm(output)
      await service.scan()
      assert.equal(await readFile(output, 'utf8'), 'valuable output')
      assert.ok(f.sessions.getSessionState(id)?.retirement)
      assert.equal(await readFile(join(root, 'result.txt'), 'utf8'), 'valuable output')
      try {
        await symlink(destination, join(root, 'linked'), 'junction')
        await assert.rejects(inspectDrafts(root), /Linked/)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EPERM') throw error
      }
    } finally { await service.stop(); await f.close(); await rm(destination, { recursive: true }) }
  })

})

test('selective knowledge is saved as discoverable wiki, not compaction; API requires authorization', async () => {
    await withTempWorkspace(async workspace => {
      const f = await fixture(workspace, new JsonlSessionStore(join(workspace, 'sessions')), async () => ({
        ...completed, knowledge: 'preserve',
        knowledgeEntries: [{ name: 'fixture-topic.md', content: '# Fixture topic\n\nA useful verified fact. Source: web:chat-retirement-fixture.' }],
      }))
      const service = new SessionRetirement({ sessions: f.sessions, workspace,
        config: () => ({ enabled: true }), protected: () => false, folderPath: () => undefined })
      let authorized = false
      const app = new Hono()
      registerRetirementRoutes(app, { sessions: f.sessions, retirement: service, ready: () => true, authorize: () => authorized })
      try {
        assert.equal((await app.request('/api/session-retirement')).status, 401)
        assert.equal((await app.request('/api/session-retirement/scan', { method: 'POST' })).status, 401)
        await service.scan()
        assert.ok(f.sessions.getSessionState(id)?.retirement)
        assert.match(await readFile(join(workspace, 'memory', 'retirement', 'fixture-topic.md'), 'utf8'), /useful verified fact/)
        assert.equal((await f.sessions.listHistorySessions()).some(state => state.sessionId === id), false)
        authorized = true
        const status = await app.request('/api/session-retirement')
        assert.equal(status.status, 200)
        assert.equal((await status.json()).recentlyDeleted.length, 1)
        assert.equal((await app.request('/api/session-retirement/restore', {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: id }),
        })).status, 200)
        assert.equal(f.sessions.getSessionState(id)?.retirement, undefined)
      } finally { await service.stop(); await f.close() }
    })
  })

test('a cron/activity change while the agent assesses blocks retirement', async () => {
    await withTempWorkspace(async workspace => {
      let blocked = false
      const f = await fixture(workspace, new JsonlSessionStore(join(workspace, 'sessions')), async () => {
        blocked = true
        return completed
      })
      const service = new SessionRetirement({ sessions: f.sessions, workspace,
        config: () => ({ enabled: true }), protected: () => blocked, folderPath: () => undefined })
      try {
        await service.scan()
        assert.equal(f.sessions.getSessionState(id)?.retirement, undefined)
        assert.match(service.status.results[0]?.status ?? '', /gates changed/)
      } finally { await service.stop(); await f.close() }
    })
  })

test('human admission updates timing and restores; automated delivery cannot reopen retirement', async () => {
    await withTempWorkspace(async workspace => {
      const f = await fixture(workspace, new JsonlSessionStore(join(workspace, 'sessions')))
      try {
        const snapshot = (await f.sessions.retirementSnapshot(id, 5))!
        await f.sessions.retireSession(id, snapshot.fingerprint, 5, { ...receipt, fingerprint: snapshot.fingerprint }, async () => {})
        await assert.rejects(f.sessions.deliver(id, {
          id: 'event', kind: 'message', content: 'automation', policy: 'queue', timestamp: new Date().toISOString(),
          source: { kind: 'event', eventId: 'event', source: 'test', type: 'test' },
        }), /retired/)
        await f.sessions.dispatch({
          channel: 'web', chatId: id.slice(4), senderId: 'owner', admin: true,
          messageId: 'human', timestamp: old, content: 'New user request',
        }, llm)
        assert.equal(f.sessions.getSessionState(id)?.retirement, undefined)
        assert.ok(Date.parse(f.sessions.getSessionState(id)!.lastUserMessageAt!) > Date.now() - 5000)
        assert.equal(await f.sessions.retirementSnapshot(id, 5), null)
      } finally { await f.close() }
    })
})

test('legacy timing uses human decision events, never synthetic role=user or assistant activity', async () => {
await withTempWorkspace(async workspace => {
  const store = new JsonlSessionStore(join(workspace, 'sessions'))
  const f = await fixture(workspace, store)
  try {
    delete f.state.lastUserMessageAt
    assert.equal(await f.sessions.retirementSnapshot(id, 5), null)
    await store.appendRawEvents(physicalSessionId(f.state), [
      { decision_input: { id: 'human-old', text: 'task', at: old } },
      { role: 'user', content: 'system event', timestamp: new Date().toISOString() },
    ])
    assert.ok(await f.sessions.retirementSnapshot(id, 5))
    await store.appendRawEvents(physicalSessionId(f.state), [{
      decision_input: { id: 'human-recent', text: 'new task', at: new Date().toISOString() },
    }])
    assert.equal(await f.sessions.retirementSnapshot(id, 5), null)
  } finally { await f.close() }
})
})

test('continuation must name an existing durable same-Project session explicitly present in source history', async () => {
await withTempWorkspace(async workspace => {
  const store = new JsonlSessionStore(join(workspace, 'sessions'))
  const target = 'web:chat-continuation'
  const f = await fixture(workspace, store, async () => ({
    ...completed, outcome: 'continued', continuationSessionId: target,
  }))
  const service = new SessionRetirement({ sessions: f.sessions, workspace,
    config: () => ({ enabled: true }), protected: () => false, folderPath: () => undefined })
  try {
    await service.scan()
    assert.equal(f.sessions.getSessionState(id)?.retirement, undefined)
    assert.match(service.status.results[0]?.status ?? '', /Unverified continuation/)
    await f.sessions.buildSession(target, undefined, { agentType: 'general', mode: 'session' })
    await store.appendRawEvents(physicalSessionId(f.sessions.getSessionState(target)!), [{
      role: 'user', content: `Continue the remaining task from ${id}. Context: fixture task.`, timestamp: old,
    }])
    await store.appendRawEvents(physicalSessionId(f.state), [{
      role: 'assistant', content: `The remaining work explicitly continues in ${target}.`, timestamp: old,
    }])
    await service.scan()
    assert.ok(f.sessions.getSessionState(id)?.retirement)
    assert.ok(f.sessions.getSessionState(target))
  } finally { await service.stop(); await f.close() }
})
})
