import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { test, type TestContext } from 'node:test'
import { AuthoringChanges, AuthoringConflictError } from './changes.ts'
import type { ConversationBinding, ResourceBundle } from './contracts.ts'
import { AgentResourceStore } from './store.ts'

const agentPath = 'agents/helper/AGENT.md'
const otherPath = 'agents/other/AGENT.md'
const content = (body: string) => `---\nallowedTools: [read, search]\n---\n${body}`
const binding = (conversationId: string, parameters = {}): ConversationBinding => ({
  botInstanceId: 'bot', platform: 'qq', conversationId, enabled: true,
  agent: 'helper', skills: [], readFolders: [], parameters, grants: [],
})

function fixture(t: TestContext) {
  const directory = resolve(`.authoring-changes-test-${randomUUID()}`)
  mkdirSync(directory)
  t.after(() => rmSync(directory, { recursive: true, force: true }))
  const resources = new AgentResourceStore({ projectId: 'project-one', directory })
  const options = { projectId: 'project-one', directory, resources }
  const changes = new AuthoringChanges(options)
  const create = () => changes.create({ title: 'Independent change', ownerSessionId: 'owner' })
  const publish = async (files: ResourceBundle['files'], bindings: ConversationBinding[] = []) => {
    const staged = await resources.stage({
      expectedRevision: resources.draft().revision, bundle: { version: 1, files, bindings },
    })
    return resources.publish(staged.revision)
  }
  return { directory, options, resources, changes, create, publish }
}

test('changes start from published resources and leave the dirty legacy draft untouched', async t => {
  const { changes, create, publish, resources, directory } = fixture(t)
  const published = await publish({ [agentPath]: content('Published') })
  const draft = await resources.stage({
    expectedRevision: resources.draft().revision,
    bundle: { version: 1, files: { [agentPath]: content('Dirty legacy draft') }, bindings: [] },
  })
  const disk = readFileSync(join(directory, 'resources.json'), 'utf8')
  const first = create()
  const second = create()
  assert.deepEqual(first.base, published)
  assert.deepEqual(first.snapshot, published)
  const edited = changes.edit(first.id, {
    expectedRevision: first.snapshot.revision,
    files: { [agentPath]: 'intentionally incomplete frontmatter', 'skills/catalog/tool.ts': 'export type T = string' },
  })
  assert.notEqual(edited.snapshot.revision, first.snapshot.revision)
  assert.deepEqual(edited.snapshot, resources.candidate(edited.snapshot.bundle))
  assert.equal(resources.validate(edited.snapshot).valid, false)
  assert.deepEqual(changes.get(second.id).snapshot, published)
  assert.deepEqual(resources.draft(), draft)
  assert.deepEqual(resources.snapshot(), published)
  assert.equal(readFileSync(join(directory, 'resources.json'), 'utf8'), disk)
  assert.equal(existsSync(join(directory, 'agents')), false)
  assert.equal(existsSync(join(directory, 'skills')), false)
  const deleted = changes.edit(first.id, {
    expectedRevision: edited.snapshot.revision, files: { 'skills/catalog/tool.ts': null },
  })
  assert.equal(Object.hasOwn(deleted.snapshot.bundle.files, 'skills/catalog/tool.ts'), false)
})

