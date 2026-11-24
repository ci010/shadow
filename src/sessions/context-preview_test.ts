import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { Hono } from 'hono'
import { ContextBuilder, type SessionPromptContext } from '../agent/context/builder.ts'
import { executionContractProvider, guidelineProvider } from '../agent/context/guideline.ts'
import { runtimeIdentityProvider } from '../agent/context/runtime.ts'
import { unavailableCapabilities } from '../channels/capabilities.ts'
import { IdentityManager } from '../agent/identity.ts'
import { BackgroundTaskManager } from '../agent/background-task.ts'
import { readAgentPromptDraft, saveAgentPromptDraft, SubOverrideStore } from '../agent/context/sub-override.ts'
import { agentPromptDraftTools } from '../tools/agent-prompt-draft.ts'
import { AgentTypesManager } from '../agent/types/manager.ts'
import { agentTypesPlugin } from '../agent/types/routes.ts'
import { Bus } from '../bus/bus.ts'
import { EventService } from '../events/service.ts'
import { InitiativeStore } from '../initiatives/store.ts'
import type { ChatMessage, LLMProvider } from '../providers/provider.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { ReadTool } from '../tools/read.ts'
import { Tools } from '../tools/registry.ts'
import { WorkTool } from '../tools/work.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { createAgentsHandler } from '../vfs/agents.ts'
import { VirtualFs } from '../vfs/virtual-fs.ts'
import { HandoffManager } from './handoff/manager.ts'
import { SessionManager } from './session-manager.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import type { SessionStore } from './session-store.ts'
import { WorkAlignment } from './work-alignment.ts'

