import assert from 'node:assert/strict'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import test from 'node:test'
import type { ExecutionContext } from '../tools/context.ts'
import { Bus } from '../bus/bus.ts'
import { McpConnection } from '../mcp/client.ts'
import { McpToolIndex } from '../mcp/tool-index.ts'
import type { LLMProvider } from '../providers/provider.ts'
import { ImportTool } from '../tools/load-tool.ts'
import { InvokeTool } from '../tools/invoke-tool.ts'
import { SearchTool } from '../tools/search.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import { BaseSession } from './base-session.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import type { SessionStore } from './session-store.ts'
import { SkillsManager } from '../skills/loader.ts'
import { parseSkillFile } from '../skills/parse.ts'
import { VirtualFs } from '../vfs/virtual-fs.ts'
import { createSkillsHandler } from '../vfs/mounts.ts'
import { ReadTool } from '../tools/read.ts'
import { WriteTool } from '../tools/filesystem.ts'
import { ConfigSchema } from '../config/schema.ts'
import { ProjectConfigStore } from '../projects/config-store.ts'
import { createMcpConfigHandler } from '../mcp/virtual-config.ts'
import { createProjectScope } from '../projects/scope.ts'
import { EvalBridgeRuntime } from '../script-runtime/bridge.ts'

class ContractSession extends BaseSession {
  run(context: ExecutionContext) {
    return this.runLlmLoop(context, { model: 'synthetic', contextWindow: 32000, temperature: 0 }, context.signal)
  }
}

