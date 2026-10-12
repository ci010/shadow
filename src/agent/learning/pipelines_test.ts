import { projectStoragePath } from '../../utils/data-paths.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LearningRunError, LearningRuntime, learningTask } from './pipelines.ts'
import { LearningLedger } from './ledger.ts'
import { LearningTools } from './tools.ts'
import { fakeSessions } from './test-fixtures.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'
import { SessionTools, Tools } from '../../tools/registry.ts'
import type { ExecutionContext } from '../../tools/context.ts'
import { SkillsManager } from '../../skills/loader.ts'
import type { ChatMessage } from '../../providers/provider.ts'
import type { RecordedFileChange } from '../../sessions/file-change-contract.ts'
import { WriteTool } from '../../tools/filesystem.ts'
import { LogTool } from '../../tools/log.ts'
import { physicalSessionId } from '../../sessions/session-identity.ts'

const signal = () => new AbortController().signal
function fixture(workspace: string, total = 5, skills?: SkillsManager) {
  const f = fakeSessions(workspace, [{ sessionId: 'web:source', segmentIndex: 0, total }])
  const runtime = new LearningRuntime(f.sessions, 'a', skills)
  const tools = new LearningTools(runtime)
  const context = (sessionId: string): ExecutionContext => ({
    sessionId, projectId: 'a', physicalSessionId: `${sessionId}-0`, cwd: workspace, signal: signal(),
    channel: 'cron', chatId: sessionId, senderId: 'fixture', messageId: 'fixture',
    tools: new SessionTools(new Tools(workspace), workspace),
  })
  return { ...f, runtime, tools, context }
}
const decision = {
  action: 'save', name: 'readable-outcomes', revision: '', title: 'Readable outcomes',
  kind: 'motivation', confidence: 'inferred', evaluation: 'new',
  condition: 'When reviewing automation output', goal: 'Understand changes without another workspace',
  rationale: 'The user requested contextual presentation, not removal of every diff.',
  guidance: 'Use contextual diffs for files and readable events.', exceptions: 'A dedicated code review can need a full diff.',
  reviewWhen: 'The user changes the task or corrects this interpretation.', evidence: ['web:source'],
}

test('verified no-change advances bounded cursors; legacy history is not replayed or relabelled', async () => {
  await withTempWorkspace(async workspace => {
    await mkdir(join(workspace, 'memory'))
    await writeFile(join(workspace, 'memory', '.reflect-watermark.json'), JSON.stringify({
      lastRunAt: '2026-09-16T00:00:00Z', sessions: { 'web:source': { segmentIndex: 0, messageCount: 3 } },
    }))
    const f = fixture(workspace, 105)
    f.onRun(async id => {
      const batch = f.runtime.ledger.batchFor(id)!
      assert.equal(batch.sources[0].offset, 3)
      assert.equal(batch.sources[0].end, 103)
      assert.match(learningTask(batch), /page_size=20/)
      await f.tools.result.execute({ status: 'no_change', summary: 'Reviewed greetings; no durable signal.' }, f.context(id))
    })
    const id = await f.runtime.run('reflector', signal())
    assert.equal(f.runtime.ledger.outcome(String(id))?.status, 'no_change')
    const restarted = new LearningRuntime(f.sessions, 'a')
    assert.equal((await restarted.sources(signal()))[0].offset, 103)
    assert.equal(restarted.ledger.outcome('historical-run'), undefined)
    assert.equal(restarted.ledger.eventsFor('encapsulator').length, 0)
  })
})

test('missing, blocked and unverified receipts do not acknowledge source ranges', async () => {
  await withTempWorkspace(async workspace => {
    const f = fixture(workspace)
    await assert.rejects(f.runtime.run('reflector', signal()), /No learning_result/)
    assert.equal((await f.runtime.sources(signal()))[0].offset, 0)
    const pending = f.runtime.ledger.pending('reflector')!.id
    f.onRun(async id => {
      await f.tools.result.execute({ status: 'blocked', summary: 'Source page could not be read.' }, f.context(id))
    })
    await assert.rejects(f.runtime.run('reflector', signal()), /blocked/)
    assert.equal(f.runtime.ledger.pending('reflector')!.id, pending)
    assert.equal(f.runtime.ledger.eventsFor('encapsulator').length, 0)
  })
})

