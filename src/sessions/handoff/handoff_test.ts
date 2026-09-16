import assert, { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { renderContinuationSummary } from './manager.ts'
import type { HandoffContext } from './manager.ts'
import { HandoffSummaryTool } from './tools.ts'
import type { HandoffCapture } from './tools.ts'
import { SessionMemoryParser } from '../session-memory.ts'
import { HandoffManager } from './manager.ts'
import { HandoffSession } from './session.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'
import { createOrganizationScope, getOrganizationScope } from '../../organizations/scope.ts'
import { JsonlSessionStore } from '../session-store-jsonl.ts'
import type { LLMProvider } from '../../providers/provider.ts'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import type { ExecutionContext } from '../../tools/context.ts'

function fallback(): HandoffContext {
  return { summary: '', currentObjective: '', recentTranscript: [] }
}

test('continuation summary — slim md is just Current Focus + Progress', () => {
  const md = renderContinuationSummary(
    {
      summary: 'Refactored the memory layer; tests pass.',
      currentObjective: 'Wire the relevance gate.',
      recentTranscript: ['x', 'y'],
    },
    '2026-07-07T00:00:00.000Z',
  )

  assert(md.includes('# Session Summary'))
  assert(md.includes('_Updated: 2026-07-07T00:00:00.000Z_'))
  assert(md.includes('## Current Focus\nWire the relevance gate.'))
  assert(md.includes('## Progress\nRefactored the memory layer; tests pass.'))

  // The slimmed handoff no longer emits the old structured sections.
  assert(!md.includes('## Themes'))
  assert(!md.includes('## Decisions'))
  assert(!md.includes('## Rejected Approaches'))
})

test('continuation summary — empty context renders (none)', () => {
  const md = renderContinuationSummary(fallback(), '2026-07-07T00:00:00.000Z')
  assert(md.includes('## Current Focus\n(none)'))
  assert(md.includes('## Progress\n(none)'))
})

test('handoff_summary tool — captures context, no memory-curation step', async () => {
  const capture: HandoffCapture = {
    context: null,
    memoryState: SessionMemoryParser.parse(''),
    memoryUpdated: false,
  }
  const tool = new HandoffSummaryTool(capture, fallback())

  const msg = await tool.execute({
    summary: 'did things',
    currentObjective: 'next thing',
    recentTranscript: ['a'],
  })

  assertEquals(capture.context?.currentObjective, 'next thing')
  assertEquals(capture.context?.summary, 'did things')
  // The message no longer points the agent at update_session_memory.
  assert(!msg.includes('update_session_memory'))
})

test('concurrent same-session handoffs use the shared provider with isolated captures, memories and runtime context', async () => {
  await withTempWorkspace(async (root) => {
    const scopes = [createOrganizationScope('a'), createOrganizationScope('b')]
    const homes = [join(root, 'a'), join(root, 'b')]
    const provider: LLMProvider = {
      name: 'fixture', listModels: () => ['fixture'],
      async chat(messages) {
        const owner = getOrganizationScope()?.organizationId
        assert(owner === 'a' || owner === 'b')
        await new Promise<void>((resolve) => setTimeout(resolve, owner === 'a' ? 5 : 1))
        if (messages.at(-1)?.role === 'tool') return { content: 'done', toolCalls: [] }
        return {
          content: null,
          toolCalls: [{
            id: 'same-tool-call', name: 'handoff_summary',
            arguments: { summary: `${owner}_PRIVATE`, currentObjective: `${owner}_NEXT`, recentTranscript: [] },
          }],
        }
      },
    }
    const managers = homes.map((home, i) => new HandoffManager(
      provider, 100_000, {}, home, new JsonlSessionStore(join(home, '.sessions')), scopes[i],
    ))
    try {
      const results = await Promise.all(managers.map((manager) => manager.create(
        'same-session', 'same-source', 'same-target',
        [{ role: 'user', content: 'Summarize this organization only' }], 'fixture',
      )))
      for (let i = 0; i < managers.length; i++) {
        const marker = i ? 'b' : 'a'
        assert.equal(results[i].context.summary, `${marker}_PRIVATE`)
        const memory = await readFile(join(homes[i], 'memory', 'sessions', 'same-session.md'), 'utf8')
        assert.match(memory, new RegExp(`${marker}_PRIVATE`))
        assert.doesNotMatch(memory, new RegExp(`${i ? 'a' : 'b'}_PRIVATE`))
      }
      await managers[0].stop()
      await assert.rejects(managers[0].create('same-session', 'x', 'y', [], 'fixture'), /stopped/)
      const alive = await managers[1].create('same-session', 'x', 'y', [], 'fixture')
      assert.equal(alive.targetSessionId, 'y')
    } finally {
      await Promise.all(managers.map((manager) => manager.stop()))
      scopes.forEach((scope) => scope.close())
    }
  })
})

test('handoff stop aborts and drains its own internal loop without writing a cancelled summary', async (t) => {
  await withTempWorkspace(async (home) => {
    const entered = Promise.withResolvers<AbortSignal>()
    const release = Promise.withResolvers<void>()
    t.mock.method(HandoffSession.prototype, 'run', async (ctx: ExecutionContext) => {
      entered.resolve(ctx.signal)
      await release.promise
    })
    const provider: LLMProvider = {
      name: 'unused', listModels: () => [],
      async chat() { throw new Error('must not reach fixture provider') },
    }
    const manager = new HandoffManager(provider, 1000, {}, home, new JsonlSessionStore(join(home, '.sessions')))
    const pending = manager.create('same-session', 'x', 'y', [{ role: 'user', content: 'test' }], 'fixture')
    const rejected = assert.rejects(pending, /Handoff runtime stopped/)
    const signal = await entered.promise
    const stopping = manager.stop()
    assert.equal(signal.aborted, true)
    release.resolve()
    await Promise.all([stopping, rejected])
    await assert.rejects(readFile(join(home, 'memory', 'sessions', 'same-session.md')), { code: 'ENOENT' })
  })
})