test('change snapshots, editors and evidence are detached; restart validates project identity', t => {
  const { changes, create, options, resources } = fixture(t)
  const created = create()
  created.snapshot.bundle.files[agentPath] = 'mutated'
  created.editors.push({ sessionId: 'intruder', paths: ['agents/'] })
  created.revisions.length = 0
  assert.deepEqual(changes.get(created.id).snapshot, resources.snapshot())
  assert.deepEqual(changes.get(created.id).editors, [])
  const saved = changes.edit(created.id, {
    expectedRevision: resources.snapshot().revision, files: { [agentPath]: 'a draft' },
  })
  const result = { messages: ['safe result'] }
  const run = changes.recordRun(saved.id, { revision: saved.snapshot.revision, kind: 'test', status: 'passed', result })
  result.messages.push('external mutation')
  ;(run.result as typeof result).messages.push('returned mutation')
  assert.deepEqual(changes.run(saved.id, run.id).result, { messages: ['safe result'] })
  const restarted = new AuthoringChanges(options)
  assert.deepEqual(restarted.list(), changes.list())
  assert.deepEqual(restarted.runs(saved.id), changes.runs(saved.id))
  assert.throws(() => new AuthoringChanges({ ...options, projectId: 'another-project' }), /another project/)
  for (const projectId of ['', ' ', ' padded ', 'bad\nid']) {
    assert.throws(() => new AuthoringChanges({ ...options, projectId }), /project ID/)
  }
  assert.throws(() => changes.get('missing'), /not found/)
  assert.throws(() => changes.run(saved.id, 'missing'), /not found/)
})

test('delegations require explicit safe exact paths or directory prefixes and support revocation', t => {
  const { changes } = fixture(t)
  const change = changes.create({
    title: 'Scoped work', ownerSessionId: 'owner',
    editors: [{ sessionId: 'exact', paths: ['skills/catalog/tool.ts'] }, { sessionId: 'empty', paths: [] }],
  })
  changes.authorize(change.id, 'owner', 'agents/other/AGENT.md')
  changes.authorize(change.id, 'exact')
  changes.authorize(change.id, 'exact', 'skills/catalog/tool.ts')
  changes.authorize(change.id, 'empty')
  assert.throws(() => changes.authorize(change.id, 'missing'), /registered/)
  assert.throws(() => changes.authorize(change.id, 'empty', agentPath), /scope/)
  assert.throws(() => changes.authorize(change.id, 'exact', 'skills/catalog/tool.js'), /scope/)
  changes.delegate(change.id, { sessionId: 'directory', paths: ['skills/catalog/'] })
  changes.authorize(change.id, 'directory', 'skills/catalog/SKILL.md')
  assert.throws(() => changes.authorize(change.id, 'directory', 'skills/catalog-other/tool.ts'), /scope/)
  for (const path of [
    'skills/catalog/../other/tool.ts', 'skills/catalog\\tool.ts', 'skills//tool.ts',
    'skills/catalog/%2e%2e', '/skills/catalog/tool.ts', 'skills/catalog/tool.ts/extra',
    'skills/catalog/**', 'skills/catalog/../../agents/helper/AGENT.md', '__proto__', 'constructor',
  ]) {
    assert.throws(() => changes.authorize(change.id, 'owner', path), /Unsafe|unsupported/)
    assert.throws(() => changes.delegate(change.id, { sessionId: 'bad', paths: [path] }), /Unsafe|unsupported/)
  }
  for (const path of ['skills/catalog', 'skills/*/', 'skills/catalog/**/', 'skills/catalog/../']) {
    assert.throws(() => changes.delegate(change.id, { sessionId: 'bad', paths: [path] }), /Unsafe/)
  }
  changes.delegate(change.id, { sessionId: 'directory', paths: ['agents/'] })
  changes.authorize(change.id, 'directory', agentPath)
  assert.throws(() => changes.authorize(change.id, 'directory', 'skills/catalog/tool.ts'), /scope/)
  changes.revoke(change.id, 'directory')
  assert.throws(() => changes.authorize(change.id, 'directory'), /registered/)
  assert.throws(() => changes.revoke(change.id, 'owner'), /owner/)
  assert.throws(() => changes.delegate(change.id, { sessionId: 'owner', paths: [] }), /Owner/)
})

