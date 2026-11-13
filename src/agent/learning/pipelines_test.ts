import { projectStoragePath } from '../../utils/data-paths.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { LearningRunError, LearningRuntime, learningTask, LEARNING_LIMITS } from './pipelines.ts'
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
      assert.equal(batch.sources[0].end, 43)
      assert.match(learningTask(batch), /\/overview.*read.offset\/read.limit/)
      const task = learningTask(batch, new Map([[batch.sources[0].physicalId, { offset: 12, end: 312, fullOffset: 28, fullEnd: 900 }]]))
      assert.match(task, /\/overview", offset: 12, limit: 100/)
      assert.match(task, /stopping before line 312/)
      assert.match(task, /Read each assigned overview range once/)
      assert.match(task, /Do not expand every tool call/)
      assert.match(task, /submit partial with the unread scope/)
      assert.match(task, /\/calls\/<encoded-id>/)
      assert.match(task, /\/c\/<message>\.<call>/)
      assert.match(task, /\[28, 900\)/)
      const empty = learningTask(batch, new Map([[batch.sources[0].physicalId, { offset: 3, end: 3, fullOffset: 3, fullEnd: 9 }]]))
      assert.match(empty, /no overview entries.*Do not read adjacent messages/)
      assert.doesNotMatch(empty, /limit: 0|First read overview/)
      assert.match(empty, /\[3, 9\)/)
      await f.tools.result.execute({ status: 'no_change', summary: 'Reviewed greetings; no durable signal.' }, f.context(id))
    })
    const id = await f.runtime.run('reflector', signal())
    assert.equal(f.runtime.ledger.outcome(String(id))?.status, 'no_change')
    assert.deepEqual((f.started[0] as unknown as { executionLimits: unknown }).executionLimits, LEARNING_LIMITS.reflector)
    const restarted = new LearningRuntime(f.sessions, 'a')
    assert.equal((await restarted.sources(signal()))[0].offset, 43)
    assert.equal(restarted.ledger.outcome('historical-run'), undefined)
    assert.equal(restarted.ledger.logsFor('encapsulator').length, 0)
  })
})