test('unsupported models, endpoints and reasoning settings are nonretryable learning failures', async () => {
  await withTempWorkspace(async workspace => {
    const f = fixture(workspace)
    for (const code of ['model_not_supported', 'unsupported_api_for_model', 'unsupported_reasoning_effort']) {
      f.onRun(async () => { throw new Error(`[copilot] ${code}: model "fixture@copilot". Check model settings.`) })
      await assert.rejects(f.runtime.run('reflector', signal()), error =>
        error instanceof LearningRunError && !error.retryable && error.message.includes(code))
      const batch = f.runtime.ledger.pending('reflector')!
      assert.equal(f.runtime.ledger.cursor(batch.sources[0]), 0)
      assert.equal(f.runtime.ledger.outcome(batch.attempts.at(-1)!)?.status, 'blocked')
    }
  })
})

test('decision writes preserve conditions, uncertainty and evidence; downstream consumes exact durable events once', async () => {
  await withTempWorkspace(async workspace => {
    const f = fixture(workspace)
    f.onRun(async id => {
      await f.tools.memory.execute(decision, f.context(id))
      await assert.rejects(f.tools.result.execute({ status: 'no_change', summary: 'Nothing' }, f.context(id)), /persisted effects/)
      await f.tools.result.execute({ status: 'applied', summary: 'Retained one scoped hypothesis.' }, f.context(id))
    })
    const id = await f.runtime.run('reflector', signal())
    const outcome = f.runtime.ledger.outcome(String(id))!
    assert.deepEqual([outcome.artifacts, outcome.events, outcome.evaluated], [1, 1, 0])
    const content = await readFile(join(workspace, 'memory', 'decisions', 'readable-outcomes.md'), 'utf8')
    assert.match(content, /provisional hypothesis/)
    assert.match(content, /Exceptions and counterexamples/)
    assert.match(content, /web:source.*\[0, 5\)/)
    assert.equal(await f.runtime.run('reflector', signal()), false)
    const events = f.runtime.ledger.eventsFor('encapsulator')
    assert.equal(events.length, 1)
    f.onRun(async id => {
      const batch = f.runtime.ledger.batchFor(id)!
      assert.deepEqual(batch.inputEvents, events)
      assert.match(learningTask(batch), new RegExp(events[0].id))
      await f.tools.result.execute({ status: 'no_change', summary: 'Decision is sufficient; no separate skill justified.' }, f.context(id))
    })
    await f.runtime.run('encapsulator', signal())
    assert.equal(await f.runtime.run('encapsulator', signal()), false)
    assert.equal(f.runtime.ledger.eventsFor('soulReflector').length, 1)
  })
})

test('partial effects survive restart and stable event keys prevent duplicate logs across midnight', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-02T23:59:00Z') })
  await withTempWorkspace(async workspace => {
    const f = fixture(workspace)
    f.onRun(async id => {
      await new LogTool(workspace, (entry, key, context) => f.tools.appendEvent(entry, key, context)).execute({
        who: 'user', what: 'Selected contextual results', session: 'web:source', key: 'message-3-choice',
      }, f.context(id))
      throw new Error('fetch failed')
    })
    await assert.rejects(f.runtime.run('reflector', signal()), /fetch failed/)
    const batch = f.runtime.ledger.pending('reflector')!
    t.mock.timers.tick(120_000)
    const runtime = new LearningRuntime(f.sessions, 'a')
    const tools = new LearningTools(runtime)
    f.onRun(async id => {
      assert.match(tools.appendEvent({ who: 'user', what: 'Selected contextual results', origin: 'web:source' }, 'message-3-choice', f.context(id))!, /already recorded/)
      await tools.result.execute({ status: 'applied', summary: 'Recovered the persisted event.' }, f.context(id))
    })
    await runtime.run('reflector', signal())
    const rows = (await readFile(join(workspace, batch.events[0].path), 'utf8')).trim().split('\n')
    assert.equal(rows.length, 1)
    assert.equal(runtime.ledger.eventsFor('encapsulator').length, 1)
  })
})

test('receipt recovery commits completed runs but never claims interrupted or changed effects', async () => {
  await withTempWorkspace(async workspace => {
    const f = fixture(workspace)
    const sources = await f.runtime.sources(signal())
    const batch = f.runtime.ledger.create('reflector', sources, [])
    f.runtime.ledger.bind(batch.id, 'cron:old')
    f.runtime.ledger.propose(batch.id, 'no_change', 'Reviewed; no reusable signal.')
    f.records.set('cron:old', { sessionId: 'cron:old', segmentIndex: 0, executionStatus: 'completed' })
    const runtime = new LearningRuntime(f.sessions, 'a')
    await runtime.recover()
    assert.equal(runtime.ledger.outcome('cron:old')?.status, 'no_change')
    assert.equal((await runtime.sources(signal())).length, 0)
    assert.throws(() => new LearningLedger(workspace, 'other'), /different Project/)
  })
})

