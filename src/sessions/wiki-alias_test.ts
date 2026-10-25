import assert from 'node:assert/strict'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test, { type TestContext } from 'node:test'
import { BackgroundTaskManager } from '../agent/background-task.ts'
import { ContextBuilder } from '../agent/context/builder.ts'
import { executionContractProvider, guidelineProvider } from '../agent/context/guideline.ts'
import { runtimeDiscoveryProvider } from '../agent/context/runtime.ts'
import { workspaceProvider } from '../agent/context/workspace.ts'
import { IdentityManager } from '../agent/identity.ts'
import { AgentTypesManager } from '../agent/types/manager.ts'
import { Bus } from '../bus/bus.ts'
import { DEFAULT_COPILOT_MODEL } from '../config/defaults.ts'
import { EventService } from '../events/service.ts'
import { FolderRegistry } from '../folders/registry.ts'
import { KnowledgeService } from '../knowledge/service.ts'
import { CopilotProvider } from '../providers/copilot.ts'
import type { LLMProvider, ToolCall } from '../providers/provider.ts'
import { SkillsManager } from '../skills/loader.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { WriteTool } from '../tools/filesystem.ts'
import { ReadTool } from '../tools/read.ts'
import { Tools } from '../tools/registry.ts'
import { SearchTool } from '../tools/search.ts'
import { SessionTool } from '../tools/session.ts'
import { createMemoryHandler, createSessionsHandler, createSkillsHandler } from '../vfs/mounts.ts'
import { VirtualFs } from '../vfs/virtual-fs.ts'
import { HandoffManager } from './handoff/manager.ts'
import type { SessionTurnFact } from './input.ts'
import { SessionManager } from './session-manager.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import type { SessionStore } from './session-store.ts'
import { TopicService } from './topics.ts'

const WIKI_PATH = 'v:memory/topics/operations.md'
const KNOWLEDGE_SKILL = 'v:skills/project-knowledge'
const SOURCE = '# Operations\n\nSynthetic service: demo.\nRestart procedure: inspect health, restart demo, inspect health again.\n'
const REQUESTS = {
  memory: '收录到本 Project 的共享 memory 知识页',
  wiki: '收录进我们的知识库。不是 memory，是 wiki',
  knowledge: '收录到本 Project 的 knowledge base 共享知识页',
} as const

interface ObservedCall {
  sessionId: string
  name: string
  args: Record<string, unknown>
  knowledgeReady: boolean
}

function scriptedProvider(sourcePath: string): LLMProvider {
  const turns = new Map<string, number>()
  return {
    name: 'fixture', listModels: () => ['fixture'],
    async chat(messages, definitions) {
      const coordinator = !definitions.some(definition => definition.function.name === 'write')
      const role = coordinator ? 'coordinator' : 'worker'
      const turn = (turns.get(role) ?? 0) + 1
      turns.set(role, turn)
      const prompt = String(messages[0].content)
      assert.match(prompt, /read `v:skills\/project-knowledge` before inspecting, editing or delegating knowledge work/)
      assert.doesNotMatch(prompt, /canonical tool path is/)
      let callIndex = 0
      const call = (name: string, args: Record<string, unknown>): ToolCall => ({
        id: `${role}-${turn}-${++callIndex}-${name}`, name, arguments: args,
      })
      if (turn === 1) return { content: null, toolCalls: [call('read', { path: KNOWLEDGE_SKILL })] }
      const loadedSkill = messages.find(message => message.role === 'tool' && typeof message.content === 'string'
        && message.content.includes('# Project knowledge and memory'))
      assert(loadedSkill, 'Knowledge operations require a successfully loaded Skill')
      assert.match(String(loadedSkill.content), /canonical tool path is `v:memory\/`/)
      if (coordinator) {
        if (turn === 2) return { content: null, toolCalls: [call('read', { path: 'v:memory/' })] }
        if (turn === 3) return { content: null, toolCalls: [
          call('search', { handler: 'glob', path: 'v:memory/topics', query: '**/*.md' }),
          call('search', { handler: 'grep', path: 'v:sessions', query: 'Operations Wiki import' }),
        ] }
        if (turn === 4) {
          assert(messages.some(message => message.role === 'tool' && message.content === 'No files found'))
          return { content: null, toolCalls: [call('session', {
            action: 'create', title: 'Operations Wiki import', agentType: 'sub',
            initialMessage: `Read ${KNOWLEDGE_SKILL}, then import ${sourcePath} into the Project Wiki at ${WIKI_PATH}. Wiki uses v:memory; do not write session memory or events. Read back the page.`,
          })] }
        }
      } else {
        assert.match(String(loadedSkill.content), /Only an authorized local session with `write`/)
        assert.match(JSON.stringify(messages), /Wiki uses v:memory/)
        if (turn === 2) return { content: null, toolCalls: [
          call('read', { path: sourcePath }),
          call('search', { handler: 'glob', path: 'v:memory/topics', query: '**/*.md' }),
        ] }
        if (turn === 3) return { content: null, toolCalls: [
          call('write', { path: WIKI_PATH, content: `${SOURCE}\nSource: ${sourcePath}\n` }),
        ] }
        if (turn === 4) return { content: null, toolCalls: [call('read', { path: WIKI_PATH })] }
        assert.match(String(messages.at(-1)?.content), /Synthetic service: demo/)
      }
      return { content: 'Done.', toolCalls: [] }
    },
  }
}

