import assert from 'node:assert/strict'
import { test } from 'node:test'
import { InitiativeStore, automaticWorkEligible } from './store.ts'
import { parseStoredWorkRecord, workRecordSchema, type WorkRecord } from './work-contract.ts'
import { WorkAlignment } from '../sessions/work-alignment.ts'
import type { SessionState } from '../sessions/session-store.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { createWorkTools } from '../tools/work-operations.ts'
import { workReceipt } from '../tools/work.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { requireToolText } from '../tools/tool.ts'

const actor = (sessionId: string) => ({ kind: 'session' as const, sessionId })
function setup(home: string) {
  const states = new Map<string, SessionState>(['manager', 'worker', 'peer'].map(sessionId =>
    [sessionId, { sessionId, segmentIndex: 0, mode: 'session' }]))
  const store = new InitiativeStore(home, { isSessionKnown: id => states.has(id) })
  const alignment = new WorkAlignment(store, { state: id => states.get(id), evidence: async () => {}, changed: async () => {} })
  const create = async (data: Record<string, unknown> = {}) => workRecordSchema.parse(await alignment.execute(actor('manager'), 'create', undefined, undefined,
    { title: 'Synthetic task', assignee: null, definition: { objective: 'Investigate only; no external action is authorized' }, ...data }))
  return { store, alignment, create, states }
}
const flow = (record: WorkRecord, patch: Partial<NonNullable<WorkRecord['workflow']>>): WorkRecord =>
  ({ ...record, workflow: { ...record.workflow!, ...patch } })

test('dispatch intent defaults preserve legacy tasks but findings require ready; ready is not authority', async () => withTempWorkspace(async home => {
  const f = setup(home)
  try {
    const legacy = await f.create()
    assert.equal(legacy.workflow?.automaticDispatch, undefined)
    assert.equal(automaticWorkEligible(legacy, [legacy]), true)
    const finding = await f.create({ notes: { kind: 'finding' } })
    assert.equal(automaticWorkEligible(finding, [finding]), false)
    for (const record of [legacy, finding]) {
      const manual = flow(record, { automaticDispatch: 'manual' })
      assert.equal(automaticWorkEligible(manual, [manual]), false)
      const ready = flow(record, { automaticDispatch: 'ready' })
      assert.equal(automaticWorkEligible(ready, [ready]), true)
      assert.equal(automaticWorkEligible({ ...ready, paused: true }, [ready]), false)
      assert.equal(automaticWorkEligible(flow(ready, { assignee: 'worker' }), [ready]), false)
      for (const status of ['done', 'cancelled'] as const) {
        assert.equal(automaticWorkEligible(flow(ready, { status }), [ready]), false)
      }
      assert.equal(automaticWorkEligible(flow(ready, { dependencies: ['missing'] }), [ready]), false)
      assert.equal(automaticWorkEligible(flow(ready, { parentKey: 'missing' }), [ready]), false)
    }
    const authority = f.store.workAuthority(finding.subject)
    const ready = await f.alignment.editNote(actor('manager'), finding.key, finding.sequence, { automaticDispatch: 'ready' })
    assert.deepEqual(f.store.workAuthority(finding.subject), authority)
    assert.equal(ready.revision, finding.revision, 'Scheduling is not a goal or authorization revision')
    assert.equal(ready.origin, finding.origin)
    assert.deepEqual(ready.definition, finding.definition)
    assert.equal(ready.automaticExecution, undefined, 'Readiness itself never dispatches')
  } finally { f.store.close() }
}))