test('reflection guidance asks for evidence-backed behavioral learning without forcing lessons', async () => {
  await withTempWorkspace(async workspace => {
    const f = fixture(workspace)
    const batch = f.runtime.ledger.create('reflector', [], [])
    const task = learningTask(batch)
    assert.match(task, /explicit user corrections/)
    assert.match(task, /observed result or correction/)
    assert.match(task, /which future decision or action would this change/)
    assert.match(task, /support, narrow, correct or retire/)
    assert.match(task, /No quota of new memories/)
    assert.match(task, /A truncated source is not fully reviewed/)
    assert.match(task, /attachment marker as image understanding/)
    assert.match(task, /downstream usefulness is not yet observed/)
    assert.match(task, /Use different retention thresholds/)
    assert.match(task, /Unresolved challenges can be retained/)
    assert.match(task, /Do not apply this extra test to Wiki facts or significant logs/)
    assert.match(task, /candidates retained or omitted/)
    assert.doesNotMatch(task, /Before retaining a candidate, answer/)
    const guideline = (await readFile(new URL('../types/builtin/reflector/AGENT.md', import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
    assert.match(guideline, /it need not change a future action/)
    assert.match(guideline, /An unresolved challenge is eligible/)
    assert.match(guideline, /parent.*\nconversation's bounded result summaries, user acceptance and corrections/)
    assert.match(guideline, /Do not fetch child-only histories/)
    assert.match(guideline, /use a higher bar/)
    assert.match(guideline, /publishable skill needs a reusable procedure/)
    assert.doesNotMatch(guideline, /Retain only facts, stated goals or conditional principles that affect future/)
    const downstream = learningTask({ ...batch, pipeline: 'encapsulator' })
    assert.doesNotMatch(downstream, /Look for learning signals/)
    assert.match(downstream, /Use learning_memory for decisions and learned_skill/)
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
    await assert.rejects(f.runtime.run('reflector', signal(), undefined, undefined, undefined, true), /blocked/)
    assert.equal(f.runtime.ledger.pending('reflector')!.id, pending)
    assert.equal(f.runtime.ledger.logsFor('encapsulator').length, 0)
  })
})

test('unsupported models, endpoints and reasoning settings are nonretryable learning failures', async () => {
  await withTempWorkspace(async workspace => {
    const f = fixture(workspace)
    for (const code of ['model_not_supported', 'unsupported_api_for_model', 'unsupported_reasoning_effort']) {
      f.onRun(async () => { throw new Error(`[copilot] ${code}: model "fixture@copilot". Check model settings.`) })
      await assert.rejects(f.runtime.run('reflector', signal(), undefined, undefined, undefined, true), error =>
        error instanceof LearningRunError && !error.retryable && error.message.includes(code))
      const batch = f.runtime.ledger.pending('reflector')!
      assert.equal(f.runtime.ledger.cursor(batch.sources[0]), 0)
      assert.equal(f.runtime.ledger.outcome(batch.attempts.at(-1)!)?.status, 'blocked')
    }
  })
})

test('decision writes preserve conditions, uncertainty and evidence; downstream consumes exact durable logs once', async () => {
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
    const events = f.runtime.ledger.logsFor('encapsulator')
    assert.equal(events.length, 1)
    f.onRun(async id => {
      const batch = f.runtime.ledger.batchFor(id)!
      assert.deepEqual(batch.inputEvents.slice(0, events.length), events)
      assert.equal(batch.inputEvents.length, 2)
      assert.equal(batch.inputEvents[1].origin, 'v:memory/decisions/readable-outcomes.md')
      assert.match(learningTask(batch), new RegExp(events[0].id))
      await f.tools.result.execute({ status: 'no_change', summary: 'Decision is sufficient; no separate skill justified.' }, f.context(id))
    })
    await f.runtime.run('encapsulator', signal())
    assert.equal(await f.runtime.run('encapsulator', signal()), false)
    assert.equal(f.runtime.ledger.logsFor('soulReflector').length, 1)
  })
})

test('partial effects survive restart and stable log keys prevent duplicate logs across midnight', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-02T23:59:00Z') })
  await withTempWorkspace(async workspace => {
    const f = fixture(workspace)
    f.onRun(async id => {
      await new LogTool(workspace, (entry, key, context) => f.tools.appendLog(entry, key, context)).execute({
        who: 'user', summary: 'User selected contextual results.', what: 'Selected contextual results', session: 'web:source', key: 'message-3-choice',
      }, f.context(id))
      throw new Error('fetch failed')
    })
    await assert.rejects(f.runtime.run('reflector', signal()), /fetch failed/)
    const batch = f.runtime.ledger.pending('reflector')!
    t.mock.timers.tick(120_000)
    const runtime = new LearningRuntime(f.sessions, 'a')
    const tools = new LearningTools(runtime)
    f.onRun(async id => {
      assert.match(tools.appendLog({ who: 'user', summary: 'User selected contextual results.', what: 'Selected contextual results', origin: 'web:source' }, 'message-3-choice', f.context(id))!, /already recorded/)
      await tools.result.execute({ status: 'applied', summary: 'Recovered the persisted event.' }, f.context(id))
    })
    await runtime.run('reflector', signal(), undefined, undefined, undefined, true)
    const rows = (await readFile(join(workspace, batch.events[0].path), 'utf8')).trim().split('\n')
    assert.equal(rows.length, 1)
    assert.equal(runtime.ledger.logsFor('encapsulator').length, 1)
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
      await assert.rejects(f.runtime.run('reflector', signal(), undefined, undefined, undefined, true), /blocked/)
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
        f.tools.appendLog({ who: 'reflector', summary: 'Retained a useful note.', what: 'Retained a useful note', origin: 'web:source' }, 'outcomes', ctx)
        await f.tools.result.execute({ status: 'applied', summary: 'Recovered the direct write.' }, ctx)
      })
      const id = String(await f.runtime.run('reflector', signal(), undefined, undefined, undefined, true))
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
      t.mock.method(f.sessions, 'getHistory', async (...[id, query]: Parameters<typeof f.sessions.getHistory>) => {
        const count = id.startsWith('cron:') ? 0 : query?.physicalId?.endsWith('-0') ? 0 : query?.physicalId?.endsWith('-1') ? 5 : total
        const offset = query?.offset ?? 0
        return { messages: Array.from({ length: count }, () => ({ role: 'user' as const, content: 'hello' }))
          .slice(offset, offset + (query?.pageSize ?? count)), total: count }
      })
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
      await runtime.run('reflector', signal(), undefined, undefined, undefined, true)
      assert.deepEqual((await runtime.sources(signal())).map(source => [source.segmentIndex, source.offset, source.end]), [[2, 10, 14]])
    })
  })

  test('cancellation and recovered partial proposals preserve input and defer incomplete outcomes', async () => {
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
      assert(restarted.ledger.pending('reflector')!.retry!.notBefore > Date.now())
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
    assert.equal(f.runtime.ledger.logsFor('encapsulator').length, 0)
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


test('source scanning and legacy retry exclude internal automation without consuming its cursor', async () => withTempWorkspace(async workspace => {
  const f = fakeSessions(workspace, ['root', 'internal', 'internal-child', 'cron-work'].map(sessionId => ({ sessionId, segmentIndex: 0, total: 3 })))
  const automation = (source: 'system' | 'cron') => ({ jobId: source, name: source, runId: source, startedAt: new Date(0).toISOString(), contextMode: 'fresh' as const, config: { source, schedule: 'manual' } })
  f.records.get('internal')!.automation = automation('system')
  f.records.get('internal-child')!.parentSessionId = 'internal'
  f.records.get('cron-work')!.automation = automation('cron')
  const runtime = new LearningRuntime(f.sessions, 'a')
  assert.deepEqual((await runtime.sources(signal())).map(source => source.sessionId), ['root', 'cron-work'])
  const identity = { sessionId: 'internal', physicalId: physicalSessionId(f.records.get('internal')!), segmentIndex: 0 }
  runtime.ledger.create('reflector', [{ ...identity, offset: 0, end: 3 }], [])
  await runtime.recover()
  assert.equal(runtime.ledger.pending('reflector'), undefined)
  assert.equal(f.started.length, 0)
  assert.equal(runtime.ledger.cursor(identity), 0)
}))

test('batch instructions mention only pipeline-specific mutation tools', async () => withTempWorkspace(async workspace => {
  const ledger = new LearningLedger(workspace, 'a')
  for (const pipeline of ['reflector', 'encapsulator', 'soulReflector'] as const) {
    const prompt = learningTask(ledger.create(pipeline, [], []))
    assert.match(prompt, /learning_result/)
    if (pipeline === 'soulReflector') {
      assert.match(prompt, /learning_soul/)
      assert.doesNotMatch(prompt, /learning_memory|learned_skill/)
    } else {
      assert.match(prompt, /learning_memory/)
      assert.doesNotMatch(prompt, /learning_soul/)
      if (pipeline === 'reflector') assert.doesNotMatch(prompt, /learned_skill/)
      else assert.match(prompt, /learned_skill/)
    }
    assert.equal(LEARNING_LIMITS[pipeline].inferenceRequests, pipeline === 'reflector' ? 6 : pipeline === 'encapsulator' ? 8 : 4)
  }
}))

test('audit repairs historical oversized reads across attempts while retaining unrelated failures', async t => {
  await withTempWorkspace(async workspace => {
    const f = fixture(workspace)
    const batch = f.runtime.ledger.create('reflector', [], [])
    f.runtime.ledger.bind(batch.id, 'cron:old')
    f.runtime.ledger.interrupt(batch.id, 'retry')
    f.runtime.ledger.bind(batch.id, 'cron:new')
    for (const id of ['cron:old', 'cron:new']) f.records.set(id, { sessionId: id, segmentIndex: 0, projectId: 'a' })
    const exchange = (id: string, name: string, args: object, text: string): ChatMessage[] => [
      { role: 'assistant', content: '', tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
      { role: 'tool', content: text, tool_call_id: id },
    ]
    let writeFailed = false
    t.mock.method(f.sessions, 'getHistory', async (id: string) => {
      const messages = id === 'cron:old'
        ? Array.from({ length: 17 }, (_, i) => exchange(`old${i}`, 'read', { path: 'v:sessions/source/overview', offset: 1, limit: 90000 }, 'Error: too large')).flat()
        : [...exchange('page1', 'read', { path: 'v:sessions/source/overview', offset: 1, limit: 2 }, 'a\nb\n\n[truncated: showing lines 1-2 of 4; use offset=3 to continue]'),
          ...exchange('page2', 'read', { path: 'v:sessions/source/overview', offset: 3, limit: 2 }, 'c\nd'),
          ...(writeFailed ? exchange('write', 'write', { path: 'v:memory/topics/x.md' }, 'Error: denied') : [])]
      return { messages, total: messages.length }
    })
    await f.runtime.inspectEffects(f.runtime.ledger.batchFor('cron:new')!, false, true)
    writeFailed = true
    await assert.rejects(f.runtime.inspectEffects(f.runtime.ledger.batchFor('cron:new')!, false, true), /denied/)
  })
})

for (const running of [false, true]) test(`excluded legacy mixed batch releases root work (running=${running})`, async () => withTempWorkspace(async workspace => {
  const f = fixture(workspace, 3)
  const root = (await f.runtime.sources(signal()))[0]
  f.records.set('virtual:child', { sessionId: 'virtual:child', segmentIndex: 0, projectId: 'a', parentSessionId: 'web:source' })
  const child = { ...root, sessionId: 'virtual:child', physicalId: 'child-0' }
  const old = f.runtime.ledger.create('reflector', [root, child], [])
  f.runtime.ledger.artifact(old.id, { path: 'memory/kept.md', revision: 'kept', kind: 'memory' })
  f.runtime.ledger.log(old.id, { id: 'kept', path: 'events', origin: 'child', when: 'then', who: 'worker', what: 'retained' })
  if (running) f.runtime.ledger.bind(old.id, 'cron:old')
  else f.runtime.ledger.defer(old.id, false)
  const runtime = new LearningRuntime(f.sessions, 'a')
  if (running) await runtime.recover()
  f.onRun(async id => {
    const batch = runtime.ledger.batchFor(id)!
    assert.deepEqual(batch.sources.map(s => s.sessionId), ['web:source'])
    runtime.ledger.propose(batch.id, 'no_change', 'Reviewed parent evidence')
  })
  await runtime.run('reflector', signal())
  assert.equal(f.started.length, 1)
  assert.equal(await runtime.run('reflector', signal(), undefined, undefined, undefined, true), false)
  const persisted = new LearningLedger(workspace, 'a')
  assert(persisted.batch(old.id).excluded)
  assert.equal(persisted.batch(old.id).artifacts.length, 1)
  assert.equal(persisted.batch(old.id).events.length, 1)
  assert.equal(persisted.outcome('cron:old'), undefined)
  assert.equal(persisted.cursor(child), 0)
  assert.equal(persisted.cursor(root), 3)
  assert.equal(persisted.pending('reflector'), undefined)
}))

test('readable-size batching preserves exact cursors and isolates atomic oversized messages', async t => {
  await withTempWorkspace(async workspace => {
    const f = fixture(workspace, 10)
    let body = 'x'.repeat(5000)
    t.mock.method(f.sessions, 'getHistory', async (_id: string, query?: { offset?: number; pageSize?: number }) => ({
      messages: Array.from({ length: 10 }, () => ({ role: 'user' as const, content: body }))
        .slice(query?.offset ?? 0, (query?.offset ?? 0) + (query?.pageSize ?? 10)), total: 10,
    }))
    const sources = await f.runtime.sources(signal())
    assert.deepEqual(sources.map(s => [s.offset, s.end]), [[0, 2]])
    const batch = f.runtime.ledger.create('reflector', sources, [])
    f.runtime.ledger.bind(batch.id, 'cron:test')
    f.runtime.ledger.propose(batch.id, 'no_change', 'Reviewed')
    f.runtime.ledger.complete(batch.id)
    assert.deepEqual((await f.runtime.sources(signal())).map(s => [s.offset, s.end]), [[2, 4]])
    body = 'x'.repeat(50000)
    assert.deepEqual((await f.runtime.sources(signal())).map(s => [s.offset, s.end]), [[2, 3]])
  })
})

test('new reflector logs require bounded briefings; persisted briefings survive restart', async () => withTempWorkspace(async workspace => {
  const f = fixture(workspace, 3)
  f.onRun(async id => {
    const ctx = f.context(id)
    const entry = { who: 'user', what: 'Full observed details', origin: 'web:source' }
    assert.throws(() => f.tools.appendLog(entry, 'brief', ctx), /require a short summary/)
    assert.throws(() => f.tools.appendLog({ ...entry, summary: '😀'.repeat(281) }, 'brief', ctx), /summary/)
    f.tools.appendLog({ ...entry, summary: '😀'.repeat(280) }, 'brief', ctx)
    f.runtime.ledger.propose(f.runtime.ledger.batchFor(id)!.id, 'applied', 'Recorded event')
  })
  await f.runtime.run('reflector', signal())
  const reloaded = new LearningLedger(workspace, 'a')
  assert.equal(reloaded.logsFor('encapsulator')[0].summary, '😀'.repeat(280))
  assert.equal(reloaded.logsFor('encapsulator')[0].what, 'Full observed details')
}))

test('Wiki-only unresolved challenge can produce an experimental discoverable skill and verified receipt', async () => withTempWorkspace(async workspace => {
  await mkdir(join(workspace, 'memory/topics'), { recursive: true })
  await writeFile(join(workspace, 'memory/topics/delivery.md'), '# Delivery challenge\nBuild passed but recipient still reports missing file. Separate status, loaded build and actual recipient delivery; cause unknown.')
  const skills = new SkillsManager(workspace)
  const f = fixture(workspace, 0, skills)
  f.onRun(async id => {
    const batch = f.runtime.ledger.batchFor(id)!
    assert.equal(batch.inputEvents.length, 1)
    assert.equal(batch.inputEvents[0].origin, 'v:memory/topics/delivery.md')
    const task = learningTask(batch)
    assert.match(task, /Narrow experimental skills need not have prior cross-log success/)
    const content = '---\nname: delivery-evidence-separation\ndescription: Diagnose disagreement between passing builds and missing recipient files\n---\n# Experimental diagnostic workflow\nSource: v:memory/topics/delivery.md (fixture). Outcome remains unresolved.\nWhen delivery is disputed, separately check status projection, loaded build and actual recipient receipt. Passing tests do not establish delivery. Do not retry sends without authorization. Revalidate after a real recipient outcome; retire if these distinctions do not help.\nExample: passing build plus missing file requires recipient evidence. Counterexample: a verified recipient receipt already settles that attempt, not every future delivery.\n'
    const baseline = JSON.parse(await f.tools.skill.execute({ action: 'read', name: 'delivery-evidence-separation' }, f.context(id)))
    await f.tools.skill.execute({ action: 'save', name: 'delivery-evidence-separation', revision: baseline.revision, content }, f.context(id))
    await f.tools.result.execute({ status: 'applied', summary: 'Installed a narrow experimental diagnostic lesson, not a delivery fix or script tool.' }, f.context(id))
  })
  const id = await f.runtime.run('encapsulator', signal())
  assert.equal(f.runtime.ledger.outcome(String(id))?.artifacts, 1)
  assert(skills.getSkillDirectory('delivery-evidence-separation'))
  assert.equal(await f.runtime.run('encapsulator', signal()), false)
}))

test('host audit recovers rejected physical ID against exact log ref across attempts, not real I/O errors', async t => withTempWorkspace(async workspace => {
  const f = fixture(workspace)
  const correct = 'v:sessions/web_chat-example-v2-f83865aca7a-0/overview'
  const wrong = 'v:sessions/web_chat-example-v2-f838aca7a-0/overview'
  const batch = f.runtime.ledger.create('encapsulator', [], [{ id: 'typo', path: 'memory/events/day.jsonl', origin: 'web:example', when: 'then', who: 'reflector', what: 'Challenge', refs: [correct] }])
  f.runtime.ledger.bind(batch.id, 'cron:old')
  f.runtime.ledger.interrupt(batch.id, 'retry')
  f.runtime.ledger.bind(batch.id, 'cron:new')
  for (const id of ['cron:old', 'cron:new']) f.records.set(id, { sessionId: id, segmentIndex: 0, projectId: 'a' })
  let error = 'Error: Physical history does not belong to this Project session'
  const exchange = (path: string, text: string): ChatMessage[] => [
    { role: 'assistant', content: '', tool_calls: [{ id: 'read', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path, offset: 1, limit: 100 }) } }] },
    { role: 'tool', content: text, tool_call_id: 'read' },
  ]
  t.mock.method(f.sessions, 'getHistory', async (id: string) => {
    const messages = id === 'cron:old' ? exchange(wrong, error) : exchange(correct, 'complete overview')
    return { messages, total: messages.length }
  })
  await f.runtime.inspectEffects(f.runtime.ledger.batchFor('cron:new')!, false, true)
  error = 'Error: filesystem denied'
  await assert.rejects(f.runtime.inspectEffects(f.runtime.ledger.batchFor('cron:new')!, false, true), /filesystem denied/)
}))


