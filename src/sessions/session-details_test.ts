import assert, { deepEqual, equal } from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { readdir } from 'node:fs/promises'
import { Hono } from 'hono'
import { Bus } from '../bus/bus.ts'
import { WebChannel } from '../channels/web.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { newPhysicalSessionId, sessionWorkspacePath } from '../utils/paths.ts'
import { SessionManager, type SessionManagerDeps } from './session-manager.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import type { SessionStore } from './session-store.ts'
import { sessionsApiPlugin } from './routes.ts'
import { localFolderWorkdirRef } from './locality.ts'
import { Tools } from '../tools/registry.ts'
import type { LLMProvider } from '../providers/provider.ts'
import type { NodeInventoryResponse } from '../cluster/node-inventory.ts'
import type { WorkdirCapabilityState } from './locality.ts'

function makeManager(workspace: string, store: SessionStore, overrides: Partial<SessionManagerDeps> = {}) {
  return new SessionManager({
    workspace, store, bus: new Bus(),
    agentTypes: { resolve: () => ({ name: 'general' }) },
    getLlmRuntimeConfig: () => ({ model: 'fixture', contextWindow: 999, temperature: 0 }),
    getKnownContextWindow: (model: string) => model === 'fixture' ? 8000 : null,
    workdirCapabilityLookup: (ref: { capabilityId: string }) => ref.capabilityId === 'offline'
      ? { node: 'offline' }
      : { node: 'online', capability: { kind: 'workdir', online: true, path: join(workspace, 'folder') } },
    ...overrides,
  } as unknown as SessionManagerDeps)
}

