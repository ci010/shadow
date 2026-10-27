import assert from 'node:assert/strict'
import { test } from 'node:test'
import { basename, join } from 'node:path'
import { readdir } from 'node:fs/promises'
import { BaseSession } from './base-session.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import { CopilotAuthenticator, CopilotProvider } from '../providers/copilot.ts'
import { AggregatedProvider } from '../providers/aggregated.ts'
import { Bus } from '../bus/bus.ts'
import { Tools, SessionTools } from '../tools/registry.ts'
import { ImportTool } from '../tools/load-tool.ts'
import { InvokeTool } from '../tools/invoke-tool.ts'
import { computerTools } from '../tools/computer.ts'
import { fixture, frame, owner } from '../computer/testing/fixture.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import type { ExecutionContext } from '../tools/context.ts'

class ComputerSession extends BaseSession {
  run(context: ExecutionContext) {
    return this.runLlmLoop(context, { model: 'synthetic@copilot', temperature: 0, contextWindow: 128_000 }, context.signal)
  }
}

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  for (const endpoint of ['/responses', '/chat/completions']) {
    for (const screenshot of [false, true]) {
      for (const entry of ['connect', 'select', 'observe'] as const) {
        test(`${Store.name} ${endpoint} ${entry} screenshot=${screenshot}: native fake → invoke_tool → aggregated → Copilot wire, private once`, async t => withTempWorkspace(async home => {
          const f = await fixture(t)
          f.desktop.observation.screenshot = frame
          if (entry === 'select') {
            await f.service.release(owner)
            await f.service.windows(owner, f.signal)
          }
          const store = new Store(join(home, '.sessions'))
          await store.init()
          try {
            const base = new Tools(home)
            const importer = new ImportTool(new Map(), home)
            for (const tool of computerTools(f.service, owner.projectId, id => assert.equal(id, owner.sessionId))) importer.registerBuiltin(tool.name, tool)
            base.register(new InvokeTool(importer))
            const tools = new SessionTools(base, home)
            tools.setExecutionScope('session', ['call'])
            t.after(() => tools.resetDynamicAndWait())
            const hooks: string[] = []
            base.addHook({ name: 'privacy', async afterExecute(_name, _args, result) { hooks.push(result); return result } })
            const files = new Map([['api-key.json', JSON.stringify({ token: 'synthetic', expires_at: Date.now() / 1000 + 3600 })]])
            const auth = new CopilotAuthenticator(join(home, 'auth'), { storage: {
              read: path => files.get(basename(path)), write: (path, value) => { files.set(basename(path), value) }, remove: path => { files.delete(basename(path)) },
            }, fetch: async () => { throw new Error('No OAuth in fixture') } })
            const wire: Record<string, unknown>[] = []
            t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
              init?.signal?.throwIfAborted()
              if (new URL(String(url)).pathname === '/models') return Response.json({ data: [{ id: 'synthetic', supported_endpoints: [endpoint], capabilities: { type: 'chat', supports: { vision: true } } }] })
              assert.equal(new URL(String(url)).pathname, endpoint)
              wire.push(JSON.parse(String(init?.body)))
              const step = wire.length
              const args = step === 1 ? entry !== 'observe' ? { name: 'computer_setup', args: { action: 'connect', screenshot, ...(entry === 'select' ? { windowId: f.desktop.window.id } : {}) } } : { name: 'computer_observe', args: { screenshot } } : { name: 'computer_setup', args: { action: 'release' } }
              const call = { id: `call-${step}`, type: 'function', function: { name: 'invoke_tool', arguments: JSON.stringify(args) } }
              if (endpoint === '/chat/completions') return Response.json({ model: 'synthetic', choices: [{ message: step < 3 ? { content: null, tool_calls: [call] } : { content: 'Finished' }, finish_reason: step < 3 ? 'tool_calls' : 'stop' }] })
              const response = { id: `response-${step}`, model: 'synthetic', status: 'completed', output: step < 3
                ? [{ type: 'function_call', id: `item-${step}`, call_id: call.id, name: call.function.name, arguments: call.function.arguments, status: 'completed' }]
                : [{ type: 'message', id: 'final', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Finished', annotations: [] }] }] }
              // Exercise streamed Responses continuation as used by the live Copilot route.
              return screenshot ? new Response(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`, {
                headers: { 'content-type': 'text/event-stream' },
              }) : Response.json(response)
            })
            const provider = new AggregatedProvider(new Map([['copilot', new CopilotProvider(auth)]]), 'copilot')
            const bus = new Bus()
            const outputs: unknown[] = []
            bus.on('message.outbound', message => { outputs.push(message) })
            const session = new ComputerSession(home, owner.sessionId, { sessionId: owner.sessionId, segmentIndex: 0, mode: 'session' }, [{ role: 'user', content: 'Inspect the synthetic window' }], provider, tools, bus, store)
            const context: ExecutionContext = { ...owner, physicalSessionId: session.physicalSessionId, channel: 'web', chatId: 'fixture', senderId: 'owner', messageId: 'fixture', tools, signal: f.signal }
            await session.run(context)
            assert.equal(wire.length, 3)
            assert.match(JSON.stringify(wire[1]), /Synthetic field/)
            assert.equal(JSON.stringify(wire[1]).includes(frame.base64), screenshot)
            assert.doesNotMatch(JSON.stringify(wire[2]), /Synthetic field|data:image/)
            // A later turn cannot revive the one-inference attachment from session state.
            await session.run(context)
            assert.equal(wire.length, 4)
            assert.doesNotMatch(JSON.stringify(wire[3]), /Synthetic field|data:image/)
            const records = await Array.fromAsync(store.readSessionLog(session.physicalSessionId))
            for (const value of [records, outputs, hooks]) {
              assert.doesNotMatch(JSON.stringify(value), /Synthetic field|data:image/)
              assert.match(JSON.stringify(value), /Private desktop observation omitted/)
            }
            assert.equal((await readdir(home, { recursive: true })).some(path => path.endsWith('.png') || path.includes('tool-result-')), false)
          } finally { store.close?.() }
        }))
      }
    }
  }
}