test('lesson maintenance preflights size, consolidates a full replacement and verifies real edit-store receipt', async () => withTempWorkspace(async workspace => {
  const skills = new SkillsManager(workspace)
  const f = fixture(workspace, 0, skills)
  const name = 'bounded-maintenance'
  const header = `---\nname: ${name}\ndescription: Consolidate diagnostic lessons without losing conditions\n---\n`
  const constraints = 'Trigger: conflicting delivery evidence. Never retry a send without authorization. Unknown cause remains unknown. Exception: recipient receipt settles only that attempt. Revalidate after a recipient outcome. Source: fixture 2026-11-06.\n'
  const original = header + constraints + 'Repeated explanation. '.repeat(330)
  assert(original.length <= 8000)
  await f.runtime.skillStore!.save(name, { 'SKILL.md': original }, null, false, signal())
  f.runtime.ledger.create('encapsulator', [], [])
  f.onRun(async id => {
    const ctx = f.context(id)
    const baseline = JSON.parse(await f.tools.skill.execute({ action: 'read', name }, ctx))
    assert.equal(baseline.limits.maxLength, 8000)
    assert.equal(baseline.limits.lengthUnit, 'UTF-16 code units')
    assert.equal(baseline.contentLength, original.length)
    assert.equal(baseline.maintenance.headroom, 8000 - original.trim().length)
    assert.equal(baseline.maintenance.preferredAction, 'patch')
    const oversized = original + 'New repeated explanation. '.repeat(80)
    const checked = JSON.parse(await f.tools.skill.execute({ action: 'check', name, revision: baseline.revision, content: oversized }, ctx))
    assert.equal(checked.withinLimit, false)
    assert.equal(checked.overBy, oversized.trim().length - 8000)
    assert.equal(checked.saved, false)
    assert.equal(f.runtime.skillStore!.read(name).revision, baseline.revision)
    assert.equal(f.runtime.ledger.batchFor(id)!.artifacts.length, 0)
    for (const [content, withinLimit, length] of [['😀'.repeat(4000), true, 8000], ['😀'.repeat(4001), false, 8002], ['  ', false, 0]] as const) {
      const boundary = JSON.parse(await f.tools.skill.execute({ action: 'check', name, revision: baseline.revision, content }, ctx))
      assert.equal(boundary.withinLimit, withinLimit)
      assert.equal(boundary.contentLength, length)
    }
    // Real rejected writes, not only preflight: exact feedback on the first and
    // repeated failure, with no persisted correction or artifact to acknowledge.
    for (const draft of [oversized, `  ${oversized}😀  `]) {
      await assert.rejects(f.tools.skill.execute({ action: 'save', name, revision: baseline.revision, content: draft }, ctx), error => {
        const message = (error as Error).message
        assert.match(message, /too_big/)
        assert(message.includes(`contentLength=${draft.trim().length}, maxLength=8000, overBy=${draft.trim().length - 8000}`))
        assert.match(message, /Do not retry an oversized whole save/)
        assert.match(message, /only a successful same-name save\/patch/)
        return true
      })
      assert.equal(f.runtime.skillStore!.read(name).revision, baseline.revision)
      assert.equal(f.runtime.ledger.batchFor(id)!.artifacts.length, 0)
    }
    const consolidated = header + constraints + 'Steps: separate reported tests, active backend build and actual recipient evidence. A passing test is not delivery. Example: missing recipient evidence leaves delivery unknown; counterexample: verified receipt.\n'
    const check = JSON.parse(await f.tools.skill.execute({ action: 'check', name, revision: baseline.revision, content: consolidated }, ctx))
    assert.equal(check.withinLimit, true)
    await f.tools.skill.execute({ action: 'save', name, revision: baseline.revision, content: consolidated }, ctx)
    assert.equal(f.runtime.skillStore!.read(name).files['SKILL.md'].toString(), consolidated.trim())
    assert(skills.getSkillDirectory(name))
    await assert.rejects(f.tools.skill.execute({ action: 'check', name, revision: baseline.revision, content: consolidated }, ctx), /changed since read/)
    await f.tools.result.execute({ status: 'applied', summary: 'Consolidated repeated wording, preserving all scoped conditions. Synthetic fixture only.' }, ctx)
  })
  const id = await f.runtime.run('encapsulator', signal())
  assert.equal(f.runtime.ledger.outcome(String(id))?.status, 'applied')
  assert.equal(f.runtime.ledger.outcome(String(id))?.artifacts, 1)
}))