test('manual ancestors exclude ready descendants without bypassing existing ancestor and dependency restrictions', async () => withTempWorkspace(async home => {
  const f = setup(home)
  try {
    const root = await f.create({ automaticDispatch: 'manual' })
    const middle = await f.create({ parentKey: root.key, notes: { kind: 'task', relation: { kind: 'supports', reason: 'Synthetic child' } } })
    const child = await f.create({ automaticDispatch: 'ready', parentKey: middle.key, notes: { kind: 'finding', relation: { kind: 'supports', reason: 'Synthetic finding' } } })
    assert.equal(automaticWorkEligible(child, [root, middle, child]), false)
    const readyRoot = flow(root, { automaticDispatch: 'ready' })
    assert.equal(automaticWorkEligible(child, [readyRoot, middle, child]), true)
    assert.equal(automaticWorkEligible(child, [{ ...readyRoot, paused: true }, middle, child]), false)
    for (const status of ['done', 'cancelled'] as const) {
      assert.equal(automaticWorkEligible(child, [flow(readyRoot, { status }), middle, child]), false)
    }
    assert.equal(automaticWorkEligible(child, [flow(readyRoot, { dependencies: ['missing'] }), middle, child]), false)
    const prerequisite = await f.create()
    const dependent = flow(child, { dependencies: [prerequisite.key] })
    assert.equal(automaticWorkEligible(dependent, [readyRoot, middle, dependent, prerequisite]), false)
    assert.equal(automaticWorkEligible(dependent, [readyRoot, middle, dependent, flow(prerequisite, { status: 'done' })]), true)
    // Preserve the existing unassigned-blocked scheduling behavior, not a new unblocking policy.
    assert.equal(automaticWorkEligible(flow(child, { status: 'blocked', blockedReason: 'Waiting' }), [readyRoot, middle, child]), true)
  } finally { f.store.close() }
}))

test('readiness changes require the existing manager or human and optimistic versions even for sync replacements', async () => withTempWorkspace(async home => {
  const f = setup(home)
  try {
    let record = await f.create({ assignee: 'worker', automaticDispatch: 'manual' })
    for (const sessionId of ['worker', 'peer']) {
      await assert.rejects(f.alignment.editNote(actor(sessionId), record.key, record.sequence, { automaticDispatch: 'ready' }), /controller|assigned branch/)
      for (const automaticDispatch of ['ready', undefined] as const) {
        assert.throws(() => f.store.saveWork({ ...flow(record, { automaticDispatch, manager: sessionId }), sequence: record.sequence + 1 }, record.sequence, sessionId, 'sync'), /controller/)
      }
    }
    assert.throws(() => f.store.saveWork({ ...flow(record, { automaticDispatch: 'ready' }), sequence: record.sequence + 1 }, record.sequence, 'work-organizer', 'sync'), /controller/)
    const workerUpdate = await f.alignment.editNote(actor('worker'), record.key, record.sequence, { notes: { summary: 'Facts only' } })
    assert.equal(workerUpdate.workflow?.automaticDispatch, 'manual')
    await assert.rejects(f.alignment.editNote(actor('manager'), record.key, record.sequence, { automaticDispatch: 'ready' }), /note changed/)
    record = await f.alignment.editNote(actor('manager'), record.key, workerUpdate.sequence, { automaticDispatch: 'ready' })
    assert.throws(() => f.store.saveWork({ ...flow(workerUpdate, { automaticDispatch: 'manual' }), sequence: workerUpdate.sequence + 1 }, workerUpdate.sequence, 'manager', 'note'), /changed/)
    record = await f.alignment.editNote({ kind: 'user' }, record.key, record.sequence, { automaticDispatch: 'manual' })
    assert.equal(record.workflow?.automaticDispatch, 'manual')
    const humanCreated = workRecordSchema.parse(await f.alignment.execute({ kind: 'user' }, 'create', undefined, undefined,
      { title: 'Human readiness', automaticDispatch: 'ready', definition: { objective: 'Review evidence' } }))
    assert.equal(humanCreated.workflow?.automaticDispatch, 'ready')
  } finally { f.store.close() }
}))

