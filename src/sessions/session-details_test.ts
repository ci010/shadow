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

  test(`${Store.name}: details are read-only, segment-owned and expose latest-call usage`, async () => {
    await withTempWorkspace(async (workspace) => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      try {
        await store.saveState('web:one', { sessionId: 'web:one', segmentIndex: 1, workspaceRoot: 'web:owner' })
        await store.createSessionLog(newPhysicalSessionId('web:one', 0), [
          { previous_physical_id: null },
          { role: 'user', content: '<sender name="Human"/> Actual question' },
          { role: 'assistant', content: 'old', usage: earlier },
        ])
        await store.createSessionLog(newPhysicalSessionId('web:one', 1), [
          { previous_physical_id: newPhysicalSessionId('web:one', 0) },
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
          usage, usageScope: 'latest-call',
          context: { usedTokens: 120, windowTokens: 8000 },
        })
        const segment = await sessions.getSessionDetails('web:one', newPhysicalSessionId('web:one', 0))
        deepEqual(segment?.usage, earlier)
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
          deepEqual(details?.context, { usedTokens: null, windowTokens: null })
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