test('encapsulation prompts expose bounded maintenance and useful small experiments without publication', async () => withTempWorkspace(async workspace => {
  const f = fixture(workspace)
  const task = learningTask(f.runtime.ledger.create('encapsulator', [], []))
  assert.match(task, /A separate check is optional size feedback, not a prerequisite/)
  assert.match(task, /eighth is receipt-only/)
  assert.match(task, /finish the first supported save by the seventh request/)
  assert.match(task, /8000 UTF-16 code units/)
  assert.match(task, /preserving conditions, exceptions, uncertainty and evidence/)
  assert.match(task, /proven high frequency is not required/)
  const role = (await readFile(new URL('../types/builtin/encapsulator/AGENT.md', import.meta.url), 'utf8')).replace(/\r\n/g, '\n')
  assert.match(role, /one concrete\ncostly or error-prone step/)
  assert.match(role, /NOT an installed tool/)
  assert.match(role, /one focused\nconsolidation/)
}))


test('oversize failed skill save is recovered by same-name successful replacement, not size check alone', async t => withTempWorkspace(async workspace => {
  const f = fixture(workspace, 0, new SkillsManager(workspace))
  const batch = f.runtime.ledger.create('encapsulator', [], [])
  f.runtime.ledger.bind(batch.id, 'cron:old')
  f.runtime.ledger.interrupt(batch.id, 'oversize write')
  f.runtime.ledger.bind(batch.id, 'cron:new')
  for (const id of ['cron:old', 'cron:new']) f.records.set(id, { sessionId: id, segmentIndex: 0, projectId: 'a' })
  let action = 'check'
  let name = 'same-lesson'
  let failed = false
  let oldError = ''
  try { await f.tools.skill.execute({ action: 'save', name, revision: '', content: 'x'.repeat(8001) }, f.context('cron:new')) }
  catch (error) { oldError = `Error executing learned_skill: ${(error as Error).message}` }
  assert.match(oldError, /too_big/)
  t.mock.method(f.sessions, 'getHistory', async (id: string) => {
    const old = id === 'cron:old'
    const messages: ChatMessage[] = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'skill', type: 'function', function: { name: 'learned_skill', arguments: JSON.stringify({ action: old ? 'save' : action, name: old ? 'same-lesson' : name }) } }] },
      { role: 'tool', content: old ? oldError : failed ? 'Error executing learned_skill: Patch match must occur exactly once.' : '{"status":"discoverable"}', tool_call_id: 'skill' },
    ]
    return { messages, total: messages.length }
  })
  await assert.rejects(f.runtime.inspectEffects(f.runtime.ledger.batchFor('cron:new')!, false, true), /too_big/)
  action = 'read'
  await assert.rejects(f.runtime.inspectEffects(f.runtime.ledger.batchFor('cron:new')!, false, true), /\[learned_skill:same-lesson\].*Error executing learned_skill/)
  action = 'save'
  name = 'different-lesson'
  await assert.rejects(f.runtime.inspectEffects(f.runtime.ledger.batchFor('cron:new')!, false, true), /too_big/)
  name = 'same-lesson'
  await f.runtime.inspectEffects(f.runtime.ledger.batchFor('cron:new')!, false, true)
  action = 'patch'
  failed = true
  await assert.rejects(f.runtime.inspectEffects(f.runtime.ledger.batchFor('cron:new')!, false, true), /exactly once/)
  failed = false
  await f.runtime.inspectEffects(f.runtime.ledger.batchFor('cron:new')!, false, true)
}))


