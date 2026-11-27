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
import { WriteTool } from '../tools/filesystem.ts'
import { InvokeTool } from '../tools/invoke-tool.ts'
import { requireToolText, type ToolDefinition } from '../tools/tool.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { VirtualFs } from '../vfs/virtual-fs.ts'
import { createSessionsHandler } from '../vfs/mounts.ts'
import { HandoffManager, type CompactResult } from './handoff/manager.ts'
import type { SessionMessageInput, SessionTurnFact } from './input.ts'
import { Session } from './session.ts'
import { SessionManager } from './session-manager.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import type { SessionState, SessionStore } from './session-store.ts'

const llm = { model: 'fixture', contextWindow: 131_072, temperature: 0 }
const oldUsage = { promptTokens: 124_501, completionTokens: 523, totalTokens: 125_024 }
const draftPath = 'v:handoff/draft.md'

function registerCompactTools(tools: Tools, workspace: string, vfs?: VirtualFs) {
  tools.register(new ReadTool(workspace, vfs))
  tools.register(new WriteTool(workspace, true, vfs))
  tools.register(new InvokeTool())
}

function hasCompactEvent(messages: ChatMessage[]): boolean {
  return messages.some(message => {
    if (message.role !== 'user' || !Array.isArray(message.content)) return false
    const tag = message.content[0]
    return tag?.type === 'text' && tag.text.startsWith('<event type="session.compact" ')
  })
}

function writeDraft(summary: string, objective: string, transcript: string[] = []) {
  const content = `## Summary\n${summary}\n\n## Current Objective\n${objective}`
    + (transcript.length ? `\n\n## Recent Transcript\n${transcript.map(line => `- ${line}`).join('\n')}` : '')
  return { id: 'draft-write', name: 'write', arguments: { path: draftPath, content } }
}

const submitDraft = { id: 'draft-submit', name: 'invoke_tool', arguments: { name: 'handoff_submit', args: {} } }

class TestSession extends Session {
  seedUsage(usage: LLMResponseUsage): void {
    this.usage = usage
    this.state.lastKnownTokens = usage.totalTokens
  }

  get contextUsage(): LLMResponseUsage | undefined { return this.usage }

