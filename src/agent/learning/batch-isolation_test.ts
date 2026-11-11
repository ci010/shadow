import assert from 'node:assert/strict'
import test from 'node:test'
import { LearningLedger, type LearningSource } from './ledger.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'

const source = (offset: number, end: number): LearningSource => ({ sessionId: 'web:source', physicalId: 'web:source-0', segmentIndex: 0, offset, end })
const done = (ledger: LearningLedger, id: string, attempt: string) => {
  ledger.bind(id, attempt)
  ledger.propose(id, 'no_change', 'Reviewed all assigned evidence')
  ledger.complete(id)
}

test('failed reservations survive restart, allow fresh work and acknowledge only contiguous verified ranges', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  await withTempWorkspace(async workspace => {
    let ledger = new LearningLedger(workspace, 'a')
    const first = ledger.create('reflector', [source(0, 2)], [])
    ledger.bind(first.id, 'attempt:failed')
    ledger.interrupt(first.id, 'network error')
    ledger.defer(first.id, true)
    assert.equal(ledger.pending('reflector', true), undefined)
    assert.equal(ledger.pending('reflector')!.retry!.notBefore, Date.now() + 60_000)
    ledger = new LearningLedger(workspace, 'a')
    assert.equal(ledger.cursor(source(0, 2)), 0)
    assert.equal(ledger.selectionCursor(source(0, 2)), 2)
    const fresh = ledger.select('reflector', [source(2, 4)], [])!
    done(ledger, fresh.id, 'attempt:fresh')
    assert.equal(ledger.cursor(source(0, 2)), 0)
    assert.equal(ledger.select('reflector', [], []), undefined)
    t.mock.timers.tick(60_000)
    assert.equal(ledger.select('reflector', [], [])!.id, first.id, 'no new input must still retry after cooldown')
    done(ledger, first.id, 'attempt:repaired')
    ledger = new LearningLedger(workspace, 'a')
    assert.equal(ledger.cursor(source(0, 2)), 4)
    assert.equal(ledger.unfinished().length, 0)
  })
})

test('many overdue failed batches alternate with continuous fresh evidence across restart', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  await withTempWorkspace(async workspace => {
    let ledger = new LearningLedger(workspace, 'a')
    const old: string[] = []
    for (let i = 0; i < 5; i++) {
      const batch = ledger.create('reflector', [source(i, i + 1)], [])
      old.push(batch.id)
      ledger.defer(batch.id, false)
    }
    t.mock.timers.tick(3_600_000)
    let end = 5
    const retried: string[] = []
    for (let i = 0; i < 10; i++) {
      ledger = new LearningLedger(workspace, 'a')
      const chosen = ledger.select('reflector', [source(end, end + 1)], [])!
      if (i % 2 === 0) {
        assert.equal(chosen.id, old[i / 2])
        retried.push(chosen.id)
        ledger.defer(chosen.id, false)
      } else {
        assert.equal(chosen.sources[0].offset, end)
        done(ledger, chosen.id, `attempt:fresh:${i}`)
        end++
      }
    }
    assert.deepEqual(retried, old)
    assert.equal(end, 10, 'fresh input gets half the opportunities even with five overdue failures')
    assert.equal(ledger.cursor(source(0, 1)), 0)
  })
})

test('downstream failed log batches reserve only their own logs and do not mark them consumed', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  await withTempWorkspace(async workspace => {
    const ledger = new LearningLedger(workspace, 'a')
    for (let i = 0; i < 2; i++) {
      const batch = ledger.create('reflector', [source(i, i + 1)], [])
      ledger.log(batch.id, { id: `event:${i}`, path: 'memory/events/test.jsonl', origin: 'test', when: 'now', who: 'test', what: 'correction' })
      done(ledger, batch.id, `attempt:${i}`)
    }
    const first = ledger.create('encapsulator', [], ledger.logsFor('encapsulator').slice(0, 1))
    ledger.defer(first.id, false)
    assert.deepEqual(ledger.logsFor('encapsulator').map(event => event.id), ['event:1'])
    const second = ledger.select('encapsulator', [], ledger.logsFor('encapsulator'))!
    done(ledger, second.id, 'attempt:second')
    assert.deepEqual(ledger.logsFor('encapsulator'), [])
    t.mock.timers.tick(3_600_000)
    assert.equal(ledger.select('encapsulator', [], [])!.id, first.id)
    done(ledger, first.id, 'attempt:first')
    assert.deepEqual(ledger.logsFor('encapsulator'), [])
  })
})

