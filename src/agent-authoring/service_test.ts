import { ImportTool } from '../tools/load-tool.ts'
import { InvokeTool } from '../tools/invoke-tool.ts'
import { requireToolText } from '../tools/tool.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { Hono } from 'hono'
import { AgentApp } from '../agent/app.ts'
import { AgentTypesManager } from '../agent/types/manager.ts'
import { ContextBuilder } from '../agent/context/builder.ts'
import { IdentityManager } from '../agent/identity.ts'
import { BackgroundTaskManager } from '../agent/background-task.ts'
import { Bus } from '../bus/bus.ts'
import { channelSessionId, type ChannelAddress, type InboundMessage } from '../bus/events.ts'
import { EventService } from '../events/service.ts'
import { McpManager } from '../mcp/manager.ts'
import { SkillsManager } from '../skills/loader.ts'
import { SessionManager } from '../sessions/session-manager.ts'
import { sessionsApiPlugin } from '../sessions/routes.ts'
import { JsonlSessionStore } from '../sessions/session-store-jsonl.ts'
import { SqliteSessionStore } from '../sessions/session-store-sqlite.ts'
import type { SessionStore } from '../sessions/session-store.ts'
import { HandoffManager } from '../sessions/handoff/manager.ts'
import { channelMessageInput } from '../sessions/input.ts'
import { CommandDispatcher } from '../slash-commands/index.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { ChatMessage, LLMProvider, LLMResponse } from '../providers/provider.ts'
import type { RemoteFolderRecord } from '../folders/contracts.ts'
import type { Executor } from '../execution/executor.ts'
import type { ExecutionRequestV2 } from '../execution/contracts.ts'
import { ResourceBundleSchema, type ResourceBundle } from './contracts.ts'
import { AgentResourceStore } from './store.ts'
import { AgentAuthoringService } from './service.ts'
import { CapabilityBroker } from './capabilities.ts'
import { AgentCredentialStore } from './credentials.ts'
import { CredentialRequests } from './credential-requests.ts'
import { PromptCaptureStore } from '../sessions/prompt-capture.ts'
import { authoringManagementTool, authoringCredentialsPlugin, registerAuthoringCommands } from './management.ts'
import { PublicationRequests } from './publication-requests.ts'

const address: ChannelAddress = { projectId: 'project-a', botInstanceId: 'bot-a', platform: 'qq', conversationId: 'group:a' }
const id = channelSessionId(address)
const otherAddress = { ...address, conversationId: 'group:b' }
const llm = { model: 'fixture', contextWindow: 128_000, temperature: 0 }
const done: LLMResponse = { content: 'Handled', toolCalls: [] }

function message(overrides: Partial<InboundMessage> = {}): InboundMessage {
  return {
    channelAddress: address, channel: 'qq', chatId: address.conversationId, senderId: 'member-a',
    messageId: randomUUID(), timestamp: new Date().toISOString(), content: 'Report an issue', isGroup: true, admin: true,
    ...overrides,
  }
}

function bundle(folderId: string): ResourceBundle {
  return ResourceBundleSchema.parse({
    version: 1,
    files: {
      'agents/reader/AGENT.md': '---\ndescription: Group reader\ndefaultMode: session\nallowedTools: [read, search]\n---\nOnly answer questions for group A.',
      'agents/quiet/AGENT.md': '---\ndescription: Group B\ndefaultMode: session\nallowedTools: []\n---\nOnly answer questions for group B.',
    },
    bindings: [
      { ...address, projectId: undefined, agent: 'reader', allowFrom: ['member-a'], readFolders: [folderId] },
      { ...otherAddress, projectId: undefined, agent: 'quiet' },
    ].map(({ projectId: _projectId, ...binding }) => binding),
  })
}

async function waitFor(check: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!check()) {
    assert(Date.now() < deadline, 'Timed out waiting for authoring fixture')
    await delay(2)
  }
}