test('legacy ten-deferral pending batch without paused text stays parked after recover; manual selection preserves attempts', async () => withTempWorkspace(async workspace => {
  const f = fixture(workspace, 0)
  const batch = f.runtime.ledger.create('encapsulator', [], [])
  for (let i = 0; i < 10; i++) {
    f.runtime.ledger.bind(batch.id, `cron:legacy-${i}`)
    f.runtime.ledger.interrupt(batch.id, 'retained rejected history reference')
    f.runtime.ledger.defer(batch.id, true)
  }
  const path = projectStoragePath(workspace, '.learning', 'state.v1.json')
  const state = JSON.parse(await readFile(path, 'utf8'))
  delete state.batches[0].retry.paused
  state.batches[0].retry.notBefore = 0
  await writeFile(path, JSON.stringify(state)) // Disposable legacy fixture, never production state.
  const restarted = new LearningRuntime(f.sessions, 'a')
  await restarted.recover()
  assert.equal(restarted.ledger.pending('encapsulator', true), undefined)
  assert.equal(restarted.ledger.select('encapsulator', [], []), undefined)
  assert.equal(restarted.ledger.select('encapsulator', [], [], true)?.id, batch.id)
  assert.equal(restarted.ledger.batch(batch.id).retry!.attempts, 10)
  assert.equal(restarted.ledger.batch(batch.id).attempts.length, 10)
  assert.equal(restarted.ledger.batch(batch.id).state, 'pending')
}))

