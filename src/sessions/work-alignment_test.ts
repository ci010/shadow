import assert from 'node:assert/strict'
import { test } from 'node:test'
import { InitiativeStore } from '../initiatives/store.ts'
import { workRecordSchema, type WorkRecord } from '../initiatives/work-contract.ts'
import { workArtifactSchema, workDecisionContextSchema } from '../initiatives/work-notes.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { WorkTool } from '../tools/work.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { requireToolText } from '../tools/tool.ts'
import { InvokeTool } from '../tools/invoke-tool.ts'
import type { SessionState } from './session-store.ts'
import { WorkAlignment } from './work-alignment.ts'
import type { YieldRequest } from './yield-contract.ts'

const owner = 'web:owner', worker = 'web:worker', peer = 'web:peer'
const actor = (sessionId: string) => ({ kind: 'session' as const, sessionId })
function fixture(home: string) {
  const states = new Map<string, SessionState>([owner, worker, peer].map(sessionId => [sessionId, { sessionId, segmentIndex: 0, mode: 'session' }]))
  const store = new InitiativeStore(home, { isSessionKnown: id => states.has(id) })
  const changes: WorkRecord[] = []
  const alignment = new WorkAlignment(store, {
    state: id => states.get(id), evidence: async source => { assert.equal(source.sessionId, owner) },
    changed: async record => { changes.push(record) }, fresh: async () => {}, successor: async () => undefined,
  })
  const base = new Tools(home), tools = new SessionTools(base, home)
  const tool = new WorkTool(alignment)
  base.setWorkGuard(alignment); base.register(tool); base.register(new InvokeTool())
  const context = (sessionId = owner): ExecutionContext => ({
    sessionId, physicalSessionId: `${sessionId}.0`, channel: 'web', chatId: sessionId.slice(4),
    senderId: 'fixture-user', messageId: 'owner-input', signal: new AbortController().signal, tools,
  })
  const create = async (data: Record<string, unknown> = {}) => workRecordSchema.parse(await alignment.execute(actor(owner), 'create', undefined, undefined, {
    title: 'Token metrics', definition: { objective: 'Measure token use, not grader scores' }, notes: { kind: 'goal' }, ...data,
  }))
  return { store, states, changes, alignment, tool, tools, base, context, create }
}
const childNotes = { kind: 'task', relation: { kind: 'supports', reason: 'Collect usage evidence for the release decision' } }

test('work mutations are small receipts, schema is opt-in, and notes are current rather than repeated HTML history', async () => withTempWorkspace(async home => {
  const f = fixture(home)
  try {
    const initial = JSON.parse(await f.tool.execute({ action: 'context' }, f.context()))
    assert.equal(initial.schema, undefined)
    const help = JSON.parse(await f.tool.execute({ action: 'context', data: { includeSchema: true } }, f.context()))
    assert(help.schema.update.notes)
    const receipt = JSON.parse(await f.tool.execute({ action: 'create', data: {
      title: 'A bounded report', definition: { objective: 'Compare release token use' },
      notes: { kind: 'goal', html: `<p>${'exhibit '.repeat(4500)}</p>` },
    } }, f.context()))
    assert.equal(receipt.version, 1)
    assert.equal(receipt.goalRevision, 1)
    assert.equal(receipt.definition, undefined)
    assert.equal(receipt.notes, undefined)
    assert(JSON.stringify(receipt).length < 400)
    const updated = JSON.parse(await f.tool.execute({ action: 'update', key: receipt.key, version: receipt.version,
      data: { notes: { summary: 'Usage collected', plan: ['Compare models'], next: 'Read the comparison' }, status: 'in_progress' } }, f.context()))
    assert.equal(updated.version, 2)
    assert.equal(updated.goalRevision, 1)
    const detail = JSON.parse(await f.tool.execute({ action: 'context', key: receipt.key }, f.context()))
    assert.equal(detail.records[0].notes.summary, 'Usage collected')
    assert.equal(detail.records[0].notes.html.length, 36007)
    assert.equal(detail.schema, undefined)
    assert.equal(detail.records[0].history, undefined)
    const listed = JSON.parse(await f.tool.execute({ action: 'list' }, f.context()))
    assert.equal(listed.items[0].version, 2)
    assert.equal(listed.items[0].goalRevision, 1)
    assert.equal(listed.items[0].notes, undefined)
    assert(JSON.stringify(f.store.workHistory(receipt.key)).length < 2500, 'Large HTML is stored once, not copied into every work event')
    assert.doesNotMatch(f.alignment.prompt(owner), /exhibit exhibit|Read-only HTML|schema/)
    for (const action of ['adopt', 'policy', 'checkpoint', 'settle', 'propose']) {
      await assert.rejects(f.tool.execute({ action }, f.context()), /Invalid enum/)
    }
    await assert.rejects(f.tool.execute({ action: 'update', key: receipt.key, version: 1, data: { notes: { summary: 'lost update' } } }, f.context()), /note changed/)
    assert.equal(f.alignment.get(receipt.key).notes?.summary, 'Usage collected')
  } finally { f.store.close() }
}))