async function fixture(Store: typeof JsonlSessionStore | typeof SqliteSessionStore = JsonlSessionStore, request?: typeof fetch) {
  await mkdir('.test-data', { recursive: true })
  const root = await mkdtemp(join(process.cwd(), '.test-data', 'agent-authoring-'))
  const home = join(root, 'home')
  const folderPath = join(root, 'docs')
  await mkdir(home)
  await mkdir(folderPath)
  await writeFile(join(folderPath, 'guide.txt'), 'Public project guide\nKnown issue: duplicate reports\n')
  const folder = { id: randomUUID(), projectId: address.projectId, name: 'Public docs', path: folderPath, createdAt: new Date().toISOString() }
  const resources = new AgentResourceStore({ projectId: address.projectId, directory: join(root, 'resources') })
  const credentials = new AgentCredentialStore(join(root, 'credentials'))
  const credentialRequests = new CredentialRequests({ projectId: address.projectId, credentials })
  const store: SessionStore = new Store(join(home, 'sessions'))
  await store.init()
  const bus = new Bus()
  const publicEvents: unknown[] = []
  bus.on('message.outbound', event => { publicEvents.push(event) })
  bus.on('session.input.accepted', event => { publicEvents.push(event) })
  bus.on('session.turn.finished', event => { publicEvents.push(event) })
  const promptCaptures = new PromptCaptureStore(address.projectId)
  const requests: Array<{ messages: ChatMessage[]; tools: string[] }> = []
  let held: Promise<LLMResponse> | undefined
  let nextResponse: LLMResponse | undefined
  const provider: LLMProvider = {
    name: 'fixture', listModels: () => ['fixture'],
    chat: async (messages, tools, options) => {
      requests.push({ messages: structuredClone(messages), tools: tools.map(tool => tool.function.name) })
      if (nextResponse) {
        const response = nextResponse
        nextResponse = undefined
        return response
      }
      if (!held) return done
      const pending = held
      held = undefined
      return await Promise.race([pending, new Promise<never>((_, reject) => {
        options?.signal?.addEventListener('abort', () => reject(options.signal?.reason), { once: true })
      })])
    },
  }
  const events = new EventService(home, bus, (target, input) => sessions.deliver(target, input))
  const tasks = new BackgroundTaskManager(bus, events)
  const handoff = new HandoffManager(provider, llm.contextWindow, { model: 'fixture', autoHandoff: false }, home, store)
  const agentTypes = new AgentTypesManager(home)
  const base = new Tools(home)
  for (const name of ['exec', 'write', 'invoke_tool']) base.register({
    name, description: name, parameters: { type: 'object', properties: {} }, execute: async () => { throw new Error('Privileged tool executed') },
  })
  const broker = new CapabilityBroker({
    projectId: address.projectId, directory: join(root, 'broker'),
    request,
    resolveSecret: async ref => credentials.resolve(ref),
    canDeliver: target => target === 'web:investigator',
    deliver: (target, input) => sessions.deliver(target, input),
  })
  const service = new AgentAuthoringService({
    projectId: address.projectId, workspace: home, store: resources, broker,
    folders: {
      get: target => target === folder.id ? folder : undefined,
      requireAvailable: async target => {
        if (target !== folder.id) throw new Error('Folder no longer available')
        return folder
      },
      acquireAccess: () => () => {},
    },
    legacyAddress: target => target === 'qq:group:a' ? { ...address, legacySessionId: true } : undefined,
  })
  const context = new ContextBuilder(home)
  context.register({ name: 'private', getPromptSection: () => 'PRIVATE PROJECT MEMORY: never show to groups' })
  const sessions: SessionManager = new SessionManager({
    projectId: address.projectId, workspace: home, store, bus, provider, tools: base,
    promptCaptures,
    conversationPolicies: service, handoffManager: handoff, context, agentTypes, events,
    backgroundTasks: tasks, identity: new IdentityManager(home, address.projectId), getLlmRuntimeConfig: () => llm,
  })
  const commands = new CommandDispatcher()
  const management = {
    service, credentials, credentialRequests, inventory: () => ({ bots: [{ id: address.botInstanceId }], folders: [folder] }),
    retire: (matches: (target: string) => boolean) => sessions.retireIdleConversationContexts(matches),
    validateLive: async () => {},
  }
  const publicationRequests = new PublicationRequests(management)
  const tool = authoringManagementTool({ ...management, publicationRequests })
  base.register(tool)
  base.register(new InvokeTool(new ImportTool(new Map([[tool.name, tool]]), home)))
  registerAuthoringCommands(commands, { ...management, publicationRequests })
  const app = new AgentApp({
    bus, sessions, commandDispatcher: commands, agentTypes, events, skills: new SkillsManager(home),
    mcpManager: new McpManager(async () => {}), getLlmRuntimeConfig: () => llm,
  })
  await app.start()
  const owner = message({ channelAddress: undefined, channel: 'web', chatId: 'chat-admin', isGroup: false, senderId: 'owner' })
  const ownerContext: ExecutionContext = {
    ...owner, projectId: address.projectId, sessionId: 'web:chat-admin', physicalSessionId: 'coord-0', inputSource: 'user',
    signal: new AbortController().signal, tools: new SessionTools(base, home),
  }
  ownerContext.tools.setExecutionScope('session', [])
  return {
    root, folder, service, resources, sessions, store, commands, owner, ownerContext, tool, requests, app, credentials,
    credentialRequests, publicationRequests, publicEvents, promptCaptures,
    respondNext(response: LLMResponse) { nextResponse = response },
    hold() {
      const pending = Promise.withResolvers<LLMResponse>()
      held = pending.promise
      return () => pending.resolve(done)
    },
    async stage(value = bundle(folder.id)) {
      return await resources.stage({ expectedRevision: resources.draft().revision, bundle: value })
    },
    publish() { return commands.dispatch(`/agent-publish ${resources.draft().revision}`, { sessionId: 'web:chat-admin', msg: owner, admin: true, llm }) },
    async idle(target = id) {
      await waitFor(() => {
        const active = sessions.getActiveSession(target)
        return !!active && 'quiescent' in active && active.quiescent
      })
    },
    async close() {
      credentialRequests.stop()
      publicationRequests.stop()
      await app.shutdown()
      await tasks.stop()
      await events.stop()
      await handoff.stop()
      store.close?.()
      bus.stopAll()
      await rm(root, { recursive: true, force: true })
    },
  }
}

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: reloaded QQ sticker previews and clearly marked old records stay out of inference`, async () => {
    const f = await fixture(Store)
    const gif = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7'
    const face = '<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">'
    try {
      const imagePath = join(f.root, 'sticker.gif')
      await writeFile(imagePath, Buffer.from(gif.split(',')[1], 'base64'))
      await f.stage()
      await f.publish()
      await f.app.receiveChannelMessage(message({ content: `${face} Keep the text`, media: [imagePath], silent: true,
        displayMetadata: { attachments: [{ path: imagePath, sticker: true }] } }))
      await f.idle()
      assert.equal(f.requests.length, 0)
      await f.sessions.retireIdleConversationContexts(target => target === id)
      await f.store.appendMessages(SessionManager.currentPhysicalId(f.sessions.getSessionState(id)!), [{
        role: 'user', timestamp: new Date().toISOString(),
        content: [{ type: 'text', text: `${face} Historical words` }, { type: 'image_url', image_url: { url: gif } }],
      }])
      await f.app.receiveChannelMessage(message({ content: 'Now reply' }))
      await f.idle()
      const request = f.requests.at(-1)!
      assert(request.messages.every(message => !Array.isArray(message.content) || message.content.every(part => part.type !== 'image_url')))
      assert.match(JSON.stringify(request.messages), /Keep the text/)
      assert.match(JSON.stringify(request.messages), /Historical words/)
      assert.doesNotMatch(JSON.stringify(request.messages), /data:image/)
      const history = f.sessions.getActiveSession(id)!.history
      assert.equal(history.flatMap(message => Array.isArray(message.content) ? message.content.filter(part => part.type === 'image_url') : []).length, 2)
    } finally { await f.close() }
  })

  test(`${Store.name}: published inference settings reach ordinary channel turns and inherit after removal`, async () => {
    const f = await fixture(Store)
    try {
      const value = bundle(f.folder.id)
      const path = 'agents/reader/AGENT.md'
      value.files[path] = value.files[path].replace('description:', 'model: configured-agent-model\nreasoningEffort: low\ntemperature: 0.4\nmaxTokens: 321\nthinking: {type: enabled}\ndescription:')
      await f.stage(value)
      await f.publish()
      await f.app.receiveChannelMessage(message())
      await f.idle()
      let options = f.promptCaptures.list(id)[0].options
      assert.equal(options.model, 'configured-agent-model')
      assert.equal(options.reasoningEffort, 'low')
      assert.equal(options.temperature, 0.4)
      assert.equal(options.maxTokens, 321)
      assert.deepEqual(options.thinking, { type: 'enabled' })
      assert.equal(f.sessions.getSessionState(id)?.config?.model, undefined)
      const http = new Hono()
      sessionsApiPlugin(f.sessions)(http)
      const patch = (body: unknown) => http.request(`/api/sessions/${encodeURIComponent(id)}/config`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      })
      const defaults = { model: 'configured-agent-model', reasoningEffort: 'low', thinking: { type: 'enabled' }, contextWindow: 128_000 }
      assert.deepEqual(f.sessions.getSessionInferenceDefaults(id), defaults)
      const graph = await (await http.request('/api/sessions/graph')).json()
      assert.deepEqual(graph.sessions.find((session: { sessionId: string }) => session.sessionId === id).inferenceDefaults, defaults)
      const published = structuredClone(f.resources.snapshot())
      assert.equal((await patch({ model: 'session-model', reasoningEffort: 'high' })).status, 200)
      assert.deepEqual(f.sessions.getSessionInferenceDefaults(id), defaults, 'Session overrides never replace inherited defaults')
      assert.deepEqual(f.resources.snapshot(), published, 'Session controls do not edit the published Agent')
      await f.app.receiveChannelMessage(message())
      await f.idle()
      options = f.promptCaptures.list(id)[0].options
      assert.equal(options.model, 'session-model')
      assert.equal(options.reasoningEffort, 'high')
      await f.app.receiveChannelMessage(message({ channelAddress: otherAddress, chatId: otherAddress.conversationId }))
      await f.idle(channelSessionId(otherAddress))
      assert.equal(f.promptCaptures.list(channelSessionId(otherAddress)).at(-1)!.options.model, 'fixture')
      assert.equal((await patch({ model: null, thinking: null, reasoningEffort: null })).status, 200)
      await f.app.receiveChannelMessage(message())
      await f.idle()
      assert.equal(f.promptCaptures.list(id)[0].options.model, 'configured-agent-model')
      assert.equal(f.promptCaptures.list(id)[0].options.reasoningEffort, 'low')
      await f.stage()
      await f.publish()
      await f.app.receiveChannelMessage(message())
      await f.idle()
      options = f.promptCaptures.list(id)[0].options
      assert.equal(options.model, 'fixture')
      assert.equal(options.reasoningEffort, undefined)
      assert.equal(options.temperature, 0)
      assert.equal(options.maxTokens, undefined)
    } finally { await f.close() }
  })

  test(`${Store.name}: owner authors and publishes group-specific prompts and strict tools end to end`, async () => {
    const f = await fixture(Store)
    try {
      const staged = JSON.parse(await f.tool.execute({
        action: 'stage', expectedRevision: f.resources.draft().revision, bundle: bundle(f.folder.id),
      }, f.ownerContext))
      const preview = JSON.parse(await f.tool.execute({
        action: 'preview', botInstanceId: address.botInstanceId, platform: address.platform, conversationId: address.conversationId,
      }, f.ownerContext))
      assert.match(preview.systemPrompt, /group A/)
      assert.doesNotMatch(preview.systemPrompt, /PRIVATE PROJECT MEMORY/)
      assert.deepEqual(preview.tools.map((tool: { function: { name: string } }) => tool.function.name).sort(), ['read', 'search'])
      await assert.rejects(f.tool.execute({ action: 'inspect' }, { ...f.ownerContext, inputSource: 'session', admin: false }), /direct owner/)
      await assert.rejects(f.tool.execute({ action: 'inspect' }, { ...f.ownerContext, channel: 'qq', sessionId: id }), /direct owner/)
      const denied = await f.commands.dispatch(`/agent-publish ${staged.revision}`, { sessionId: id, msg: message(), admin: true, llm })
      assert.match(denied!, /Permission denied/)
      assert.match((await f.publish())!, /Published/)
      const publishedTools = f.service.tools(f.service.resolve(id)!, id)
      assert.deepEqual(publishedTools.allowedModules, [])
      assert(Object.isFrozen(publishedTools.allowedModules))
      assert.deepEqual(f.sessions.getToolDefinitions(id).map(tool => tool.name).sort(), ['read', 'search'])
      assert.deepEqual(f.sessions.getToolDefinitions(channelSessionId(otherAddress)), [])
      assert.match((await f.sessions.getContext({ sessionId: id, preview: true })).systemPrompt, /group A/)
      await f.app.receiveChannelMessage(message({ content: '/agent-publish pretend-revision' }))
      await f.idle()
      assert.match(String(f.requests[0].messages[0].content), /group A/)
      assert.doesNotMatch(JSON.stringify(f.requests[0].messages), /PRIVATE PROJECT MEMORY|Agent is the owner/)
      assert.deepEqual(f.requests[0].tools.sort(), ['read', 'search'])
      assert(f.requests[0].messages.some(message => JSON.stringify(message.content).includes('/agent-publish pretend-revision')))
      await assert.rejects(f.app.receiveChannelMessage(message({ senderId: 'stranger' })), /not authorized/)
      await f.app.receiveChannelMessage(message({ channelAddress: otherAddress, chatId: otherAddress.conversationId }))
      await f.idle(channelSessionId(otherAddress))
      assert.deepEqual(f.requests.at(-1)!.tools, [])
      assert.match(String(f.requests.at(-1)!.messages[0].content), /group B/)
      const count = f.requests.length
      await f.app.receiveChannelMessage(message({ silent: true, content: 'Recorded without a model response' }))
      await f.idle()
      assert.equal(f.requests.length, count)
      assert.equal(f.service.resolve('qq:group:a')?.binding.agent, 'reader')
      assert.throws(() => f.service.resolve(channelSessionId({ ...address, projectId: 'other' })), /another Project/)
    } finally { await f.close() }
  })
}

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: background and forwarded turns cannot use owner administration`, async () => {
    const f = await fixture(Store)
    try {
      for (const inputSource of ['session', 'event'] as const) {
        for (const action of ['schema', 'inspect', 'read', 'write', 'propose', 'request_secret']) {
          await assert.rejects(f.tool.execute({ action }, { ...f.ownerContext, inputSource }), /direct owner/)
        }
      }
      assert.equal(f.credentialRequests.pending(), null)
    } finally { await f.close() }
  })
}