test('foreign sources, stale edits, remote/call contexts and artifact drift are rejected', async () => {
  await withTempWorkspace(async workspace => {
    const f = fixture(workspace)
    f.onRun(async id => {
      const ctx = f.context(id)
      await assert.rejects(f.tools.memory.execute({ ...decision, evidence: ['web:foreign'] }, ctx), /assigned learning batch/)
      await assert.rejects(f.tools.memory.execute(decision, { ...ctx, projectId: 'b' }), /owning Project/)
      await f.tools.memory.execute(decision, ctx)
      await assert.rejects(f.tools.memory.execute({ ...decision, evaluation: 'corrected' }, ctx), /changed since read/)
      const read = JSON.parse(await f.tools.memory.execute({ action: 'read', name: decision.name }, ctx))
      await f.tools.memory.execute({ ...decision, evaluation: 'retired', revision: read.revision }, ctx)
      assert.match(await readFile(join(workspace, 'memory', 'decisions', `${decision.name}.md`), 'utf8'), /retired; do not apply/)
      await f.tools.result.execute({ status: 'applied', summary: 'Retired the disproven hypothesis.' }, ctx)
      await writeFile(join(workspace, 'memory', 'decisions', `${decision.name}.md`), 'concurrent change')
    })
    await assert.rejects(f.runtime.run('reflector', signal()), error =>
      error instanceof LearningRunError && !error.retryable && /changed after writing/.test(error.message))
    assert.equal((await f.runtime.sources(signal()))[0].offset, 0)
  })
})