  appendWithWindow(contextWindow: number, ...messages: ChatMessage[]): Promise<void> {
    return this.appendMessages({ ...llm, contextWindow }, ...messages)
  }

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
      const compactCalls: ChatMessage[][] = []
      let ordinaryTools: ToolDefinition[] | undefined
      let priorReference: string | undefined
      const continuation = {
        summary: 'UNIQUE_COMPACT_PROGRESS',
        currentObjective: 'UNIQUE_COMPACT_OBJECTIVE',
        recentTranscript: ['UNIQUE_COMPACT_EXCERPT'],
      }
      const provider: LLMProvider = {
        name: 'fixture', listModels: () => ['fixture'],
        async chat(messages, tools) {
          if (hasCompactEvent(messages)) {
            assert.deepEqual(tools, ordinaryTools, 'maintenance retains the ordinary tool definitions and order')
            compactCalls.push(structuredClone(messages))
            if (compactCalls.length === 3) {
              assert.ok(priorReference)
              assert.doesNotMatch(JSON.stringify(messages), /PRIOR_PHYSICAL_CANARY/)
              return { content: null, toolCalls: [{ id: 'read-prior', name: 'read', arguments: { path: priorReference, limit: 35 } }] }
            }
            if (compactCalls.length === 1 || compactCalls.length === 4) {
              if (compactCalls.length === 4) {
                const read = messages.find(message => message.tool_call_id === 'read-prior')
                assert.match(String(read?.content), /PRIOR_PHYSICAL_CANARY/)
                assert.doesNotMatch(String(read?.content), /Continue after restart/)
              }
              return { content: 'Do not publish this maintenance narration.', toolCalls: [
                writeDraft(continuation.summary, continuation.currentObjective, continuation.recentTranscript),
              ] }
            }
            return { content: null, toolCalls: [submitDraft] }
          }
          ordinaryTools = structuredClone(tools)
          calls.push(structuredClone(messages))
          return { content: calls.length === 1 ? 'Finished. PRIOR_PHYSICAL_CANARY' : 'Finished.', toolCalls: [] }
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
        const tools = new Tools(workspace)
        const vfs = new VirtualFs()
        const sessions: SessionManager = new SessionManager({
          workspace, store, bus, provider, context, agentTypes, events, backgroundTasks,
          tools, identity: new IdentityManager(workspace),
          handoffManager: handoff, getLlmRuntimeConfig: () => llm,
        })
        const history = createSessionsHandler(sessions)
        vfs.mount('v:sessions', 'Sessions', history.read, history.list)
        registerCompactTools(tools, workspace, vfs)
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

      async function assertPreviousSegmentReadable(sessions: SessionManager, store: SessionStore) {
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
        assert.match(result, /Finished/)
        assert.doesNotMatch(result, /Continue after compact|Continue after restart|maintenance narration/)
        const records = await Array.fromAsync(store.readSessionLog(path.split('/').at(-1)!))
        assert.match(JSON.stringify(records), /Original task/)
        assert.equal(records.filter(record => record.type === 'session.compact').length, 1)
        assert.doesNotMatch(JSON.stringify(records), /maintenance narration|draft-write|draft-submit/)
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
        assert.equal(compactCalls.length, 2, 'default v2 writes a draft, then submits it')
        assert.deepEqual(compactCalls[0].slice(0, -1), calls[0].concat([compactCalls[0].at(-2)!]))
        assert.match(JSON.stringify(compactCalls[0].at(-1)?.content), /session\.compact/)
        assert.match(String(compactCalls[0].at(-2)?.content), /Finished/)
        assert.deepEqual(compactCalls[1].slice(0, compactCalls[0].length), compactCalls[0])
        assert.equal(compactCalls[1].at(-2)?.tool_calls?.[0].id, 'draft-write')
        assert.equal(compactCalls[1].at(-1)?.tool_call_id, 'draft-write')
        const active = runtime.sessions.getActiveSession(id)!
        const start = await runtime.store.readFirstRecord(active.physicalSessionId)
        assert.equal(start?.summary_context, active.history[1].content)
        const summaryPath = join(workspace, 'memory', 'sessions', 'web_compaction-summary.md')
        const saved = await readFile(summaryPath, 'utf8')
        assert.match(saved, /UNIQUE_COMPACT_PROGRESS/)
        assert.match(saved, /UNIQUE_COMPACT_OBJECTIVE/)
        await runtime.send('Continue after compact')
        assertSingleSummary()
        await assertPreviousSegmentReadable(runtime.sessions, runtime.store)

        await runtime.close()
        runtime = await openRuntime()
        await runtime.send('Continue after restart')
        assertSingleSummary()
        await assertPreviousSegmentReadable(runtime.sessions, runtime.store)
        assert.equal(calls.at(-1)![1].name, '__compaction_summary__')
        assert.equal(await readFile(summaryPath, 'utf8'), saved)

        priorReference = String(calls.at(-1)![1].content).match(/read\("(v:sessions\/[^"\n]+)"\)/)?.[1]
        assert.ok(priorReference)
        const compactedAgain = Promise.withResolvers<void>()
        const next = runtime.bus.on('session.handoff', event => { if (event.sessionId === id) compactedAgain.resolve() })
        try {
          assert.equal(runtime.sessions.requestCompact(id, llm), true)
          await compactedAgain.promise
          assert.equal(compactCalls.length, 5, 'second v2 reads the prior segment, writes, then submits')
        } finally { runtime.bus.off(next) }
      } finally { await runtime.close() }
    })
  })

  async function fixture(run: (f: {
    session: TestSession
    handoff: TestHandoffManager
    store: SessionStore
    bus: Bus
    tools: Tools
  }) => Promise<void>): Promise<void> {
    await withTempWorkspace(async workspace => {
      const store = createStore(join(workspace, 'sessions'))
      await store.init()
      const provider: LLMProvider = {
        name: 'fixture',
        listModels: () => ['fixture'],
        chat: async () => ({ content: 'Finished response for the user.', toolCalls: [], usage: oldUsage }),
      }
      const handoff = new TestHandoffManager(provider, llm.contextWindow, { compactV2: false }, workspace, store)
      const bus = new Bus()
      const state: SessionState = { sessionId: 'test:compaction', segmentIndex: 4, mode: 'session' }
      const tools = new Tools(workspace)
      const session = new TestSession(
        workspace, state.sessionId, state, [], provider,
        new SessionTools(tools, workspace), bus, store, handoff, () => {},
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

  test(`${name}: auto compaction uses the turn budget instead of the shared manager default`, async () => {
    await fixture(async ({ session, handoff }) => {
      session.seedUsage({ promptTokens: 250000, completionTokens: 0, totalTokens: 250000 })
      await session.appendWithWindow(1000000, { role: 'user', content: 'Large conversation' })
      assert.equal(handoff.calls, 0)
      await session.appendWithWindow(256000, { role: 'user', content: 'Smaller conversation' })
      assert.equal(handoff.calls, 1)
    })
  })

    test(`${name}: compaction retains the activation system snapshot without caching dynamic Work context`, async () => {
      await fixture(async ({ session, handoff, tools }) => {
        const base = '# Runtime\nIdentity\n\n---\n\n# Historical reference\n> Old notes'
        let work = '# Current work contracts\nRevision 1'
        tools.setWorkGuard({
          snapshot: () => [], prompt: () => work, current: () => true,
          before: () => undefined,
        })
        await session.append({ role: 'system', content: base })
        await session.forceCompact()
        assert.equal(handoff.inputs[0][0].content, base)
        const first = JSON.stringify(handoff.inputs[0].at(-1)!.content)
        assert.match(first, /Revision 1/)
        assert.equal(handoff.inputs[0].at(-1)!.role, 'user')
        assert.equal(session.history[0].content, base)
        work = '# Current work contracts\nRevision 2'
        await session.forceCompact()
        const second = JSON.stringify(handoff.inputs[1].at(-1)!.content)
        assert.match(second, /Revision 2/)
        assert.doesNotMatch(second, /Revision 1/)
        assert.equal(second.match(/# Current work contracts/g)?.length, 1)
        assert.equal(session.history[0].content, base)
      })
    })

  test(`${name}: hot compaction does not reuse the previous segment's usage`, async () => {
    await fixture(async ({ session, handoff, store }) => {
      session.seedUsage(oldUsage)
      await session.append({ role: 'user', content: 'x'.repeat(888) })
      assert.equal(handoff.calls, 1)
      assert.equal(session.getState().segmentIndex, 5)
      await session.append({ role: 'user', content: 'x'.repeat(112) })
      assert.equal(handoff.calls, 1)
      assert.equal(session.history.filter(message => message.name !== 'runtime-context').length, 3)
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


for (const mode of ['success', 'context-limit', 'corrected', 'no-submit', 'plain-text', 'disabled', 'cancelled'] as const) {
  test(`hot Compact v2 preserves tool pairs and chooses the expected strategy (${mode})`, { timeout: 10_000 }, async () => {
    const submitted = mode === 'success' || mode === 'corrected'
    await withTempWorkspace(async workspace => {
      const store = new JsonlSessionStore(join(workspace, 'sessions'))
      await store.init()
      const started = Promise.withResolvers<void>()
      const attempts: string[] = []
      let v2Calls = 0
      const draft = writeDraft('Operation already started', 'Check the existing operation')
      const provider: LLMProvider = {
        name: 'fixture', listModels: () => ['fixture'],
        async chat(messages, tools, options) {
          const round = ++v2Calls
          if (round === 1) attempts.push('v2')
          assert.ok(round <= 8, 'maintenance inference must be bounded')
          assert.ok(hasCompactEvent(messages))
          assert.deepEqual(tools, registry.getDefinitions(), `round ${round} retains the complete ordinary tool set`)
          assert.deepEqual(messages.slice(0, 4).map(message => message.role), ['system', 'assistant', 'tool', 'user'])
          assert.equal(messages[1].tool_calls?.[0].id, messages[2].tool_call_id)
          assert.match(JSON.stringify(messages[3].content), /session\.compact/)
          assert.doesNotMatch(JSON.stringify(messages), /Queued trigger message/)
          if (mode === 'cancelled') {
            if (round === 1) return { content: null, toolCalls: [draft] }
            started.resolve()
            await new Promise((_resolve, reject) => options.signal!.addEventListener('abort', () => reject(new TokenLimitExceededError('late size error')), { once: true }))
          }
          if (mode === 'context-limit') throw new TokenLimitExceededError('v2 limit')
          if (mode === 'plain-text') return { content: 'Unsubmitted narration', toolCalls: [] }
          if (mode === 'corrected') {
            if (round === 1) return { content: null, toolCalls: [
              { id: 'unsupported', name: 'exec', arguments: {} },
              { id: 'dynamic', name: 'invoke_tool', arguments: { name: 'exec', args: {} } },
              { id: 'unexpected', name: 'write', arguments: { path: 'unexpected.txt', content: 'must not run' } },
              { id: 'foreign-read', name: 'read', arguments: { path: 'v:sessions/web:foreign' } },
            ] }
            if (round === 2) {
              for (const id of ['unsupported', 'dynamic', 'unexpected', 'foreign-read']) {
                const error = messages.find(message => message.role === 'tool' && message.tool_call_id === id)
                assert.match(String(error?.content), /error/i)
              }
              return { content: null, toolCalls: [{ ...submitDraft, id: 'premature-submit' }] }
            }
            if (round === 3) {
              const error = messages.find(message => message.role === 'tool' && message.tool_call_id === 'premature-submit')
              assert.match(String(error?.content), /error.*draft/is)
              return { content: null, toolCalls: [draft] }
            }
            if (round === 4) return { content: null, toolCalls: [{ id: 'direct-submit', name: 'handoff_submit', arguments: {} }] }
            if (round === 5) {
              const error = messages.find(message => message.role === 'tool' && message.tool_call_id === 'direct-submit')
              assert.match(String(error?.content), /error/i)
              return { content: null, toolCalls: [{ id: 'read-draft', name: 'read', arguments: { path: draftPath, offset: 2, limit: 1 } }] }
            }
            const read = messages.find(message => message.role === 'tool' && message.tool_call_id === 'read-draft')
            assert.match(String(read?.content), /Operation already started/)
            assert.doesNotMatch(String(read?.content), /## Summary|Check the existing operation/)
          } else if (round === 1) {
            return { content: null, toolCalls: [draft] }
          } else if (mode === 'no-submit') {
            return { content: null, toolCalls: [{ id: `read-${round}`, name: 'read', arguments: { path: draftPath } }] }
          }
          return { content: null, toolCalls: [submitDraft] }
        },
      }
      class Legacy extends TestHandoffManager {
        override async create(...args: Parameters<TestHandoffManager['create']>): Promise<CompactResult> {
          attempts.push('v1')
          assert.equal(session.getState().segmentIndex, 0, 'must not cut before falling back')
          return super.create(...args)
        }
      }
      const handoff = new Legacy(provider, llm.contextWindow, { compactV2: () => mode !== 'disabled' }, workspace, store)
      const id = 'test:compact-v2'
      const registry = new Tools(workspace)
      registerCompactTools(registry, workspace)
      let executed = false
      registry.register({ name: 'exec', description: 'Unrelated fixture tool', parameters: { type: 'object', properties: {} },
        async execute() { executed = true; return 'Must not execute inside compaction' },
      })
      const session = new TestSession(workspace, id, { sessionId: id, segmentIndex: 0, mode: 'session' }, [
        { role: 'system', content: 'Activation prompt' },
        { role: 'assistant', content: null, tool_calls: [{ id: 'old', type: 'function', function: { name: 'exec', arguments: '{}' } }] },
        { role: 'tool', name: 'exec', tool_call_id: 'old', content: 'Operation ID: 123' },
      ], provider, new SessionTools(registry, workspace), new Bus(), store, handoff, () => {})
      try {
        session.seedUsage({ promptTokens: 125_000, completionTokens: 0, totalTokens: 125_000 })
        const append = session.append({ role: 'user', content: 'Queued trigger message' })
        if (mode === 'cancelled') {
          const rejected = assert.rejects(append, /abort/i)
          await started.promise
          session.stop()
          await rejected
          assert.equal(session.getState().segmentIndex, 0)
          await assert.rejects(readFile(join(workspace, 'memory', 'sessions', 'test_compact-v2.md')), { code: 'ENOENT' })
        } else {
          await append
          assert.equal(session.getState().segmentIndex, 1)
          assert.equal(session.history.at(-1)?.content, 'Queued trigger message')
          assert.match(String(session.history[1].content), submitted ? /Operation already started/ : /Continuation/)
          if (!submitted) assert.doesNotMatch(JSON.stringify(session.history), /Operation already started|Unsubmitted narration/)
        }
        assert.deepEqual(attempts, mode === 'disabled' ? ['v1'] : submitted || mode === 'cancelled' ? ['v2'] : ['v2', 'v1'])
        assert.equal(v2Calls, { success: 2, 'context-limit': 1, corrected: 6, 'no-submit': 8, 'plain-text': 1, disabled: 0, cancelled: 2 }[mode])
        assert.equal(executed, false)
        await assert.rejects(readFile(join(workspace, 'unexpected.txt'), 'utf8'), { code: 'ENOENT' })
      } finally {
        session.stop()
        await session.completion
        await handoff.stop()
        store.close?.()
      }
    })
  })
}

for (const outcome of ['v2', 'fallback', 'failed'] as const) {
  test(`hot compaction queues new inputs until it settles (${outcome})`, { timeout: 10_000 }, async () => {
    const fallback = outcome !== 'v2'
    const failed = outcome === 'failed'
    await withTempWorkspace(async workspace => {
      const summarizing = Promise.withResolvers<AbortSignal>()
      const completeV2 = Promise.withResolvers<void>()
      const synthesizingLegacy = Promise.withResolvers<void>()
      const completeV1 = Promise.withResolvers<void>()
      const savingSegment = Promise.withResolvers<void>()
      const completeCommit = Promise.withResolvers<void>()
      let pausedCommit = false
      class PausedStore extends JsonlSessionStore {
        override async saveState(id: string, state: SessionState): Promise<void> {
          if (state.segmentIndex === 1 && !pausedCommit) {
            pausedCommit = true
            savingSegment.resolve()
            await completeCommit.promise
          }
          await super.saveState(id, state)
        }
      }
      const store = new PausedStore(join(workspace, 'sessions'))
      await store.init()
      let normalCalls = 0
      let compactCalls = 0
      let ordinaryTools: ToolDefinition[] | undefined
      const provider: LLMProvider = {
        name: 'fixture', listModels: () => ['fixture'],
        async chat(messages, tools, options) {
          if (!hasCompactEvent(messages)) {
            ordinaryTools = structuredClone(tools)
            return { content: 'Finished', toolCalls: [], usage: normalCalls++ === 0
              ? { promptTokens: 125_000, completionTokens: 0, totalTokens: 125_000 } : undefined }
          }
          assert.deepEqual(tools, ordinaryTools)
          const round = ++compactCalls
          if (round === 1) {
            summarizing.resolve(options.signal!)
            await completeV2.promise
          }
          assert.doesNotMatch(JSON.stringify(messages), /DURING_COMPACT_/)
          if (fallback) throw new TokenLimitExceededError('v2 limit')
          return { content: null, toolCalls: [round === 1 ? writeDraft('Continuation', 'Await new inputs') : submitDraft] }
        },
      }
      class Legacy extends TestHandoffManager {
        override async create(...args: Parameters<TestHandoffManager['create']>): Promise<CompactResult> {
          synthesizingLegacy.resolve()
          await completeV1.promise
          assert.doesNotMatch(JSON.stringify(args[3]), /DURING_COMPACT_/)
          if (failed) throw new Error('Legacy synthesis failed')
          return super.create(...args)
        }
      }
      const handoff = new Legacy(provider, llm.contextWindow, {}, workspace, store)
      const id = 'web:compact-inbox'
      const bus = new Bus()
      const tools = new Tools(workspace)
      registerCompactTools(tools, workspace)
      const session = new TestSession(workspace, id, { sessionId: id, segmentIndex: 0, mode: 'session' }, [],
        provider, new SessionTools(tools, workspace), bus, store, handoff, () => {})
      const order: string[] = []
      const facts: SessionTurnFact[] = []
      const settled = Promise.withResolvers<void>()
      const initialPhysicalId = session.physicalSessionId
      bus.on('session.turn.started', fact => { order.push(fact.inputId) })
      bus.on('session.handoff', () => { order.push('handoff') })
      bus.on('session.turn.finished', fact => { facts.push(fact); if (fact.inputId === 'late') settled.resolve() })
      const send = (inputId: string, policy: SessionMessageInput['policy'], user = false) => {
        const requestId = crypto.randomUUID()
        session.dispatch({ kind: 'message', policy, id: inputId, timestamp: new Date().toISOString(), content: `DURING_COMPACT_${inputId}`,
          source: user ? { kind: 'user', sender: { channel: 'web', chatId: id, senderId: 'owner', messageId: inputId } }
            : { kind: 'session', sessionId: 'test:peer' },
          ...(user ? { replyTo: { channel: 'web', chatId: id, platformMessageId: requestId } } : {}),
        }, llm)
        return requestId
      }
      try {
        session.dispatch({ kind: 'message', policy: 'queue', id: 'initial', timestamp: new Date().toISOString(),
          content: 'Initial request', source: { kind: 'event', type: 'fixture', source: 'system', eventId: 'initial' } }, llm)
        const signal = await summarizing.promise
        const requestId = send('interactive', 'interactive', true)
        send('next-step', 'next-step')
        assert.equal(session.webInputDelivery.find(entry => entry.requestId === requestId)?.status, 'queue')
        assert.equal(signal.aborted, false)
        assert.deepEqual(order, ['initial'])
        completeV2.resolve()
        if (fallback) {
          await synthesizingLegacy.promise
          send('steering', 'steering')
          assert.deepEqual(order, ['initial'])
        }
        if (!failed) {
          completeV1.resolve()
          await savingSegment.promise
        }
        send('late', 'interactive', true)
        assert.equal(signal.aborted, false)
        assert.deepEqual(order, ['initial'])
        if (failed) completeV1.resolve()
        else completeCommit.resolve()
        await settled.promise
        const queued = ['interactive', 'next-step', ...(fallback ? ['steering'] : []), 'late']
        assert.deepEqual(order, ['initial', ...(failed ? [] : ['handoff']), ...queued])
        assert.equal(compactCalls, fallback ? 1 : 2)
        assert.deepEqual(facts.map(fact => fact.status), [failed ? 'failed' : 'completed', ...queued.map(() => 'completed')])
        assert.equal(session.physicalSessionId === initialPhysicalId, failed)
        if (!failed) assert.doesNotMatch(JSON.stringify(await Array.fromAsync(store.readSessionLog(initialPhysicalId))), /DURING_COMPACT_/)
        assert.match(JSON.stringify(await Array.fromAsync(store.readSessionLog(session.physicalSessionId))), /DURING_COMPACT_late/)
      } finally {
        completeV2.resolve()
        completeV1.resolve()
        completeCommit.resolve()
        session.stop()
        await session.completion
        await handoff.stop()
      }
    })
  })
}

test('manual compact queued during a turn leaves newly interrupted history available for recovery', { timeout: 10_000 }, async () => {
  await withTempWorkspace(async workspace => {
    const store = new JsonlSessionStore(join(workspace, 'sessions'))
    await store.init()
    const started = Promise.withResolvers<void>()
    const failRequest = Promise.withResolvers<void>()
    const idle = Promise.withResolvers<void>()
    let modelCalls = 0
    const provider: LLMProvider = { name: 'fixture', listModels: () => ['fixture'], async chat() {
      modelCalls++
      started.resolve()
      await failRequest.promise
      throw new ProviderHttpError(401, 'Fixture request failed')
    } }
    const handoff = new TestHandoffManager(provider, llm.contextWindow, {}, workspace, store)
    const id = 'test:compact-recovery-race'
    const session = new TestSession(workspace, id, { sessionId: id, segmentIndex: 0, mode: 'session' }, [],
      provider, new SessionTools(new Tools(workspace), workspace), new Bus(), store, handoff, () => {})
    try {
      session.dispatch({ kind: 'message', policy: 'queue', id: 'initial', timestamp: new Date().toISOString(),
        content: 'Keep this interrupted request', source: { kind: 'event', type: 'fixture', source: 'system', eventId: 'initial' } }, llm)
      await started.promise
      session.requestCompact(llm)
      session.onIdle = idle.resolve
      failRequest.resolve()
      await idle.promise
      assert.equal(modelCalls, 1)
      assert.equal(handoff.calls, 0)
      assert.equal(session.getState().segmentIndex, 0)
      assert.equal(session.getState().recovery?.reason, 'failed')
      assert.match(JSON.stringify(session.history), /Keep this interrupted request/)
    } finally {
      failRequest.resolve()
      session.stop()
      await session.completion
      await handoff.stop()
    }
  })
})

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
              assert.deepEqual(tools.map(tool => tool.function.name), ['handoff_summary', 'read'])
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