test('direct save uses last work call, rejects oversized and stale drafts without effects, preserves receipt reserve', async () => withTempWorkspace(async workspace => {
  const skills = new SkillsManager(workspace)
  const f = fixture(workspace, 0, skills)
  const batch = f.runtime.ledger.create('encapsulator', [], [])
  f.runtime.ledger.bind(batch.id, 'cron:bounded')
  f.records.set('cron:bounded', { sessionId: 'cron:bounded', segmentIndex: 0, projectId: 'a' })
  const ctx = f.context('cron:bounded')
  const base = new Tools(workspace)
  base.register(f.tools.skill); base.register(f.tools.result)
  ctx.tools = new SessionTools(base, workspace, ['learned_skill', 'learning_result'])
  ctx.tools.setTrustedLimits({ allowedTools: ['learned_skill', 'learning_result'], inferenceRequests: 8, toolCalls: 4, argumentBytes: 48000 })
  ctx.tools.reserveReceipt('learning_result')
  const name = 'direct-bounded-save'
  const content = `---\nname: ${name}\ndescription: Check evidence before claiming success\n---\nExperimental fixture. Preserve uncertainty and authorization boundaries. Source: synthetic 2026-11-07. Revalidate after observed outcome.`
  const original = await f.runtime.skillStore!.save(name, { 'SKILL.md': content }, null, false, signal())
  assert.match(String(await ctx.tools.execute('learned_skill', { action: 'save', name, revision: original.revision, content: 'x'.repeat(8001) }, ctx)), /8000/)
  assert.match(String(await ctx.tools.execute('learned_skill', { action: 'save', name, revision: '', content }, ctx)), /changed since read/)
  assert.equal(f.runtime.ledger.batch(batch.id).artifacts.length, 0)
  assert.equal(f.runtime.skillStore!.read(name).revision, original.revision)
  const replacement = content + '\nCounterexample: a receipt proves that attempt only.'
  const saved = JSON.parse(String(await ctx.tools.execute('learned_skill', { action: 'save', name, revision: original.revision, content: replacement }, ctx)))
  assert.equal(saved.status, 'discoverable')
  assert.equal(f.runtime.skillStore!.read(name).files['SKILL.md'].toString(), replacement)
  assert(skills.getSkillDirectory(name))
  assert.match(String(await ctx.tools.execute('learned_skill', { action: 'read', name }, ctx)), /receipt capacity/)
  ctx.tools.restrictToReceipt('learning_result')
  const receipt = await ctx.tools.execute('learning_result', { status: 'partial', summary: 'Retained one real fixture effect; failed drafts remain unresolved.' }, ctx)
  assert.doesNotMatch(String(receipt), /^Error:/)
  assert.equal(f.runtime.ledger.batch(batch.id).proposal?.status, 'partial', String(receipt))
  assert.equal(f.runtime.ledger.batch(batch.id).artifacts.length, 1)
}))

