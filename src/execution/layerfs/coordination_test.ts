import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, writeFile, rm, unlink } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { DatabaseSync } from 'node:sqlite'
import { coordinationRunner, inspectReservation, reconcileReservation, releaseReservation, resourceJournal } from './coordination.ts'

async function fixture() {
  const directory = await mkdtemp(join(process.cwd(), '.layerfs-coordination-test-'))
  const projectJournal = join(directory, 'project.jsonl'), database = projectJournal + '.sqlite'
  const journal = (branch: string) => resourceJournal(projectJournal, branch)
  const reserve = (owner = 'owner', resources = ['A', 'B'], crashBeforeCommit = false) => {
    const args = { coordination: database, owner, resources, journals: resources.map(journal), projectJournal }
    // Run the actual embedded admission code, exiting BEFORE journal creation.
    // No SDK, worker, Docker, or real LayerFS resources are involved.
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', `
      import {mkdir,stat} from 'node:fs/promises'; import {dirname} from 'node:path'; import {DatabaseSync} from 'node:sqlite';
      const a=${JSON.stringify(args)}, project='project', action='merge';
      ${crashBeforeCommit ? coordinationRunner.replace("db.exec('COMMIT');", 'process.exit(19);') : coordinationRunner}
      try { await reserveResources(); console.log(JSON.stringify({ok:true})); }
      catch(e) { console.log(JSON.stringify({ok:false,code:e.code,message:e.message})); }
    `], { encoding: 'utf8', timeout: 10000 })
    assert.equal(child.error, undefined)
    assert.equal(child.status, crashBeforeCommit ? 19 : 0, child.stderr)
    if (crashBeforeCommit) return { ok: false, code: 'SimulatedCrash' }
    return JSON.parse(child.stdout) as { ok: boolean; code?: string; message?: string }
  }
  const admitted = async (owner = 'owner', resources = ['A', 'B'], phase = 'admitted') => {
    const { mkdir } = await import('node:fs/promises')
    await mkdir(projectJournal + '.resources', { recursive: true })
    for (const resource of resources) await writeFile(journal(resource), JSON.stringify({ owner, project: 'project', action: 'merge', phase }) + '\n')
  }
  const snapshot = (owner = 'owner') => inspectReservation(database, owner)
  const settle = () => {
    // Simulate the durable boundary reached by releaseReservation's first COMMIT,
    // then die before/during journal cleanup. The operation remains reserved.
    const state = snapshot()
    const db = new DatabaseSync(database)
    try {
      db.prepare("UPDATE coordination_operations SET phase='settled', evidence=?, receipt=?, settled_at=? WHERE owner='owner'")
        .run(JSON.stringify(state.evidence), JSON.stringify({ ok: true, result: { kind: 'Merged', head: 'aa' } }), new Date().toISOString())
    } finally { db.close() }
  }
  return { directory, database, journal, reserve, admitted, snapshot, settle, close: () => rm(directory, { recursive: true, force: true }) }
}

test('admission atomically retains owner, phase and all resources before any journal exists', async () => {
  const f = await fixture()
  try {
    assert.equal(f.reserve().ok, true)
    const state = f.snapshot()
    assert.equal(state.phase, 'reserved')
    assert.equal(state.project, 'project')
    assert.equal(state.action, 'merge')
    assert.deepEqual(state.resources, ['branch:A', 'branch:B'])
    assert.deepEqual(state.evidence.map(e => e.text), [null, null])
    assert.equal(f.reserve('overlap', ['B']).code, 'Busy')
    assert.equal(f.reserve('independent', ['C']).ok, true)
    assert.throws(() => releaseReservation(f.database, 'owner', state.journals), /Missing admitted journal/)
    // Missing evidence alone cannot be used as a clear-lock operation.
    await assert.rejects(reconcileReservation(f.database, 'owner', state.fingerprint, async () => ({ ownerInactive: false, outcome: 'not-dispatched', receipt: {} }) as never), /inactive-owner/)
    assert.equal(f.snapshot().phase, 'reserved')
    const result = await reconcileReservation(f.database, 'owner', state.fingerprint, async observed => {
      assert.deepEqual(observed, state)
      return { ownerInactive: true, outcome: 'not-dispatched', receipt: { source: 'test harness: process exited immediately after reserve; no SDK imported' } }
    })
    assert.equal(result.phase, 'released')
    assert.deepEqual(result.retainedEvidence, state.evidence)
    assert.equal(f.reserve('replacement', ['A', 'B']).ok, true)
  } finally { await f.close() }
})

test('release retains exact journal bytes and settled receipt before removing reservation files', async () => {
  const f = await fixture()
  try {
    assert.equal(f.reserve().ok, true)
    await f.admitted()
    const before = f.snapshot()
    const receipt = { ok: true, result: { kind: 'Merged', head: 'ab' } }
    releaseReservation(f.database, 'owner', before.journals, receipt)
    const after = f.snapshot()
    assert.equal(after.phase, 'released')
    assert.deepEqual(after.retainedEvidence, before.evidence)
    assert.deepEqual(after.receipt, receipt)
    assert.deepEqual(after.evidence.map(e => e.text), [null, null])
    assert.throws(() => releaseReservation(f.database, 'owner', before.journals, receipt), /mismatch/)
    assert.equal(f.reserve('next').ok, true)
  } finally { await f.close() }
})

test('crash after settlement commit / partial unlink is recoverable without losing evidence', async () => {
  for (const deleted of [0, 1, 2]) {
    const f = await fixture()
    try {
      assert.equal(f.reserve().ok, true)
      await f.admitted()
      const originals = f.snapshot().evidence
      f.settle()
      for (const resource of ['A', 'B'].slice(0, deleted)) await unlink(f.journal(resource))
      const before = f.snapshot()
      assert.equal(before.phase, 'settled')
      assert.equal(f.reserve('overlap', ['A']).code, 'Busy')
      assert.deepEqual(before.retainedEvidence, originals)
      assert.throws(() => releaseReservation(f.database, 'owner', before.journals), /already attempted/)
      const after = await reconcileReservation(f.database, 'owner', before.fingerprint, async () => ({ ownerInactive: true, outcome: 'retire-settled' }))
      assert.equal(after.phase, 'released')
      assert.deepEqual(after.retainedEvidence, originals)
      assert.deepEqual(after.receipt, before.receipt)
      assert.equal(f.reserve('replacement').ok, true)
    } finally { await f.close() }
  }
})

test('owner/path mismatch, unknown phase and forged not-dispatched reconciliation preserve reservations', async () => {
  const f = await fixture()
  try {
    assert.equal(f.reserve().ok, true)
    await f.admitted('owner', ['A', 'B'], 'merge-dispatched')
    const before = f.snapshot()
    assert.throws(() => releaseReservation(f.database, 'wrong', before.journals), /mismatch/)
    assert.throws(() => releaseReservation(f.database, 'owner', [f.journal('A')]), /mismatch/)
    assert.throws(() => releaseReservation(f.database, 'owner', [f.journal('A'), f.journal('A')]), /mismatch/)
    await assert.rejects(reconcileReservation(f.database, 'owner', before.fingerprint, async () => ({ ownerInactive: true, outcome: 'retire-settled' })), /No settled receipt/)
    await assert.rejects(reconcileReservation(f.database, 'owner', before.fingerprint, async () => ({ ownerInactive: true, outcome: 'not-dispatched', receipt: { why: 'missing PID is NOT proof' } })), /Dispatch evidence/)
    await assert.rejects(reconcileReservation(f.database, 'owner', before.fingerprint, async () => { throw Error('SDK outcome still unknown') }), /still unknown/)
    assert.equal(f.snapshot().fingerprint, before.fingerprint)
    assert.equal(f.reserve('overlap', ['B']).code, 'Busy')
    const after = await reconcileReservation(f.database, 'owner', before.fingerprint, async () => ({ ownerInactive: true, outcome: 'settled', receipt: { authoritativeDomainVerification: { kind: 'Merged', head: 'aa' } } }))
    assert.equal(after.phase, 'released')
    assert.deepEqual(after.retainedEvidence, before.evidence)
  } finally { await f.close() }
})

test('reconcile checks exact snapshot before and after asynchronous host verification', async () => {
  const f = await fixture()
  try {
    assert.equal(f.reserve().ok, true)
    await f.admitted()
    const before = f.snapshot()
    let called = false
    await assert.rejects(reconcileReservation(f.database, 'owner', 'old fingerprint', async () => { called = true; return { ownerInactive: true, outcome: 'retire-settled' } }), /snapshot changed/)
    assert.equal(called, false)
    await assert.rejects(reconcileReservation(f.database, 'owner', before.fingerprint, async () => {
      await f.admitted('owner', ['A'], 'merge-dispatched')
      return { ownerInactive: true, outcome: 'settled', receipt: { ok: true } }
    }), /evidence changed/)
    assert.equal(f.snapshot().phase, 'reserved')
    assert.equal(existsSync(f.journal('A')), true)
  } finally { await f.close() }
})

test('changed/foreign journal after settlement cannot be erased by reconcile', async () => {
  const f = await fixture()
  try {
    assert.equal(f.reserve().ok, true)
    await f.admitted()
    f.settle()
    await f.admitted('foreign-owner', ['B'])
    const before = f.snapshot()
    await assert.rejects(reconcileReservation(f.database, 'owner', before.fingerprint, async () => ({ ownerInactive: true, outcome: 'retire-settled' })), /changed after settlement/)
    assert.match(await readFile(f.journal('B'), 'utf8'), /foreign-owner/)
    assert.equal(existsSync(f.journal('A')), true) // validate ALL before unlinking any
    assert.equal(f.snapshot().phase, 'settled')
  } finally { await f.close() }
})

test('preexisting orphan resource journal is quarantined before admission, never overwritten', async () => {
  const f = await fixture()
  try {
    await f.admitted('old-owner', ['A'])
    const original = await readFile(f.journal('A'), 'utf8')
    assert.equal(f.reserve().code, 'Busy')
    assert.equal(await readFile(f.journal('A'), 'utf8'), original)
    assert.equal(f.reserve('independent', ['C']).ok, true)
  } finally { await f.close() }
})

test('legacy rows without ledger evidence are not silently cleared', async () => {
  const f = await fixture()
  try {
    assert.equal(f.reserve('unrelated', ['C']).ok, true)
    const db = new DatabaseSync(f.database)
    try { db.prepare('INSERT INTO reservations VALUES (?, ?, ?, ?, ?)').run('branch:A', 'legacy', f.journal('A'), 'project', 'exec') } finally { db.close() }
    await f.admitted('legacy', ['A'])
    assert.throws(() => releaseReservation(f.database, 'legacy', [f.journal('A')]), /no durable operation evidence/)
    assert.equal(f.reserve('next', ['A']).code, 'Busy')
    assert.equal(existsSync(f.journal('A')), true)
  } finally { await f.close() }
})


test('process death before admission COMMIT rolls back ledger and complete reservation set together', async () => {
  const f = await fixture()
  try {
    assert.equal(f.reserve('dead', ['A', 'B'], true).code, 'SimulatedCrash')
    const db = new DatabaseSync(f.database)
    try {
      assert.equal(db.prepare('SELECT * FROM reservations').all().length, 0)
      assert.equal(db.prepare('SELECT * FROM coordination_operations').all().length, 0)
    } finally { db.close() }
    assert.equal(f.reserve('live', ['A', 'B']).ok, true)
  } finally { await f.close() }
})

test('partial journal creation remains inspectable and requires authoritative non-dispatch verification', async () => {
  const f = await fixture()
  try {
    assert.equal(f.reserve().ok, true)
    await f.admitted('owner', ['A'])
    const before = f.snapshot()
    assert.equal(before.evidence[1]?.text, null)
    assert.throws(() => releaseReservation(f.database, 'owner', before.journals), /Missing admitted journal/)
    const after = await reconcileReservation(f.database, 'owner', before.fingerprint, async () => ({
      ownerInactive: true, outcome: 'not-dispatched', receipt: { source: 'test owner exited after first journal; no SDK calls' },
    }))
    assert.equal(after.phase, 'released')
    assert.deepEqual(after.retainedEvidence, before.evidence)
  } finally { await f.close() }
})