test('edits reject stale revisions and unsafe deletion paths without changing stored state', t => {
  const { changes, create } = fixture(t)
  const change = create()
  const edited = changes.edit(change.id, { expectedRevision: change.snapshot.revision, files: { [agentPath]: 'first' } })
  assert.throws(() => changes.edit(change.id, {
    expectedRevision: change.snapshot.revision, files: { [agentPath]: 'stale' },
  }), /Stale change revision/)
  assert.throws(() => changes.rebase(change.id, change.snapshot.revision), /Stale change revision/)
  assert.throws(() => changes.close(change.id, change.snapshot.revision), /Stale change revision/)
  for (const files of [{ '../outside': null }, JSON.parse('{"__proto__":null}'), { 'agents/helper/../AGENT.md': null }]) {
    assert.throws(() => changes.edit(change.id, { expectedRevision: edited.snapshot.revision, files }), /Unsafe/)
  }
  assert.deepEqual(changes.get(change.id), edited)
})

test('authorization epochs persist across revoke and regrant without changing source revisions', t => {
  const { changes, create, options, directory } = fixture(t)
  const created = create()
  assert.equal(created.accessRevision, 0)
  const editor = { sessionId: 'editor', paths: ['skills/'] }
  const delegated = changes.delegate(created.id, editor)
  assert.equal(delegated.accessRevision, 1)
  assert.equal(changes.revoke(created.id, editor.sessionId).accessRevision, 2)
  const regranted = changes.delegate(created.id, editor)
  assert.equal(regranted.accessRevision, 3)
  assert.equal(regranted.snapshot.revision, created.snapshot.revision)
  assert.deepEqual(regranted.editors, delegated.editors)
  assert.equal(new AuthoringChanges(options).get(created.id).accessRevision, 3)
  const edited = changes.edit(created.id, {
    expectedRevision: regranted.snapshot.revision, files: { [agentPath]: 'draft' },
  })
  assert.equal(edited.accessRevision, 3)
  assert.throws(() => changes.delegate(created.id, { sessionId: 'bad', paths: ['../'] }))
  assert.equal(changes.get(created.id).accessRevision, 3)
  mkdirSync(join(directory, 'changes.json.lock'))
  assert.throws(() => changes.revoke(created.id, editor.sessionId), /storage boundary/)
  assert.equal(changes.get(created.id).accessRevision, 3)
  assert.equal(new AuthoringChanges(options).get(created.id).accessRevision, 3)
})

test('older change documents default authorization epoch to zero and reject invalid epochs', t => {
  const { create, options, directory } = fixture(t)
  const created = create()
  const file = join(directory, 'changes.json')
  const envelope = JSON.parse(readFileSync(file, 'utf8'))
  delete envelope.value.changes[0].accessRevision
  writeFileSync(file, JSON.stringify(envelope))
  const legacy = new AuthoringChanges(options)
  assert.equal(legacy.get(created.id).accessRevision, 0)
  assert.equal(legacy.delegate(created.id, { sessionId: 'editor', paths: [] }).accessRevision, 1)
  assert.equal(new AuthoringChanges(options).get(created.id).accessRevision, 1)
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER + 1, '1']) {
    envelope.value.changes[0].accessRevision = value
    writeFileSync(file, JSON.stringify(envelope))
    assert.throws(() => new AuthoringChanges(options))
  }
  envelope.value.changes[0].accessRevision = Number.MAX_SAFE_INTEGER
  writeFileSync(file, JSON.stringify(envelope))
  const full = new AuthoringChanges(options)
  assert.throws(() => full.delegate(created.id, { sessionId: 'editor', paths: [] }), /access revision limit/)
  assert.deepEqual(full.get(created.id).editors, [])
})

