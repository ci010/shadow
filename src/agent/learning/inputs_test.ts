import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile, symlink } from 'node:fs/promises'
import { join } from 'node:path'
import { withTempWorkspace } from '../../testing/workspace.ts'
import { encapsulationInputs } from './inputs.ts'
import { LearningLedger } from './ledger.ts'

test('retained Wiki and external challenges are discoverable, revision-consumed, isolated and deduplicated', async () => withTempWorkspace(async workspace => {
  for (const dir of ['topics', 'events', 'sessions', 'identities']) await mkdir(join(workspace, 'memory', dir), { recursive: true })
  await writeFile(join(workspace, 'memory/topics/useful.md'), '# Useful\nExperimental diagnostic workflow with unresolved outcome.')
  for (const dir of ['sessions', 'identities']) await writeFile(join(workspace, `memory/${dir}/private.md`), 'Not pipeline input')
  await symlink(join(workspace, 'memory/identities/private.md'), join(workspace, 'memory/topics/alias.md'))
  const event = { id: 'outside', when: '2026-11-05', who: 'user', what: 'Expensive repeated challenge', challenge: 'Unresolved; try a bounded diagnostic', origin: 'web:source' }
  await writeFile(join(workspace, 'memory/events/day.jsonl'), JSON.stringify(event) + '\n')
  const signal = new AbortController().signal
  const retained = await encapsulationInputs(workspace, signal)
  assert.equal(retained.length, 2)
  assert(retained.some(input => input.id === 'outside' && input.challenge))
  const ledger = new LearningLedger(workspace, 'a')
  const selected = ledger.eventsFor('encapsulator', [...retained, ...retained])
  assert.equal(selected.length, 2)
  const batch = ledger.create('encapsulator', [], selected)
  ledger.bind(batch.id, 'cron:test')
  ledger.propose(batch.id, 'no_change', 'Reviewed narrow candidates; no extra container justified.')
  ledger.complete(batch.id)
  assert.deepEqual(new LearningLedger(workspace, 'a').eventsFor('encapsulator', retained), [])
  await writeFile(join(workspace, 'memory/topics/useful.md'), '# Useful\nCorrected diagnostic and counterexample.')
  assert.equal(ledger.eventsFor('encapsulator', await encapsulationInputs(workspace, signal)).length, 1)
}))

test('external scan cannot bypass unfinished reflector effect reservations', async () => withTempWorkspace(async workspace => {
  const ledger = new LearningLedger(workspace, 'a')
  const event = { id: 'unfinished', path: 'memory/events/day.jsonl', when: 'then', who: 'reflector', what: 'Retained effect', origin: 'web:source' }
  const batch = ledger.create('reflector', [], [])
  ledger.event(batch.id, event)
  assert.deepEqual(ledger.eventsFor('encapsulator', [event]), [])
}))
