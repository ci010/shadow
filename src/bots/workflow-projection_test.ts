import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { Hono } from 'hono'
import { withTempWorkspace } from '../testing/workspace.ts'
import { BotInstanceStore } from '../channels/bot-store.ts'
import { ChannelManager } from '../channels/manager.ts'
import { ConfigSchema } from '../config/schema.ts'
import { Bus } from '../bus/bus.ts'
import type { SessionManager } from '../sessions/session-manager.ts'
import { BotDeployments } from './deployments.ts'
import { DirectoryBots } from './runtime.ts'
import { botFiles } from './sdk-test-fixture.ts'
import { botWorkflowProjection } from './workflow-projection.ts'
import { channelSessionId } from '../bus/events.ts'
import { registerWorkflowRoutes } from '../workflows/management.ts'
import { WorkflowRuntime } from '../workflows/runtime.ts'
import { connectionSinkProjection } from '../channels/sink-projection.ts'

const tree = (path: string): unknown => readdirSync(path).sort().map(name => { const p = join(path, name); return [name, statSync(p).isDirectory() ? tree(p) : readFileSync(p, 'utf8')] })
test('real immutable BOT packages project shared connection, distinct groups/Agents, disabled/unsubscribed and invalid deployment without effects or secrets', async () => {
  await withTempWorkspace(async workspace => {
    const store = new BotInstanceStore({ projectId: 'p', path: join(workspace, 'connections.json') })
    const connection = store.create('qq', 'Shared QQ', { enabled: true, appId: 'PRIVATE_APP', secret: 'PRIVATE_SECRET' }, undefined, 'service')
    const bus = new Bus()
    const channels = new ChannelManager(ConfigSchema.parse({}), bus, {} as SessionManager, async () => { throw Error('Must not receive') }, { projectId: 'p', instanceStore: store, factory: () => { throw Error('Must not connect') } })
    const deployments = new BotDeployments({ projectId: 'p', directory: join(workspace, 'deployments'), runGit: async () => { throw Error('No git') } })
    const directory = new DirectoryBots(deployments)
    const binding = (conversationId: string, enabled = true) => ({ platform: 'qq', botInstanceId: connection.id, conversationId, enabled, tools: [], parameters: { secret: 'PRIVATE_PARAMETER' }, allowFrom: ['PRIVATE_SENDER'] })
    const deploy = async (id: string, overrides: Record<string, unknown> = {}) => {
      const files = botFiles('throw Error("PRIVATE_MODULE_MUST_NOT_RUN")', overrides)
      files['BOT.md'] = files['BOT.md']!.replace('id: demo', `id: ${id}`).replace('A helpful bot.', 'PRIVATE_PROMPT')
      await deployments.deploy({ id, source: { folderId: 'source', directory: id }, ...deployments.freeze(files) })
    }
    await deploy('sales', { bindings: [binding('group:one')] })
    await deploy('support', { bindings: [binding('group:two'), binding('group:disabled', false), binding('group:unsubscribed')], subscriptions: [ { platform: 'qq', botInstanceId: connection.id, conversationId: 'group:two' }, { platform: 'qq', botInstanceId: connection.id, conversationId: 'group:disabled' } ] })
    await deploy('broken', { invalid: 'PRIVATE_INVALID' })
    const existing = channelSessionId({ projectId: 'p', botInstanceId: connection.id, platform: 'qq', conversationId: 'group:two' })
    const sink = connectionSinkProjection({ projectId: 'p', connectionId: connection.id, platform: 'qq', histories: [], observations: [] })
    const lookedUp: string[] = []
    const options = { projectId: 'p', store, channels, directory, sessionIds: [existing], personalListeners: [],
      sinkLookup: (id: string) => {
        lookedUp.push(id)
        return connectionSinkProjection({ projectId: 'p', connectionId: id, platform: 'qq', histories: [], observations: [] })
      } }
    const before = tree(workspace)
    const snapshot = botWorkflowProjection(options)
    assert.equal(snapshot.connections.length, 1)
    assert.deepEqual(lookedUp, [connection.id])
    assert.deepEqual(snapshot.sinks, [sink], 'API nests real host-resolved sinks under bots, not copied binding receivers')
    const foreign = botWorkflowProjection({ ...options, sinkLookup: () => ({ ...sink, projectId: 'other' }) })
    assert.deepEqual(foreign.sinks, [])
    assert.ok(foreign.warnings.includes('connection-sink-unavailable'))
    assert.equal(foreign.connections.length, 1, 'A bad projection never hides the transport connection')
    assert.equal(snapshot.bindings.length, 4)
    assert.equal(new Set(snapshot.bindings.map(b => b.connectionId)).size, 1)
    assert.notEqual(snapshot.deployments.find(d => d.id === 'sales')?.agent, snapshot.deployments.find(d => d.id === 'support')?.agent)
    assert.equal(snapshot.deployments.find(d => d.id === 'broken')?.state, 'quarantined')
    assert.equal(snapshot.bindings.find(b => b.topic === 'group:disabled')?.listener, false)
    assert.equal(snapshot.bindings.find(b => b.topic === 'group:unsubscribed')?.subscribed, false)
    assert.deepEqual(snapshot.bindings.find(b => b.topic === 'group:two')?.sessionIds, [existing])
    assert.deepEqual(snapshot.bindings.find(b => b.topic === 'group:one')?.sessionIds, [])
    assert.doesNotMatch(JSON.stringify(snapshot), /PRIVATE_|prompt|parameters|allowFrom|config|secret/)
    assert.deepEqual(tree(workspace), before)
    assert.deepEqual(directory.diagnostics(), [])
    assert.throws(() => botWorkflowProjection({ ...options, projectId: 'other' }), /Project mismatch/)
    const runtime = new WorkflowRuntime(workspace, 'p', { canUse: () => true, deliver: async () => { throw Error('Must not deliver') } })
    const app = new Hono()
    registerWorkflowRoutes(app, runtime, request => request.headers.get('x-owner') === 'yes', undefined, () => botWorkflowProjection(options))
    assert.equal((await app.request('/api/workflows')).status, 403)
    const response = await app.request('/api/workflows', { headers: { 'x-owner': 'yes' } })
    assert.equal(response.status, 200)
    assert.deepEqual((await response.json()).bots, snapshot)
    assert.equal((await app.request('/api/workflows/control', { method: 'POST', headers: { 'x-owner': 'yes', 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'resume', id: 'bot-binding:any' }) })).status, 409)
    store.update(connection.id, { config: { enabled: false } })
    const disabled = botWorkflowProjection(options)
    assert.equal(disabled.connections[0]?.enabled, false)
    assert.equal(disabled.bindings.find(b => b.topic === 'group:one')?.enabled, true, 'Connection disablement does not rewrite package binding enablement')
    assert.equal(disabled.bindings.find(b => b.topic === 'group:one')?.listener, true, 'Listener projection is not transport admission')
    const personal = store.create('qq', 'Personal QQ', { enabled: true, appId: 'PRIVATE_APP', secret: 'PRIVATE_SECRET' }, undefined, 'personal')
    store.bindOwner(personal.id, 'PRIVATE_OWNER', 'PRIVATE_OWNER_TOPIC')
    await deploy('personal', { mode: 'personal', connection: personal.id, agent: 'general', tools: [], allowedModules: [], bindings: [] })
    const personalSession = channelSessionId({ projectId: 'p', botInstanceId: personal.id, platform: 'qq', conversationId: 'owner-conversation' })
    const personalView = botWorkflowProjection({ ...options, sessionIds: [personalSession], personalListeners: [{ source: { type: 'qq', id: personal.id }, kind: 'message', topic: 'PRIVATE_OWNER_TOPIC', target: { kind: 'session', id: personalSession } }] })
    const ingress = personalView.bindings.find(b => b.deploymentId === 'personal')
    assert.equal(ingress?.kind, 'host-owner-ingress')
    assert.deepEqual(ingress?.sessionIds, [personalSession])
    assert.equal(ingress?.topic, undefined)
    assert.equal(personalView.deployments.find(d => d.id === 'personal')?.agent, 'general')
    assert.doesNotMatch(JSON.stringify(personalView), /PRIVATE_/)
    const brokenApp = new Hono()
    registerWorkflowRoutes(brokenApp, runtime, () => true, undefined, () => { throw Error('PRIVATE_STORAGE_ERROR') })
    const unavailable = await (await brokenApp.request('/api/workflows')).json()
    assert.equal(unavailable.botsUnavailable, true)
    assert.doesNotMatch(JSON.stringify(unavailable), /PRIVATE_/)
    bus.stopAll()
  })
})