test('read grants are confined, revocation rejects old tools, and publishing cannot discard queued work', async () => {
  const f = await fixture()
  try {
    await f.stage()
    assert.match((await f.publish())!, /Published/)
    const policy = f.service.resolve(id)!
    const tools = f.service.tools(policy, id)
    const context = { ...f.ownerContext, ...message(), projectId: address.projectId, sessionId: id, tools }
    assert.match(requireToolText(await tools.execute('read', { path: `folder:${f.folder.id}/guide.txt` }, context)), /Public project guide/)
    const search = JSON.parse(requireToolText(await tools.execute('search', { path: `folder:${f.folder.id}/guide.txt`, query: 'duplicate' }, context)))
    assert.equal(search.matches[0].line, 2)
    for (const path of ['v:memory', 'https://example.com', `folder:foreign/guide.txt`, `folder:${f.folder.id}/../outside`, `folder:${f.folder.id}/.env`]) {
      assert.match(requireToolText(await tools.execute('read', { path }, context)), /Error|not permitted|authorized/)
    }
    for (const name of ['exec', 'write', 'invoke_tool', 'project_config', 'message', 'subagent']) assert.equal(tools.has(name), false)
    const release = f.hold()
    await f.app.receiveChannelMessage(message())
    await waitFor(() => f.requests.length === 1)
    await f.app.receiveChannelMessage(message({ content: 'queued follow-up' }))
    const next = bundle(f.folder.id)
    next.bindings[0].enabled = false
    await f.stage(next)
    assert.match((await f.publish())!, /active or queued work/)
    assert.equal(f.resources.snapshot().revision, policy.revision)
    release()
    await waitFor(() => f.requests.length === 2)
    await f.idle()
    assert.match((await f.publish())!, /Published/)
    assert.match(requireToolText(await tools.execute('read', { path: `folder:${f.folder.id}/guide.txt` }, context)), /disabled|no longer published/)
    await assert.rejects(f.app.receiveChannelMessage(message()), /disabled|no longer published/)
    const rollback = await f.commands.dispatch(`/agent-rollback ${policy.revision} ${f.resources.snapshot().revision}`, { sessionId: 'web:chat-admin', msg: f.owner, admin: true, llm })
    assert.match(rollback!, /Restored/)
    assert.equal(f.resources.draft().bundle.bindings[0].enabled, false)
    await f.app.receiveChannelMessage(message())
    await f.idle()
    assert.deepEqual(f.requests.at(-1)!.tools.sort(), ['read', 'search'])
  } finally { await f.close() }
})