test('three-way rebase merges independent additions, updates and deletions without touching legacy draft', async t => {
  const { changes, create, publish, resources } = fixture(t)
  await publish({ [agentPath]: content('base'), [otherPath]: content('delete me') }, [binding('one'), binding('delete')])
  const change = create()
  const edited = changes.edit(change.id, {
    expectedRevision: change.snapshot.revision,
    files: { [agentPath]: content('ours'), [otherPath]: null },
    bindings: [binding('one', { version: 'ours' })],
  })
  const published = await publish({
    [agentPath]: content('base'), [otherPath]: content('delete me'), 'agents/third/AGENT.md': content('theirs'),
  }, [binding('one'), binding('delete'), binding('three')])
  const draft = resources.draft()
  const rebased = changes.rebase(change.id, edited.snapshot.revision)
  assert.deepEqual(rebased.base, published)
  assert.deepEqual(rebased.snapshot.bundle.files, {
    [agentPath]: content('ours'), 'agents/third/AGENT.md': content('theirs'),
  })
  assert.deepEqual(rebased.snapshot.bundle.bindings, [binding('one', { version: 'ours' }), binding('three')])
  assert.deepEqual(rebased.snapshot, resources.candidate(rebased.snapshot.bundle))
  assert(rebased.revisions.includes(edited.snapshot.revision))
  assert.deepEqual(resources.draft(), draft)
  assert.deepEqual(resources.snapshot(), published)
})

test('three-way rebase reports all divergent file and binding conflicts atomically', async t => {
  const { changes, create, publish } = fixture(t)
  await publish({ [agentPath]: content('base') }, [binding('one')])
  const change = create()
  const edited = changes.edit(change.id, {
    expectedRevision: change.snapshot.revision,
    files: { [agentPath]: null }, bindings: [binding('one', { side: 'ours' })],
  })
  await publish({ [agentPath]: content('theirs') }, [binding('one', { side: 'theirs' })])
  assert.throws(() => changes.rebase(change.id, edited.snapshot.revision), error => {
    assert(error instanceof AuthoringConflictError)
    assert.deepEqual(error.conflicts, [agentPath, 'bindings:["bot","qq","one"]'])
    return true
  })
  assert.deepEqual(changes.get(change.id), edited)
})

test('three-way rebase accepts identical concurrent edits and binding deletions', async t => {
  const { changes, create, publish } = fixture(t)
  await publish({ [agentPath]: content('base') }, [binding('one')])
  const change = create()
  const edited = changes.edit(change.id, {
    expectedRevision: change.snapshot.revision, files: { [agentPath]: content('same') }, bindings: [],
  })
  const current = await publish({ [agentPath]: content('same') })
  assert.deepEqual(changes.rebase(change.id, edited.snapshot.revision).snapshot, current)
})

test('evidence pins historical source revisions across edits, rebases and restarts', async t => {
  const { changes, create, publish, options } = fixture(t)
  const change = create()
  const first = changes.edit(change.id, { expectedRevision: change.snapshot.revision, files: { [agentPath]: 'first' } })
  const second = changes.edit(change.id, { expectedRevision: first.snapshot.revision, files: { [agentPath]: 'second' } })
  const stale = changes.recordRun(change.id, {
    revision: first.snapshot.revision, kind: 'preview', status: 'completed', result: { output: 'old' },
  })
  assert.notEqual(stale.revision, second.snapshot.revision)
  assert.equal(changes.runs(change.id).filter(run => run.revision === second.snapshot.revision).length, 0)
  const foreign = await publish({ [otherPath]: content('foreign revision') })
  assert.throws(() => changes.recordRun(change.id, {
    revision: foreign.revision, kind: 'validate', status: 'passed', result: {},
  }), /Unknown change revision/)
  const rebased = changes.rebase(change.id, second.snapshot.revision)
  assert.notEqual(rebased.snapshot.revision, second.snapshot.revision)
  const restarted = new AuthoringChanges(options)
  assert.deepEqual(restarted.run(change.id, stale.id), stale)
  assert(restarted.get(change.id).revisions.includes(first.snapshot.revision))
  assert.throws(() => restarted.recordRun(change.id, {
    revision: rebased.snapshot.revision, kind: 'probe', status: 'completed', result: 'x'.repeat(256 * 1024),
  }), /result exceeds size limit/)
  assert.equal(restarted.runs(change.id).length, 1)
})

