import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { BackgroundTaskManager } from '../agent/background-task.ts'
import { ContextBuilder } from '../agent/context/builder.ts'
import { memoryProvider } from '../agent/context/memory-provider.ts'
import { IdentityManager } from '../agent/identity.ts'
import { MemoryStore } from '../agent/memory.ts'
import { AgentTypesManager } from '../agent/types/manager.ts'
import { Bus } from '../bus/bus.ts'
import type { OutboundMessage } from '../bus/events.ts'
import { EventService } from '../events/service.ts'
import { ProviderHttpError, TokenLimitExceededError, isContextSizeError, type ChatMessage, type LLMProvider, type LLMResponseUsage } from '../providers/provider.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import { ReadTool } from '../tools/read.ts'
import { requireToolText } from '../tools/tool.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { VirtualFs } from '../vfs/virtual-fs.ts'
import { createSessionsHandler } from '../vfs/mounts.ts'
import { HandoffManager, type CompactResult } from './handoff/manager.ts'
import type { SessionTurnFact } from './input.ts'
import { Session } from './session.ts'
import { SessionManager } from './session-manager.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import type { SessionState, SessionStore } from './session-store.ts'

const llm = { model: 'fixture', contextWindow: 131_072, temperature: 0 }
const oldUsage = { promptTokens: 124_501, completionTokens: 523, totalTokens: 125_024 }

class TestSession extends Session {
  seedUsage(usage: LLMResponseUsage): void {
    this.usage = usage
    this.state.lastKnownTokens = usage.totalTokens
  }

  get contextUsage(): LLMResponseUsage | undefined { return this.usage }

  append(...messages: ChatMessage[]): Promise<void> {
    return this.appendMessages(llm, ...messages)
  }

  forceCompact(): Promise<boolean> {
    return this.handleTokenLimitExceeded(llm)
  }
}

class TestHandoffManager extends HandoffManager {
  calls = 0
  failure?: Error
  inputs: ChatMessage[][] = []

  override async create(
    _id: string, _source: string, targetSessionId: string,
    messages: ChatMessage[],
  ): Promise<CompactResult> {
    if (this.failure) throw this.failure
    this.calls++
    this.inputs.push(structuredClone(messages))
    return {
      targetSessionId,
      timestamp: new Date().toISOString(),
      context: { summary: 'Continuation', currentObjective: '', recentTranscript: [] },
      prompt: 'Continuation',
    }
  }
}

const stores = [
  ['JSONL', (directory: string): SessionStore => new JsonlSessionStore(directory)],
  ['SQLite', (directory: string): SessionStore => new SqliteSessionStore(directory)],
] as const