test('credentials are authenticated write-only resources and survive restart without entering snapshots', async () => {
  const f = await fixture()
  try {
    const app = new Hono()
    authoringCredentialsPlugin(f.credentials, request => request.headers.get('authorization') === 'Bearer fixture-owner')(app)
    assert.equal((await app.request('/api/agent-resources/credentials')).status, 401)
    const headers = { authorization: 'Bearer fixture-owner', 'content-type': 'application/json' }
    assert.equal((await app.request('/api/agent-resources/credentials/service-token', { method: 'PUT', headers, body: JSON.stringify({ value: 'synthetic-private-value' }) })).status, 200)
    const listing = await (await app.request('/api/agent-resources/credentials', { headers })).text()
    assert.equal(listing, '{"names":["service-token"]}')
    assert.equal(new AgentCredentialStore(join(f.root, 'credentials')).resolve('service-token'), 'synthetic-private-value')
    assert.doesNotMatch(await f.tool.execute({ action: 'inspect' }, f.ownerContext), /synthetic-private-value/)
    assert.doesNotMatch(JSON.stringify(f.resources.snapshot()), /synthetic-private-value/)
    assert.equal((await app.request('/api/agent-resources/credentials/service-token', { method: 'DELETE', headers })).status, 200)
    assert.equal(f.credentials.resolve('service-token'), undefined)
  } finally { await f.close() }
})

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  for (const sessionId of ['web:chat-admin']) test(`${Store.name} ${sessionId}: private credential input resumes its session without entering provider input, history or public events`, async () => {
    const f = await fixture(Store)
    const secret = 'synthetic-owner-value-NEVER-IN-MODEL'
    try {
      await f.sessions.buildSession(sessionId, undefined, { agentType: 'general', mode: 'session' })
      const http = new Hono()
      const headers = { authorization: 'test-owner-access', 'content-type': 'application/json' }
      authoringCredentialsPlugin(f.credentials, request => request.headers.get('authorization') === headers.authorization, f.credentialRequests)(http)
      f.respondNext({
        content: null,
        toolCalls: [{ id: 'credential-fixture', name: 'invoke_tool', arguments: { name: 'project_config', args: {
          action: 'request_secret', secretRef: 'github-issues', purpose: 'Read issues for the reviewed repository.',
        } } }],
      })
      await f.app.receiveChannelMessage({ ...f.owner, chatId: sessionId.slice(4) })
      await waitFor(() => f.credentialRequests.pending() !== null)
      const endpoint = '/api/agent-resources/credential-requests'
      assert.equal((await http.request(endpoint)).status, 401)
      const listing = await http.request(endpoint, { headers })
      assert.equal(listing.headers.get('cache-control'), 'no-store')
      const { request } = await listing.json()
      assert.equal(request.secretRef, 'github-issues')
      assert.equal(request.sessionId, sessionId)
      assert(!f.requests[0].tools.includes('project_config'), 'complex schema is not resident')
      assert(f.requests[0].tools.includes('invoke_tool'))
      const submit = `${endpoint}/${request.id}`
      assert.equal((await http.request(submit, { method: 'POST', body: JSON.stringify({ value: secret }) })).status, 401)
      assert.equal((await http.request(submit, { method: 'DELETE' })).status, 401)
      const invalid = await http.request(submit, { method: 'POST', headers, body: JSON.stringify({ value: `${secret}\n` }) })
      assert.equal(invalid.status, 400)
      assert.doesNotMatch(await invalid.text(), /synthetic-owner-value/)
      assert.equal(f.requests.length, 1, 'Invalid entry does not resume the model')
      assert.equal(f.credentials.resolve('github-issues'), undefined)
      const saved = await http.request(submit, { method: 'POST', headers, body: JSON.stringify({ value: secret }) })
      assert.equal(saved.status, 200)
      const receipt = await saved.json()
      assert.deepEqual(receipt.result, { requestId: request.id, secretRef: 'github-issues', status: 'saved' })
      assert.equal(f.credentials.resolve('github-issues'), secret)
      await f.idle(sessionId)
      assert.equal(f.requests.length, 2)
      const toolResult = f.requests[1].messages.find(message => message.tool_call_id === 'credential-fixture')
      assert.deepEqual(JSON.parse(String(toolResult?.content)), receipt.result)
      const state = f.sessions.getSessionState(sessionId)!
      const log = await Array.fromAsync(f.store.readSessionLog(SessionManager.currentPhysicalId(state)))
      assert.doesNotMatch(JSON.stringify([
        receipt, log, f.requests, f.publicEvents, f.resources.snapshot(), f.resources.draft(),
        f.promptCaptures.list(sessionId), await f.sessions.getContext({ sessionId, preview: true }),
      ]), /synthetic-owner-value/)
      const duplicate = await http.request(submit, { method: 'POST', headers, body: JSON.stringify({ value: 'must-not-replace' }) })
      assert.equal(duplicate.status, 409)
      assert.equal(f.credentials.resolve('github-issues'), secret)
      assert.deepEqual(await (await http.request(endpoint, { headers })).json(), { request: null })
    } finally { await f.close() }
  })
}