const usage = { promptTokens: 120, completionTokens: 30, totalTokens: 150 }
const earlier = { promptTokens: 40, completionTokens: 10, totalTokens: 50 }
const invalidConfigs = [
  null, [], false, 1, 'enabled',
  { model: '' }, { model: 12 }, { model: {} }, { extra: true }, { thinking: [] },
  { thinking: 'enabled' }, { thinking: {} }, { thinking: { type: 'auto' } },
  { thinking: { type: 'enabled', budget: 3 } },
  { reasoningEffort: 'unsupported' }, { reasoningEffort: false },
  { thinking: { type: 'enabled' }, reasoningEffort: 'invalid' },
]

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: details use runtime budget and actual handoff policy, not catalog limits`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      let windowTokens = 400_000
      const policy = { enabled: false, low: .6, high: .9, windowTokens: 400_000 }
      const sessions = makeManager(workspace, store, {
        getLlmRuntimeConfig: () => ({ model: 'fixture', contextWindow: windowTokens, temperature: 0 }),
        handoffManager: { getContextPolicy: () => policy } as SessionManagerDeps['handoffManager'],
      })
      try {
        await store.saveState('web:budget', { sessionId: 'web:budget', segmentIndex: 0, config: { model: 'unlisted' } })
        await store.createSessionLog(newPhysicalSessionId('web:budget', 0, 1), [{ role: 'assistant', usage }])
        await sessions.start()
        const details = await sessions.getSessionDetails('web:budget')
        equal(details?.context.windowTokens, 400_000)
        deepEqual(details?.context.handoff, policy)
        // Read the Project's current runtime config on every request.
        windowTokens = 250_000
        equal((await sessions.getSessionDetails('web:budget'))?.context.windowTokens, 250_000)
        deepEqual((await sessions.getSessionDetails('web:budget'))?.context.handoff, policy)
      } finally { await sessions.stop(); store.close?.() }
    })
  })

  for (const platform of ['qq', 'discord', 'feishu']) test(`${Store.name}: ${platform} conversation PATCH persists only selected overrides and null restores inherited settings`, async t => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const key = `bot:project-a:bot-a:${platform}:group%3Aa`
      const peer = `bot:project-a:bot-a:${platform}:group%3Ab`
      const legacy = `${platform}:legacy`
      const sessions = makeManager(workspace, store)
      try {
        await store.saveState(key, { sessionId: key, segmentIndex: 0, mode: 'session' })
        await store.saveState(peer, { sessionId: peer, segmentIndex: 0, mode: 'session' })
        await store.saveState(legacy, { sessionId: legacy, segmentIndex: 0, mode: 'session' })
        await sessions.start()
        const app = new Hono()
        sessionsApiPlugin(sessions)(app)
        const config = { model: `${platform}-override`, thinking: { type: 'enabled' }, reasoningEffort: 'high' }
        const response = await app.request(`/api/sessions/${encodeURIComponent(key)}/config`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(config),
        })
        equal(response.status, 200)
        deepEqual(await response.json(), { key, config })
        deepEqual(sessions.getSessionConfig(peer), {})
        const graph = await (await app.request('/api/sessions/graph')).json()
        for (const id of [key, peer, legacy]) {
          deepEqual(graph.sessions.find((s: { sessionId: string }) => s.sessionId === id).inferenceDefaults, { model: 'fixture', contextWindow: 999 })
        }
        const defaults = sessions.getSessionInferenceDefaults.bind(sessions)
        const unavailable = t.mock.method(sessions, 'getSessionInferenceDefaults', (id: string) => {
          if (id === key) throw new Error('Synthetic disabled binding')
          return defaults(id)
        })
        try {
          const response = await app.request('/api/sessions/graph')
          equal(response.status, 200, 'A disabled binding must not break the conversation list')
          const graph = await response.json()
          equal(graph.sessions.find((s: { sessionId: string }) => s.sessionId === key).inferenceDefaults, null)
          deepEqual(graph.sessions.find((s: { sessionId: string }) => s.sessionId === peer).inferenceDefaults, { model: 'fixture', contextWindow: 999 })
        } finally { unavailable.mock.restore() }
        await sessions.stop()
        const restarted = makeManager(workspace, store)
        try {
          await restarted.start()
          deepEqual(restarted.getSessionConfig(key), config)
          deepEqual(restarted.getSessionConfig(peer), {})
          equal(restarted.getSessionInferenceDefaults(key)?.model, 'fixture')
          const http = new Hono()
          sessionsApiPlugin(restarted)(http)
          equal((await http.request(`/api/sessions/${encodeURIComponent(key)}/config`, {
            method: 'PATCH', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model: null, thinking: null, reasoningEffort: null }),
          })).status, 200)
          deepEqual(restarted.getSessionConfig(key), {})
          equal((await store.getState(key))?.config, undefined)
        } finally { await restarted.stop() }
      } finally { await sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: committed creation, metadata, configuration and deletion invalidate the session catalog`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const bus = new Bus()
      const changed: Array<{ id: string; exists: boolean }> = []
      const sessions = makeManager(workspace, store, { bus })
      bus.on('session.changed', ({ sessionId }) => changed.push({ id: sessionId, exists: !!sessions.getSessionState(sessionId) }))
      try {
        await sessions.start()
        await sessions.buildSession('web:new')
        assert.deepEqual(changed, [{ id: 'web:new', exists: true }])
        await sessions.setSessionConfig('web:new', { model: 'fixture' })
        await sessions.unsetSessionConfig('web:new', 'model')
        await sessions.setSessionConfig('web:new', { model: 'fixture' })
        await sessions.resetSessionConfig('web:new')
        assert.equal(changed.length, 5)
        await sessions.updateConversationMetadata('web:new', { title: 'Updated', description: 'Refresh metadata' })
        assert.equal(changed.length, 6)
        await sessions.deleteSession('web:new')
        assert.deepEqual(changed.at(-1), { id: 'web:new', exists: false })
      } finally { await sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: failed metadata saves do not publish session changes`, async t => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const bus = new Bus()
      const sessions = makeManager(workspace, store, { bus })
      try {
        await sessions.start()
        await sessions.buildSession('web:one')
        let notifications = 0
        bus.on('session.changed', () => notifications++)
        const save = t.mock.method(store, 'saveState', async () => { throw new Error('synthetic disk failure') })
        try {
          await assert.rejects(sessions.setSessionConfig('web:one', { model: 'fixture' }), /synthetic disk failure/)
          await assert.rejects(sessions.updateConversationMetadata('web:one', { title: 'Updated', description: 'Discussion' }), /synthetic disk failure/)
          await assert.rejects(sessions.buildSession('web:two'), /synthetic disk failure/)
          assert.equal(notifications, 0)
        } finally { save.mock.restore() }
      } finally { await sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: rename persists display metadata without changing identity, topic or history`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const bus = new Bus()
      const renamed: string[] = []
      bus.on('session.renamed', fact => renamed.push(fact.sessionId))
      const sessions = makeManager(workspace, store, { bus })
      try {
        await store.saveState('web:rename', {
          sessionId: 'web:rename', segmentIndex: 0, mode: 'session', sessionKind: 'topic',
          topic: { title: 'Original topic', goal: 'Preserve goal', scope: 'Preserve scope' },
        })
        await store.createSessionLog(newPhysicalSessionId('web:rename', 0, 1), [
          { role: 'user', content: 'Original message' },
        ])
        await sessions.start()
        const app = new Hono()
        sessionsApiPlugin(sessions)(app)
        const patch = (body: unknown, key = 'web:rename') => app.request(`/api/sessions/${key}/name`, {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })
        const before = structuredClone(sessions.getSessionState('web:rename')!)
        equal((await patch({ name: '  Renamed conversation  ' })).status, 200)
        equal(sessions.getSessionState('web:rename')?.name, 'Renamed conversation')
        deepEqual(sessions.getSessionState('web:rename'), { ...before, name: 'Renamed conversation' })
        equal((await sessions.getSessionDetails('web:rename'))?.name, 'Renamed conversation')
        equal((await (await app.request('/api/sessions/graph')).json()).sessions[0].title, 'Renamed conversation')
        equal((await store.listSessions())[0].name, 'Renamed conversation')
        equal(sessions.listSessions()[0].name, 'Renamed conversation')
        equal(await sessions.getFirstUserMessage('web:rename'), 'Original message')
        deepEqual(renamed, ['web:rename'])
        for (const invalid of [null, [], {}, { name: '' }, { name: '  ' }, { name: 42 }, { name: null },
          { name: 'a'.repeat(121) }, { name: 'two\nlines' }, { name: 'bad\u0000name' },
          { name: 'valid', sessionId: 'web:other' }]) equal((await patch(invalid)).status, 400)
        equal((await app.request('/api/sessions/web:rename/name', { method: 'PATCH', body: '{' })).status, 400)
        equal((await patch({ name: 'No creation' }, 'web:missing')).status, 404)
        const denied = new Hono()
        sessionsApiPlugin(sessions, { authorizeRename: () => false })(denied)
        equal((await denied.request('/api/sessions/web:rename/name', { method: 'PATCH', body: '{"name":"denied"}' })).status, 401)
        deepEqual(renamed, ['web:rename'])
        await sessions.renameSession('web:rename', 'x'.repeat(120))
        await sessions.setSessionConfig('web:rename', { model: 'fixture' })
        equal((await store.getState('web:rename'))?.name, 'x'.repeat(120), 'Later metadata saves retain the name')
        await sessions.stop()
        const restarted = makeManager(workspace, store)
        await restarted.start()
        try { equal((await restarted.getSessionDetails('web:rename'))?.name, 'x'.repeat(120)) }
        finally { await restarted.stop() }
      } finally { await sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: failed rename does not publish optimistic metadata or notifications`, async t => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const bus = new Bus()
      let notifications = 0
      bus.on('session.renamed', () => notifications++)
      const sessions = makeManager(workspace, store, { bus })
      try {
        await store.saveState('web:one', { sessionId: 'web:one', segmentIndex: 0, name: 'Before' })
        await sessions.start()
        const save = t.mock.method(store, 'saveState', async () => { throw new Error('synthetic disk failure') })
        await assert.rejects(sessions.renameSession('web:one', 'After'), /synthetic disk failure/)
        equal(sessions.getSessionState('web:one')?.name, 'Before')
        equal((await store.getState('web:one'))?.name, 'Before')
        equal(notifications, 0)
        save.mock.restore()
      } finally { await sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: remote details use current registry metadata and explicit availability`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      let availability: WorkdirCapabilityState = { node: 'online', capability: { kind: 'workdir', online: true } }
      let inventory: NodeInventoryResponse = { version: 1, nodes: [{
        nodeId: 'child', displayName: 'Registered Child', role: 'child', connection: 'connected',
        capabilities: [{
          capabilityId: 'folder', kind: 'workdir', displayName: 'Registered Folder',
          displayPath: '/child/not-a-main-path', online: true,
        }],
      }] }
      try {
        const sessions = makeManager(workspace, store, {
          workdirCapabilityLookup: () => availability,
          getNodeInventory: () => inventory,
        })
        await sessions.start()
        await sessions.buildSession('web:remote', undefined, { workdir: {
          version: 1, nodeId: 'child', capabilityId: 'folder',
          displayName: 'Untrusted renderer label', displayPathSnapshot: 'Z:\\untrusted',
        } })
        deepEqual((await sessions.getSessionDetails('web:remote'))?.workdir, {
          kind: 'remote', nodeId: 'child', nodeName: 'Registered Child', displayName: 'Registered Folder',
          displayPath: '/child/not-a-main-path', available: true, availability: 'available',
        })
        inventory = { version: 1, nodes: [{
          ...inventory.nodes[0], displayName: 'Renamed Child', connection: 'offline',
          capabilities: [{ ...inventory.nodes[0].capabilities[0], displayPath: '/child/moved', online: false }],
        }] }
        availability = { node: 'offline' }
        const restarted = makeManager(workspace, store, {
          workdirCapabilityLookup: () => availability,
          getNodeInventory: () => inventory,
        })
        await restarted.start()
        deepEqual((await restarted.getSessionDetails('web:remote'))?.workdir, {
          kind: 'remote', nodeId: 'child', nodeName: 'Renamed Child', displayName: 'Registered Folder',
          displayPath: '/child/moved', available: false, availability: 'node-offline',
        })
        inventory = { version: 1, nodes: [{ ...inventory.nodes[0], connection: 'revoked', capabilities: [] }] }
        availability = { node: 'revoked' }
        deepEqual((await restarted.getSessionDetails('web:remote'))?.workdir, {
          kind: 'remote', nodeId: 'child', nodeName: 'Renamed Child', displayPath: null,
          available: false, availability: 'capability-revoked',
        })
        for (const [state, reason] of [
          [{ node: 'missing' }, 'node-missing'],
          [{ node: 'online' }, 'capability-missing'],
          [{ node: 'online', capability: { kind: 'workdir', online: false } }, 'capability-offline'],
          [{ node: 'online', capability: { kind: 'shell', online: true } }, 'incompatible'],
        ] as const) {
          availability = state
          inventory = { version: 1, nodes: [] }
          deepEqual((await restarted.getSessionDetails('web:remote'))?.workdir, {
            kind: 'remote', nodeId: 'child', displayPath: null, available: false, availability: reason,
          })
        }
      } finally {
        store.close?.()
      }
    })
  })

  test(`${Store.name}: details are read-only, preserve selected context and flag incomplete legacy usage`, async () => {
    await withTempWorkspace(async (workspace) => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      try {
        await store.saveState('web:one', { sessionId: 'web:one', segmentIndex: 1, workspaceRoot: 'web:owner' })
        await store.createSessionLog(newPhysicalSessionId('web:one', 0, 1), [
          { previous_physical_id: null },
          { role: 'user', content: '<sender name="Human"/> Actual question' },
          { role: 'assistant', content: 'old', usage: earlier },
        ])
        await store.createSessionLog(newPhysicalSessionId('web:one', 1, 1), [
          { previous_physical_id: newPhysicalSessionId('web:one', 0, 1) },
          { role: 'assistant', content: 'new', usage },
          { role: 'assistant', content: 'copied usage', usage },
          { role: 'assistant', content: 'invalid fractional usage', usage: { ...usage, promptTokens: 1.5 } },
          { role: 'tool', usage: { promptTokens: 9999 } },
        ])
        const sessions = makeManager(workspace, store)
        await sessions.start()
        const app = new Hono()
        sessionsApiPlugin(sessions)(app)
        const before = await readdir(join(workspace, 'sessions'), { recursive: true })
        for (const url of [
          '/api/sessions/web:missing/details',
          '/api/sessions/web:one/details?physicalId=web_other-0',
          '/api/sessions/web:one/details?physicalId=web_one-2',
          '/api/sessions/web:one/details?physicalId=',
        ]) equal((await app.request(url)).status, 404)
        equal(sessions.getSessionState('web:missing'), null)
        deepEqual(await readdir(join(workspace, 'sessions'), { recursive: true }), before)
        deepEqual(await (await app.request('/api/sessions/web:one/details')).json(), {
          sessionId: 'web:one', name: 'Actual question',
          workdir: { kind: 'local', displayPath: sessionWorkspacePath(workspace, 'web:owner'), nodeId: 'local', available: true, availability: 'available' },
          usage, usageScope: 'session', subagentUsage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, usageIncomplete: true,
          context: { usedTokens: 120, windowTokens: 999 },
        })

        test(`${Store.name}: total usage includes nested task/call ownership but excludes forks, peers and other projects`, async () => {
          await withTempWorkspace(async workspace => {
            const store: SessionStore = new Store(join(workspace, 'sessions'))
            await store.init()
            const states = [
              { sessionId: 'web:owner', mode: 'session' as const, segmentIndex: 1 },
              { sessionId: 'task', mode: 'task' as const, parentSessionId: 'web:owner', segmentIndex: 0 },
              { sessionId: 'call', mode: 'call' as const, parentSessionId: 'task', segmentIndex: 0 },
              { sessionId: 'fork', mode: 'session' as const, parentSessionId: 'web:owner', segmentIndex: 0 },
              { sessionId: 'peer', mode: 'task' as const, parentSessionId: null, segmentIndex: 0 },
              { sessionId: 'foreign', mode: 'call' as const, parentSessionId: 'web:owner', segmentIndex: 0, projectId: 'elsewhere' },
            ]
            const sessions = makeManager(workspace, store)
            try {
              for (const state of states) {
                await store.saveState(state.sessionId, state)
                for (let segment = 0; segment <= state.segmentIndex; segment++) {
                  await store.createSessionLog(newPhysicalSessionId(state.sessionId, segment, 1), [
                    { type: 'model_usage', sessionId: state.sessionId, id: `${state.sessionId}-${segment}`, usage },
                    { role: 'assistant', usage },
                  ])
                }
              }
              await sessions.start()
              const details = await sessions.getSessionDetails('web:owner', newPhysicalSessionId('web:owner', 0, 1))
              deepEqual(details?.usage, { promptTokens: 480, completionTokens: 120, totalTokens: 600 })
              deepEqual(details?.subagentUsage, { promptTokens: 240, completionTokens: 60, totalTokens: 300 })
              equal(details?.usageIncomplete, false)
              equal(details?.context.usedTokens, 120)
              await sessions.stop()
              const restarted = makeManager(workspace, store)
              await restarted.start()
              try { deepEqual((await restarted.getSessionDetails('web:owner'))?.usage, details?.usage) }
              finally { await restarted.stop() }
            } finally { await sessions.stop(); store.close?.() }
          })
        })
        const segment = await sessions.getSessionDetails('web:one', newPhysicalSessionId('web:one', 0, 1))
        deepEqual(segment?.usage, usage)
        equal(segment?.context.usedTokens, 40)
        for (const [id, workdir, expected] of [
          ['folder', localFolderWorkdirRef('p'), { kind: 'local', displayPath: join(workspace, 'folder'), nodeId: 'local', available: true, availability: 'available' }],
          ['remote', { version: 1 as const, nodeId: 'child', capabilityId: 'p', displayPathSnapshot: '/opaque/child/path' },
            { kind: 'remote', displayPath: null, nodeId: 'child', available: true, availability: 'available' }],
          ['unknown-remote', { version: 1 as const, nodeId: 'child', capabilityId: 'p' },
            { kind: 'remote', displayPath: null, nodeId: 'child', available: true, availability: 'available' }],
          ['offline-remote', { version: 1 as const, nodeId: 'child', capabilityId: 'offline', displayPathSnapshot: 'Z:\\offline' },
            { kind: 'remote', displayPath: null, nodeId: 'child', available: false, availability: 'node-offline' }],
          ['offline-local', { version: 1 as const, nodeId: 'local', capabilityId: 'offline', displayPathSnapshot: 'Z:\\untrusted' },
            { kind: 'local', displayPath: null, nodeId: 'local', available: false, availability: 'node-offline' }],
        ] as const) {
          await sessions.buildSession(id, undefined, { workdir })
          await sessions.setSessionConfig(id, { model: 'unlisted' })
          const details = await sessions.getSessionDetails(id)
          deepEqual(details?.workdir, expected)
          equal(details?.name, null)
          equal(details?.usage, null)
          deepEqual(details?.context, { usedTokens: null, windowTokens: 999 })
        }
      } finally {
        store.close?.()
      }
    })
  })

  test(`${Store.name}: send validates before mutation and persists settings before admission`, async () => {
    await withTempWorkspace(async (workspace) => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const sessions = makeManager(workspace, store)
      await sessions.start()
      const app = new Hono()
      sessionsApiPlugin(sessions)(app)
      const channel = new WebChannel(new Bus(), { workspace, sessionManager: sessions })
      const admitted: Array<unknown> = []
      channel.setReceiver(async (message) => {
        const id = `web:${message.chatId}`
        admitted.push({ config: structuredClone(sessions.getSessionConfig(id)), retry: message.retry })
        deepEqual((await store.getState(id))?.config ?? {}, JSON.parse(JSON.stringify(sessions.getSessionConfig(id))))
        return { status: 'accepted', sessionId: id, inputId: message.messageId }
      })
      await channel.start(app)
      const send = (body: unknown) => app.request('/api/chat/send', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      try {
        for (const config of invalidConfigs) {
          equal((await send({ chatId: 'draft', content: 'hi', parentChatId: 'parent', config })).status, 400)
          equal(sessions.getSessionState('web:draft'), null)
        }
        for (const body of [null, [], true, 3]) equal((await send(body)).status, 400)
        for (const field of [
          { chatId: 7 }, { content: [] }, { media: [7] }, { retry: 'true' },
          { parentSessionId: {} }, { forkAt: -1 }, { stream: 'false' },
        ]) {
          equal((await send({ chatId: 'invalid-envelope', content: 'hi', config: { reasoningEffort: 'high' }, ...field })).status, 400)
          equal(sessions.getSessionState('web:invalid-envelope'), null)
        }
        equal((await app.request('/api/chat/send', { method: 'POST', body: '{' })).status, 400)
        equal((await send({
          chatId: 'retired-stream', content: 'must not admit', stream: true,
          parentChatId: 'parent', config: { reasoningEffort: 'high' },
        })).status, 410)
        equal(sessions.getSessionState('web:retired-stream'), null)
        equal(admitted.length, 0)
        const config = { model: 'other', thinking: { type: 'disabled' }, reasoningEffort: 'max' }
        equal((await send({ chatId: 'draft', content: 'hi', stream: false, config })).status, 200)
        deepEqual(sessions.getSessionConfig('web:draft'), config)
        const restarted = makeManager(workspace, store)
        await restarted.start()
        deepEqual(restarted.getSessionConfig('web:draft'), config)
        equal((await send({
          chatId: 'draft', retry: true, stream: false,
          config: { model: null, thinking: null, reasoningEffort: null },
        })).status, 200)
        deepEqual(sessions.getSessionConfig('web:draft'), {})
        equal(admitted.length, 2)
        const patch = (body: unknown) => app.request('/api/sessions/web:draft/config', {
          method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        })
        for (const body of invalidConfigs) {
          equal((await patch(body)).status, 400)
          deepEqual(sessions.getSessionConfig('web:draft'), {})
        }
        equal((await patch({ model: 'fixture', thinking: { type: 'enabled' }, reasoningEffort: 'high' })).status, 200)
        equal((await patch({ model: null, thinking: null, reasoningEffort: null })).status, 200)
        deepEqual((await store.getState('web:draft'))?.config ?? {}, {})
        await sessions.buildSession('web:parent', undefined, { folderId: 'p', workdir: localFolderWorkdirRef('p') })
        equal((await send({ chatId: 'child', content: 'fork', parentChatId: 'parent', forkAt: 2, stream: false, config })).status, 200)
        const child = sessions.getSessionState('web:child')
        equal(child?.folderId, 'p')
        deepEqual(child?.parent, { id: 'web:parent', index: 2 })
        deepEqual(child?.workdir, localFolderWorkdirRef('p'))
        equal((await send({ chatId: 'legacy', content: 'unchanged', stream: false })).status, 200)
        equal(sessions.getSessionState('web:legacy'), null)
        const count = admitted.length
        const saveState = store.saveState.bind(store)
        store.saveState = async () => { throw new Error('fixture config failure') }
        equal((await send({ chatId: 'draft', content: 'must not admit', stream: false, config })).status, 500)
        equal(admitted.length, count)
        deepEqual(sessions.getSessionConfig('web:draft'), {})
        store.saveState = saveState
        const response = await send({ chatId: 'draft', content: 'Default JSON admission', config })
        equal(response.status, 200)
        assert(response.headers.get('Content-Type')?.includes('application/json'))
        const receipt = await response.json()
        equal(receipt.chatId, 'draft')
        equal(typeof receipt.requestId, 'string')
      } finally {
        await channel.stop()
        store.close?.()
      }
    })
  })

  test(`${Store.name}: first-send settings reach the provider and usage survives restart`, async () => {
    await withTempWorkspace(async (workspace) => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      const calls: Array<Parameters<LLMProvider['chat']>[2]> = []
      const sessions = makeManager(workspace, store, {
        handoffManager: { shouldHandoff: () => false } as unknown as SessionManagerDeps['handoffManager'],
        tools: new Tools(workspace),
        context: { buildSystemPrompt: async () => 'Synthetic context' } as unknown as SessionManagerDeps['context'],
        agentTypes: {
          resolve: () => ({ name: 'general', description: '', prompt: '', defaultMode: 'session', source: 'builtin' }),
        } as unknown as SessionManagerDeps['agentTypes'],
        provider: {
          name: 'fixture', listModels: () => ['fixture'],
          chat: async (_messages, _tools, request) => {
            calls.push(request)
            return { content: 'answer', toolCalls: [], usage }
          },
        },
      })
      await sessions.start()
      const channel = new WebChannel(new Bus(), { workspace, sessionManager: sessions })
      channel.setReceiver(async (message) => {
        await sessions.dispatch(message, {
          model: 'fixture', contextWindow: 8000, temperature: 0,
          thinking: { type: 'enabled' }, reasoningEffort: 'high',
        })
        return { status: 'accepted', sessionId: `web:${message.chatId}`, inputId: message.messageId }
      })
      const app = new Hono()
      await channel.start(app)
      try {
        for (const [chatId, config] of [
          ['configured', { thinking: { type: 'disabled' }, reasoningEffort: 'max' }],
          ['fallback', { thinking: null, reasoningEffort: null }],
          ['low-effort', { thinking: { type: 'enabled' }, reasoningEffort: 'low' }],
          ['no-thinking', { thinking: { type: 'disabled' }, reasoningEffort: null }],
          ['medium-effort', { thinking: { type: 'enabled' }, reasoningEffort: 'medium' }],
          ['xhigh-effort', { thinking: { type: 'enabled' }, reasoningEffort: 'xhigh' }],
        ]) {
          const response = await app.request('/api/chat/send', {
            method: 'POST', headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ chatId, content: 'actual first question', stream: false, config }),
          })
          equal(response.status, 200)
          while (sessions.getSessionState(`web:${chatId}`)?.executionStatus !== 'completed') {
            await new Promise(resolve => setTimeout(resolve, 2))
          }
        }
        equal(calls.length, 6)
        deepEqual(calls[0]?.thinking, { type: 'disabled' })
        equal(calls[0]?.reasoningEffort, 'max')
        deepEqual(calls[1]?.thinking, { type: 'enabled' })
        equal(calls[1]?.reasoningEffort, 'high')
        equal(calls[2]?.reasoningEffort, 'low')
        deepEqual(calls[3]?.thinking, { type: 'disabled' })
        equal(calls[3]?.reasoningEffort, 'high')
        equal(calls[4]?.reasoningEffort, 'medium')
        equal(calls[5]?.reasoningEffort, 'xhigh')
        await sessions.stop()
        const restarted = makeManager(workspace, store)
        await restarted.start()
        equal(restarted.getSessionConfig('web:low-effort')?.reasoningEffort, 'low')
        equal(restarted.getSessionConfig('web:medium-effort')?.reasoningEffort, 'medium')
        equal(restarted.getSessionConfig('web:xhigh-effort')?.reasoningEffort, 'xhigh')
        deepEqual(restarted.getSessionConfig('web:no-thinking')?.thinking, { type: 'disabled' })
        equal(restarted.getSessionConfig('web:no-thinking')?.reasoningEffort, undefined)
        const details = await restarted.getSessionDetails('web:configured')
        deepEqual(details?.usage, usage)
        equal(details?.name, 'actual first question')
        equal(details?.context.usedTokens, 120)
        await restarted.stop()
      } finally {
        await sessions.stop()
        await channel.stop()
        store.close?.()
      }
    })
  })
}