for (const [name, createStore] of stores) {
  test(`${name}: compacted summaries reach the provider once, including after restart`, { timeout: 15000 }, async () => {
    await withTempWorkspace(async workspace => {
      const id = 'web:compaction-summary'
      const calls: ChatMessage[][] = []
      const continuation = {
        summary: 'UNIQUE_COMPACT_PROGRESS',
        currentObjective: 'UNIQUE_COMPACT_OBJECTIVE',
        recentTranscript: ['UNIQUE_COMPACT_EXCERPT'],
      }
      const provider: LLMProvider = {
        name: 'fixture', listModels: () => ['fixture'],
        async chat(messages, tools) {
          if (tools?.some(tool => tool.function.name === 'handoff_summary')) {
            return messages.at(-1)?.role === 'tool'
              ? { content: 'Summary saved.', toolCalls: [] }
              : { content: null, toolCalls: [{ id: 'summary-call', name: 'handoff_summary', arguments: continuation }] }
          }
          calls.push(structuredClone(messages))
          return { content: 'Finished.', toolCalls: [] }
        },
      }
      const memory = new MemoryStore(workspace)
      await memory.recordModifiedFile(id, 'KEEP_WORKING_SET.txt', 'edit')

      async function openRuntime() {
        const store = createStore(join(workspace, 'sessions'))
        await store.init()
        const bus = new Bus()
        const agentTypes = new AgentTypesManager(workspace)
        await agentTypes.load()
        const context = new ContextBuilder(workspace)
        context.register(memoryProvider(memory, () => undefined))
        const handoff = new HandoffManager(provider, llm.contextWindow, { autoHandoff: false }, workspace, store)
        const events = new EventService(workspace, bus, (sessionId, input) => sessions.deliver(sessionId, input))
        const backgroundTasks = new BackgroundTaskManager(bus, events)
        const sessions: SessionManager = new SessionManager({
          workspace, store, bus, provider, context, agentTypes, events, backgroundTasks,
          tools: new Tools(workspace), identity: new IdentityManager(workspace),
          handoffManager: handoff, getLlmRuntimeConfig: () => llm,
        })
        await sessions.start()
        return {
          sessions, bus, store,
          async send(content: string) {
            const inputId = crypto.randomUUID()
            const finished = Promise.withResolvers<SessionTurnFact>()
            const subscription = bus.on('session.turn.finished', fact => {
              if (fact.inputId === inputId) finished.resolve(fact)
            })
            try {
              await sessions.deliver(id, {
                id: inputId, timestamp: new Date().toISOString(), kind: 'message', content, policy: 'queue',
                source: { kind: 'event', eventId: inputId, type: 'fixture', source: 'system' },
              })
              const fact = await finished.promise
              assert.equal(fact.status, 'completed', fact.error)
            } finally { bus.off(subscription) }
          },
          async close() {
            await sessions.stop()
            await handoff.stop()
            await backgroundTasks.stop()
            await events.stop()
            store.close?.()
          },
        }
      }

      function assertSingleSummary() {
        const messages = calls.at(-1)!
        assert.equal(messages[0].role, 'system')
        assert.match(String(messages[0].content), /KEEP_WORKING_SET/)
        assert.doesNotMatch(String(messages[0].content), /Historical session summary|UNIQUE_COMPACT_/)
        for (const marker of [continuation.summary, continuation.currentObjective, ...continuation.recentTranscript]) {
          assert.deepEqual(messages.filter(message => String(message.content).includes(marker)).map(message => message.role), ['user'])
          assert.equal(messages.reduce((count, message) => count + String(message.content).split(marker).length - 1, 0), 1)
        }
        assert.match(String(messages[1].content), /Previous Conversation Summary/)
        assert.match(String(messages[1].content), /v:sessions\//)
      }

      async function assertPreviousSegmentReadable(sessions: SessionManager) {
        const summary = String(calls.at(-1)![1].content)
        const path = summary.match(/read\("(v:sessions\/[^"]+)"\)/)?.[1]
        assert.ok(path)
        const handlers = createSessionsHandler(sessions)
        const vfs = new VirtualFs()
        vfs.mount('v:sessions', 'Sessions', handlers.read, handlers.list)
        const context = {
          sessionId: id, signal: new AbortController().signal,
          tools: new SessionTools(new Tools(workspace), workspace),
        } as ExecutionContext
        const result = requireToolText(await new ReadTool(workspace, vfs).execute({ path, limit: 35 }, context))
        assert.match(result, /Original task/)
        assert.doesNotMatch(result, /Continue after compact|Continue after restart/)
      }

      let runtime = await openRuntime()
      try {
        await runtime.send('Original task')
        const compacted = Promise.withResolvers<void>()
        const subscription = runtime.bus.on('session.handoff', event => {
          if (event.sessionId === id) compacted.resolve()
        })
        try {
          assert.equal(runtime.sessions.requestCompact(id, llm), true)
          await compacted.promise
        } finally { runtime.bus.off(subscription) }
        const active = runtime.sessions.getActiveSession(id)!
        const start = await runtime.store.readFirstRecord(active.physicalSessionId)
        assert.equal(start?.summary_context, active.history[1].content)
        const summaryPath = join(workspace, 'memory', 'sessions', 'web_compaction-summary.md')
        const saved = await readFile(summaryPath, 'utf8')
        assert.match(saved, /UNIQUE_COMPACT_PROGRESS/)
        assert.match(saved, /UNIQUE_COMPACT_OBJECTIVE/)
        await runtime.send('Continue after compact')
        assertSingleSummary()
        await assertPreviousSegmentReadable(runtime.sessions)

        await runtime.close()
        runtime = await openRuntime()
        await runtime.send('Continue after restart')
        assertSingleSummary()
        await assertPreviousSegmentReadable(runtime.sessions)
        assert.equal(calls.at(-1)![1].name, '__compaction_summary__')
        assert.equal(await readFile(summaryPath, 'utf8'), saved)
      } finally { await runtime.close() }
    })
  })

  async function fixture(run: (f: {
    session: TestSession
    handoff: TestHandoffManager
    store: SessionStore
    bus: Bus
    tools: Tools
  }) => Promise<void>, rebuild?: () => Promise<string>): Promise<void> {
    await withTempWorkspace(async workspace => {
      const store = createStore(join(workspace, 'sessions'))
      await store.init()
      const provider: LLMProvider = {
        name: 'fixture',
        listModels: () => ['fixture'],
        chat: async () => ({ content: 'Finished response for the user.', toolCalls: [], usage: oldUsage }),
      }
      const handoff = new TestHandoffManager(provider, llm.contextWindow, {}, workspace, store)
      const bus = new Bus()
      const state: SessionState = { sessionId: 'test:compaction', segmentIndex: 4, mode: 'session' }
      const tools = new Tools(workspace)
      const session = new TestSession(
        workspace, state.sessionId, state, [], provider,
        new SessionTools(tools, workspace), bus, store, handoff, () => {}, rebuild,
      )
      try {
        await run({ session, handoff, store, bus, tools })
      } finally {
        session.stop()
        await session.completion
        await handoff.stop()
        store.close?.()
      }
    })
  }

  for (const fallback of ['no rebuilder', 'failed rebuild'] as const) {
    test(`${name}: compaction with ${fallback} never caches a per-inference work agreement`, async () => {
      await fixture(async ({ session, handoff, tools }) => {
        const base = '# Runtime\nIdentity\n\n---\n\n# Historical reference\n> Old notes'
        let work = '# Current work contracts\nRevision 1'
        tools.setWorkGuard({
          snapshot: () => [], prompt: () => work, current: () => true,
          before: () => undefined,
        })
        await session.append({ role: 'system', content: base })
        await session.forceCompact()
        const first = String(handoff.inputs[0][0].content)
        assert.equal(first, '# Runtime\nIdentity\n\n---\n\n' + work + '\n\n---\n\n# Historical reference\n> Old notes')
        assert.equal(session.history[0].content, base)
        work = '# Current work contracts\nRevision 2'
        await session.forceCompact()
        const second = String(handoff.inputs[1][0].content)
        assert.match(second, /Revision 2/)
        assert.doesNotMatch(second, /Revision 1/)
        assert.equal(second.match(/# Current work contracts/g)?.length, 1)
        assert.equal(session.history[0].content, base)
      }, fallback === 'failed rebuild' ? async () => { throw new Error('Synthetic rebuild failure') } : undefined)
    })
  }

  test(`${name}: hot compaction does not reuse the previous segment's usage`, async () => {
    await fixture(async ({ session, handoff, store }) => {
      session.seedUsage(oldUsage)
      await session.append({ role: 'user', content: 'x'.repeat(888) })
      assert.equal(handoff.calls, 1)
      assert.equal(session.getState().segmentIndex, 5)
      await session.append({ role: 'user', content: 'x'.repeat(112) })
      assert.equal(handoff.calls, 1)
      assert.equal(session.history.length, 3)
      assert.equal(session.contextUsage, undefined)
      assert.equal((await store.getState(session.id))?.lastKnownTokens, 0)

      // A fresh response must still be able to trigger the next handoff.
      session.seedUsage(oldUsage)
      await session.append({ role: 'user', content: 'x'.repeat(112) })
      assert.equal(handoff.calls, 2)
    })
  })

  test(`${name}: a compaction-triggering response retains its usage in history and outbound events`, async () => {
    await fixture(async ({ session, handoff, store, bus }) => {
      const outbound: OutboundMessage[] = []
      bus.on('message.outbound', message => { outbound.push(message) })
      const finished = Promise.withResolvers<void>()
      bus.on('session.turn.finished', () => { finished.resolve() })
      session.dispatch({
        id: 'input', timestamp: new Date().toISOString(), kind: 'message',
        content: 'First', policy: 'queue',
        source: { kind: 'event', eventId: 'input', type: 'fixture', source: 'system' },
      }, llm)
      await finished.promise
      assert.equal(handoff.calls, 1)
      assert.equal(session.contextUsage, undefined)
      const records = await Array.fromAsync(store.readSessionLog(session.physicalSessionId))
      assert.deepEqual(records.at(-1)?.usage, oldUsage)
      assert.deepEqual(session.history.at(-1)?.usage, oldUsage)
      assert.deepEqual(outbound.at(-1)?.usage, oldUsage)
      assert.equal((await store.getState(session.id))?.lastKnownTokens, 0)
    })
  })

  test(`${name}: forced and manual compaction persist cleared accounting without another response`, async () => {
    await fixture(async ({ session, handoff, store, bus }) => {
      session.seedUsage(oldUsage)
      await session.forceCompact()
      assert.equal(session.contextUsage, undefined)
      assert.equal((await store.getState(session.id))?.lastKnownTokens, 0)
      assert.equal((await store.getState(session.id))?.segmentIndex, 5)
      await session.append({ role: 'user', content: 'x'.repeat(112) })
      assert.equal(handoff.calls, 1)

      session.seedUsage(oldUsage)
      const compacted = Promise.withResolvers<void>()
      bus.on('session.handoff', () => { compacted.resolve() })
      session.requestCompact(llm)
      await compacted.promise
      assert.equal(session.contextUsage, undefined)
      assert.equal((await store.getState(session.id))?.lastKnownTokens, 0)
      assert.equal((await store.getState(session.id))?.segmentIndex, 6)
    })
  })

  test(`${name}: failed compaction retains the existing segment and its accounting`, async () => {
    await fixture(async ({ session, handoff }) => {
      session.seedUsage(oldUsage)
      handoff.failure = new Error('Synthetic handoff failure')
      await assert.rejects(session.forceCompact(), /Synthetic handoff failure/)
      assert.equal(session.getState().segmentIndex, 4)
      assert.deepEqual(session.contextUsage, oldUsage)
      assert.equal(session.getState().lastKnownTokens, oldUsage.totalTokens)
    })
  })
}


test('context-size detection uses structured errors, not arbitrary error text', () => {
  assert.equal(isContextSizeError(new ProviderHttpError(413, '<html>proxy limit</html>')), true)
  assert.equal(isContextSizeError(new TokenLimitExceededError('limit')), true)
  assert.equal(isContextSizeError(new ProviderHttpError(400, '413 payload too large')), false)
  assert.equal(isContextSizeError(new Error('413 payload too large')), false)
})

for (const [name, createStore] of stores) {
  for (const repeated of [false, true]) {
    test(`${name}: HTTP 413 compacts image history with summary fallback; repeated=${repeated}`, { timeout: 15000 }, async () => {
      await withTempWorkspace(async workspace => {
        const store = createStore(join(workspace, 'sessions'))
        await store.init()
        const calls: ChatMessage[][] = []
        let summaries = 0
        const provider: LLMProvider = {
          name: 'fixture', listModels: () => ['fixture'],
          async chat(messages, tools) {
            if (tools.some(tool => tool.function.name === 'handoff_summary')) {
              summaries++
              // Even the bounded textual summary request may be too large.
              assert.doesNotMatch(JSON.stringify(messages), /data:image/)
              throw new ProviderHttpError(413, 'proxy limit')
            }
            calls.push(structuredClone(messages))
            if (calls.length === 1 || repeated) throw new ProviderHttpError(413, '<html>limit</html>')
            return { content: 'Recovered.', toolCalls: [] }
          },
        }
        const handoff = new HandoffManager(provider, llm.contextWindow, { autoHandoff: false }, workspace, store)
        const bus = new Bus()
        let handoffs = 0
        bus.on('session.handoff', () => { handoffs++ })
        const session = new TestSession(workspace, 'test:413', { sessionId: 'test:413', segmentIndex: 0, mode: 'session' }, [
          { role: 'system', content: 'System prompt' },
          { role: 'user', content: [
            { type: 'text', text: 'Analyze attached image and continue the task.' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,' + 'A'.repeat(10000) } },
          ] },
          { role: 'assistant', content: null, tool_calls: [{ id: 'old-call', type: 'function', function: { name: 'read', arguments: '{}' } }] },
          { role: 'tool', tool_call_id: 'old-call', name: 'read', content: 'Completed old tool result' },
        ], provider, new SessionTools(new Tools(workspace), workspace), bus, store, handoff, () => {})
        const finished = Promise.withResolvers<SessionTurnFact>()
        bus.on('session.turn.finished', fact => { finished.resolve(fact) })
        try {
          session.dispatch({ id: 'input', timestamp: new Date().toISOString(), kind: 'message', content: 'Continue image task', policy: 'queue',
            source: { kind: 'event', eventId: 'input', type: 'fixture', source: 'system' },
          }, llm)
          const result = await finished.promise
          assert.equal(result.status, repeated ? 'failed' : 'completed')
          assert.equal(calls.length, 2, 'only one recovery attempt per turn')
          assert.equal(summaries, 1, 'summary request is not retried recursively')
          assert.equal(handoffs, 1)
          assert.equal(session.getState().segmentIndex, 1)
          assert.match(JSON.stringify(calls[0]), /data:image/)
          assert.doesNotMatch(JSON.stringify(calls[1]), /data:image/)
          assert.match(String(calls[1][1].content), /Continue image task|Completed old tool result/)
          assert.ok(!calls[1].some(message => message.role === 'tool'), 'no orphan tool results in continuation')
          assert.equal((await store.readFirstRecord(session.physicalSessionId))?.summary_context, calls[1][1].content)
          const saved = await readFile(join(workspace, 'memory', 'sessions', 'test_413.md'), 'utf8')
          assert.match(saved, /Continue image task/)
        } finally {
          session.stop()
          await session.completion
          await handoff.stop()
          store.close?.()
        }
      })
    })
  }
}

for (const failure of ['token-limit', 'authentication', 'abort'] as const) {
  test(`summary fallback only recovers size errors (${failure})`, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new JsonlSessionStore(join(workspace, 'sessions'))
      await store.init()
      let calls = 0
      const error = failure === 'token-limit' ? new TokenLimitExceededError('limit')
        : failure === 'authentication' ? new ProviderHttpError(401, 'denied') : new DOMException('Aborted', 'AbortError')
      const provider: LLMProvider = { name: 'fixture', listModels: () => ['fixture'], async chat() { calls++; throw error } }
      const handoff = new HandoffManager(provider, llm.contextWindow, {}, workspace, store)
      try {
        const result = handoff.create('test:summary', 'test:summary-0', 'test:summary-1', [{ role: 'user', content: 'Preserve this objective' }], llm.model)
        if (failure === 'token-limit') assert.match((await result).prompt, /Preserve this objective/)
        else await assert.rejects(result, caught => caught === error)
        assert.equal(calls, 1)
      } finally { await handoff.stop(); store.close?.() }
    })
  })
}

test('stopping handoff overrides a concurrent size rejection without persisting fallback', async () => {
  await withTempWorkspace(async workspace => {
    const store: SessionStore = new JsonlSessionStore(join(workspace, 'sessions'))
    await store.init()
    const started = Promise.withResolvers<void>()
    const provider: LLMProvider = { name: 'fixture', listModels: () => ['fixture'],
      async chat(_messages, _tools, options) {
        started.resolve()
        return await new Promise((_resolve, reject) => {
          options.signal!.addEventListener('abort', () => reject(new ProviderHttpError(413, 'late size rejection')), { once: true })
        })
      },
    }
    const handoff = new HandoffManager(provider, llm.contextWindow, {}, workspace, store)
    const result = handoff.create('test:abort-summary', 'old', 'new', [{ role: 'user', content: 'Task' }], llm.model)
    const rejected = assert.rejects(result, /Handoff runtime stopped/)
    await started.promise
    await handoff.stop()
    await rejected
    await assert.rejects(readFile(join(workspace, 'memory', 'sessions', 'test_abort-summary.md')), { code: 'ENOENT' })
  })
})