test('credential requests require direct owner coordination and cancellation returns no value', async () => {
  const f = await fixture()
  const args = { action: 'request_secret', secretRef: 'service-token', purpose: 'Access the reviewed service.' }
  try {
    for (const context of [
      { ...f.ownerContext, inputSource: 'session' as const },
      { ...f.ownerContext, projectId: 'another-project' },
      { ...f.ownerContext, channel: 'qq', sessionId: id, isGroup: true },
      { ...f.ownerContext, admin: false },
    ]) await assert.rejects(f.tool.execute(args, context), /direct owner/)
    for (const mode of ['task', 'call'] as const) {
      const tools = new SessionTools(new Tools('.'), '.')
      tools.setExecutionScope(mode, [])
      await assert.rejects(f.tool.execute(args, { ...f.ownerContext, tools }), /direct owner/)
    }
    assert.equal(f.credentialRequests.pending(), null)
    const pending = f.tool.execute(args, { ...f.ownerContext, sessionId: 'web:ordinary' })
    const request = f.credentialRequests.pending()!
    assert.equal(request.sessionId, 'web:ordinary')
    const http = new Hono()
    authoringCredentialsPlugin(f.credentials, () => true, f.credentialRequests)(http)
    const cancelled = await http.request(`/api/agent-resources/credential-requests/${request.id}`, { method: 'DELETE' })
    assert.equal(cancelled.status, 200)
    assert.deepEqual(JSON.parse(await pending), { requestId: request.id, secretRef: 'service-token', status: 'cancelled' })
    assert.equal(f.credentials.resolve('service-token'), undefined)
  } finally { await f.close() }
})