test('manual runtime retry bypasses cooldown while automatic empty scans do not dispatch', async () => {
  await withTempWorkspace(async workspace => {
    const { fakeSessions } = await import('./test-fixtures.ts')
    const { LearningRuntime } = await import('./pipelines.ts')
    const f = fakeSessions(workspace, [{ sessionId: 'web:source', segmentIndex: 0, total: 2 }])
    const runtime = new LearningRuntime(f.sessions, 'a')
    const signal = () => new AbortController().signal
    await assert.rejects(runtime.run('reflector', signal()), /No learning_result/)
    const batch = runtime.ledger.pending('reflector')!
    assert.equal(batch.retry!.attempts, 1)
    assert.equal(await runtime.run('reflector', signal()), false)
    assert.equal(f.started.length, 1)
    f.onRun(async id => { runtime.ledger.propose(runtime.ledger.batchFor(id)!.id, 'no_change', 'Reviewed') })
    await runtime.run('reflector', signal(), undefined, undefined, undefined, true)
    assert.equal(f.started.length, 2)
    assert.equal(runtime.ledger.cursor(batch.sources[0]), 2)
  })
})

test('retry budget is exponential and capped, nonretryable failures cool down for one hour', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  await withTempWorkspace(async workspace => {
    const ledger = new LearningLedger(workspace, 'a')
    const batch = ledger.create('reflector', [source(0, 1)], [])
    for (const delay of [60_000, 120_000, 240_000, 480_000, 960_000, 1_920_000, 3_600_000, 3_600_000]) {
      ledger.defer(batch.id, true)
      assert.equal(ledger.batch(batch.id).retry!.notBefore, Date.now() + delay)
    }
    ledger.defer(batch.id, false)
    assert.equal(ledger.batch(batch.id).retry!.notBefore, Date.now() + 3_600_000)
  })
})

test('three deferrals park unchanged automatic retries durably, retaining manual recovery and fresh input', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  await withTempWorkspace(async workspace => {
    let ledger = new LearningLedger(workspace, 'a')
    const batch = ledger.create('reflector', [source(0, 1)], [])
    for (let i = 0; i < 3; i++) {
      ledger.bind(batch.id, `attempt-${i}`)
      ledger.interrupt(batch.id, 'maximum iterations with retained evidence')
      ledger.defer(batch.id, true)
      t.mock.timers.tick(3_600_001)
    }
    ledger = new LearningLedger(workspace, 'a')
    assert.equal(ledger.pending('reflector', true), undefined)
    assert.match(ledger.batch(batch.id).retry!.paused!, /Automatic retry limit/)
    assert.equal(ledger.cursor(source(0, 1)), 0)
    assert.equal(ledger.unfinished().length, 1)
    assert.equal(ledger.select('reflector', [], []), undefined)
    assert.equal(ledger.select('reflector', [], [], true)?.id, batch.id)
    assert.notEqual(ledger.select('reflector', [source(1, 2)], [])?.id, batch.id)
    assert.deepEqual(ledger.batch(batch.id).attempts, ['attempt-0', 'attempt-1', 'attempt-2'])
  })
})

const candidate = {
  path: 'topics/scoped-requirement.md', correction: 'Retain the scoped requirement, not implementation acceptance.',
  action: 'Read current Wiki and merge only missing supported constraints.', conditions: 'May already be superseded.',
  evidence: [{ sessionId: 'web:source', physicalId: 'web:source-0', offset: 0, end: 1 }],
}