test('notes, blockers and previous required metadata never gate tools; actual tool permissions and input validation remain enforced', async () => withTempWorkspace(async home => {
  const f = fixture(home)
  let writes = 0
  f.base.register({ name: 'fixture_write', description: '', parameters: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'], additionalProperties: false },
    execute: async () => { writes++; return 'saved' } })
  try {
    const work = await f.create()
    f.states.get(owner)!.workPolicy = { mode: 'required', keys: [work.key], controllerSessionId: owner }
    const pending = await f.alignment.editNote(actor(owner), work.key, work.sequence,
      { status: 'blocked', blockedReason: 'One approach is waiting; independent authorized work can continue.' })
    assert.equal(pending.notes?.attention?.kind, 'blocker')
    assert.equal(f.alignment.required(owner), false)
    assert.deepEqual(f.alignment.snapshot(owner), [])
    assert.equal(requireToolText(await f.tools.execute('fixture_write', { text: 'synthetic' }, f.context())), 'saved')
    const scoped = new SessionTools(f.base, home, ['read'])
    assert.match(requireToolText(await scoped.execute('fixture_write', { text: 'synthetic' }, { ...f.context(), tools: scoped })), /not allowed|not available|not found/i)
    assert.match(requireToolText(await f.tools.execute('invoke_tool', { name: 'fixture_write', args: { text: 12 } }, f.context())), /Error|invalid/i)
    assert.equal(writes, 1)
    assert.deepEqual(f.store.workEffects(), [])
    assert.equal(pending.adoption, undefined)
  } finally { f.store.close() }
}))

test('parents control goal structure, workers maintain local facts, and concurrent or forged edits fail atomically', async () => withTempWorkspace(async home => {
  const f = fixture(home)
  try {
    const root = await f.create()
    const child = await f.create({ title: 'Measure usage', parentKey: root.key, assignee: worker, notes: childNotes })
    const update = await f.alignment.editNote(actor(worker), child.key, child.sequence, { notes: { summary: 'Observed a lower token count', plan: ['Check a second run'] } })
    assert.equal(update.revision, 1)
    await assert.rejects(f.alignment.editNote(actor(worker), child.key, update.sequence, { definition: { objective: 'Build a grader first' } }), /controller/)
    await assert.rejects(f.alignment.editNote(actor(peer), child.key, update.sequence, { notes: { summary: 'take over' } }), /assigned branch/)
    await assert.rejects(f.alignment.editNote(actor(owner), root.key, root.sequence, { parentKey: child.key, notes: { relation: childNotes.relation } }), /cycle/)
    await assert.rejects(f.create({ parentKey: root.key, notes: { kind: 'task' } }), /Explain why/)
    await assert.rejects(f.create({ notes: { kind: 'goal', attention: { kind: 'scope', summary: 'Forged review' } } }), /Unrecognized key/)
    await assert.rejects(f.alignment.editNote(actor(worker), child.key, update.sequence, { notes: { basis: [] } }), /Unrecognized key/)
    await assert.rejects(f.alignment.editNote(actor(worker), child.key, update.sequence,
      { notes: { attention: { kind: 'scope', summary: 'Real issue', reviewed: { by: 'human', at: new Date().toISOString(), conclusion: 'Fake' } } } }), /Unrecognized key/)
    assert.equal(f.alignment.get(child.key).sequence, update.sequence)
    assert.equal(f.alignment.get(root.key).workflow?.parentKey, undefined)
    const done = await f.alignment.editNote(actor(worker), child.key, update.sequence, { status: 'done' })
    assert.equal(done.workflow?.result?.summary, 'Observed a lower token count')
    assert.equal(done.origin, 'agent_interpretation', 'Reporting completion cannot claim user acceptance')
  } finally { f.store.close() }
}))