test('direct writes and unresolved tool failures cannot masquerade as no-change, but repaired writes can complete', async t => {
    await withTempWorkspace(async workspace => {
      const f = fixture(workspace)
      const histories = new Map<string, ChatMessage[]>()
      const writes = new Map<string, RecordedFileChange[]>()
      const original = f.sessions.getHistory.bind(f.sessions)
      t.mock.method(f.sessions, 'getHistory', async (...[id, query]: Parameters<typeof f.sessions.getHistory>) => {
        if (!id.startsWith('cron:')) return original(id, query)
        const messages = histories.get(id) ?? []
        return { messages: messages.slice(query?.offset ?? 0, (query?.offset ?? 0) + (query?.pageSize ?? 100)), total: messages.length }
      })
      t.mock.method(f.sessions, 'getFileChanges', async (id: string) => ({ changes: writes.get(id) ?? [], total: (writes.get(id) ?? []).length, offset: 0 }))
      const record = (id: string, path: string, result: string) => {
        const messages = histories.get(id) ?? []
        const callId = `write-${messages.length}`
        messages.push({ role: 'assistant', content: '', tool_calls: [{ id: callId, type: 'function',
          function: { name: 'write', arguments: JSON.stringify({ path, content: 'useful note' }) } }] },
        { role: 'tool', name: 'write', content: result, tool_call_id: callId })
        histories.set(id, messages)
      }
      f.onRun(async id => {
        record(id, 'v:memory/topics/outcomes.md', 'Error executing write: readonly')
        await assert.rejects(f.tools.result.execute({ status: 'no_change', summary: 'Nothing retained' }, f.context(id)), /Unresolved/)
        await f.tools.result.execute({ status: 'blocked', summary: 'Writing failed.' }, f.context(id))
      })
      await assert.rejects(f.runtime.run('reflector', signal()), /blocked/)
      f.onRun(async id => {
        const ctx = { ...f.context(id), toolCallId: 'write-0', recordFileChange: async (change: RecordedFileChange) => { writes.set(id, [change]) } }
        const path = join(workspace, 'memory', 'topics', 'outcomes.md')
        await new WriteTool(workspace).execute({ path, content: 'useful note' }, ctx)
        record(id, path, 'Successfully wrote file')
        await assert.rejects(f.tools.result.execute({ status: 'no_change', summary: 'Nothing retained' }, ctx), /persisted effects/)
        record(id, path, 'Error executing write: later revision failed')
        await assert.rejects(f.tools.result.execute({ status: 'applied', summary: 'All done' }, ctx), /Unresolved/,
          'an earlier successful write must not hide a later failure')
        record(id, path, 'Successfully wrote file')
        f.tools.appendEvent({ who: 'reflector', what: 'Retained a useful note', origin: 'web:source' }, 'outcomes', ctx)
        await f.tools.result.execute({ status: 'applied', summary: 'Recovered the direct write.' }, ctx)
      })
      const id = String(await f.runtime.run('reflector', signal()))
      assert.equal(f.runtime.ledger.outcome(id)?.artifacts, 1)
      assert.equal((await f.runtime.sources(signal())).length, 0)
    })
  })

  test('source ranges survive compaction, skip foreign Projects and never acknowledge messages arriving mid-batch', async t => {
    await withTempWorkspace(async workspace => {
      const f = fakeSessions(workspace, [{ sessionId: 'web:source', segmentIndex: 2, total: 10 },
        { sessionId: 'web:foreign', segmentIndex: 0, total: 50 }])
      f.records.get('web:foreign')!.projectId = 'b'
      let total = 10
      t.mock.method(f.sessions, 'getHistory', async (...[id, query]: Parameters<typeof f.sessions.getHistory>) => ({
        messages: [], total: id.startsWith('cron:') ? 0 : query?.physicalId?.endsWith('-0') ? 0 : query?.physicalId?.endsWith('-1') ? 5 : total,
      }))
      const runtime = new LearningRuntime(f.sessions, 'a')
      const tools = new LearningTools(runtime)
      const context = fixture(workspace).context
      const sources = await runtime.sources(signal())
      assert.deepEqual(sources.map(source => [source.sessionId, source.segmentIndex, source.offset, source.end]),
        [['web:source', 1, 0, 5], ['web:source', 2, 0, 10]])
      f.onRun(async id => {
        total = 14
        await tools.result.execute({ status: 'no_change', summary: 'No durable signal in the original ranges.' }, context(id))
      })
      await runtime.run('reflector', signal())
      assert.deepEqual((await runtime.sources(signal())).map(source => [source.segmentIndex, source.offset, source.end]), [[2, 10, 14]])
    })
  })

  test('cancellation and recovered partial proposals preserve input and pause incomplete outcomes', async () => {
    await withTempWorkspace(async workspace => {
      const f = fixture(workspace)
      const controller = new AbortController()
      f.onRun(async id => {
        await f.tools.result.execute({ status: 'no_change', summary: 'Reviewed' }, f.context(id))
        controller.abort(new Error('cancelled'))
      })
      await assert.rejects(f.runtime.run('reflector', controller.signal), /cancelled/)
      assert.equal((await f.runtime.sources(signal()))[0].offset, 0)
      const batch = f.runtime.ledger.pending('reflector')!
      f.runtime.ledger.bind(batch.id, 'cron:partial')
      f.runtime.ledger.propose(batch.id, 'partial', 'Review remains incomplete')
      f.records.set('cron:partial', { sessionId: 'cron:partial', segmentIndex: 0, executionStatus: 'completed' })
      const restarted = new LearningRuntime(f.sessions, 'a')
      await restarted.recover()
      assert.equal(restarted.ledger.outcome('cron:partial')?.status, 'partial')
      assert(restarted.ledger.retry('reflector').paused)
      assert.equal((await restarted.sources(signal()))[0].offset, 0)
    })
  })

  test('failed journal persistence rolls back in-memory acknowledgement', async () => {
    await withTempWorkspace(async workspace => {
      const f = fixture(workspace)
      const source = (await f.runtime.sources(signal()))[0]
      const batch = f.runtime.ledger.create('reflector', [source], [])
      f.runtime.ledger.bind(batch.id, 'cron:pending')
      f.runtime.ledger.propose(batch.id, 'no_change', 'Reviewed')
      const path = projectStoragePath(workspace, '.learning', 'state.v1.json')
      const saved = await readFile(path, 'utf8')
      await rm(path)
      await mkdir(path)
      assert.throws(() => f.runtime.ledger.complete(batch.id))
      assert.equal(f.runtime.ledger.cursor(source), 0)
      assert.equal(f.runtime.ledger.outcome('cron:pending'), undefined)
      await rm(path, { recursive: true })
      await writeFile(path, saved)
      f.runtime.ledger.complete(batch.id)
      assert.equal(new LearningLedger(workspace, 'a').cursor(source), source.end)
    })
  })

  test('Soul revisions require independent source origins and preserve continuity', async () => {
    await withTempWorkspace(async workspace => {
      const f = fixture(workspace)
      const source = { sessionId: 'web:other', physicalId: physicalSessionId({ sessionId: 'web:other', segmentIndex: 0 }, 0),
        segmentIndex: 0, offset: 0, end: 1 }
      const batch = f.runtime.ledger.create('soulReflector', [], [source.sessionId, 'web:source'].map((origin, index) => ({
        id: String(index), path: 'memory/events/fixture.jsonl', when: '2026-10-02T00:00:00Z', origin, who: 'user', what: 'Stable pattern',
      })))
      f.runtime.ledger.bind(batch.id, 'cron:soul')
      f.records.set('cron:soul', { sessionId: 'cron:soul', segmentIndex: 0 })
      const ctx = f.context('cron:soul')
      const args = { action: 'save', revision: '', content: '# Soul\nIf you change this file, tell the user.\nKeep reasons conditional.',
        rationale: 'Independent sources agree on the scope.', evidence: ['web:source', 'web:source'] }
      await assert.rejects(f.tools.soul.execute(args, ctx), /distinct source sessions/)
      await assert.rejects(f.tools.soul.execute({ ...args, evidence: ['web:source', 'web:other'], content: '# Soul' }, ctx), /continuity/)
      await f.tools.soul.execute({ ...args, evidence: ['web:source', 'web:other'] }, ctx)
      assert.match(await readFile(projectStoragePath(workspace, 'SOUL.md'), 'utf8'), /Keep reasons conditional/)
    })
  })