test('Wiki publication combines precise source ranges, host readback and recoverable provenance without closing unread scope', async () => {
  await withTempWorkspace(async workspace => {
    const f = fixture(workspace)
    const batch = f.runtime.ledger.create('reflector', [{ sessionId: 'web:source', physicalId: 'source-physical', segmentIndex: 0, offset: 0, end: 5 }], [])
    f.runtime.ledger.bind(batch.id, 'cron:wiki')
    f.records.set('cron:wiki', { sessionId: 'cron:wiki', segmentIndex: 0, projectId: 'a' })
    const context = f.context('cron:wiki')
    const draft = { action: 'save_wiki', path: 'topics/diagnostic-correction.md', revision: '',
      content: '# Diagnostic correction\n\nParent report: detach hypothesis withdrawn; minimal window/UiSelect harness fix retained assertions. Reported 10 pass/1 baseline-conflict failure, not independently verified. Applies to this harness only; revalidate on changed reproduction.',
      summary: 'Parent withdrew detach hypothesis and reported a narrower harness correction; independent acceptance remains unknown.',
      wikiEvidence: [{ sessionId: 'web:source', physicalId: 'source-physical', offset: 2, end: 4 }] }
    await assert.rejects(f.tools.memory.execute({ ...draft, wikiEvidence: [{ sessionId: 'web:source', physicalId: 'source-physical', offset: 2, end: 6 }] }, context), /inside an assigned source/)
    const originalArtifact = f.runtime.ledger.artifact.bind(f.runtime.ledger)
    f.runtime.ledger.artifact = () => { throw new Error('injected journal failure after page write') }
    await assert.rejects(f.tools.memory.execute(draft, context), /injected journal failure/)
    const file = projectStoragePath(workspace, 'memory/topics/diagnostic-correction.md')
    const persisted = await readFile(file, 'utf8')
    assert.match(persisted, /source-physical messages \[2, 4\)/)
    assert.match(persisted, /not independently verified/)
    f.runtime.ledger.artifact = originalArtifact
    const originalEvent = f.tools.appendLog.bind(f.tools)
    f.tools.appendLog = () => { throw new Error('injected event failure') }
    await assert.rejects(f.tools.memory.execute(draft, context), /injected event failure/)
    f.tools.appendLog = originalEvent
    const recovered = new LearningTools(f.runtime)
    const receipt = JSON.parse(String(await recovered.memory.execute(draft, context)))
    assert.equal(receipt.verified, true)
    await recovered.memory.execute(draft, context)
    const savedBatch = f.runtime.ledger.batchFor(context.sessionId)!
    assert.equal(savedBatch.artifacts.length, 1)
    assert.equal(savedBatch.events.length, 1)
    assert.equal(savedBatch.proposal, undefined, 'a page save does not claim complete review or advance the cursor')
    await f.runtime.verify(savedBatch, false)
    await assert.rejects(recovered.result.execute({ status: 'no_change', summary: 'Duplicate' }, context), /persisted effects/)
    await writeFile(file, persisted + '\nConcurrent useful content\n')
    await assert.rejects(recovered.memory.execute(draft, context), /changed since read/)
    await assert.rejects(f.runtime.verify(savedBatch, false), /changed after writing/)
    assert.match(await readFile(file, 'utf8'), /Concurrent useful content/)
    const latest = JSON.parse(String(await recovered.memory.execute({ action: 'read_wiki', path: draft.path }, context)))
    await recovered.memory.execute({ ...draft, revision: latest.revision, content: draft.content + '\n\nConcurrent useful content' }, context)
    await f.runtime.verify(f.runtime.ledger.batchFor(context.sessionId)!, false)
    await recovered.result.execute({ status: 'partial', summary: 'Correction persisted and host verified. Messages [0,2) and [4,5) remain unread; no acceptance established.' }, context)
    assert.equal(f.runtime.ledger.batchFor(context.sessionId)!.proposal!.status, 'partial')
  })
})

test('Wiki save failures remain receipt blockers until a same-page save succeeds; permissions and path boundaries remain unchanged', async () => {
  await withTempWorkspace(async workspace => {
    const f = fixture(workspace)
    const batch = f.runtime.ledger.create('reflector', [{ sessionId: 'web:source', physicalId: 'source', segmentIndex: 0, offset: 0, end: 5 }], [])
    f.runtime.ledger.bind(batch.id, 'cron:audit')
    f.records.set('cron:audit', { sessionId: 'cron:audit', segmentIndex: 0, projectId: 'a' })
    const context = f.context('cron:audit')
    const draft = { action: 'save_wiki', path: 'topics/trust-boundary.md', revision: '', content: '# Boundary\nParent-reported limitation; not a reset procedure.', summary: 'Retain the parent-reported identity deletion limitation.', wikiEvidence: [{ sessionId: 'web:source', physicalId: 'source', offset: 1, end: 3 }] }
    await assert.rejects(f.tools.memory.execute(draft, { ...context, projectId: 'foreign' }), /owning Project/)
    await assert.rejects(f.tools.memory.execute(draft, { ...context, remoteWorkdir: {} } as ExecutionContext), /owning Project/)
    for (const path of ['events/test.md', 'sessions/test.md', '../topics/test.md', 'decisions/test.md']) {
      await assert.rejects(f.tools.memory.execute({ ...draft, path }, context))
    }
    const messages: ChatMessage[] = [
      { role: 'assistant', content: '', tool_calls: [{ id: 'save', type: 'function', function: { name: 'learning_memory', arguments: JSON.stringify(draft) } }] },
      { role: 'tool', tool_call_id: 'save', content: 'Error: injected persistence failure' },
    ]
    f.sessions.getHistory = async () => ({ messages, total: messages.length })
    await assert.rejects(f.tools.result.execute({ status: 'no_change', summary: 'No useful change' }, context), /injected persistence failure/)
    await f.tools.memory.execute(draft, context)
    await assert.rejects(f.tools.result.execute({ status: 'applied', summary: 'Saved' }, context), /injected persistence failure/)
    messages.push({ role: 'assistant', content: '', tool_calls: [{ id: 'retry', type: 'function', function: { name: 'learning_memory', arguments: JSON.stringify(draft) } }] },
      { role: 'tool', tool_call_id: 'retry', content: JSON.stringify({ verified: true }) })
    await f.tools.result.execute({ status: 'applied', summary: 'Source-scoped limitation saved and verified; no deployment claim.' }, context)
    assert.equal(f.runtime.ledger.batchFor(context.sessionId)!.proposal!.status, 'applied')
  })
})

