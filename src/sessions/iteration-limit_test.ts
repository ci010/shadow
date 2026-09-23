import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { BaseSession } from './base-session.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import type { LLMProvider } from '../providers/provider.ts'
import { Bus } from '../bus/bus.ts'
import { Tools, SessionTools } from '../tools/registry.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { withTempWorkspace } from '../testing/workspace.ts'

class IterationSession extends BaseSession {
  run(context: ExecutionContext) {
    return this.runLlmLoop(context, { model: 'fixture', contextWindow: 128_000, temperature: 0 }, context.signal)
  }
}

for (const mode of ['session', 'task', 'call'] as const) {
  for (const finishes of [true, false]) {
    test(`${mode}: ${finishes ? 'can finish on iteration 1000' : 'fails after 1000 iterations without making call 1001'}`, async t => withTempWorkspace(async home => {
      const store = new JsonlSessionStore(join(home, '.sessions'))
      t.mock.method(store, 'appendMessages', async () => {})
      t.mock.method(store, 'saveState', async () => {})
      let inferences = 0
      let executions = 0
      const provider: LLMProvider = {
        name: 'fixture', listModels: () => ['fixture'],
        async chat() {
          inferences++
          return finishes && inferences === 1000
            ? { content: 'Finished', toolCalls: [] }
            : { content: null, toolCalls: [{ id: `step-${inferences}`, name: 'step', arguments: {} }] }
        },
      }
      const base = new Tools(home)
      base.register({
        name: 'step', description: '', readonly: true,
        parameters: { type: 'object', properties: {} },
        execute: async () => { executions++; return 'Continue' },
      })
      const tools = new SessionTools(base, home)
      const sessionId = `test:${mode}`
      const session = new IterationSession(home, sessionId, { sessionId, segmentIndex: 0, mode }, [], provider, tools, new Bus(), store)
      const context: ExecutionContext = {
        sessionId, physicalSessionId: session.physicalSessionId, cwd: home,
        channel: 'test', chatId: mode, senderId: 'fixture', messageId: 'fixture',
        tools, signal: new AbortController().signal,
      }
      if (finishes) assert.equal(await session.run(context), 'Finished')
      else await assert.rejects(session.run(context), /Session turn exceeded the maximum number of iterations/)
      assert.equal(inferences, 1000)
      assert.equal(executions, finishes ? 999 : 1000)
      assert.equal(session.history.filter(message => message.role === 'tool').length, executions)
    }))
  }
}
