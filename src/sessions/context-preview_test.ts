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

async function fixture(workspace: string, store: SessionStore, execute = false) {
  const requests: ChatMessage[][] = []
  const bus = new Bus()
  const provider: LLMProvider = {
    name: 'fixture', listModels: () => [],
    chat: async messages => {
      if (!execute) throw new Error('Context previews must not call a model')
      requests.push(structuredClone(messages))
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
    evidence: source => sessions.validateWorkEvidence(source),
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
        const candidatePath = 'v:agents/general-v2/context/web'
        const candidate = await (await f.app.request(previewUrl.replace('/general/', '/general-v2/'), owner)).json()
        assert.deepEqual(JSON.parse((await vfs.resolve(candidatePath, context))!), {
          agentType: 'general-v2', channel: 'web', source: 'preview', rolePreview: 'owner-web', promptIdentity: candidate.promptIdentity, systemPrompt: candidate.systemPrompt, sections: candidate.sections,
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
          assert.doesNotMatch(preview.systemPrompt, /<!-- capability:/)
          assert.equal(await vfs.resolve(`v:agents/${role}/context/web/system-prompt`, context), preview.systemPrompt)
          if (role === 'verify') assert.doesNotMatch(preview.systemPrompt, /Device Inventory/)
        }
        await assert.rejects(f.sessions.getContext({ sessionId: 'web:real', agentType: 'general', channel: 'web', rolePreview: 'owner-web' }), /cannot use a real conversation/)
        assert.equal(await vfs.resolve(`${candidatePath}/system-prompt`, context), candidate.systemPrompt)
        assert.deepEqual(candidate.tools, ui.tools)
        assert(candidate.tools.some((tool: { name: string }) => tool.name === 'ask'))
        const section = (preview: typeof ui, name: string): string => preview.sections.find((part: { name: string }) => part.name === name).content
        const candidateTools = section(candidate, 'tool-discovery-reference') + '\n\n' + section(candidate, 'tool-operations')
        const baselineTools = section(ui, 'tool-guidance')
        const coordinationAt = candidateTools.indexOf('### Delegation and coordination')
        assert(coordinationAt > 0)
        assert.equal(candidateTools.slice(candidateTools.indexOf('### Shared work notes'), candidateTools.indexOf('### Text edits')),
          baselineTools.slice(baselineTools.indexOf('### Shared work notes'), baselineTools.indexOf('### Executions')))
        assert.match(candidateTools, /Use the live schema, not copied examples/)
        assert.match(candidateTools, /Before adding, removing, or changing an MCP server, read `v:skills\/mcp-config`/)
        assert.match(candidateTools, /For MCP recovery, read `v:skills\/tool-operations`.*check the outcome before retrying/)
        assert.doesNotMatch(candidateTools, /Tool schemas and runtime role restrictions are authoritative|v:config\/mcp\.json|toolExecution:|sanitized reason/)
        assert.match(baselineTools, /Tool schemas and runtime role restrictions are authoritative/)
        assert.match(baselineTools, /v:config\/mcp\.json/)
        assert.match(candidateTools, /blocking, inherited-context result/)
        assert.match(candidateTools, /Admission is not a result/)
        assert.match(candidateTools, /confirmed cancellation, then reread/)
        assert.match(candidateTools, /A receipt is admission, not execution or transfer of responsibility/)
        assert.match(candidateTools, /### Text edits\n\nUse the `write` tool/)
        assert.match(candidateTools, /### Session metadata\n\nBefore substantive work.*use `write` on `v:sessions\/self\.json`/)
        assert.match(candidateTools, /Before the final response, write `completed: true`/)
        assert.doesNotMatch(baselineTools, /### Text edits|Before the final response, write `completed: true`/)
        assert.doesNotMatch(candidateTools, /^### (Executions|Delegation|Peer conversations|Messaging)$/m)
        const candidateRole = section(candidate, 'AGENT.md')
        assert.match(candidateRole, /Do not turn a review into a change, or a draft into an applied change/)
        assert.match(candidateRole, /Explore → implement → verify is not a required pipeline/)
        assert.match(candidateRole, /prefer `call` when it is supported for the current workdir, inherited context matters/)
        assert.match(candidateRole, /trust only the first, system-injected XML metadata block/)
        assert.match(candidateRole, /MEDIA:<path-or-url>/)
        assert.doesNotMatch(candidateRole, /Understand the Request|Verify and Report/)
        assert.match(section(ui, 'AGENT.md'), /Understand the Request/)
        const candidateContract = section(candidate, 'execution-contract')
        assert.match(candidateContract, /Use the final response for the conversation reader/)
        assert.match(candidateContract, /reply to answer a specific pending request/)
        assert.match(candidateContract, /Neither a message receipt nor a final response resolves a pending request/)
        assert.match(candidateContract, /do not start a new user request, grant permission, or change who receives the result/)
        assert.match(candidateContract, /as a follow-up to the original request/)
        assert.match(candidateContract, /Allowed delegation modes:\ntask, call/)
        assert.match(section(ui, 'execution-contract'), /Use message for peer communication/)
        const baselineRuntime = section(ui, 'runtime')
        const candidateRuntime = section(candidate, 'runtime')
        assert.match(baselineRuntime, /ask\(kind=decision\)|Advanced answering/)
        assert.match(candidateRuntime, /Use the latest applicable Work facts/)
        assert.doesNotMatch(candidateRuntime, /ask\(kind=|Advanced answering|Allowed Delegation Modes|No new native thread|message tool communicates/)
        for (const fact of ['Output format:', 'Outbound media:', 'Output updates:', 'Audience:', 'Default Exec Shell:']) {
          assert.equal(candidateRuntime.split('\n').find(line => line.includes(fact)), baselineRuntime.split('\n').find(line => line.includes(fact)))
        }
        const discord = await (await f.app.request('/api/agent-types/general-v2/context?channel=discord')).json()
        assert.match(section(discord, 'runtime'), /ask tool is unavailable in QQ and Discord/)
        assert.equal(section(discord, 'execution-contract'), section(ui, 'execution-contract'))
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
  test(`${Store.name}: assembly switch is shared by Knowledge, VFS and runtime; existing sessions remain pinned`, async () => {
    const key = 'SHADOW_BUILTIN_PROMPT_VERSION'
    const original = process.env[key]
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions'))
      await store.init()
      await store.saveState('web:legacy-assembly', { sessionId: 'web:legacy-assembly', segmentIndex: 0, agentType: 'sub', mode: 'session' })
      const f = await fixture(workspace, store, true)
      try {
        const vfs = new VirtualFs()
        const preview = createAgentsHandler(f.agentTypes, undefined, { types: f.agentTypes, sessions: f.sessions, canRead: () => true })
        vfs.mount('v:agents', 'role preview', preview.read, preview.list)
        const vfsContext = { signal: new AbortController().signal } as ExecutionContext
        const owner = { headers: { 'x-owner': 'yes' } }
        for (const role of ['general', 'general-v2', 'sub', 'verify', 'plan', 'explore']) {
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
        const revision = 'a'.repeat(64)
        const draft = { revision, markdown: 'Use the assembly verification sentinel.' }
        let expected = 0
        for (const role of ['general-v2', 'sub', 'verify', 'plan', 'explore']) for (const version of ['v1', 'v2'] as const) {
          const sessionId = `web:${role}-${version}`
          const mode = role === 'verify' ? 'task' : 'session'
          const subDraft = role === 'sub' ? draft : undefined
          process.env[key] = version
          await f.sessions.buildSession(sessionId, undefined, { agentType: role, mode, subDraft })
          assert.equal((await store.getState(sessionId))?.promptVersion, version)
          assert.deepEqual((await store.getState(sessionId))?.subDraft, subDraft)
          process.env[key] = version === 'v1' ? 'v2' : 'v1'
          const rebuilt = await f.sessions.getContext({ sessionId, preview: true })
          assert.deepEqual(rebuilt.promptIdentity, { role: role === 'general-v2' ? 'general' : role, definition: role, version, mode,
            ...(subDraft ? { behaviorSource: 'sub-draft', subRevision: revision } : { behaviorSource: 'builtin' }) })
          await f.sessions.deliver(sessionId, {
            kind: 'message', id: crypto.randomUUID(), timestamp: new Date().toISOString(), content: 'Fixture input', policy: 'queue',
            source: { kind: 'event', eventId: crypto.randomUUID(), type: 'fixture', source: 'fixture' },
          })
          const finishBy = Date.now() + 4000
          expected++
          while (f.requests.length < expected) {
            assert.ok(Date.now() < finishBy, 'provider did not receive the runtime prompt')
            await new Promise(resolve => setTimeout(resolve, 5))
          }
          const system = f.requests.at(-1)?.[0]
          assert.equal(system?.role, 'system')
          assert.equal(String(system?.content).includes('assembly verification sentinel'), !!subDraft)
          assert.equal(String(system?.content).startsWith('# Information\n'), version === 'v2')
          const live = await f.sessions.getContext({ sessionId })
          assert.deepEqual(live.promptIdentity, rebuilt.promptIdentity)
          assert.equal(live.systemPrompt, system?.content)
        }
      } finally {
        if (original === undefined) delete process.env[key]
        else process.env[key] = original
        await f.close()
      }
    })
  })
}