test('publication fences concurrent admission and empty sender allowlists deny everyone', async () => {
  const f = await fixture()
  const gate = Promise.withResolvers<void>()
  try {
    const next = bundle(f.folder.id)
    next.bindings[0].allowFrom = []
    const draft = await f.stage(next)
    const publishing = f.service.changePublished(() => gate.promise, () => f.resources.publish(draft.revision))
    await assert.rejects(f.app.receiveChannelMessage(message()), /being published/)
    gate.resolve()
    await publishing
    await assert.rejects(f.app.receiveChannelMessage(message()), /not authorized/)
    assert.equal(f.requests.length, 0)
  } finally {
    gate.resolve()
    await f.close()
  }
})

test('coordinator discovers a valid authoring template without existing custom resources', async () => {
  const f = await fixture()
  try {
    const guide = JSON.parse(await f.tool.execute({ action: 'schema' }, f.ownerContext))
    const rules = guide.rules.join(' ')
    for (const contract of [
      /ESM export async function run\(args\)/,
      /exact imports.*allowedModules.*omitted allowedModules means no imports/,
      /Raw native filesystem\/network modules.*not readFolders or named grant restrictions/,
      /Node VM.*not an OS sandbox/,
      /Synthetic tests and read-only probes refuse native modules/,
      /agent_tool_test.*HTTP results are \{status, body\}/,
      /Mock capabilityResults.*throws.*sequence.*http_status/,
      /probe.*unchanged existing owner-approved GET grants/,
      /request_secret.*private credential entry/,
      /propose.*owner Publish\/Cancel buttons/,
    ]) assert.match(rules, contract)
    await f.stage(ResourceBundleSchema.parse(guide.example))
    assert.deepEqual(f.resources.validate().errors, [])
    const before = f.resources.snapshot().revision
    const proposal = JSON.parse(await f.tool.execute({ action: 'propose' }, f.ownerContext))
    assert.equal(proposal.ownerCommand, `/agent-publish ${f.resources.draft().revision}`)
    const review = f.publicationRequests.pending()!
    const { files, previousBindings, bindings, impact, ...metadata } = review
    assert.deepEqual(proposal.request, metadata)
    assert.deepEqual(proposal.changedFiles, files.map(file => file.path))
    assert.equal(proposal.bindingCount, bindings.length)
    assert.equal(proposal.previousBindingCount, previousBindings.length)
    assert.equal('bindings' in proposal, false)
    assert.equal('files' in proposal.request, false)
    assert.equal(JSON.stringify(proposal).includes(JSON.stringify(guide.example.files['agents/support/AGENT.md'])), false)
    assert.equal(f.resources.snapshot().revision, before)
    await f.publish()
    assert.equal(f.publicationRequests.pending(), null)
    assert.equal(f.resources.snapshot().revision, proposal.request.revision)
  } finally { await f.close() }
})

test('remote reads route through the granted capability and never open its local-looking display path', async () => {
  const f = await fixture()
  try {
    await f.stage()
    await f.publish()
    const folder: RemoteFolderRecord = {
      ...f.folder, kind: 'remote',
      workdir: { version: 2, nodeId: 'child', workdirId: 'public-docs' },
      identity: { version: 1, rootId: 'a'.repeat(64), ancestorIds: [] },
    }
    const jobs: ExecutionRequestV2[] = []
    const executor: Executor = {
      execute: async function* (request) {
        jobs.push(request)
        const timestamp = new Date().toISOString()
        yield { version: 1, jobId: request.jobId, sequence: 0, timestamp, type: 'stdout', chunk: 'Remote-only documentation' }
        yield {
          version: 1, jobId: request.jobId, sequence: 1, timestamp, type: 'completed',
          receipt: { version: 1, jobId: request.jobId, nodeId: request.nodeId, state: 'completed', finishedAt: timestamp },
        }
      },
      getStatus: async () => null,
      cancel: async jobId => ({ version: 1, jobId, outcome: 'not-found', timestamp: new Date().toISOString(), status: null }),
    }
    const options = {
      ...f.service.options, remoteExecutor: executor,
      folders: { get: () => folder, requireAvailable: async () => folder, acquireAccess: () => () => {} },
    }
    const service = new AgentAuthoringService(options)
    const policy = service.resolve(id)!
    const tools = service.tools(policy, id)
    const context = { ...f.ownerContext, ...message(), sessionId: id, tools }
    assert.equal(await tools.execute('read', { path: `folder:${folder.id}/guide.txt` }, context), 'Remote-only documentation')
    assert.equal(jobs[0].nodeId, 'child')
    assert.equal(jobs[0].workdirId, 'public-docs')
    assert.deepEqual(jobs[0].args, { path: 'guide.txt' })
    assert.equal(jobs[0].sessionId, id)
    const unavailable = new AgentAuthoringService({ ...options, remoteExecutor: undefined }).tools(policy, id)
    assert.match(requireToolText(await unavailable.execute('read', { path: `folder:${folder.id}/guide.txt` }, { ...context, tools: unavailable })), /no local path/)
    folder.projectId = 'other-project'
    assert.match(requireToolText(await tools.execute('read', { path: `folder:${folder.id}/guide.txt` }, context)), /does not belong/)
    assert.equal(jobs.length, 1)
  } finally { await f.close() }
})