test('Wiki reread/edit/save merges managed provenance once and requires exact physical segments', async () => {
  await withTempWorkspace(async workspace => {
    const f = fixture(workspace)
    const sources = ['physical-first', 'physical-second'].map((physicalId, segmentIndex) => ({
      sessionId: 'web:source', physicalId, segmentIndex, offset: 0, end: 5,
    }))
    const batch = f.runtime.ledger.create('reflector', sources, [])
    f.runtime.ledger.bind(batch.id, 'cron:segments')
    const context = f.context('cron:segments')
    const draft = { action: 'save_wiki', path: 'topics/segment-evidence.md', revision: '',
      content: '# Scoped evidence\nA reported correction.', summary: 'Retain the scoped correction.',
      wikiEvidence: [{ sessionId: 'web:source', physicalId: 'physical-second', offset: 1, end: 3 }] }
    await assert.rejects(f.tools.memory.execute({ ...draft, wikiEvidence: [{ sessionId: 'web:source', offset: 1, end: 3 }] }, context))
    await assert.rejects(f.tools.memory.execute({ ...draft, wikiEvidence: [{ ...draft.wikiEvidence[0], physicalId: 'unassigned-segment' }] }, context), /inside an assigned source/)
    await f.tools.memory.execute(draft, context)
    const read = async () => JSON.parse(String(await f.tools.memory.execute({ action: 'read_wiki', path: draft.path }, context)))
    let page = await read()
    assert.match(page.content, /physical-second messages \[1, 3\)/)
    assert.doesNotMatch(page.content, /physical-first/)
    // Normal full-content roundtrip, with a second segment at identical logical offsets.
    await f.tools.memory.execute({ ...draft, revision: page.revision,
      content: page.content.replace('A reported correction.', 'A reported correction with its condition.'),
      wikiEvidence: [{ ...draft.wikiEvidence[0], physicalId: 'physical-first' }] }, context)
    for (let i = 0; i < 3; i++) {
      page = await read()
      await f.tools.memory.execute({ ...draft, revision: page.revision,
        content: page.content.replace('Scoped evidence', `Scoped evidence ${i}`) }, context)
    }
    page = await read()
    assert.equal(page.content.match(/## Learning provenance/g)?.length, 1)
    assert.equal(page.content.match(/<!-- shadow:learning-provenance:start -->/g)?.length, 1)
    assert.equal(page.content.match(/physical-first messages/g)?.length, 1)
    assert.equal(page.content.match(/physical-second messages/g)?.length, 1)
    assert.match(page.content, /correction with its condition/)
    // Upgrade the previous unmarked generated format without duplicating metadata.
    const file = projectStoragePath(workspace, `memory/${draft.path}`)
    await writeFile(file, page.content.replace('<!-- shadow:learning-provenance:start -->\n', '')
      .replace('\n<!-- shadow:learning-provenance:end -->', ''))
    page = await read()
    await f.tools.memory.execute({ ...draft, revision: page.revision, content: page.content }, context)
    page = await read()
    assert.equal(page.content.match(/## Learning provenance/g)?.length, 1)
    assert.equal(page.content.match(/physical-first messages/g)?.length, 1)
    assert.equal(page.content.match(/physical-second messages/g)?.length, 1)
    // Even a body-only replacement retains the previous exact source references.
    await f.tools.memory.execute({ ...draft, revision: page.revision, content: '# Body only\nStill scoped.' }, context)
    page = await read()
    assert.equal(page.content.match(/physical-first messages/g)?.length, 1)
    assert.equal(page.content.match(/physical-second messages/g)?.length, 1)
    assert.equal(page.content.match(/## Learning provenance/g)?.length, 1)
  })
})


test('exact lesson corrections preserve unrelated evidence and all save boundaries', async () => withTempWorkspace(async workspace => {
  const skills = new SkillsManager(workspace)
  const f = fixture(workspace, 0, skills)
  const name = 'targeted-correction'
  const original = `---\nname: ${name}\ndescription: Test scoped maintenance\n---\nRequire obsolete entity.\nNever widen authorization.\nSource: fixture.\nRepeated repeated\n` + 'Evidence. '.repeat(760)
  await f.runtime.skillStore!.save(name, { 'SKILL.md': original }, null, false, signal())
  f.runtime.ledger.create('encapsulator', [], [])
  f.onRun(async id => {
    const ctx = f.context(id)
    const baseline = JSON.parse(await f.tools.skill.execute({ action: 'read', name }, ctx))
    const patch = { action: 'patch', name, revision: baseline.revision, match: 'Require obsolete entity.', replacement: 'Use current policy.' }
    for (const [change, error] of [
      [{ match: 'not present' }, /exactly once/], [{ match: 'Evidence.' }, /exactly once/],
      [{ match: '' }, /at least 1/], [{ revision: '' }, /changed since read/],
      [{ replacement: 'x'.repeat(8000) }, /8000/],
      [{ match: `name: ${name}`, replacement: 'name: wrong-name' }, /standalone lesson/],
      [{ match: 'description: Test scoped maintenance', replacement: 'description: Test scoped maintenance\nadmin: true' }, /standalone lesson/],
    ] as const) {
      await assert.rejects(f.tools.skill.execute({ ...patch, ...change }, ctx), error)
      assert.equal(f.runtime.skillStore!.read(name).revision, baseline.revision)
      assert.equal(f.runtime.ledger.batchFor(id)!.artifacts.length, 0)
    }
    await f.tools.skill.execute(patch, ctx)
    const saved = f.runtime.skillStore!.read(name)
    assert.equal(saved.files['SKILL.md'].toString(), original.replace(patch.match, patch.replacement).trim())
    assert(skills.getSkillDirectory(name))
    await assert.rejects(f.tools.skill.execute(patch, ctx), /changed since read/)
    await f.tools.skill.execute({ ...patch, revision: saved.revision, match: 'Repeated repeated\n', replacement: '' }, ctx)
    assert(!f.runtime.skillStore!.read(name).files['SKILL.md'].toString().includes('Repeated repeated'))
    const beforePeer = f.runtime.skillStore!.read(name)
    const peerContent = beforePeer.files['SKILL.md'].toString() + '\nPeer evidence retained.'
    await f.runtime.skillStore!.save(name, { 'SKILL.md': peerContent }, beforePeer.revision, false, signal())
    await assert.rejects(f.tools.skill.execute({ ...patch, revision: beforePeer.revision, match: 'Use current policy.', replacement: 'Use adopted policy.' }, ctx), /changed since read/)
    const refreshed = JSON.parse(await f.tools.skill.execute({ action: 'read', name }, ctx))
    await f.tools.skill.execute({ ...patch, revision: refreshed.revision, match: 'Use current policy.', replacement: 'Use adopted policy.' }, ctx)
    assert.match(f.runtime.skillStore!.read(name).files['SKILL.md'].toString(), /Peer evidence retained/)
    await f.tools.result.execute({ status: 'applied', summary: 'Corrected obsolete fixture requirement, retained evidence and safety; optional expansion deferred.' }, ctx)
  })
  await f.runtime.run('encapsulator', signal())
}))