test('first structured candidate on final regular attempt gets one cooldown-bound continuation, fair to fresh sources', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  await withTempWorkspace(async workspace => {
    let ledger = new LearningLedger(workspace, 'a')
    const batch = ledger.create('reflector', [source(0, 1)], [])
    ledger.artifact(batch.id, { path: 'memory/topics/existing.md', revision: 'prior', kind: 'memory' })
    for (let i = 0; i < 3; i++) {
      ledger.bind(batch.id, `regular-${i}`)
      ledger.propose(batch.id, 'partial', 'Honest unresolved scope', i === 2 ? [candidate] : undefined)
      ledger.complete(batch.id)
      ledger.defer(batch.id, false)
      if (i < 2) t.mock.timers.tick(3_600_001)
    }
    ledger = new LearningLedger(workspace, 'a')
    assert.equal(ledger.pending('reflector', true), undefined, 'cooldown is not bypassed')
    t.mock.timers.tick(3_600_001)
    assert.equal(ledger.select('reflector', [source(1, 2)], [])?.id, batch.id)
    ledger = new LearningLedger(workspace, 'a')
    const fresh = ledger.select('reflector', [source(1, 2)], [])!
    assert.notEqual(fresh.id, batch.id, 'persisted fresh/retry alternation still applies')
    done(ledger, fresh.id, 'fresh')
    assert.equal(ledger.cursor(source(0, 1)), 0, 'later success cannot skip unresolved evidence')
    ledger.bind(batch.id, 'continuation')
    ledger = new LearningLedger(workspace, 'a')
    assert.equal(ledger.batch(batch.id).candidateContinuationUsed, true)
    ledger.interrupt(batch.id, 'crash after admission, before receipt/deferral')
    assert.equal(ledger.pending('reflector', true), undefined, 'crash cannot renew spent opportunity')
    assert.equal(ledger.batch(batch.id).pendingCandidates?.length, 1)
    assert.equal(ledger.batch(batch.id).artifacts[0].revision, 'prior')
    ledger.defer(batch.id, false)
    t.mock.timers.tick(3_600_001)
    assert.equal(ledger.select('reflector', [], []), undefined)
    assert.match(ledger.unfinished()[0].retry!.paused!, /Automatic retry limit/)
    assert.equal(ledger.select('reflector', [], [], true)?.id, batch.id, 'manual recovery remains available')
    ledger.bind(batch.id, 'manual')
    ledger.propose(batch.id, 'partial', 'Rewording or replacing a candidate grants no new budget',
      [{ ...candidate, correction: 'A rewritten correction.' }])
    ledger.complete(batch.id)
    ledger.defer(batch.id, false)
    t.mock.timers.tick(3_600_001)
    assert.equal(new LearningLedger(workspace, 'a').pending('reflector', true), undefined)
  })
})

test('unchanged structured candidate in continuation stays visible and paused after fourth deferral', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  await withTempWorkspace(async workspace => {
    let ledger = new LearningLedger(workspace, 'a')
    const batch = ledger.create('reflector', [source(0, 1)], [])
    for (let i = 0; i < 4; i++) {
      assert.equal(ledger.select('reflector', [], [])?.id, batch.id)
      ledger.bind(batch.id, `attempt-${i}`)
      ledger.propose(batch.id, 'partial', 'Still unresolved', [candidate])
      ledger.complete(batch.id)
      ledger.defer(batch.id, false)
      t.mock.timers.tick(3_600_001)
      ledger = new LearningLedger(workspace, 'a')
    }
    assert.equal(ledger.pending('reflector', true), undefined)
    assert.equal(ledger.unfinished()[0].pendingCandidates?.[0].path, candidate.path)
    assert.equal(ledger.unfinished()[0].retry?.attempts, 4)
    assert.equal(ledger.cursor(source(0, 1)), 0)
    assert.equal(ledger.batch(batch.id).proposal?.status, 'partial')
  })
})

test('historical exactly-three-deferral structured batch qualifies without resetting counters or old pause text', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  await withTempWorkspace(async workspace => {
    let ledger = new LearningLedger(workspace, 'a')
    const batch = ledger.create('reflector', [source(0, 1)], [])
    // Build the old persisted shape: candidates plus a three-deferral pause,
    // with no continuation marker. No production journal migration is needed.
    for (let i = 0; i < 3; i++) {
      ledger.bind(batch.id, `old-${i}`)
      ledger.interrupt(batch.id, 'unfinished')
      ledger.defer(batch.id, false)
    }
    ledger.propose(batch.id, 'partial', 'Old structured receipt', [candidate])
    ledger = new LearningLedger(workspace, 'a')
    assert.match(ledger.batch(batch.id).retry!.paused!, /Automatic retry limit/)
    assert.equal(ledger.pending('reflector', true), undefined)
    t.mock.timers.tick(3_600_001)
    assert.equal(ledger.pending('reflector', true)?.id, batch.id)
    ledger.bind(batch.id, 'new-continuation')
    assert.equal(ledger.batch(batch.id).retry?.attempts, 3)
    ledger.interrupt(batch.id, 'still incomplete')
    assert.equal(new LearningLedger(workspace, 'a').pending('reflector', true), undefined)
  })
})
