import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { Bus } from '../../bus/bus.ts'
import { openaiChat } from '../../providers/openai-compatible.ts'
import type { ChatMessage, LLMProvider } from '../../providers/provider.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'
import { InvokeTool } from '../../tools/invoke-tool.ts'
import { ReadTool } from '../../tools/read.ts'
import { SessionTools, Tools } from '../../tools/registry.ts'
import { transientToolResult } from '../../tools/tool.ts'
import { WriteTool } from '../../tools/filesystem.ts'
import { Session } from '../session.ts'
import { JsonlSessionStore } from '../session-store-jsonl.ts'
import { HandoffManager } from './manager.ts'

interface Body { model: string; messages: ChatMessage[]; tools: unknown[]; max_tokens?: number }

const draft = { path: 'v:handoff/draft.md', content: '## Summary\nPreserved prefix\n\n## Current Objective\nNo action remains' }

test('Compact uses the actual last provider prefix, including transient results and complete tool schemas', { timeout: 10_000 }, async t => {
  await withTempWorkspace(async workspace => {
    const store = new JsonlSessionStore(join(workspace, 'sessions'))
    await store.init()
    const bodies: Body[] = []
    const message = (name: string, args: object, id: string) => ({ content: null, tool_calls: [
      { id, type: 'function', function: { name, arguments: JSON.stringify(args) } },
    ] })
    t.mock.method(globalThis, 'fetch', async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as Body
      bodies.push(body)
      const reply = [
        message('observe_fixture', {}, 'observe'),
        { content: 'Turn done' },
        message('write', draft, 'write-draft'),
        message('invoke_tool', { name: 'observe_fixture', args: {} }, 'blocked'),
        message('invoke_tool', { name: 'handoff_submit', args: {} }, 'submit'),
      ][bodies.length - 1]
      assert.ok(reply, 'unexpected additional inference')
      return Response.json({ choices: [{ message: reply }], usage: { prompt_tokens: bodies.length === 2 ? 99_000 : 1000, completion_tokens: 10, total_tokens: bodies.length === 2 ? 99_010 : 1010 } })
    })
    const provider: LLMProvider = { name: 'fixture', listModels: () => ['fixture'],
      chat: (messages, tools, options) => openaiChat({ url: 'https://fixture.invalid/chat', apiKey: 'fixture', messages, tools, ...options }),
    }
    const tools = new Tools(workspace)
    let executions = 0
    tools.register(new ReadTool(workspace))
    tools.register(new WriteTool(workspace))
    tools.register(new InvokeTool())
    tools.register({ name: 'observe_fixture', description: 'Read an ephemeral fixture', parameters: { type: 'object', properties: {} },
      async execute() {
        executions++
        return transientToolResult([{ type: 'text', text: 'LIVE_PREFIX_CANARY' }], 'Persisted preview only')
      },
    })
    const bus = new Bus()
    const handoff = new HandoffManager(provider, 100_000, {}, workspace, store)
    const id = 'web:compact-cache-prefix'
    const session = new Session(workspace, id, { sessionId: id, segmentIndex: 0, mode: 'session' },
      [{ role: 'system', content: 'Stable system prompt' }], provider, new SessionTools(tools, workspace), bus, store, handoff, () => {})
    const sourcePhysicalId = session.physicalSessionId
    const finished = Promise.withResolvers<string>()
    bus.on('session.turn.finished', fact => { finished.resolve(fact.status) })
    try {
      session.dispatch({ kind: 'message', policy: 'queue', id: 'initial', timestamp: new Date().toISOString(), content: 'User request',
        source: { kind: 'event', type: 'fixture', source: 'system', eventId: 'initial' } },
      { model: 'fixture', contextWindow: 100_000, temperature: 0.1, maxTokens: 3210 })
      assert.equal(await finished.promise, 'completed')
      assert.equal(session.getState().segmentIndex, 1)
      assert.equal(bodies.length, 5)
      assert.equal(executions, 1, 'visible tools are not executable in maintenance')
      const [, regular, ...compact] = bodies
      assert.match(JSON.stringify(regular.messages), /LIVE_PREFIX_CANARY/)
      assert.equal(regular.max_tokens, 3210)
      for (const body of compact) {
        const { messages, ...other } = body
        const { messages: previous, ...regularOther } = regular
        assert.equal(JSON.stringify(other), JSON.stringify(regularOther))
        assert.equal(JSON.stringify(messages.slice(0, previous.length)), JSON.stringify(previous))
      }
      assert.match(JSON.stringify(compact[0].messages.at(-1)), /session\.compact/)
      for (let i = 1; i < compact.length; i++) {
        assert.deepEqual(compact[i].messages.slice(0, compact[i - 1].messages.length), compact[i - 1].messages)
      }
      assert.match(JSON.stringify(compact[2].messages.at(-1)), /does not dispatch regular dynamic tools/)
      assert.doesNotMatch(JSON.stringify(await Array.fromAsync(store.readSessionLog(sourcePhysicalId))), /LIVE_PREFIX_CANARY/)
    } finally {
      session.stop()
      await session.completion
      await handoff.stop()
    }
  })
})