async function scenario(
  t: TestContext, Store: new (path: string) => SessionStore,
  alias: keyof typeof REQUESTS, live = false,
) {
  await withTempWorkspace(async home => {
    const sourcePath = join(home, 'operations-source.md')
    await writeFile(sourcePath, SOURCE)
    await mkdir(join(home, 'memory', 'sessions'), { recursive: true })
    const protectedPath = join(home, 'memory', 'sessions', 'existing.md')
    await writeFile(protectedPath, '# Existing session memory\n')
    const store = new Store(join(home, '.sessions'))
    await store.init()
    const bus = new Bus()
    const events = new EventService(home, bus, async () => { throw new Error('No fixture events expected') })
    const background = new BackgroundTaskManager(bus, events)
    const agentTypes = new AgentTypesManager(home)
    await agentTypes.load()
    const folders = new FolderRegistry(home)
    await folders.init()
    const vfs = new VirtualFs()
    const skills = new SkillsManager(home)
    await skills.load()
    const skillHandlers = createSkillsHandler(skills)
    vfs.mount('v:skills', 'Skill instructions', skillHandlers.read, skillHandlers.list)
    const memory = createMemoryHandler(home, 'wiki-alias-fixture')
    vfs.mount('v:memory', 'read Project memory; write wiki Markdown files', memory.read, memory.list, memory.write)
    const tools = new Tools(home)
    tools.register(new ReadTool(home, vfs))
    tools.register(new SearchTool(home, undefined, vfs))
    tools.register(new WriteTool(home, false, vfs))
    const calls: ObservedCall[] = []
    const skillLoads = new Set<string>()
    tools.addHook({
      name: 'wiki-alias-observation',
      async beforeExecute(name, args, context) {
        calls.push({
          sessionId: context.sessionId, name, args: structuredClone(args),
          knowledgeReady: skillLoads.has(context.sessionId),
        })
      },
      async afterExecute(name, args, result, context) {
        if (name === 'read' && args.path === KNOWLEDGE_SKILL && result.includes('canonical tool path is `v:memory/`')) {
          skillLoads.add(context.sessionId)
        }
        return undefined
      },
    })
    const context = new ContextBuilder(home)
    context.register(guidelineProvider())
    context.register(executionContractProvider())
    context.register(workspaceProvider(home, vfs))
    context.register(runtimeDiscoveryProvider({
      projectId: 'wiki-alias-fixture', identity: new IdentityManager(home),
      getSkillsSummary: (admin, sessionId) => skills.getMetadataSummary(admin, sessionId),
      getAgentTypesSummary: () => agentTypes.getAgentTypesSummary(),
    }))
    const actualProvider = live ? new CopilotProvider() : scriptedProvider(sourcePath)
    let modelCalls = 0
    const deadline = AbortSignal.timeout(live ? 180_000 : 10_000)
    const provider: LLMProvider = {
      name: actualProvider.name, listModels: () => actualProvider.listModels(),
      async chat(messages, definitions, options) {
        assert(++modelCalls <= 20, 'Wiki regression exceeded its model-call budget')
        return actualProvider.chat(messages, definitions, {
          ...options, signal: AbortSignal.any([deadline, ...(options.signal ? [options.signal] : [])]),
        })
      },
    }
    const sessions = new SessionManager({
      projectId: 'wiki-alias-fixture', workspace: home, store, bus, events, provider,
      tools, context, agentTypes, backgroundTasks: background, identity: new IdentityManager(home),
      handoffManager: new HandoffManager(provider, 100000, { autoHandoff: false }, home, store),
      getLlmRuntimeConfig: () => ({
        model: live ? DEFAULT_COPILOT_MODEL : 'fixture', contextWindow: 100000, temperature: 0,
      }),
    })
    const topics = new TopicService({
      projectId: 'wiki-alias-fixture', sessions, folders,
      listStates: async () => Object.values(await store.listAllStates()),
      resolveAgent: name => agentTypes.resolve(name), changed: () => {},
    })
    tools.register(new SessionTool(topics))
    const history = createSessionsHandler(sessions, () => topics)
    vfs.mount('v:sessions', 'Project sessions', history.read, history.list)
    const facts: SessionTurnFact[] = []
    const finished = Promise.withResolvers<void>()
    const subscription = bus.on('session.turn.finished', fact => {
      facts.push(fact)
      if (fact.status !== 'completed') finished.reject(new Error(`Wiki session ${fact.sessionId}: ${fact.status}`))
      else if (fact.sessionId === 'web:chat-admin' && !calls.some(call => call.name === 'session')) {
        finished.reject(new Error(`Coordinator did not delegate the requested Wiki import: ${fact.content}\nCalls: ${
          JSON.stringify(calls.map(call => ({ name: call.name, args: call.args })))
        }`))
      } else if (facts.length === 2) finished.resolve()
    })
    const abort = () => finished.reject(deadline.reason)
    deadline.addEventListener('abort', abort, { once: true })
    try {
      await sessions.start()
      await sessions.buildSession('web:chat-admin', undefined, { mode: 'session', agentType: 'general' })
      await sessions.deliver('web:chat-admin', {
        kind: 'message', id: 'wiki-import-request', timestamp: new Date().toISOString(),
        content: `请让另一个 session 把 ${sourcePath} 的运维知识${REQUESTS[alias]}。请保留来源，执行会话写入后回读验证；不要改变原始文档或会话记忆。`,
        policy: 'queue',
        source: { kind: 'user', sender: {
          channel: 'web', chatId: 'chat-admin', senderId: 'owner', messageId: 'wiki-import-request',
        } },
      })
      await finished.promise
      const creation = calls.filter(call => call.name === 'session' && call.args.action === 'create')
      assert.equal(creation.length, 1, 'Exactly one independent worker should be created')
      assert.match(String(creation[0].args.initialMessage), /v:memory/, 'Kickoff must preserve the canonical Wiki path')
      assert.match(String(creation[0].args.initialMessage), /v:skills\/project-knowledge/, 'Worker should be directed to the same Skill')
      for (const fact of facts) {
        const sessionCalls = calls.filter(call => call.sessionId === fact.sessionId)
        const skillRead = sessionCalls.findIndex(call => call.name === 'read' && call.args.path === KNOWLEDGE_SKILL)
        assert(skillRead >= 0, `${fact.sessionId} must read the knowledge Skill`)
        assert(skillLoads.has(fact.sessionId), `${fact.sessionId} must successfully load the Skill body, not just attempt a read`)
        const operation = sessionCalls.findIndex(call =>
          call.name === 'session' && call.args.action === 'create'
          || /^v:memory(?:[\\/]|$)/.test(String(call.args.path))
          || /^(?:glob|grep):v:memory(?:[\\/]|$)/.test(String(call.args.space))
          || call.args.path === sourcePath)
        assert(operation > skillRead, `${fact.sessionId} must load the Skill before inspecting or delegating knowledge`)
        assert(sessionCalls[operation].knowledgeReady, `${fact.sessionId} must wait for the Skill result before knowledge operations`)
      }
      const invalidMountCalls = calls.filter(call =>
        /^v:wiki(?:[\\/]|$)/.test(String(call.args.path))
        || /^(?:glob|grep):v:wiki(?:[\\/]|$)/.test(String(call.args.space))
        || /^glob(?::)?$/.test(String(call.args.handler ?? call.args.space)) && /^v:wiki(?:[\\/]|$)/.test(String(call.args.query)))
      assert.deepEqual(invalidMountCalls, [], 'No reads, searches or writes may address the nonexistent Wiki mount')
      assert(!calls.some(call => call.sessionId === 'web:chat-admin' && call.name === 'write'))
      const writes = calls.filter(call => call.name === 'write')
      assert(writes.length > 0, 'Wiki import must persist pages, not just report success')
      assert(writes.every(call => /^v:memory\/(?!sessions\/|events\/).+\.md$/.test(String(call.args.path))))
      const catalog = new KnowledgeService(home, skills).catalog()
      const wiki = catalog.entries.filter(entry => entry.kind === 'wiki')
      assert(wiki.length > 0, 'Imported files must appear in the UI Wiki category')
      for (const entry of wiki) {
        const path = `v:${entry.path}`
        const written = calls.findIndex(call => call.name === 'write' && call.args.path === path)
        assert(written >= 0 && calls.slice(written + 1).some(call =>
          call.sessionId !== 'web:chat-admin' && call.name === 'read' && call.args.path === path), `Worker must read back ${path} after writing`)
      }
      const content = (await Promise.all(wiki.map(entry => readFile(join(home, ...entry.path.split('/')), 'utf8')))).join('\n')
      assert.match(content, /demo/)
      assert(content.includes(sourcePath), 'Imported Wiki must retain its source')
      assert.equal(await readFile(sourcePath, 'utf8'), SOURCE)
      assert.equal(await readFile(protectedPath, 'utf8'), '# Existing session memory\n')
      for (const fact of facts) {
        const persisted = await sessions.getHistory(fact.sessionId, { offset: 0, pageSize: 100 })
        assert(persisted.messages.some(message => message.role === 'tool'))
        assert.equal((await store.getState(fact.sessionId))?.executionStatus, 'completed')
      }
      t.diagnostic(`${live ? 'Live model' : 'Scripted provider'}: ${modelCalls} calls, ${skillLoads.size} sessions loaded the Skill, ${wiki.length} Wiki page(s), coordinator and worker completed`)
    } finally {
      deadline.removeEventListener('abort', abort)
      bus.off(subscription)
      await sessions.stop()
      await background.stop()
      await events.stop()
      bus.stopAll()
      store.close?.()
    }
  })
}

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  for (const alias of ['memory', 'wiki', 'knowledge'] as const) {
    test(`${Store.name}: ${alias} requests load the Skill before delegating and writing Wiki pages`,
      { timeout: 20_000 }, t => scenario(t, Store, alias))
  }
}

for (const alias of ['memory', 'wiki', 'knowledge'] as const) {
  test(`live model: ${alias} loads the knowledge Skill before delegation and Wiki writes`, {
    skip: process.env.SHADOW_WIKI_ALIAS_LIVE !== '1',
    timeout: 210_000,
  }, t => scenario(t, SqliteSessionStore, alias, true))
}
