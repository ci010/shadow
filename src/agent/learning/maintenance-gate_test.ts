import assert from 'node:assert/strict'
import { test } from 'node:test'
import { randomUUID } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { withTempWorkspace } from '../../testing/workspace.ts'
import { projectStoragePath } from '../../utils/data-paths.ts'
import { SkillsManager } from '../../skills/loader.ts'
import { SkillEditStore } from '../../skills/edit-store.ts'
import { KnowledgeService } from '../../knowledge/service.ts'
import { checksum } from './maintenance-contracts.ts'
import { MaintenanceGate } from './maintenance-gate.ts'

const operation = () => ({ id: randomUUID(), revision: checksum('synthetic-plan') })
test('persistent operation fence rejects in-flight writers, survives reconstruction, and does not clear on status', async () => withTempWorkspace(async home => {
  const gate = new MaintenanceGate(home), op = operation()
  let release!: () => void, entered!: () => void
  const started = new Promise<void>(resolve => { entered = resolve })
  const waiting = new Promise<void>(resolve => { release = resolve })
  const write = gate.write(['memory/topics/example.md'], async () => { entered(); await waiting })
  await started
  assert.throws(() => new MaintenanceGate(home).reserve(op), /In-flight/)
  assert.equal(new MaintenanceGate(home).status().writers.length, 1)
  release(); await write
  gate.reserve(op)
  assert.equal(new MaintenanceGate(home).status().operation?.id, op.id)
  await assert.rejects(() => new MaintenanceGate(home).write([], () => undefined), /fence active/)
  assert.throws(() => gate.reserve(operation()), /identity/)
  gate.reserve(op) // explicit exact resumption
  await gate.operation(op, () => gate.transition(op, 'blocked'))
  await assert.rejects(() => new MaintenanceGate(home).operation(op, () => gate.transition(op, 'mutating')), /Blocked/)
  assert.equal(new MaintenanceGate(home).status().operation?.phase, 'blocked')
}))

test('formal Skill save and Knowledge delete share fence; host operation scope does not leak', async () => withTempWorkspace(async home => {
  const skills = new SkillsManager(home), store = new SkillEditStore(home, skills)
  const gate = new MaintenanceGate(home), op = operation()
  const file = projectStoragePath(home, 'memory/topics/example.md')
  mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, 'original')
  gate.reserve(op, ['memory/topics/example.md', 'skills/example/SKILL.md'])
  const text = '---\nname: example\ndescription: Synthetic fence test\n---\nExample\n'
  await assert.rejects(store.save('example', { 'SKILL.md': text }, null), /fence active/)
  assert.throws(() => new KnowledgeService(home, skills).delete('memory/topics/example.md', checksum('original')), /fence active/)
  const saved = await gate.operation(op, () => store.save('example', { 'SKILL.md': text }, null))
  await assert.rejects(store.save('example', { 'SKILL.md': text }, saved.revision), /fence active/)
  await gate.operation(op, () => gate.transition(op, 'committed', ['memory/topics/example.md', 'skills/example/SKILL.md']))
  await assert.rejects(store.save('example', { 'SKILL.md': text }, saved.revision), /Retired/)
  assert.throws(() => new KnowledgeService(home, skills).delete('memory/topics/example.md', checksum('original')), /Retired/)
  assert.equal(new MaintenanceGate(home).isRetired('memory/topics/example.md'), true)
}))