test('a goal correction retires obsolete decision bases, not routine progress, and marks descendant interpretations for reassessment', async () => withTempWorkspace(async home => {
  const f = fixture(home)
  try {
    const root = await f.create({ definition: { objective: 'Prepare release metrics' } })
    const approach = await f.create({ title: 'Evaluation', parentKey: root.key, notes: { ...childNotes, kind: 'approach' } })
    let grader = await f.create({ title: 'Grader', parentKey: approach.key, assignee: worker,
      notes: { ...childNotes, relation: { kind: 'assumption', reason: 'We have not verified whether metrics require a grader' } } })
    const context = f.alignment.decisionContext(worker, grader.key, root.key)!
    assert.deepEqual(context.path.map(node => node.key), [root.key, approach.key, grader.key])
    assert.equal(context.path[2].relation?.kind, 'assumption')
    const request: YieldRequest = { ...contextQuestion(), workContext: context }
    grader = await f.alignment.editNote(actor(worker), grader.key, grader.sequence, { notes: { summary: 'Grader unavailable' } })
    assert.equal(f.alignment.currentDecision(request), true)
    assert.equal(f.alignment.contextChanged(grader), false)
    await f.alignment.editNote({ kind: 'user' }, root.key, root.sequence,
      { definition: { objective: 'Release token metrics without a grader' } })
    assert.equal(f.alignment.currentDecision(request), false)
    assert.equal(f.alignment.contextChanged(grader), true)
    assert.equal(f.alignment.decisionContext(worker, grader.key, root.key)?.path.at(-1)?.contextNeedsReview, true)
    assert.match(f.alignment.prompt(worker), /without a grader/)
    assert.match(f.alignment.prompt(worker), /"contextNeedsReview":true/)
    grader = await f.alignment.editNote(actor(owner), grader.key, grader.sequence, { title: 'Optional scoring', notes: { kind: 'finding' } })
    assert.equal(f.alignment.contextChanged(grader), true, 'Editing a label or local interpretation does not assess changed ancestors')
    assert.equal(grader.revision, 2, 'A changed abstraction kind invalidates old decision context')
    await assert.rejects(f.alignment.reviewNote(actor(worker), grader.key, grader.sequence, 'I approve the new goal'), /controller/)
    const reviewed = await f.alignment.reviewNote(actor(owner), grader.key, grader.sequence, 'The grader is not a prerequisite; collect token counts directly.')
    assert.equal(f.alignment.contextChanged(reviewed), false)
    assert.equal(reviewed.notes?.attention?.reviewed?.by, owner)
    const assessed = f.alignment.decisionContext(worker, grader.key, root.key)!.path.at(-1)!
    assert.equal(assessed.contextNeedsReview, undefined)
    assert.equal(assessed.assessment, 'The grader is not a prerequisite; collect token counts directly.')
    assert.match(f.alignment.prompt(worker), /The grader is not a prerequisite; collect token counts directly/,
      'The worker sees the assessment as well as the unchanged historical task title')
    assert.equal(f.alignment.currentDecision(request), false, 'Review cannot revive a question based on an old ancestor')
    assert.equal(f.alignment.decisionContext(worker, grader.key, root.key)?.path[0].revision, 2)
    assert.throws(() => f.alignment.decisionContext(worker, grader.key, 'missing'), /goal path/)
  } finally { f.store.close() }
}))

function contextQuestion(): YieldRequest {
  return { id: 'question', sessionId: worker, question: 'Delay for a grader or collect counts now?',
    options: ['Collect counts', 'Delay'], defaultOption: 'Collect counts',
    recipient: { kind: 'user', sessionId: worker }, createdAt: new Date().toISOString(), deadline: null }
}