test('lesson skills use the real shared edit store and are immediately discoverable, never executable', async () => {
  await withTempWorkspace(async workspace => {
    const skills = new SkillsManager(workspace)
    const f = fixture(workspace, 5, skills)
    f.onRun(async id => {
      await f.tools.memory.execute(decision, f.context(id))
      await f.tools.result.execute({ status: 'applied', summary: 'One decision.' }, f.context(id))
    })
    await f.runtime.run('reflector', signal())
    f.onRun(async id => {
      const ctx = f.context(id)
      const content = '---\nname: outcome-review\ndescription: Review outcomes in context\n---\nUse contextual results; retain source evidence and recheck the user goal.\n'
      const read = JSON.parse(await f.tools.skill.execute({ action: 'read', name: 'outcome-review' }, ctx))
      assert.equal(read.revision, '')
      await f.tools.skill.execute({ action: 'save', name: 'outcome-review', revision: '', content }, ctx)
      assert(skills.getSkillDirectory('outcome-review'))
      await assert.rejects(f.tools.skill.execute({ action: 'save', name: 'unsafe', revision: '',
        content: '---\nname: unsafe\ndescription: bad\ntools: {bad: {source: execute.ts}}\n---\nBad' }, ctx), /executable packages/)
      await f.tools.result.execute({ status: 'applied', summary: 'Installed one lesson-only skill.' }, ctx)
    })
    await f.runtime.run('encapsulator', signal())
    assert.equal(f.runtime.ledger.eventsFor('encapsulator').length, 0)
  })
})

test('invalid persisted progress is surfaced, not silently replayed as a first run', async () => {
  await withTempWorkspace(async workspace => {
    await mkdir(join(workspace, 'memory'))
    await writeFile(join(workspace, 'memory', '.reflect-watermark.json'), '{invalid')
    assert.throws(() => fixture(workspace), /JSON/)
  })
})

test('empty or oversized diagnostics still persist a blocked outcome without advancing progress', async () => {
  await withTempWorkspace(async workspace => {
    const f = fixture(workspace)
    const sources = await f.runtime.sources(signal())
    const batch = f.runtime.ledger.create('reflector', sources, [])
    for (const [index, error] of ['', 'x'.repeat(9000)].entries()) {
      const id = `cron:error-${index}`
      f.runtime.ledger.bind(batch.id, id)
      f.runtime.ledger.interrupt(batch.id, error)
      const outcome = new LearningLedger(workspace, 'a').outcome(id)!
      assert.equal(outcome.status, 'blocked')
      assert(outcome.summary.length > 0 && outcome.summary.length <= 8000)
      assert.equal(f.runtime.ledger.cursor(sources[0]), 0)
    }
  })
})