test('orphaned cross-process writer is durable evidence, not an expiring or deleted lock', async () => withTempWorkspace(async home => {
  const { spawnSync } = await import('node:child_process')
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { MaintenanceGate } from './src/agent/learning/maintenance-gate.ts'
    await new MaintenanceGate(${JSON.stringify(home)}).write([], () => process.exit(0))
  `], { encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  const gate = new MaintenanceGate(home), before = gate.status()
  assert.equal(before.writers.length, 1)
  assert.throws(() => gate.reserve(operation()), /In-flight/)
  assert.deepEqual(new MaintenanceGate(home).status(), before)
}))

test('detached continuations cannot reuse an already released async writer admission', async () => withTempWorkspace(async home => {
  const gate = new MaintenanceGate(home)
  let release!: () => void, pending!: Promise<void>
  const later = new Promise<void>(resolve => { release = resolve })
  await gate.write([], () => {
    pending = later.then(() => gate.write([], () => { throw new Error('must never enter writer') }))
  })
  release()
  await assert.rejects(pending, /Expired writer admission/)
  assert.deepEqual(gate.status().writers, [])
}))


test('all ordinary Wiki writers hold a shared cross-process path reservation through CAS publication', async () => withTempWorkspace(async home => {
  const { spawnSync } = await import('node:child_process')
  const { WikiDocumentStore } = await import('../../knowledge/document-store.ts')
  const path = 'memory/topics/example.md', file = projectStoragePath(home, path)
  mkdirSync(dirname(file), { recursive: true }); writeFileSync(file, 'original')
  await new MaintenanceGate(home).write([path], () => {
    const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { WikiDocumentStore } from './src/knowledge/document-store.ts'
      try {
        new WikiDocumentStore(${JSON.stringify(home)}).replace(${JSON.stringify(path)}, ${JSON.stringify(checksum('original'))}, Buffer.from('competing version'))
        process.exit(2)
      } catch (error) {
        console.log(error.message)
        process.exit(error.message.includes('path is busy') ? 0 : 3)
      }
    `], { encoding: 'utf8' })
    assert.equal(child.status, 0, child.stderr + child.stdout)
    assert.match(child.stdout, /path is busy/)
    assert.equal(new WikiDocumentStore(home).replace(path, checksum('original'), Buffer.from('first owner')), checksum('first owner'))
  })
  assert.throws(() => new WikiDocumentStore(home).replace(path, checksum('original'), Buffer.from('stale version')), /exact-CAS conflict/)
}))

test('explicit dead-owner execution recovery retains abandoned generation/direction evidence', async () => withTempWorkspace(async home => {
  const { spawnSync } = await import('node:child_process'), op = operation()
  const child = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
    import { MaintenanceGate } from './src/agent/learning/maintenance-gate.ts'
    const gate = new MaintenanceGate(${JSON.stringify(home)})
    const op = ${JSON.stringify(op)}
    gate.reserve(op)
    await gate.operation(op, () => process.exit(0), 'commit')
  `], { encoding: 'utf8' })
  assert.equal(child.status, 0, child.stderr)
  const gate = new MaintenanceGate(home), crashed = gate.status().runner
  assert.ok(crashed)
  assert.deepEqual(new MaintenanceGate(home).status().runner, crashed)
  await assert.rejects(() => gate.operation(op, () => undefined, 'commit'), /already owned/)
  await gate.operation(op, () => undefined, 'commit', true)
  assert.equal(gate.status().runner, null)
  assert.deepEqual(gate.status().abandonedExecutions, [crashed])
}))


test('automatic/manual/recovery/bind/correction entrypoints preserve old learning evidence under a fence', async () => withTempWorkspace(async home => {
  const { fakeSessions } = await import('./test-fixtures.ts')
  const { LearningRuntime } = await import('./pipelines.ts')
  const skills = new SkillsManager(home), store = new SkillEditStore(home, skills)
  const saved = await store.save('example', { 'SKILL.md': '---\nname: example\ndescription: Synthetic\n---\nEvidence\n' }, null)
  const f = fakeSessions(home, []), runtime = new LearningRuntime(f.sessions, 'a', skills)
  const batch = runtime.ledger.create('encapsulator', [], [{ id: 'synthetic-evidence', path: 'memory/events/2026-11-17.jsonl', origin: 'web:original',
    when: '2026-11-17T00:00:00.000Z', who: 'synthetic', what: 'Original evidence', refs: ['v:memory/topics/original.md'] }])
  runtime.ledger.propose(batch.id, 'blocked', 'Original failed correction evidence')
  for (let index = 0; index < 3; index++) runtime.ledger.defer(batch.id, false)
  const before = runtime.ledger.batch(batch.id), gate = new MaintenanceGate(home)
  gate.reserve(operation())
  for (const manual of [true, false]) await assert.rejects(() => runtime.run('encapsulator', new AbortController().signal, undefined, undefined, undefined, manual), /fence active/)
  await runtime.recover() // Startup may inspect, but cannot repair/acknowledge old work.
  assert.throws(() => runtime.ledger.bind(batch.id, 'cron:old-attempt'), /fence active/)
  assert.throws(() => runtime.queueCorrection({ batchId: batch.id, target: 'example', revision: saved.revision,
    correction: 'Synthetic unsaved correction', evidence: ['v:memory/topics/original.md'], changed: 'Host reviewed synthetic evidence' }), /fence active/)
  assert.deepEqual(runtime.ledger.batch(batch.id), before)
  assert.deepEqual(f.started, [])
}))