test('draft assertions use the shared evaluator with explicit expected evidence and synthetic grants', async () => {
  const f = await fixture()
  try {
    const guide = JSON.parse(await f.tool.execute({ action: 'schema' }, f.ownerContext))
    await f.stage(ResourceBundleSchema.parse(guide.example))
    const { botInstanceId, platform, conversationId } = guide.example.bindings[0]
    const expected = { status: 200, body: { healthy: true } }
    const args = {
      action: 'test', botInstanceId, platform, conversationId, toolName: 'service_status',
      capabilityResults: { 'service-read': expected }, assertion: { expected },
    }
    const passing = JSON.parse(await f.tool.execute(args, f.ownerContext))
    assert.deepEqual(passing.evaluation, { name: 'service_status', passed: true, actual: expected, expected })
    assert.deepEqual(passing.result, expected)
    assert.equal(passing.synthetic, true)
    const mismatch = JSON.parse(await f.tool.execute({ ...args, assertion: { expected: null } }, f.ownerContext))
    assert.deepEqual(mismatch.evaluation, { name: 'service_status', passed: false, actual: expected, expected: null })
    const failure = JSON.parse(await f.tool.execute({ ...args, capabilityResults: {} }, f.ownerContext))
    assert.equal(failure.evaluation.passed, false)
    assert.match(failure.evaluation.error, /mock_missing/)
    await assert.rejects(f.tool.execute({ ...args, assertion: {} }, f.ownerContext), /explicit expected/)
    await assert.rejects(f.tool.execute({ ...args, assertion: { expected: undefined } }, f.ownerContext), /JSON/)
    await assert.rejects(f.tool.execute(args, { ...f.ownerContext, signal: AbortSignal.abort() }))
    assert.equal(f.requests.length, 0)
  } finally { await f.close() }
})