test('many assignments remain discoverable and repeated progress does not grow inference context', async () => withTempWorkspace(async home => {
  const f = fixture(home)
  try {
    let note = await f.create({ assignee: worker })
    const lengths: number[] = []
    for (let i = 0; i < 40; i++) {
      note = await f.alignment.editNote(actor(worker), note.key, note.sequence,
        { notes: { summary: `Sample ${String(i).padStart(2, '0')}`, next: 'Compare samples' } })
      lengths.push(f.alignment.prompt(worker).length)
    }
    assert(Math.max(...lengths) - Math.min(...lengths) <= 1, 'Only the version counter grows')
    assert.equal(note.revision, 1)
    for (let i = 1; i < 20; i++) await f.create({ title: `Assignment ${i}`, assignee: worker })
    const prompt = f.alignment.prompt(worker)
    assert.match(prompt, /Active notes: 20; shown: 3; omitted: 17/)
    assert(prompt.length < 6500)
    assert.equal(f.alignment.context(worker).records.length, 20)
    assert.equal(f.alignment.decisionContext(worker), undefined, 'Never invent one task when several assignments are active')
  } finally { f.store.close() }
}))

test('repeated goal changes preserve unassessed provenance and invalidate earlier assessment text', async () => withTempWorkspace(async home => {
  const f = fixture(home)
  try {
    let goal = await f.create()
    const branch = await f.create({ parentKey: goal.key, assignee: worker, notes: childNotes })
    goal = await f.alignment.editNote({ kind: 'user' }, goal.key, goal.sequence,
      { definition: { objective: 'Collect counts without scoring' } })
    const unassessed = f.alignment.decisionContext(worker, branch.key, goal.key)!
    assert.equal(unassessed.path.at(-1)?.contextNeedsReview, true)
    assert.equal(f.alignment.currentContext(unassessed), true, 'Reassessment warnings do not gate tools or questions')
    const reviewed = await f.alignment.reviewNote(actor(owner), branch.key, branch.sequence, 'Scoring is optional')
    assert.equal(f.alignment.decisionContext(worker, branch.key)?.path.at(-1)?.assessment, 'Scoring is optional')
    await f.alignment.editNote({ kind: 'user' }, goal.key, goal.sequence,
      { definition: { objective: 'Measure both quality and token use' } })
    const changedAgain = f.alignment.decisionContext(worker, branch.key)!
    assert.equal(changedAgain.path.at(-1)?.contextNeedsReview, true)
    assert.equal(changedAgain.path.at(-1)?.assessment, undefined, 'A prior assessment is not current after another correction')
    assert.equal(f.alignment.get(branch.key).sequence, reviewed.sequence)
    assert.equal(f.alignment.currentContext(unassessed), false)
  } finally { f.store.close() }
}))

test('stable work links survive note edits, preserve temporary execution focus, and never guess among multiple assignments', async () => withTempWorkspace(async home => {
  const f = fixture(home)
  try {
    const first = await f.create({ title: 'First branch', assignee: worker })
    const second = await f.create({ title: 'Second branch', assignee: worker })
    assert.equal(f.alignment.decisionContext(worker), undefined)
    f.states.set('virtual:task', { sessionId: 'virtual:task', segmentIndex: 0, mode: 'task', parentSessionId: worker })
    f.alignment.linkExecution('virtual:task', worker, { key: first.key })
    assert.equal(f.alignment.decisionContext('virtual:task')?.originKey, first.key)
    assert.match(f.alignment.prompt('virtual:task'), /First branch/)
    assert.doesNotMatch(f.alignment.prompt('virtual:task'), /Second branch/)
    await f.alignment.editNote(actor('virtual:task'), first.key, first.sequence, { notes: { summary: 'One bounded finding' } })
    await assert.rejects(f.alignment.editNote(actor('virtual:task'), second.key, second.sequence, { notes: { summary: 'Cross-branch change' } }), /linked to this temporary/)
    const unassigned = await f.create({ title: 'Peer branch', assignee: null })
    assert.deepEqual(f.alignment.prepareDelegation(owner, { key: unassigned.key }, 'session'), { mode: 'optional' })
    await f.alignment.bindDelegation(peer, owner, { key: unassigned.key })
    assert.equal(f.alignment.get(unassigned.key).workflow?.assignee, peer)
    assert.equal(f.alignment.required(peer), false)
    assert.equal(f.alignment.decisionContext(peer)?.originKey, unassigned.key)
  } finally { f.store.close() }
}))

