import assert from 'node:assert/strict'
import test from 'node:test'
import { nextTick, watch } from 'vue'
import { createBotResources } from './bots.ts'
import { createCatalogResources } from './catalog.ts'
import type { LiveObserver } from '../live-client.ts'
import type { ProjectionPool } from '../live-projection.ts'

function projectionPool() {
  const observers = new Map<string, LiveObserver>()
  const pool: ProjectionPool = { client: () => ({ subscribe(topic, observer) {
    observers.set(topic.kind, observer)
    return { ready: async () => {}, refreshProjection: () => true, close() { observers.delete(topic.kind) } }
  } }) }
  return { pool, observers }
}

test('BOT lease watch receives initial and later snapshots and project revocation', async t => {
  const { pool, observers } = projectionPool()
  const resources = createBotResources(async () => { throw new Error('Unexpected HTTP fallback') })
  t.after(() => resources.dispose())
  const lease = resources.catalog('http://localhost', 'p', pool)
  const states: Array<typeof lease.state.value> = []
  const stop = watch(lease.state, state => states.push(state), { immediate: true })
  t.after(stop)
  const snapshot = (revision: string, platform: string) => observers.get('channels')!.projectionSnapshot!({
    event: 'snapshot', revision, data: { channels: [{ id: platform, projectId: 'p', platform, displayName: platform, enabled: true, configured: true, state: 'connected' }] },
  })
  snapshot('1', 'qq'); await nextTick(); await lease.read()
  assert.equal(states.length, 2)
  assert.equal(states.at(-1)!.value![0].platform, 'qq')
  snapshot('2', 'discord'); await nextTick()
  assert.equal(states.length, 3)
  assert.equal(states.at(-1)!.value![0].platform, 'discord')
  assert.equal(states[1].value![0].platform, 'qq', 'previous watcher snapshots stay immutable')
  observers.get('channels')!.reset!('project-removed'); await nextTick()
  assert.equal(states.length, 4)
  assert.equal(states.at(-1)!.status, 'forbidden')
  assert.equal(states.at(-1)!.value, undefined)
  lease.release()
  assert.equal(observers.size, 0)
})

test('public catalog lease watch receives the initial nodes projection', async t => {
  const { pool, observers } = projectionPool()
  const resources = createCatalogResources(async () => { throw new Error('Unexpected HTTP fallback') })
  t.after(() => resources.dispose())
  const lease = resources.nodes('http://localhost', 'p', pool)
  const states: Array<typeof lease.state.value> = []
  const stop = watch(lease.state, state => states.push(state), { immediate: true })
  t.after(stop)
  observers.get('nodes')!.projectionSnapshot!({ event: 'snapshot', revision: '1', data: { version: 1, nodes: [] } })
  await nextTick(); await lease.read()
  assert.equal(states.length, 2)
  assert.deepEqual(states.at(-1)!.value, { version: 1, nodes: [] })
  lease.release()
  assert.equal(observers.size, 0)
})