async function fixture(workspace: string, store: SessionStore, execute = false, getBuiltinPromptVersion?: () => 'v1' | 'v2' | undefined) {
  const requests: Array<{ messages: ChatMessage[]; tools: string[] }> = []
  const bus = new Bus()
  const provider: LLMProvider = {
    name: 'fixture', listModels: () => [],
    chat: async (messages, tools) => {
      if (!execute) throw new Error('Context previews must not call a model')
      requests.push({ messages: structuredClone(messages), tools: tools.map(tool => tool.function.name) })
      return { content: 'Fixture response', toolCalls: [] }
    },
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
  context.register(runtimeIdentityProvider({
    projectId: 'preview-project', identity: new IdentityManager(workspace), getSkillsSummary: () => '',
    getAgentTypesSummary: () => agentTypes.getAgentTypesSummary(),
    getProjectNodeInventory: id => {
      assert.equal(id, 'preview-project')
      return { version: 1, nodes: [{ nodeId: 'owner-child', displayName: 'Owner-only fixture device', role: 'child',
        connection: 'connected', executionProtocol: 'compatible', support: { operations: [] }, workdirs: [{
          version: 2, nodeId: 'owner-child', workdirId: 'fixture-dir-id', displayName: 'Fixture directory',
          displayPath: 'C:\\Fixture\\Directory', online: true, support: { operations: ['filesystem.read'] },
        }] }] }
    },
    getChannelCapabilities: channel => channel === 'web' ? {
      ...unavailableCapabilities(), conversation: 'web', format: 'markdown', codeBlocks: true, tables: true,
      updates: 'stream', decisions: 'native', outboundMedia: ['image', 'file', 'audio', 'video'],
    } : unavailableCapabilities(),
  }))
  context.register(executionContractProvider())
  context.register(guidelineProvider())
  const tools = new Tools(workspace)
  const policyLookups: string[] = []
  const sessions = new SessionManager({
    projectId: 'preview-project', workspace, store, bus, provider, events, backgroundTasks,
    getBuiltinPromptVersion,
    getLlmRuntimeConfig: () => ({ model: 'fixture', contextWindow: 128_000, temperature: 0 }),
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
    changed: async () => {},
  })
  sessions.alignment = alignment
  tools.setWorkGuard(alignment)
  tools.register(new ReadTool(workspace))
  tools.register(new WorkTool(alignment))
  tools.register({ name: 'ask', description: 'fixture ask', parameters: { type: 'object', properties: {} },
    execute: async () => { throw new Error('Role previews must not call tools') } })
  const errors: Error[] = []
  const app = new Hono()
  app.onError((error, c) => {
    errors.push(error)
    return c.json({ error: error.message }, 500)
  })
  agentTypesPlugin(sessions, agentTypes, request => request.headers.get('x-owner') === 'yes')(app)
  return {
    sessions, alignment, app, agentTypes, contexts, policyLookups, errors, requests,
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

async function sendFixtureInput(f: Awaited<ReturnType<typeof fixture>>, sessionId: string) {
  const requestIndex = f.requests.length
  await f.sessions.deliver(sessionId, {
    kind: 'message', id: crypto.randomUUID(), timestamp: new Date().toISOString(), content: 'Fixture input', policy: 'queue',
    source: { kind: 'event', eventId: crypto.randomUUID(), type: 'fixture', source: 'fixture' },
  })
  const finishBy = Date.now() + 4000
  while (!f.requests[requestIndex]) {
    assert.ok(Date.now() < finishBy, 'provider did not receive the runtime prompt')
    await new Promise(resolve => setTimeout(resolve, 5))
  }
  const request = f.requests[requestIndex]!
  const system = request.messages[0]
  assert.equal(system?.role, 'system')
  assert.ok(typeof system?.content === 'string')
  return { systemPrompt: system.content, tools: request.tools }
}

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: agent role previews need no session and preserve strict real-session Work checks`, async () => {
    const original = process.env.SHADOW_BUILTIN_PROMPT_VERSION
    process.env.SHADOW_BUILTIN_PROMPT_VERSION = 'v1'
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      const f = await fixture(workspace, store)
      try {
        for (const channel of ['heartbeat', 'web', 'discord', 'wechat', 'feishu']) {
          for (const role of ['a2a-text', 'general', 'reflector']) {
            const response = await f.app.request(`/api/agent-types/${role}/context?channel=${channel}`)
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
        const vfs = new VirtualFs()
        const handlers = createAgentsHandler(f.agentTypes, undefined, { types: f.agentTypes, sessions: f.sessions, canRead: () => true })
        vfs.mount('v:agents', 'role preview', handlers.read, handlers.list)
        const context = { signal: new AbortController().signal } as ExecutionContext
        const path = 'v:agents/general/context/web'
        const previewUrl = '/api/agent-types/general/context?channel=web&rolePreview=owner-web'
        const owner = { headers: { 'x-owner': 'yes' } }
        const beforeDenied = f.contexts.length
        const denied = await f.app.request(previewUrl)
        assert.equal(denied.status, 401)
        assert.equal(denied.headers.get('Cache-Control'), 'no-store')
        assert.equal(f.contexts.length, beforeDenied)
        assert.equal((await f.app.request(previewUrl.replace('channel=web', 'channel=discord'), owner)).status, 400)
        assert.equal((await f.app.request(previewUrl.replace('/general/', '/dispatcher/'), owner)).status, 404)
        const generic = await (await f.app.request('/api/agent-types/general/context?channel=web')).json()
        assert.equal(generic.rolePreview, undefined)
        assert.doesNotMatch(generic.systemPrompt, /Device Inventory|Owner-only fixture device/)
        const response = await f.app.request(previewUrl, owner)
        assert.equal(response.status, 200)
        assert.equal(response.headers.get('Cache-Control'), 'no-store')
        const ui = await response.json()
        assert.equal(ui.rolePreview, 'owner-web')
        assert.deepEqual(ui.promptIdentity, { role: 'general', definition: 'general', version: 'v1', mode: 'session', behaviorSource: 'builtin' })
        assert.match(ui.systemPrompt, /Device Inventory/)
        assert.match(ui.systemPrompt, /Owner-only fixture device/)
        // A renderer from before the owner-web query was introduced still sees the same preview.
        const legacyRenderer = await f.app.request('/api/agent-types/general/context?channel=web', owner)
        assert.equal(legacyRenderer.status, 200)
        assert.equal(legacyRenderer.headers.get('Cache-Control'), 'no-store')
        assert.deepEqual(await legacyRenderer.json(), ui)
        assert.deepEqual(JSON.parse((await vfs.resolve(path, context))!), {
          agentType: 'general', channel: 'web', source: ui.source, rolePreview: 'owner-web', promptIdentity: ui.promptIdentity, systemPrompt: ui.systemPrompt, sections: ui.sections,
        })
        assert.deepEqual(ui.sections.map((section: { name: string }) => section.name),
          ['fixture', 'runtime', 'execution-contract', 'AGENT.md', 'tool-guidance'])
        assert.equal(await vfs.resolve(`${path}/system-prompt`, context), ui.systemPrompt)

        process.env.SHADOW_BUILTIN_PROMPT_VERSION = 'v2'
        const candidatePath = path
        const candidate = await (await f.app.request(previewUrl, owner)).json()
        assert.deepEqual(JSON.parse((await vfs.resolve(candidatePath, context))!), {
          agentType: 'general', channel: 'web', source: 'preview', rolePreview: 'owner-web', promptIdentity: candidate.promptIdentity, systemPrompt: candidate.systemPrompt, sections: candidate.sections,
        })
        assert.equal(candidate.promptIdentity.version, 'v2')
        assert.match(candidate.systemPrompt, /"owner-child" "Owner-only fixture device" \(child, connected\)/)
        assert.match(candidate.systemPrompt, /Read `v:devices` for live status and supported operations/)
        assert.doesNotMatch(candidate.systemPrompt, /fixture-dir-id|Fixture directory|supported operations "filesystem\.read"/)
        assert.match(ui.systemPrompt, /directory "fixture-dir-id" "Fixture directory"/)
        for (const [role, marker, mode] of [
          ['sub', /Complete the assigned outcome/, 'session'],
          ['verify', /Verification is not repair/, 'task'],
          ['plan', /Do not execute the plan/, 'session'],
          ['explore', /Stay read-only/, 'session'],
        ] as const) {
          const response = await f.app.request(previewUrl.replace('/general/', `/${role}/`), owner)
          assert.equal(response.status, 200)
          const preview = await response.json()
          assert.equal(f.contexts.at(-1)?.mode, mode)
          assert.match(preview.systemPrompt, marker)
          assert.doesNotMatch(preview.systemPrompt, /<!-- (?:capability|include|when):/)
          assert(!preview.sections.some((section: { name: string }) => section.name === 'tool-discovery-reference'))
          assert.equal(await vfs.resolve(`v:agents/${role}/context/web/system-prompt`, context), preview.systemPrompt)
          if (role === 'verify') assert.doesNotMatch(preview.systemPrompt, /Device Inventory/)
        }
        await assert.rejects(f.sessions.getContext({ sessionId: 'web:real', agentType: 'general', channel: 'web', rolePreview: 'owner-web' }), /cannot use a real conversation/)
        assert.equal(await vfs.resolve(`${candidatePath}/system-prompt`, context), candidate.systemPrompt)
        assert.deepEqual(candidate.tools, ui.tools)
        assert(candidate.tools.some((tool: { name: string }) => tool.name === 'ask'))
        const part = (preview: typeof ui, name: string) => {
          const found = preview.sections.find((entry: { name: string }) => entry.name === name)
          assert.ok(found, `Missing ${name} prompt section`)
          return found
        }
        const section = (preview: typeof ui, name: string): string => part(preview, name).content
        const baselineTools = section(ui, 'tool-guidance')
        assert.match(baselineTools, /Tool schemas and runtime role restrictions are authoritative/)
        assert.match(baselineTools, /v:config\/mcp\.json/)
        assert.match(baselineTools, /### Shared work notes/)
        assert.doesNotMatch(baselineTools, /### Text edits|Before the final response, write `completed: true`/)

        for (const name of ['tool-discovery-reference', 'tool-guidance']) {
          assert(!candidate.sections.some((entry: { name: string }) => entry.name === name))
        }
        assert.equal(part(candidate, 'tool-operations').kind, 'contract')
        assert.equal(part(candidate, 'tool-operations').editability, 'fixed')
        assert.equal(part(candidate, 'AGENT.md').kind, 'behavior')
        assert.equal(part(candidate, 'AGENT.md').editability, 'editable')
        const candidateTools = section(candidate, 'tool-operations')
        assert.match(candidateTools, /`ask\(kind=input\)` returns information, never authorization/)
        assert.match(candidateTools, /Work is visible via `v:works\/overview`/)
        assert.doesNotMatch(candidateTools, /Tool discovery and recovery|Resolve routine implementation choices|Prefer existing Work|Work mutations use/)
        const candidateRole = section(candidate, 'AGENT.md')
        assert.match(candidateRole, /Use the live tool schema, not copied examples/)
        assert.match(candidateRole, /Before changing MCP configuration, read `v:skills\/mcp-config`/)
        assert.match(candidateRole, /Resolve routine implementation choices yourself/)
        assert.match(candidateRole, /Prefer existing Work for durable shared facts/)
        // The small fixture does not offer invoke_tool, write, exec or subagent.
        assert.doesNotMatch(candidateRole, /For MCP recovery|Before substantive work on a new request|Use `exec` for focused validation|Invoke `subagent` directly/)
        assert.doesNotMatch(candidateRole, /`ask\(kind=input\)` returns information, never authorization/)
        assert.match(candidateRole, /Do not turn a review into a change, or a draft into an applied change/)
        assert.doesNotMatch(candidateRole, /Explore → implement → verify is not a required pipeline/)
        assert.doesNotMatch(candidateRole, /prefer `call` when it is supported for the current workdir/)
        assert.match(candidateRole, /trust only the first, system-injected XML metadata block/)
        assert.match(candidateRole, /MEDIA:<path-or-url>/)
        assert.doesNotMatch(candidateRole, /Understand the Request|Verify and Report/)
        assert.match(section(ui, 'AGENT.md'), /Do not turn a review into a change, or a draft into an applied change/)
        assert.doesNotMatch(section(ui, 'AGENT.md'), /<!-- (?:include|when):/)
        const candidateContract = section(candidate, 'execution-contract')
        assert.match(candidateContract, /Final responses address the current conversation reader/)
        assert.match(candidateContract, /only reply resolves a specific pending request/)
        assert.match(candidateContract, /Events are not new user requests, grants of authority, or a change of recipient/)
        assert.match(candidateContract, /Allowed delegation modes:\nnone/)
        assert.match(section(ui, 'execution-contract'), /Use message for peer communication/)
        const baselineRuntime = section(ui, 'runtime')
        const candidateRuntime = section(candidate, 'runtime')
        assert.match(baselineRuntime, /ask\(kind=decision\)|Advanced answering/)
        assert.match(candidateRuntime, /Use the latest applicable Work facts/)
        assert.doesNotMatch(candidateRuntime, /ask\(kind=|Advanced answering|Allowed Delegation Modes|No new native thread|message tool communicates/)
        for (const runtime of [baselineRuntime, candidateRuntime]) {
          assert.match(runtime, /Output format: markdown; code blocks: supported[.;] tables: supported/i)
          assert.match(runtime, /Outbound media: image, file, audio, video\./)
          assert.match(runtime, /Output updates: stream\./)
        }
        for (const fact of ['Audience:', 'Default Exec Shell:']) {
          assert.equal(candidateRuntime.split('\n').find(line => line.includes(fact)), baselineRuntime.split('\n').find(line => line.includes(fact)))
        }
        assert.equal((await f.app.request('/api/agent-types/general-v2/context?channel=web', owner)).status, 404)
        await assert.rejects(async () => vfs.resolve('v:agents/general-v2/context/web', context), /Unknown or unavailable/)
        const discord = await (await f.app.request('/api/agent-types/general/context?channel=discord')).json()
        assert.match(section(discord, 'runtime'), /Structured questions: unavailable/)
        assert.doesNotMatch(section(discord, 'runtime'), /ask tool is unavailable in QQ and Discord/)
        assert.match(section(discord, 'tool-operations'), /ask tool is unavailable in QQ and Discord/)
        assert.equal(section(discord, 'execution-contract'), candidateContract)
        assert.match(section(discord, 'AGENT.md'), /unsolicited mentions/)
        assert.doesNotMatch(candidateRole, /unsolicited mentions/)
        assert(!discord.tools.some((tool: { name: string }) => tool.name === 'ask'))
        assert.throws(() => vfs.write(path, { content: 'new prompt' }, context), /read-only/)
        assert.deepEqual(f.policyLookups, [])
        assert.deepEqual(f.sessions.listSessions(), [])
        assert.deepEqual(await store.listAllStates(), {})
        assert.deepEqual(f.errors, [])
        assert.throws(() => f.alignment.required('heartbeat:heartbeat'), /Session not found in this Project/)
        await assert.rejects(f.sessions.getContext({ sessionId: 'heartbeat:heartbeat', preview: true }),
          /Session not found in this Project/)
      } finally {
        if (original === undefined) delete process.env.SHADOW_BUILTIN_PROMPT_VERSION
        else process.env.SHADOW_BUILTIN_PROMPT_VERSION = original
        await f.close()
      }
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
          const response = await f.app.request(`/api/agent-types/${role}/context?channel=heartbeat`)
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

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: a generic sub draft replaces the role body and renders against scoped tools`, async () => {
    const key = 'SHADOW_BUILTIN_PROMPT_VERSION'
    const original = process.env[key]
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      const f = await fixture(workspace, store, true, () => 'v2')
      try {
        process.env[key] = 'v2'
        const drafts = new SubOverrideStore(workspace)
        const role = f.agentTypes.resolve('sub')!
        const markdown = `# Replacement sub role

<!-- when: tools=ask; channels=web,discord; modes=session -->
Scoped request sentinel.
<!-- /when -->`
        const revision = await saveAgentPromptDraft(drafts, role, markdown)
        const draft = await readAgentPromptDraft(drafts, role, revision)
        const assertBody = (text: string, matchesCondition: boolean) => {
          assert.match(text, /# Replacement sub role/)
          assert.equal(text.includes('Scoped request sentinel.'), matchesCondition)
          assert.doesNotMatch(text, /# Sub-Agent|Complete the assigned outcome|Tool selection and coordination|Tool discovery and recovery|<!-- \/?when/)
        }
        const ownerPreview = await f.sessions.getContext({ agentType: 'sub', channel: 'web', rolePreview: 'owner-web',
          previewDraft: { draft, mode: 'session' } })
        assert.equal(ownerPreview.promptIdentity?.behaviorSource, 'agent-draft')
        assert.equal(ownerPreview.promptIdentity?.promptRevision, revision)
        assert.deepEqual(ownerPreview.sections?.filter(section => section.kind === 'behavior' && section.editability === 'editable')
          .map(section => section.name), [`AGENT.md@${revision}`])
        assert(!ownerPreview.sections?.some(section => section.name === 'tool-discovery-reference'))
        assert.ok(ownerPreview.tools.some(tool => tool.name === 'ask'))
        assertBody(ownerPreview.systemPrompt, true)
        assert.match(ownerPreview.systemPrompt, /`ask\(kind=input\)` returns information, never authorization/)
        assert.equal(f.requests.length, 0)
        assert.deepEqual(await store.listAllStates(), {})

        for (const [channel, mode, offersAsk, matchesCondition] of [
          ['web', 'session', true, true],
          ['discord', 'session', false, false], // Channel matches the directive, but ask is filtered out.
          ['feishu', 'session', true, false], // ask is offered, but the channel is not listed.
          ['web', 'task', true, false], // Channel and tools match, but the mode does not.
        ] as const) {
          const sessionId = `${channel}:scoped-sub-${mode}`
          await f.sessions.buildSession(sessionId, undefined, { agentType: 'sub', promptDraft: draft, mode })
          const preview = await f.sessions.getContext({ sessionId, preview: true })
          assert.equal(preview.tools.some(tool => tool.name === 'ask'), offersAsk, sessionId)
          assertBody(preview.systemPrompt, matchesCondition)
          const request = await sendFixtureInput(f, sessionId)
          assert.equal(request.tools.includes('ask'), offersAsk, sessionId)
          assertBody(request.systemPrompt, matchesCondition)
        }
      } finally {
        if (original === undefined) delete process.env[key]
        else process.env[key] = original
        await f.close()
      }
    })
  })

  test(`${Store.name}: assembly switch is shared by Knowledge, VFS and runtime; existing sessions remain pinned`, async () => {
    const key = 'SHADOW_BUILTIN_PROMPT_VERSION'
    const original = process.env[key]
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      await store.saveState('web:legacy-assembly', { sessionId: 'web:legacy-assembly', segmentIndex: 0, agentType: 'sub', mode: 'session' })
      const historicalState = { sessionId: 'web:historical-general', segmentIndex: 0, physicalIdVersion: 2, agentType: 'general-v2', mode: 'session' } as const
      await store.saveState(historicalState.sessionId, historicalState)
      await store.createSessionLog(SessionManager.currentPhysicalId(historicalState), [{
        sessionId: historicalState.sessionId, previous_physical_id: null, timestamp: new Date().toISOString(),
      }])
      let savedVersion: 'v1' | 'v2' | undefined = 'v1'
      const f = await fixture(workspace, store, true, () => savedVersion)
      try {
        delete process.env[key]
        const root = 'web:app-default-root'
        await f.sessions.buildSession(root)
        const initial = await f.sessions.getContext({ sessionId: root, preview: true })
        assert.equal(initial.promptIdentity?.definition, 'general')
        assert.equal(initial.promptIdentity?.version, 'v1')
        savedVersion = 'v2'
        for (const mode of ['call', 'task'] as const) {
          const child = `web:app-default-${mode}`
          await f.sessions.buildSession(child, undefined, { parentSessionId: root, agentType: 'sub', mode })
          assert.equal((await store.getState(child))?.promptVersion, 'v2')
        }
        assert.equal((await f.sessions.getContext({ sessionId: root, preview: true })).promptIdentity?.version, 'v1')
        savedVersion = undefined
        await f.sessions.buildSession('web:new-general-default')
        const defaultState = await store.getState('web:new-general-default')
        assert.equal(defaultState?.agentType, 'general')
        assert.equal(defaultState?.promptVersion, 'v2')
        await assert.rejects(f.sessions.buildSession('web:new-historical-definition', undefined, { agentType: 'general-v2' }), /retired for new runs/)
        const vfs = new VirtualFs()
        const preview = createAgentsHandler(f.agentTypes, undefined, { types: f.agentTypes, sessions: f.sessions, canRead: () => true })
        vfs.mount('v:agents', 'role preview', preview.read, preview.list)
        const vfsContext = { signal: new AbortController().signal } as ExecutionContext
        const owner = { headers: { 'x-owner': 'yes' } }
        for (const role of ['general', 'sub', 'verify', 'plan', 'explore']) {
          for (const version of ['v1', 'v2'] as const) {
            process.env[key] = version
            const result = await f.app.request(`/api/agent-types/${role}/context?channel=web&rolePreview=owner-web`, owner)
            assert.equal(result.status, 200)
            const ui = await result.json()
            assert.equal(ui.promptIdentity.version, version)
            assert.equal(ui.promptIdentity.definition, role)
            assert.equal(ui.promptIdentity.behaviorSource, 'builtin')
            assert.equal(ui.systemPrompt.startsWith('# Information\n'), version === 'v2')
            const text = await vfs.resolve(`v:agents/${role}/context/web`, vfsContext)
            assert.deepEqual(JSON.parse(text!).promptIdentity, ui.promptIdentity)
            assert.equal(JSON.parse(text!).systemPrompt, ui.systemPrompt)
          }
        }
        assert.equal(f.requests.length, 0, 'preview does not invoke a provider')
        const legacy = await f.sessions.getContext({ sessionId: 'web:legacy-assembly', preview: true })
        assert.equal(legacy.promptIdentity?.version, 'v1')
        process.env[key] = 'v1'
        const historical = await f.sessions.getContext({ sessionId: 'web:historical-general', preview: true })
        assert.deepEqual(historical.promptIdentity, { role: 'general', definition: 'general-v2', version: 'v2', mode: 'session', behaviorSource: 'builtin' })
        const draftStore = new SubOverrideStore(workspace)
        f.agentTypes.setWorkspaceType('custom-draft', {
          name: 'custom-draft', source: 'workspace', prompt: 'Original custom behavior',
          description: 'Custom draft', defaultMode: 'session', allowedTools: ['read'],
        })
        const tools = { executionMode: 'session' } as { executionMode: string; dynamicOwner?: object }
        tools.dynamicOwner = tools
        const ownerContext = { projectId: 'draft-test', sessionId: root, channel: 'web', admin: true, inputSource: 'user',
          soleDirectToolCall: true, tools, signal: new AbortController().signal } as unknown as ExecutionContext
        const [save, inspect, create] = agentPromptDraftTools(draftStore, 'draft-test', f.agentTypes, f.sessions, ctx => ctx.sessionId === root)
        const markdown = 'Use the assembly verification sentinel.'
        const saveDraft = async (agent_type: string, text = markdown) => JSON.parse(await save.execute({ agent_type, markdown: text }, ownerContext))
        const saved = await saveDraft('general')
        assert.equal(saved.enabled, false)
        const args = { agent_type: 'general', prompt_revision: saved.revision }
        const countBefore = (await store.listAllStates()).length
        const inspection = JSON.parse(await inspect.execute(args, ownerContext))
        assert.equal(inspection.source, 'preview')
        assert.equal(inspection.sessionCreated, false)
        assert.equal(inspection.promptIdentity.promptRevision, saved.revision)
        assert.match(inspection.systemPrompt, /assembly verification sentinel/)
        assert.equal((await store.listAllStates()).length, countBefore)
        const retired = f.agentTypes.resolve('general-v2')!
        const historicalRevision = await saveAgentPromptDraft(draftStore, retired, markdown)
        const historicalArgs = { agent_type: retired.name, prompt_revision: historicalRevision }
        const historicalDraft = JSON.parse(await inspect.execute(historicalArgs, ownerContext))
        assert.equal(historicalDraft.promptIdentity.definition, 'general-v2')
        assert.match(historicalDraft.systemPrompt, /assembly verification sentinel/)
        await assert.rejects(create.execute(historicalArgs, ownerContext), /retired for new runs/)
        await assert.rejects(save.execute({ agent_type: retired.name, markdown }, ownerContext), /retired for new runs/)
        await assert.rejects(create.execute(args, { ...ownerContext, projectId: 'other' }), /direct authorized/)
        await assert.rejects(save.execute({ agent_type: 'a2a:outside', markdown }, ownerContext), /remote A2A/)
        const created = JSON.parse(await create.execute(args, ownerContext))
        assert.equal(created.inferenceStarted, false)
        assert.equal(created.promptRevision, saved.revision)
        const before = await f.sessions.getContext({ sessionId: created.sessionId })
        await saveDraft('general', 'Replacement revision')
        assert.equal((await f.sessions.getContext({ sessionId: created.sessionId })).systemPrompt, before.systemPrompt)
        assert.equal(f.requests.length, 0, 'save, preview and idle session creation must not start inference')
        const revision = 'a'.repeat(64)
        const draft = { revision, markdown: 'Use the assembly verification sentinel.' }
        for (const role of ['general', 'sub', 'verify', 'plan', 'explore', 'custom-draft']) for (const version of ['v1', 'v2'] as const) {
          const sessionId = `web:${role}-${version}`
          const mode = role === 'verify' ? 'task' : 'session'
          const subDraft = role === 'sub' && version === 'v1' ? draft : undefined
          const promptDraft = subDraft ? undefined : await readAgentPromptDraft(draftStore, f.agentTypes.resolve(role)!, (await saveDraft(role)).revision)
          const assembly = role === 'custom-draft' ? 'v1' : version
          process.env[key] = version
          await f.sessions.buildSession(sessionId, undefined, { agentType: role, mode, subDraft, promptDraft })
          assert.equal((await store.getState(sessionId))?.promptVersion, assembly)
          assert.deepEqual((await store.getState(sessionId))?.promptDraft, promptDraft)
          assert.deepEqual((await store.getState(sessionId))?.subDraft, subDraft)
          process.env[key] = version === 'v1' ? 'v2' : 'v1'
          const rebuilt = await f.sessions.getContext({ sessionId, preview: true })
          assert.deepEqual(rebuilt.promptIdentity, { role, definition: role, version: assembly, mode,
            ...(subDraft ? { behaviorSource: 'sub-draft', subRevision: revision } : { behaviorSource: 'agent-draft', promptRevision: promptDraft!.revision }) })
          if (subDraft) {
            assert.match(rebuilt.systemPrompt, /Complete the assigned outcome/)
            assert.ok(rebuilt.sections?.some(section => section.name === `sub-behavior.md@${revision}`))
            assert.ok(rebuilt.sections?.some(section => section.name === 'tool-discovery-reference'))
          }
          const { systemPrompt } = await sendFixtureInput(f, sessionId)
          assert.match(systemPrompt, /assembly verification sentinel/)
          assert.match(systemPrompt, new RegExp(`Execution Contract: ${mode === 'task' ? 'Task' : 'Session'}`))
          assert.equal(systemPrompt.startsWith('# Information\n'), assembly === 'v2')
          const live = await f.sessions.getContext({ sessionId })
          assert.deepEqual(live.promptIdentity, rebuilt.promptIdentity)
          assert.equal(live.systemPrompt, systemPrompt)
        }
        process.env[key] = 'v1'
        for (const [sessionId, definition] of [['web:new-general-default', 'general'], [historicalState.sessionId, 'general-v2']] as const) {
          const { systemPrompt } = await sendFixtureInput(f, sessionId)
          assert.match(systemPrompt, /^# Information\n/)
          assert.match(systemPrompt, /Do not turn a review into a change/)
          const live = await f.sessions.getContext({ sessionId })
          assert.equal(live.promptIdentity?.definition, definition)
          assert.equal(live.promptIdentity?.version, 'v2')
        }
      } finally {
        if (original === undefined) delete process.env[key]
        else process.env[key] = original
        await f.close()
      }
    })
  })
}