test('human goals cannot be rewritten from a peer message or invented user quote', async () => withTempWorkspace(async home => {
  const f = fixture(home)
  try {
    const root = workRecordSchema.parse(await f.alignment.execute({ kind: 'user' }, 'create', undefined, undefined,
      { title: 'User goal', assignee: owner, definition: { objective: 'Token metrics only' } }))
    await assert.rejects(f.tool.execute({ action: 'update', key: root.key, version: 1,
      data: { definition: { objective: 'Train a grader' }, requestQuote: 'Approved' } },
    { ...f.context(), inputSource: 'session', workUserInput: 'Approved', admin: true, isGroup: false }), /authenticated user/)
    await assert.rejects(f.alignment.editNote(actor(owner), root.key, 1, { definition: { objective: 'Train a grader' } }), /set by the human/)
    assert.equal(f.alignment.get(root.key).definition.objective, 'Token metrics only')
    const corrected = await f.alignment.editNote(actor(owner), root.key, 1, {
      definition: { objective: 'Compare token metrics across candidates' }, requestQuote: 'Compare token metrics',
    }, undefined, { text: 'Compare token metrics across the candidates.', source: {
      sessionId: owner, physicalId: `${owner}.0`, kind: 'user', id: 'owner-input',
    } })
    assert.equal(corrected.origin, 'agent_interpretation')
    assert.equal(corrected.requestSource?.quote, 'Compare token metrics')
    await assert.rejects(f.alignment.editNote(actor(owner), root.key, corrected.sequence, {
      definition: { objective: 'Train a grader before comparing anything' },
    }), /set by the human/, 'Interpreting a real user correction cannot remove its source protection')
    const humanEdit = await f.alignment.editNote({ kind: 'user' }, root.key, corrected.sequence, {
      definition: { objective: 'Report latency instead' },
    })
    assert.equal(humanEdit.requestSource, undefined, 'A later direct edit cannot display an older quote as its current source')
    assert.match(JSON.stringify(f.store.workHistory(root.key)), /Compare token metrics/, 'The previous source remains in audit history')
  } finally { f.store.close() }
}))

test('artifact and decision path validation reject active URLs, escaping resources and fabricated ancestry', () => {
  for (const href of ['javascript:alert(1)', 'data:text/html,hello', '//other.example/', '/\\other.example',
    '/../api/projects/other', '/%2e%2e/api/projects/other', 'https://name:secret@example.com', '/white space']) {
    assert.equal(workArtifactSchema.safeParse({ label: 'Unsafe', href }).success, false, href)
  }
  for (const href of ['https://example.com/report', '/api/files/report?download=1', 'http://127.0.0.1:3000/result']) {
    assert(workArtifactSchema.safeParse({ label: 'Result', href }).success)
  }
  const node = { key: 'root', revision: 1, title: 'Root', objective: 'Outcome', kind: 'goal', origin: 'human' }
  assert.equal(workDecisionContextSchema.safeParse({ originKey: 'root', decisionKey: 'other', path: [node] }).success, false)
  assert.equal(workDecisionContextSchema.safeParse({ originKey: 'root', decisionKey: 'root', path: [node, node] }).success, false)
})

test('notes persist across reload without growing every inference or losing optimistic concurrency', async () => withTempWorkspace(async home => {
  const f = fixture(home)
  let key: string
  try {
    const root = await f.create()
    key = root.key
    const updated = await f.alignment.editNote(actor(owner), key, 1, { notes: { summary: 'Current result', html: '<h1>Result</h1>' } })
    const events = f.store.workHistory(key).length
    for (let i = 0; i < 4; i++) {
      f.alignment.prompt(owner)
      f.alignment.context(owner)
    }
    assert.equal(f.store.workHistory(key).length, events)
    assert.equal(updated.revision, 1)
  } finally { f.store.close() }
  const reopened = new InitiativeStore(home)
  try {
    const record = reopened.workRecords().find(record => record.key === key)!
    assert.equal(record.notes?.summary, 'Current result')
    assert.equal(record.notes?.html, '<h1>Result</h1>')
    assert.equal(record.sequence, 2)
    assert.equal(reopened.workFocus(owner), key)
  } finally { reopened.close() }
}))