test('typed create/update and read receipts expose strict readiness; SQLite reopen retains omitted and explicit values', async () => withTempWorkspace(async home => {
  const f = setup(home)
  const tools = new SessionTools(new Tools(home), home)
  const context: ExecutionContext = { sessionId: 'manager', physicalSessionId: 'manager.0', channel: 'web', chatId: 'manager',
    messageId: 'synthetic-input', senderId: 'synthetic-user', signal: new AbortController().signal, tools }
  const typed = createWorkTools(f.alignment)
  const create = typed.find(tool => tool.name === 'work_create')!
  const update = typed.find(tool => tool.name === 'work_update')!
  const call = async (tool: typeof create, args: Record<string, unknown>) => JSON.parse(requireToolText(await tool.execute(args, context)))
  let persisted: WorkRecord[]
  try {
    assert.deepEqual((create.parameters.properties!.automaticDispatch as { enum: string[] }).enum, ['manual', 'ready'])
    assert.deepEqual((update.parameters.properties!.automaticDispatch as { enum: string[] }).enum, ['manual', 'ready'])
    await f.create()
    await f.create({ notes: { kind: 'finding' } })
    await f.create({ automaticDispatch: 'manual' })
    const receipt = await call(create, { title: 'Typed finding', assignee: null, automaticDispatch: 'manual', notes: { kind: 'finding' }, definition: { objective: 'Track' }, idempotencyKey: 'readiness' })
    assert.equal(receipt.automaticDispatch, 'manual')
    await assert.rejects(call(create, { title: 'Typed finding', assignee: null, automaticDispatch: 'ready', notes: { kind: 'finding' }, definition: { objective: 'Track' }, idempotencyKey: 'readiness' }), /conflicts/)
    const changed = await call(update, { key: receipt.key, version: receipt.version, automaticDispatch: 'ready' })
    assert.equal(changed.automaticDispatch, 'ready')
    const listed = await f.alignment.execute(actor('manager'), 'list', undefined, undefined, {}) as { items: ReturnType<typeof workReceipt>[] }
    assert.equal(listed.items.find(item => item.key === receipt.key)?.automaticDispatch, 'ready')
    assert.equal(f.alignment.context('manager', receipt.key).records[0].workflow?.automaticDispatch, 'ready')
    for (const automaticDispatch of ['automatic', true, null, { ready: true }]) {
      await assert.rejects(call(update, { key: receipt.key, version: changed.version, automaticDispatch }))
      await assert.rejects(f.create({ automaticDispatch }))
      assert.throws(() => parseStoredWorkRecord(flow(f.alignment.get(receipt.key), { automaticDispatch } as never)))
    }
    assert.throws(() => parseStoredWorkRecord({ ...f.alignment.get(receipt.key), workflow: { ...f.alignment.get(receipt.key).workflow, unexpected: true } }), /Unrecognized key/)
    persisted = f.store.workRecords()
  } finally { f.store.close() }
  const reopened = new InitiativeStore(home)
  try {
    assert.deepEqual(reopened.workRecords(), persisted)
    assert.deepEqual(reopened.workRecords().map(record => automaticWorkEligible(record, reopened.workRecords())),
      persisted.map(record => automaticWorkEligible(record, persisted)))
    assert(reopened.workRecords().some(record => !Object.hasOwn(record.workflow!, 'automaticDispatch')), 'Legacy omission is not rewritten')
  } finally { reopened.close() }
}))

test('automatic claims recheck readiness and ancestor changes inside the storage transaction', async () => withTempWorkspace(async home => {
  const f = setup(home)
  const claim = (record: WorkRecord, automaticDispatch = record.workflow!.automaticDispatch): WorkRecord => ({
    ...flow(record, { automaticDispatch, assignee: 'worker', assignmentRevision: record.workflow!.assignmentRevision + 1 }), sequence: record.sequence + 1,
    automaticExecution: { jobId: 'default:work-dispatch-v1', sessionId: 'worker', assignmentRevision: record.workflow!.assignmentRevision + 1,
      inputId: 'synthetic-claim', stage: 'claimed' },
  })
  try {
    const finding = await f.create({ notes: { kind: 'finding' } })
    assert.throws(() => f.store.claimAutomaticWork(claim(finding), finding.sequence), /claimable/)
    assert.throws(() => f.store.claimAutomaticWork(claim(finding, 'ready'), finding.sequence), /controller/)
    const ready = await f.alignment.editNote(actor('manager'), finding.key, finding.sequence, { automaticDispatch: 'ready' })
    const manual = await f.alignment.editNote(actor('manager'), ready.key, ready.sequence, { automaticDispatch: 'manual' })
    assert.throws(() => f.store.claimAutomaticWork(claim(ready), ready.sequence), /changed/)
    assert.throws(() => f.store.claimAutomaticWork(claim(manual), manual.sequence), /claimable/)
    const root = await f.create()
    const child = await f.create({ automaticDispatch: 'ready', parentKey: root.key, notes: { kind: 'finding', relation: { kind: 'supports', reason: 'Evidence' } } })
    await f.alignment.editNote(actor('manager'), root.key, root.sequence, { automaticDispatch: 'manual' })
    assert.throws(() => f.store.claimAutomaticWork(claim(child), child.sequence), /claimable/)
    const admitted = await f.create({ automaticDispatch: 'ready', notes: { kind: 'finding' } })
    f.store.claimAutomaticWork(claim(admitted), admitted.sequence)
    assert.equal(f.alignment.get(admitted.key).workflow?.assignee, 'worker')
    assert.equal(f.alignment.get(admitted.key).workflow?.automaticDispatch, 'ready')
  } finally { f.store.close() }
}))
