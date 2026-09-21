import assert from 'node:assert/strict'
import { join } from 'node:path'
import { test } from 'node:test'
import { Bus } from '../bus/bus.ts'
import type { OutboundMessage } from '../bus/events.ts'
import type { ChatMessage, LLMProvider, LLMResponseUsage } from '../providers/provider.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import { HandoffManager, type CompactResult } from './handoff/manager.ts'
import { Session } from './session.ts'
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

  override async create(
    _id: string, _source: string, targetSessionId: string,
  ): Promise<CompactResult> {
    if (this.failure) throw this.failure
    this.calls++
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
  async function fixture(run: (f: {
    session: TestSession
    handoff: TestHandoffManager
    store: SessionStore
    bus: Bus
  }) => Promise<void>): Promise<void> {
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
      const session = new TestSession(
        workspace, state.sessionId, state, [], provider,
        new SessionTools(new Tools(workspace), workspace), bus, store, handoff, () => {},
      )
      try {
        await run({ session, handoff, store, bus })
      } finally {
        session.stop()
        await session.completion
        await handoff.stop()
        store.close?.()
      }
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