test('explicit native filesystem imports run in Project Home, never synthetic tests or a remote workdir', async () => {
  const f = await fixture()
  try {
    const next = bundle(f.folder.id)
    next.files['agents/reader/AGENT.md'] = '---\ndescription: Native fixture writer\nallowedTools: [record]\nallowedModules: ["node:fs/promises"]\n---\nWrite the fixed fixture using record.'
    next.files['skills/native/SKILL.md'] = '---\nname: native\ndescription: Native fixture\ntools:\n  record:\n    source: record.js\n    description: Write a fixed fixture\n    imports: ["node:fs/promises"]\n    parameters:\n      type: object\n      additionalProperties: false\n---\nUse only the fixed record operation.'
    next.files['skills/native/record.js'] = 'import {writeFile,readFile} from "node:fs/promises"; export async function run() { await writeFile("native-owned-fixture.txt","fixed fixture"); return await readFile("native-owned-fixture.txt","utf8"); }'
    next.bindings[0].skills = ['native']
    next.bindings[0].readFolders = []
    await f.stage(next)
    await assert.rejects(f.tool.execute({
      action: 'test', botInstanceId: address.botInstanceId, platform: address.platform,
      conversationId: address.conversationId, toolName: 'record',
    }, f.ownerContext), /test\/probe mode refuses effectsful native imports/)
    const output = join(f.service.options.workspace, 'native-owned-fixture.txt')
    await assert.rejects(readFile(output), { code: 'ENOENT' })
    assert.match((await f.publish())!, /Published/)
    const policy = f.service.resolve(id)!
    const tools = f.service.tools(policy, id)
    const context = { ...f.ownerContext, ...message(), sessionId: id, tools }
    const executor: Executor = {
      execute: async function* () { throw new Error('Native filesystem must not execute remotely') },
      getStatus: async () => { throw new Error('Unexpected remote status request') },
      cancel: async () => { throw new Error('Unexpected remote cancellation') },
    }
    assert.match(requireToolText(await tools.execute('record', {}, {
      ...context, remoteWorkdir: { nodeId: 'child', workdirId: 'remote-folder', executor },
    })), /does not support remote workdirs/)
    await assert.rejects(readFile(output), { code: 'ENOENT' })
    assert.equal(JSON.parse(requireToolText(await tools.execute('record', {}, context))), 'fixed fixture')
    assert.equal(await readFile(output, 'utf8'), 'fixed fixture')
    await f.stage(bundle(f.folder.id))
    await f.publish()
    assert.match(requireToolText(await tools.execute('record', {}, context)), /policy changed/)
  } finally { await f.close() }
})

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
test(`${Store.name}: published custom tool reaches only its granted HTTP route and fixed inbox`, async () => {
  const sent: Array<{ url: string; authorization: string | null }> = []
  const f = await fixture(Store, async (input, init) => {
    sent.push({ url: String(input), authorization: new Headers(init?.headers).get('authorization') })
    return new Response(JSON.stringify({ report: 12 }), { headers: { 'content-type': 'application/json' } })
  })
  try {
    f.credentials.put('report-token', 'synthetic-auth-token')
    await f.sessions.buildSession('web:investigator', undefined, { mode: 'session', sessionKind: 'topic' })
    const next = bundle(f.folder.id)
    next.files['agents/reader/AGENT.md'] = '---\ndescription: Feedback collector\ndefaultMode: session\nallowedTools: [submit]\nallowedModules: ["@shadow/reports", "@shadow/wake"]\n---\nCollect useful reports. Do not implement fixes.'
    next.files['skills/feedback/SKILL.md'] = `---
name: feedback
description: Submit a report and wake its investigator
tools:
  submit:
    source: submit.js
    description: Submit a report
    parameters:
      type: object
      properties:
        title: { type: string }
        key: { type: string }
      required: [title, key]
      additionalProperties: false
    imports: ["@shadow/reports", "@shadow/wake"]
---
Collect sufficient context before submitting.
`
    next.files['skills/feedback/submit.js'] = `import reportRequest from '@shadow/reports';
        import {call as wakeInvestigator} from '@shadow/wake';
        export async function run(args) {
          const report = await reportRequest({method:'POST',path:'/reports',body:{title:args.title},idempotencyKey:args.key});
          const wake = await wakeInvestigator({content:'Investigate report ' + JSON.stringify(report),idempotencyKey:args.key});
          return {report,wake,process:typeof process,require:typeof require,fetch:typeof fetch};
        }`
    next.bindings[0].skills = ['feedback']
    next.bindings[0].grants = [
      { id: 'reports', kind: 'http', origin: 'https://example.com', routes: [{ method: 'POST', path: '/reports' }],
        credential: { secretRef: 'report-token', header: 'Authorization', prefix: 'Bearer ' } },
      { id: 'wake', kind: 'inbox', sessionId: 'web:investigator' },
    ]
    await f.stage(next)
    assert.deepEqual(f.resources.validate().errors, [])
    await assert.rejects(f.tool.execute({
      action: 'test', botInstanceId: address.botInstanceId, platform: address.platform, conversationId: address.conversationId,
      toolName: 'submit', testArguments: { title: 'Invalid fixture', key: 'invalid-fixture' },
      capabilityResults: { reports: { report: 0 }, wake: { admitted: true } },
    }, f.ownerContext))
    assert.equal(sent.length, 0)
    const simulated = JSON.parse(await f.tool.execute({
      action: 'test', botInstanceId: address.botInstanceId, platform: address.platform, conversationId: address.conversationId,
      toolName: 'submit', testArguments: { title: 'Synthetic test', key: 'synthetic-test' },
      capabilityResults: { reports: { status: 200, body: { report: 0 } }, wake: { status: 'admitted', sessionId: 'web:investigator', inputId: randomUUID() } },
    }, f.ownerContext))
    assert.equal(simulated.synthetic, true)
    assert.equal(simulated.policy.kind, 'restricted')
    assert.deepEqual(simulated.policy.imports, ['@shadow/reports', '@shadow/wake'])
    assert.match(simulated.sourceHash, /^sha256:[a-f0-9]{64}$/)
    assert.deepEqual(simulated.calls.map((call: { name: string }) => call.name), ['reports', 'wake'])
    assert.equal(sent.length, 0)
    assert.equal(f.requests.length, 0)
    assert.match((await f.publish())!, /Published/)
    await f.app.receiveChannelMessage(message())
    await f.idle()
    const tools = f.service.tools(f.service.resolve(id)!, id)
    assert.deepEqual(tools.allowedModules, ['@shadow/reports', '@shadow/wake'])
    assert(Object.isFrozen(tools.allowedModules))
    const context = { ...f.ownerContext, ...message(), sessionId: id, tools, toolCallId: 'submit-1' }
    assert.deepEqual(tools.getDefinitions().map(tool => tool.function.name), ['submit'])
    const first = await tools.execute('submit', { title: 'A reproducible report', key: 'issue-1' }, context)
    assert.doesNotMatch(requireToolText(first), /synthetic-auth-token/)
    const result = JSON.parse(requireToolText(first))
    assert.equal(result.process, 'undefined')
    assert.equal(result.require, 'undefined')
    assert.equal(result.fetch, 'undefined')
    await f.idle('web:investigator')
    assert.equal(sent.length, 1)
    assert.equal(sent[0].authorization, 'Bearer synthetic-auth-token')
    const replay = await tools.execute('submit', { title: 'A reproducible report', key: 'issue-1' }, { ...context, toolCallId: 'submit-2' })
    assert.doesNotMatch(requireToolText(replay), /synthetic-auth-token/)
    assert.equal(sent.length, 1)
    assert.equal(f.requests.filter(request => JSON.stringify(request.messages).includes('Investigate report')).length, 1)
    assert.match(requireToolText(await tools.execute('submit', { title: 123, key: 'bad' }, context)), /Invalid tool arguments/)
    assert.equal(sent.length, 1)
  } finally { await f.close() }
})
}
