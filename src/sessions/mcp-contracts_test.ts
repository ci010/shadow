import assert from 'node:assert/strict'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { resolve, join } from 'node:path'
import test from 'node:test'
import type { ExecutionContext } from '../agent/agent.ts'
import { Bus } from '../bus/bus.ts'
import { McpConnection } from '../mcp/client.ts'
import type { LLMProvider } from '../providers/provider.ts'
import { ImportTool } from '../tools/load-tool.ts'
import { InvokeTool } from '../tools/invoke-tool.ts'
import { SearchTool } from '../tools/search.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import { BaseSession } from './base-session.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import type { SessionStore } from './session-store.ts'

class ContractSession extends BaseSession {
  run(context: ExecutionContext) {
    return this.runLlmLoop(context, { model: 'synthetic', contextWindow: 32000, temperature: 0 }, context.signal)
  }
}

for (const storage of ['jsonl', 'sqlite'] as const) {
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
    base.register(new SearchTool(home, undefined, undefined, importer))
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
            { id: 'search', name: 'search', arguments: { query: 'synthetic', space: 'tools:fixture' } },
            { id: 'invalid', name: 'invoke_tool', arguments: { name: 'fixture__write', args: { value: 3 } } },
          ],
        }
        if (turns === 2) {
          assert.deepEqual(executed, [])
          const results = messages.filter(message => message.role === 'tool')
          assert.equal(results.length, 2)
          assert.match(String(results[0].content), /"parameters"/)
          for (const result of results.slice(1)) assert.match(String(result.content), /no tool was executed/)
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
    assert.equal(turns, 3)
  })
}
