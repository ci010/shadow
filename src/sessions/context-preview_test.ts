import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { Hono } from 'hono'
import { ContextBuilder, type SessionPromptContext } from '../agent/context/builder.ts'
import { guidelineProvider } from '../agent/context/guideline.ts'
import { IdentityManager } from '../agent/identity.ts'
import { BackgroundTaskManager } from '../agent/background-task.ts'
import { AgentTypesManager } from '../agent/types/manager.ts'
import { agentTypesPlugin } from '../agent/types/routes.ts'
import { Bus } from '../bus/bus.ts'
import { EventService } from '../events/service.ts'
import { InitiativeStore } from '../initiatives/store.ts'
import type { LLMProvider } from '../providers/provider.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { ReadTool } from '../tools/read.ts'
import { Tools } from '../tools/registry.ts'
import { WorkTool } from '../tools/work.ts'
import { HandoffManager } from './handoff/manager.ts'
import { SessionManager } from './session-manager.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import type { SessionStore } from './session-store.ts'
import { WorkAlignment } from './work-alignment.ts'

async function fixture(workspace: string, store: SessionStore) {
  const bus = new Bus()
  const provider: LLMProvider = {
    name: 'fixture', listModels: () => [],
    chat: async () => { throw new Error('Context previews must not call a model') },
  }
  const events = new EventService(workspace, bus, async () => { throw new Error('No delivery expected') })
  const backgroundTasks = new BackgroundTaskManager(bus, events)
  const handoffManager = new HandoffManager(provider, 100000, { autoHandoff: false }, workspace, store)
  const agentTypes = new AgentTypesManager(workspace)
  await agentTypes.load()
  const contexts: SessionPromptContext[] = []
  const context = new ContextBuilder(workspace)
  context.register({
    name: 'fixture',
    getPromptSection: ctx => {
      contexts.push(ctx)
      return `Role: ${ctx.agent.name}\nChannel: ${ctx.channel}\nSession: ${ctx.sessionId}`
    },
  })
  context.register(guidelineProvider())
  const tools = new Tools(workspace)
  const policyLookups: string[] = []
  const sessions = new SessionManager({
    projectId: 'preview-project', workspace, store, bus, provider, events, backgroundTasks,
    handoffManager, agentTypes, context, tools, identity: new IdentityManager(workspace),
    conversationPolicies: {
      resolve: sessionId => { policyLookups.push(sessionId); return undefined },
      managed: () => false,
      authorize: () => {},
      tools: () => { throw new Error('No conversation policy expected') },
      prompt: () => { throw new Error('No conversation policy expected') },
    },
  })
  await sessions.start()
  const initiatives = new InitiativeStore(workspace, { isSessionKnown: id => !!sessions.getSessionState(id) })
  const alignment = new WorkAlignment(initiatives, {
    state: id => sessions.getSessionState(id),
    evidence: source => sessions.validateWorkEvidence(source),
    changed: async () => {},
    fresh: async () => { throw new Error('No Work transition expected') },
    successor: async () => { throw new Error('No successor expected') },
  })
  sessions.alignment = alignment
  tools.setWorkGuard(alignment)
  tools.register(new ReadTool(workspace))
  tools.register(new WorkTool(alignment))
  const errors: Error[] = []
  const app = new Hono()
  app.onError((error, c) => {
    errors.push(error)
    return c.json({ error: error.message }, 500)
  })
  agentTypesPlugin(sessions, agentTypes)(app)
  return {
    sessions, alignment, app, contexts, policyLookups, errors,
    async close() {
      await sessions.stop()
      await handoffManager.stop()
      await backgroundTasks.stop()
      await events.stop()
      bus.stopAll()
      initiatives.close()
      store.close?.()
    },
  }
}

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: agent role previews need no session and preserve strict real-session Work checks`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      const f = await fixture(workspace, store)
      try {
        for (const channel of ['heartbeat', 'web', 'discord', 'wechat', 'feishu']) {
          for (const role of ['a2a-text', 'general', 'reflector']) {
            const response = await f.app.request(`/debug/agent-types/${role}/context?channel=${channel}`)
            assert.equal(response.status, 200, `${role}/${channel}: ${f.errors.at(-1)?.message}`)
            const body = await response.json()
            assert.equal(body.source, 'preview')
            assert.match(body.systemPrompt, new RegExp(`Role: ${role}\\nChannel: ${channel}`))
            const ctx = f.contexts.at(-1)!
            assert.equal(ctx.projectId, 'preview-project')
            assert.equal(ctx.workRequired, false)
            if (role === 'a2a-text') assert.deepEqual(body.tools, [])
            if (role === 'general') {
              assert.match(body.systemPrompt, /### Shared work notes/)
              assert(body.tools.some((tool: { name: string }) => tool.name === 'work'))
            }
            if (role === 'reflector') assert.equal(ctx.mode, 'task')
          }
        }
        assert.deepEqual(f.policyLookups, [])
        assert.deepEqual(f.sessions.listSessions(), [])
        assert.deepEqual(await store.listAllStates(), {})
        assert.deepEqual(f.errors, [])
        assert.throws(() => f.alignment.required('heartbeat:heartbeat'), /Session not found in this Project/)
        await assert.rejects(f.sessions.getContext({ sessionId: 'heartbeat:heartbeat', preview: true }),
          /Session not found in this Project/)
      } finally { await f.close() }
    })
  })

  test(`${Store.name}: agent role previews do not borrow a matching conversation's context or tools`, async t => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      const f = await fixture(workspace, store)
      const sessionId = 'heartbeat:heartbeat'
      try {
        await f.sessions.buildSession(sessionId, undefined, {
          agentType: 'general', config: { defaultShell: 'powershell' },
          workPolicy: { mode: 'required', controllerSessionId: sessionId, keys: [`topic:${sessionId}`] },
        })
        const real = await f.sessions.getContext({ sessionId, preview: true })
        assert.match(real.systemPrompt, /### Shared work notes/)
        assert.equal(f.contexts.at(-1)?.workRequired, false)
        assert.equal(f.contexts.at(-1)?.defaultExecShell, 'powershell')
        assert(real.tools.some(tool => tool.name === 'work'))
        const states = await store.listAllStates()
        f.policyLookups.length = 0
        const activeLookup = t.mock.method(f.sessions, 'getActiveSession', () => {
          throw new Error('Role previews must not consult active conversations')
        })
        for (const role of ['a2a-text', 'general']) {
          const response = await f.app.request(`/debug/agent-types/${role}/context?channel=heartbeat`)
          assert.equal(response.status, 200, f.errors.at(-1)?.message)
          const body = await response.json()
          const ctx = f.contexts.at(-1)!
          assert.equal(body.source, 'preview')
          assert.equal(ctx.agent.name, role)
          assert.notEqual(ctx.sessionId, sessionId)
          assert.equal(ctx.workRequired, false)
          assert.equal(ctx.defaultExecShell, undefined)
          if (role === 'a2a-text') assert.deepEqual(body.tools, [])
          else assert.match(body.systemPrompt, /### Shared work notes/)
        }
        activeLookup.mock.restore()
        assert.deepEqual(f.policyLookups, [])
        assert.deepEqual(await store.listAllStates(), states)
        assert.equal(f.alignment.required(sessionId), false)
        const stillReal = await f.sessions.getContext({ sessionId, preview: true })
        assert.match(stillReal.systemPrompt, /### Shared work notes/)
        assert.equal(f.contexts.at(-1)?.sessionId, sessionId)
      } finally { await f.close() }
    })
  })
}
