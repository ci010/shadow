import assert from 'node:assert/strict'
import { test } from 'node:test'
import { existsSync } from 'node:fs'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withTempWorkspace } from '../../testing/workspace.ts'
import { projectStoragePath } from '../../utils/data-paths.ts'
import { digest } from './contracts.ts'
import { collectionInput, definitionInput, providerStatePath, stateInput } from './legacy-compat.ts'
import { SignalProviderRuntime } from './runtime.ts'

test('legacy state retains subscriptions, checkpoint/baseline, pending drafts and old producer/processor code across restart', async () => withTempWorkspace(async workspace => {
  const path = projectStoragePath(workspace, '.events', 'providers-v1.json')
  const demand = { tag: 'fixture' }, key = digest(['feed', demand])
  const code = 'export function run({demands}) { const result={}; for(const d of demands) result[d.key]={events:[{id:"before",data:{title:"baseline"}}],checkpoint:d.checkpoint}; return result }'
  const old = { format: 1, definitions: [{ id: 'legacy-feed', version: 1, description: 'fixture', code,
    http: { origin: 'https://example.org', routes: [{ method: 'GET', path: '/feed' }] },
    demandSchema: { type: 'object' }, eventSchema: { type: 'object' }, examples: [{ demand, event: { id: 'before', data: { title: 'baseline' } } }] }],
    instances: [{ id: 'feed', owner: 'owner', provider: 'legacy-feed', version: 1, origin: 'https://example.org', enabled: true, nextAt: 0 }],
    subscriptions: [{ id: 'reader', instance: 'feed', owner: 'owner', demand, processor: 'export function run({event}) { return [{content:event.data.title}] }' }],
    demands: { [key]: { mode: 'snapshot', checkpoint: { cursor: 9 }, seen: ['before'], baseline: true } },
    jobs: [
      { id: 'draft-job', subscription: 'reader', event: { id: 'queued', data: {} }, attempts: 2, nextAt: 0, drafts: [{ content: 'already accepted' }, { content: 'remaining draft' }], delivered: 1, timestamp: '2026-01-01T00:00:00Z' },
      { id: 'processor-job', subscription: 'reader', event: { id: 'unprocessed', data: { title: 'legacy processor' } }, attempts: 1, nextAt: 0, delivered: 0, timestamp: '2026-01-01T00:00:00Z' },
    ] }
  await mkdir(dirname(path), { recursive: true }); await writeFile(path, JSON.stringify(old))
  const received: string[] = []
  const make = () => new SignalProviderRuntime(workspace, { execute: async () => { throw Error('No external IO expected') } }, async (id, input) => {
    received.push(input.kind === 'message' ? input.content ?? '' : ''); return { status: 'accepted', sessionId: id, inputId: input.id }
  }, id => id === 'owner', () => false)
  let runtime = make()
  try {
    runtime.start()
    assert.equal(runtime.snapshot('owner').pending.length, 2)
    assert.equal(runtime.snapshot('owner').providers.find(p => p.id === 'legacy-feed')!.code, code)
    await runtime.run()
    assert.deepEqual(received, ['remaining draft', 'legacy processor'])
    await runtime.stop()
    const stored = JSON.parse(await readFile(path, 'utf8'))
    assert.equal(stored.format, 2)
    assert.equal(typeof stored.legacyRevisions['legacy-feed:1'], 'string')
    assert.deepEqual(stored.demands[key], old.demands[key])
    assert.equal(stored.subscriptions[0].processor, old.subscriptions[0].processor)
    assert.equal(stored.definitions[0].code, code)
    assert.deepEqual(stored.jobs, [])
    assert.equal(existsSync(projectStoragePath(workspace, '.signals', 'providers-v2.json')), false)
    runtime = make(); runtime.start(); await runtime.run()
    assert.deepEqual(received, ['remaining draft', 'legacy processor'], 'silent baseline survives new-format restart without replay')
  } finally { await runtime.stop() }
}))

test('compatibility rejects ambiguous schemas/collections/jobs and never silently picks between two states', async () => withTempWorkspace(async workspace => {
  assert.deepEqual(collectionInput({ mode: 'delta', events: [], checkpoint: 3 }), { mode: 'delta', signals: [], checkpoint: 3 })
  assert.throws(() => collectionInput({ events: [], signals: [] }), /Ambiguous/)
  assert.throws(() => definitionInput({ eventSchema: {}, signalSchema: {} }), /Ambiguous/)
  assert.throws(() => definitionInput({ examples: [{ event: {}, signal: {} }] }), /Ambiguous/)
  assert.throws(() => stateInput({ format: 1, jobs: [{ event: {}, signal: {} }] }), /Ambiguous/)
  assert.equal(providerStatePath(workspace), projectStoragePath(workspace, '.signals', 'providers-v2.json'))
  for (const path of [projectStoragePath(workspace, '.events', 'providers-v1.json'), projectStoragePath(workspace, '.signals', 'providers-v2.json')]) {
    await mkdir(dirname(path), { recursive: true }); await writeFile(path, '{}')
  }
  assert.throws(() => providerStatePath(workspace), /Both signal and legacy/)
}))
