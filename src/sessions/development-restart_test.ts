import assert from 'node:assert/strict'
import test from 'node:test'
import { join } from 'node:path'
import { BaseSession } from './base-session.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import { Bus } from '../bus/bus.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { LLMProvider } from '../providers/provider.ts'
import { Tools, SessionTools } from '../tools/registry.ts'
import { ImportTool } from '../tools/load-tool.ts'
import { InvokeTool } from '../tools/invoke-tool.ts'
import { DevelopmentRestartTool, registerDevelopmentRestart } from '../tools/development-restart.ts'
import { withTempWorkspace } from '../testing/workspace.ts'

class RestartSession extends BaseSession {
  run(context: ExecutionContext) { return this.runLlmLoop(context, { model: 'fixture', contextWindow: 128_000, temperature: 0 }, context.signal) }
}

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  for (const failPersistence of [false, true]) {
    test(`${Store.name}: restart waits for persisted outbound receipt; persistence failure=${failPersistence}`, async () => withTempWorkspace(async home => {
      const store = new Store(join(home, '.sessions'))
      await store.init()
      try {
        const events: string[] = []
        const timers: Array<() => void> = []
        const restart = new DevelopmentRestartTool({
          env: { SHADOW_DEV_RESTART_TOOL: '1', SHADOW_DESKTOP_DEV_IPC: '1' },
          parentPort: { postMessage(message) { assert.deepEqual(message, { type: 'shadow:dev-restart' }); events.push('ipc') } },
        }, (callback, delay) => { assert.equal(delay, 1500); events.push('delay'); timers.push(callback) })
        const catalog = new ImportTool(new Map(), home)
        registerDevelopmentRestart(catalog, { env: { SHADOW_DEV_RESTART_TOOL: '1', SHADOW_DESKTOP_DEV_IPC: '1' }, parentPort: { postMessage() {} } }, restart)
        const tools = new Tools(home)
        tools.register(new InvokeTool(catalog))
        const sessionTools = new SessionTools(tools, home)
        const append = store.appendMessages.bind(store)
        store.appendMessages = async (...args) => {
          if (args[1].some(message => message.role === 'tool')) {
            if (failPersistence) throw new Error('synthetic receipt persistence failure')
            await append(...args)
            events.push('persisted')
          } else await append(...args)
        }
        const bus = new Bus()
        bus.on('message.outbound', message => { if (message.event === 'tool_result') events.push('outbound') })
        let inference = 0
        const provider: LLMProvider = { name: 'fixture', listModels: () => ['fixture'], async chat() {
          return ++inference === 1 ? { content: null, toolCalls: [{ id: 'restart', name: 'invoke_tool', arguments: { name: 'development_restart', args: {} } }] }
            : { content: 'Receipt received', toolCalls: [] }
        } }
        const sessionId = 'web:restart'
        const session = new RestartSession(home, sessionId, { sessionId, segmentIndex: 0, mode: 'session' },
          [{ role: 'user', content: 'Restart development fixture' }], provider, sessionTools, bus, store)
        const context: ExecutionContext = { sessionId, physicalSessionId: session.physicalSessionId, channel: 'web', chatId: 'fixture',
          senderId: 'fixture', messageId: 'fixture', admin: true, tools: sessionTools, signal: new AbortController().signal }
        if (failPersistence) {
          await assert.rejects(session.run(context), /session message persistence failure/)
          assert.deepEqual(events, [])
          assert.equal(timers.length, 0)
        } else {
          await session.run(context)
          assert.deepEqual(events, ['persisted', 'outbound', 'delay'])
          const records = await Array.fromAsync(store.readSessionLog(session.physicalSessionId))
          assert(records.some(record => record.role === 'tool' && record.tool_call_id === 'restart'))
          timers[0]()
          assert.deepEqual(events, ['persisted', 'outbound', 'delay', 'ipc'])
        }
      } finally { store.close?.() }
    }))
  }
}