test('closed changes permit member history access and late evidence but not file authorization or mutation', t => {
  const { changes, create, options } = fixture(t)
  const change = create()
  changes.delegate(change.id, { sessionId: 'editor', paths: ['skills/'] })
  changes.delegate(change.id, { sessionId: 'revoked', paths: [] })
  changes.revoke(change.id, 'revoked')
  const input = { revision: change.snapshot.revision, kind: 'test' as const, status: 'failed' as const, result: null }
  const run = changes.recordRun(change.id, input)
  const closed = changes.close(change.id, change.snapshot.revision)
  assert.equal(closed.closed, true)
  assert.deepEqual(changes.run(change.id, run.id), run)
  for (const operation of [
    () => changes.edit(change.id, { expectedRevision: change.snapshot.revision }),
    () => changes.rebase(change.id, change.snapshot.revision),
    () => changes.delegate(change.id, { sessionId: 'editor', paths: [] }),
    () => changes.revoke(change.id, 'editor'),
    () => changes.authorize(change.id, 'owner', agentPath),
    () => changes.authorize(change.id, 'editor', 'skills/catalog/tool.ts'),
  ]) assert.throws(operation, /closed/)
  changes.authorize(change.id, 'owner')
  changes.authorize(change.id, 'editor')
  assert.throws(() => changes.authorize(change.id, 'revoked'), /registered/)
  assert.throws(() => changes.authorize(change.id, 'stranger'), /registered/)
  const late = changes.recordRun(change.id, { ...input, result: { reason: 'Change closed during execution' } })
  const restarted = new AuthoringChanges(options)
  assert.equal(restarted.get(change.id).closed, true)
  restarted.authorize(change.id, 'owner')
  restarted.authorize(change.id, 'editor')
  assert.throws(() => restarted.authorize(change.id, 'revoked'), /registered/)
  assert.deepEqual(restarted.run(change.id, late.id), late)
  assert.throws(() => changes.recordRun(change.id, {
    ...input, revision: `sha256:${'0'.repeat(64)}`,
  }), /Unknown change revision/)
})

test('in-flight historical evidence survives revocation, later edits and closure', t => {
  const { changes, create, options } = fixture(t)
  const created = create()
  const delegated = changes.delegate(created.id, { sessionId: 'editor', paths: ['skills/'] })
  changes.authorize(created.id, 'editor')
  const admittedRevision = delegated.snapshot.revision
  const edited = changes.edit(created.id, {
    expectedRevision: admittedRevision, files: { [agentPath]: 'new candidate' },
  })
  changes.revoke(created.id, 'editor')
  changes.close(created.id, edited.snapshot.revision)
  assert.throws(() => changes.authorize(created.id, 'editor'), /registered/)
  const failed = changes.recordRun(created.id, {
    revision: admittedRevision, kind: 'probe', status: 'failed',
    result: { reason: 'Authorization changed while probe was executing' },
  })
  assert.notEqual(failed.revision, edited.snapshot.revision)
  assert.deepEqual(new AuthoringChanges(options).run(created.id, failed.id), failed)
})

test('disk CAS and persistent write failure never report in-memory success', t => {
  const { changes, create, options, directory } = fixture(t)
  const change = create()
  const stale = new AuthoringChanges(options)
  changes.delegate(change.id, { sessionId: 'editor', paths: ['skills/'] })
  assert.throws(() => stale.edit(change.id, {
    expectedRevision: change.snapshot.revision, files: { [agentPath]: 'must not persist' },
  }), /changed externally/)
  assert.deepEqual(stale.get(change.id), change)
  const before = changes.get(change.id)
  mkdirSync(join(directory, 'changes.json.lock'))
  assert.throws(() => changes.edit(change.id, {
    expectedRevision: before.snapshot.revision, files: { [agentPath]: 'write failure' },
  }), /storage boundary/)
  assert.deepEqual(changes.get(change.id), before)
  assert.deepEqual(new AuthoringChanges(options).get(change.id), before)
})