for (const storage of ['jsonl', 'sqlite'] as const) {
  test(`${storage}: MCP config read/edit then invoke works through the persisted agent loop`, async t => {
    await mkdir(resolve('.tmp'), { recursive: true })
    const home = await mkdtemp(resolve('.tmp', 'mcp-config-loop-'))
    const store: SessionStore = storage === 'jsonl'
      ? new JsonlSessionStore(join(home, 'sessions'))
      : new SqliteSessionStore(join(home, 'sessions'))
    const base = new Tools(home)
    const loader = new ImportTool(new Map(), home)
    const configStore = new ProjectConfigStore({
      home, configPath: join(home, 'project.json'), getSharedConfig: () => ConfigSchema.parse({}),
      onChanged: config => loader.updateMcpServers(config.mcp.servers),
    })
    await configStore.init()
    const vfs = new VirtualFs()
    const config = createMcpConfigHandler({ projectId: 'fixture', configStore, isReservedName: name => base.has(name) })
    vfs.mount('v:config', 'Project MCP config', config.read, undefined, config.write)
    base.register(new ReadTool(home, vfs))
    base.register(new WriteTool(home, undefined, true, vfs))
    base.register(new InvokeTool(loader))
    const tools = new SessionTools(base, home)
    const bus = new Bus()
    t.after(async () => {
      tools.resetDynamic()
      bus.stopAll()
      if (store instanceof SqliteSessionStore) store.close()
      await rm(home, { recursive: true, force: true })
    })
    const connect = t.mock.method(McpConnection.prototype, 'connect', async () => {})
    t.mock.method(McpConnection.prototype, 'disconnect', async () => {})
    t.mock.method(McpConnection.prototype, 'setToolsChangedHandler', () => {})
    t.mock.method(McpConnection.prototype, 'listTools', async () => [{
      name: 'echo', description: 'Synthetic echo', inputSchema: { type: 'object', properties: {} },
    }])
    const call = t.mock.method(McpConnection.prototype, 'callTool', async () => 'mcp-config-case-complete')
    let turns = 0
    const provider: LLMProvider = {
      name: 'synthetic', listModels: () => ['synthetic'],
      async chat(messages, definitions) {
        turns++
        assert(!definitions.some(tool => ['install_tool', 'import_tool', 'fixture__echo'].includes(tool.function.name)))
        if (turns === 1) return {
          content: '', finishReason: 'tool_calls',
          toolCalls: [{ id: 'config-read', name: 'read', arguments: { path: 'v:config/mcp.json' } }],
        }
        const last = messages.filter(message => message.role === 'tool').at(-1)
        assert(last)
        if (turns === 2) {
          const document = JSON.parse(String(last.content))
          assert.equal(typeof document.revision, 'string')
          return {
            content: '', finishReason: 'tool_calls',
            toolCalls: [{ id: 'config-write', name: 'write', arguments: {
              path: 'v:config/mcp.json',
              content: JSON.stringify({ ...document, mcpServers: { fixture: { command: 'synthetic-never-run' } } }),
            } }],
          }
        }
        if (turns === 3) {
          assert.doesNotMatch(String(last.content), /^Error/)
          assert.equal(configStore.current().mcp.servers[0].name, 'fixture')
          assert.equal(connect.mock.callCount(), 1, 'Configuration must be indexed before saving')
          return {
            content: '', finishReason: 'tool_calls',
            toolCalls: [{ id: 'invoke', name: 'invoke_tool', arguments: { name: 'fixture__echo', args: {} } }],
          }
        }
        assert.equal(last.content, 'mcp-config-case-complete')
        assert.equal(call.mock.callCount(), 1)
        return { content: 'done', finishReason: 'stop', toolCalls: [] }
      },
    }
    await store.init()
    const session = new ContractSession(home, 'test:mcp-config-case', {
      sessionId: 'test:mcp-config-case', segmentIndex: 0, config: {}, mode: 'session',
    }, [], provider, tools, bus, store)
    await store.createSessionLog(session.physicalSessionId, [])
    assert.equal(await session.run({
      projectId: 'fixture', tools, signal: new AbortController().signal,
      channel: 'test', chatId: 'mcp-config-case', sessionId: session.id,
      physicalSessionId: session.physicalSessionId, senderId: 'synthetic', messageId: 'synthetic',
    }), 'done')
    assert.equal(turns, 4)
    const records = []
    for await (const record of store.readSessionLog(session.physicalSessionId)) records.push(record)
    const history = JSON.stringify(records)
    assert.match(history, /v:config\/mcp.json/)
    assert.match(history, /mcp-config-case-complete/)
    assert.doesNotMatch(history, /import_tool|install_tool/)
  })

  test(`${storage}: read skill then invoke persists the agent sequence without registration tools`, async t => {
    await mkdir(resolve('.tmp'), { recursive: true })
    const home = await mkdtemp(resolve('.tmp', 'skill-contract-loop-'))
    const store: SessionStore = storage === 'jsonl'
      ? new JsonlSessionStore(join(home, 'sessions'))
      : new SqliteSessionStore(join(home, 'sessions'))
    const base = new Tools(home)
    const skills = new SkillsManager(home)
    const dir = join(home, 'skills', 'echo')
    await mkdir(dir, { recursive: true })
    const manifest = '---\nname: echo\ndescription: Echo helper\ntools:\n  echo_tool:\n    source: echo.ts\n    description: Echo helper\n    parameters: {type: object, properties: {}}\n    imports: [node:fs]\n---\nCall echo_tool with empty args.'
    await writeFile(join(dir, 'SKILL.md'), manifest)
    const marker = join(home, 'loaded')
    await writeFile(join(dir, 'echo.ts'), `
import { writeFileSync } from 'node:fs'
writeFileSync(${JSON.stringify(marker)}, 'loaded')
export async function run() {return 'skill-case-complete'}
`)
    skills.setSkill('echo', { ...parseSkillFile(manifest, 'echo'), dirPath: dir })
    const loader = new ImportTool(new Map(), home, undefined, name => skills.getSkillDirectory(name))
    const vfs = new VirtualFs()
    vfs.mount('v:skills', 'Skills', createSkillsHandler(skills, (skill, ctx) => loader.registerSkillTools(skill, ctx)).read)
    base.register(new ReadTool(home, vfs))
    base.register(new InvokeTool(loader))
    base.register(new SearchTool(home, undefined, vfs))
    const tools = new SessionTools(base, home)
    const bus = new Bus()
    t.after(async () => {
      tools.resetDynamic()
      bus.stopAll()
      if (store instanceof SqliteSessionStore) store.close()
      await rm(home, { recursive: true, force: true })
    })
    let turns = 0
    const provider: LLMProvider = {
      name: 'synthetic', listModels: () => ['synthetic'],
      async chat(messages, definitions) {
        turns++
        assert(!definitions.some(tool => tool.function.name === 'install_tool'))
        assert(!definitions.some(tool => tool.function.name === 'import_tool'))
        assert(!definitions.some(tool => tool.function.name === 'echo_tool'))
        if (turns === 1) return {
          content: '', finishReason: 'tool_calls',
          toolCalls: [{ id: 'skill', name: 'read', arguments: { path: 'v:skills/echo' } }],
        }
        const last = messages.filter(message => message.role === 'tool').at(-1)
        assert(last)
        if (turns === 2) {
          assert.match(String(last.content), /Registered for this session: echo_tool/)
          await assert.rejects(access(marker), { code: 'ENOENT' })
          return {
            content: '', finishReason: 'tool_calls',
            toolCalls: [{ id: 'invoke', name: 'invoke_tool', arguments: { name: 'echo_tool', args: {} } }],
          }
        }
        assert.equal(last.content, 'skill-case-complete')
        return { content: 'done', finishReason: 'stop', toolCalls: [] }
      },
    }
    await store.init()
    const session = new ContractSession(home, 'test:skill-case', {
      sessionId: 'test:skill-case', segmentIndex: 0, config: {}, mode: 'session',
    }, [], provider, tools, bus, store)
    await store.createSessionLog(session.physicalSessionId, [])
    assert.equal(await session.run({
      projectId: 'fixture', tools, signal: new AbortController().signal,
      evalBridge: new EvalBridgeRuntime({ projectId: 'fixture', scope: createProjectScope('fixture') }),
      channel: 'test', chatId: 'skill-case', sessionId: session.id,
      physicalSessionId: session.physicalSessionId, senderId: 'synthetic', messageId: 'synthetic',
    }), 'done')
    assert.equal(turns, 3)
    const records = []
    for await (const record of store.readSessionLog(session.physicalSessionId)) records.push(record)
    const history = JSON.stringify(records)
    assert.match(history, /v:skills\/echo/)
    assert.match(history, /skill-case-complete/)
    assert.doesNotMatch(history, /import_tool|install_tool/)
  })

  test(`${storage}: search contracts and argument errors flow through the real session loop without executing invalid calls`, async t => {
    await mkdir(resolve('.tmp'), { recursive: true })
    const home = await mkdtemp(resolve('.tmp', 'mcp-contract-loop-'))
    const store: SessionStore = storage === 'jsonl'
      ? new JsonlSessionStore(join(home, 'sessions'))
      : new SqliteSessionStore(join(home, 'sessions'))
    const base = new Tools(home)
    const importer = new ImportTool(new Map(), home)
    base.register(importer)
    base.register(new InvokeTool(importer))
    const vfs = new VirtualFs()
    vfs.mount('v:tools', 'Tools', (path, ctx) => importer.readVirtual(path, ctx), (ctx, opts) => importer.virtualEntries(ctx, opts))
    base.register(new SearchTool(home, undefined, vfs))
    base.register(new ReadTool(home, vfs))
    const tools = new SessionTools(base, home)
    const bus = new Bus()
    t.after(async () => {
      tools.resetDynamic()
      bus.stopAll()
      if (store instanceof SqliteSessionStore) store.close()
      await rm(home, { recursive: true, force: true })
    })
    t.mock.method(McpConnection.prototype, 'connect', async () => {})
    t.mock.method(McpConnection.prototype, 'disconnect', async () => {})
    t.mock.method(McpConnection.prototype, 'setToolsChangedHandler', () => {})
    t.mock.method(McpConnection.prototype, 'listTools', async () => [{
      name: 'write', description: 'Synthetic side effect',
      inputSchema: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'] },
    }])
    const executed: string[] = []
    t.mock.method(McpConnection.prototype, 'callTool', async (_name: string, args: Record<string, unknown>) => {
      executed.push(String(args.value))
      return 'written'
    })
    await importer.updateMcpServers([{ name: 'fixture', transport: 'stdio', command: 'never-executed' }])
    await new McpToolIndex(home).ensure({ name: 'fixture', transport: 'stdio', command: 'never-executed' })
    let turns = 0
    const provider: LLMProvider = {
      name: 'synthetic',
      listModels: () => ['synthetic'],
      async chat(messages, definitions) {
        turns++
        assert(!definitions.some(tool => tool.function.name === 'fixture__write'))
        if (turns === 1) return {
          content: '', finishReason: 'tool_calls',
          toolCalls: [
            { id: 'search', name: 'search', arguments: { query: 'Synthetic', space: 'grep:v:tools/fixture' } },
          ],
        }
        if (turns === 2) {
          assert.match(String(messages.at(-1)?.content), /v:tools\/fixture\/fixture__write/)
          return {
            content: '', finishReason: 'tool_calls',
            toolCalls: [
              { id: 'read-contract', name: 'read', arguments: { path: 'v:tools/fixture/fixture__write' } },
              { id: 'invalid', name: 'invoke_tool', arguments: { name: 'fixture__write', args: { value: 3 } } },
            ],
          }
        }
        if (turns === 3) {
          assert.deepEqual(executed, [])
          const results = messages.filter(message => message.role === 'tool')
          assert.equal(results.length, 3)
          assert.match(String(results[1].content), /"parameters"/)
          for (const result of results.slice(2)) assert.match(String(result.content), /no tool was executed/)
          return {
            content: '', finishReason: 'tool_calls',
            toolCalls: [{ id: 'informed', name: 'invoke_tool', arguments: { name: 'fixture__write', args: { value: 'informed' } } }],
          }
        }
        assert.deepEqual(executed, ['informed'])
        return { content: 'done', finishReason: 'stop', toolCalls: [] }
      },
    }
    await store.init()
    const session = new ContractSession(home, 'test:contracts', {
      sessionId: 'test:contracts', segmentIndex: 0, config: {}, mode: 'session',
    }, [], provider, tools, bus, store)
    await store.createSessionLog(session.physicalSessionId, [])
    assert.equal(await session.run({
      tools, signal: new AbortController().signal,
      channel: 'test', chatId: 'contracts', sessionId: session.id,
      physicalSessionId: session.physicalSessionId,
      senderId: 'synthetic', messageId: 'synthetic',
    }), 'done')
    assert.equal(turns, 4)
  })
}