test('load rejects corrupted source hashes, unknown evidence revisions and duplicate editor identities', t => {
  const { changes, create, options, directory } = fixture(t)
  const change = create()
  changes.recordRun(change.id, { revision: change.snapshot.revision, kind: 'validate', status: 'passed', result: {} })
  const file = join(directory, 'changes.json')
  const original = readFileSync(file, 'utf8')
  for (const corrupt of [
    (value: any) => { value.changes[0].snapshot.bundle.files[agentPath] = 'forged' },
    (value: any) => { value.runs[0].revision = `sha256:${'0'.repeat(64)}` },
    (value: any) => { value.changes[0].editors = [{ sessionId: 'editor', paths: [] }, { sessionId: 'editor', paths: [] }] },
    (value: any) => { value.changes[0].revisions = [] },
  ]) {
    const envelope = JSON.parse(original)
    corrupt(envelope.value)
    writeFileSync(file, JSON.stringify(envelope))
    assert.throws(() => new AuthoringChanges(options))
  }
  writeFileSync(file, original)
  assert.deepEqual(new AuthoringChanges(options).list(), changes.list())
})

test('change storage rejects symlink directories rather than materializing external data', t => {
  const { options, directory } = fixture(t)
  const external = join(directory, 'external')
  const alias = join(directory, 'alias')
  mkdirSync(external)
  symlinkSync(external, alias, 'junction')
  assert.throws(() => new AuthoringChanges({ ...options, directory: alias }), /Symlink/)
  assert.equal(existsSync(join(external, 'changes.json')), false)
})

test('bounded changes, revision hashes and evidence fail explicitly without pruning saved history', t => {
  const { create, options, directory } = fixture(t)
  const change = create()
  const file = join(directory, 'changes.json')
  const original = JSON.parse(readFileSync(file, 'utf8'))
  const changesEnvelope = structuredClone(original)
  changesEnvelope.value.changes = Array.from({ length: 256 }, () => ({ ...change, id: randomUUID() }))
  writeFileSync(file, JSON.stringify(changesEnvelope))
  const fullChanges = new AuthoringChanges(options)
  assert.throws(() => fullChanges.create({ title: 'One too many', ownerSessionId: 'owner' }), /change limit/)
  assert.equal(fullChanges.list().length, 256)

  const revisionEnvelope = structuredClone(original)
  revisionEnvelope.value.changes[0].revisions = [
    change.snapshot.revision,
    ...Array.from({ length: 4095 }, (_, index) => `sha256:${index.toString(16).padStart(64, '0')}`),
  ]
  writeFileSync(file, JSON.stringify(revisionEnvelope))
  const fullRevisions = new AuthoringChanges(options)
  assert.throws(() => fullRevisions.edit(change.id, {
    expectedRevision: change.snapshot.revision, files: { [agentPath]: 'new source' },
  }), /revision history limit/)
  assert.equal(fullRevisions.get(change.id).revisions.length, 4096)

  const evidenceEnvelope = structuredClone(original)
  evidenceEnvelope.value.runs = Array.from({ length: 4096 }, () => ({
    id: randomUUID(), changeId: change.id, revision: change.snapshot.revision,
    createdAt: change.createdAt, kind: 'validate', status: 'passed', result: null,
  }))
  writeFileSync(file, JSON.stringify(evidenceEnvelope))
  const fullEvidence = new AuthoringChanges(options)
  assert.throws(() => fullEvidence.recordRun(change.id, {
    revision: change.snapshot.revision, kind: 'test', status: 'completed', result: {},
  }), /evidence limit/)
  assert.equal(fullEvidence.runs(change.id).length, 4096)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).value.runs.length, 4096)
})
