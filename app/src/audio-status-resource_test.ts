import test from 'node:test'
import assert from 'node:assert/strict'
import { audioStatusResource } from './audio-status-resource.ts'
import { configResource } from './settings-resource.ts'
import type { ResourceLivePool } from './live-resource-refresh.ts'
import type { LiveObserver } from './live-client.ts'

test('audio capability snapshots are pool/Project scoped and refreshed on explicit setup, config and recovery', async t => {
  const observers: LiveObserver[] = [], disposers: Array<() => void> = []
  const pool: ResourceLivePool = {
    client: () => ({ subscribe(_topic, observer) {
      observers.push(observer)
      return { ready: async () => {}, close() {} }
    } }),
    observeHost: (_base, observer) => { observer({ phase: 'live' }); return () => {} },
    onDispose: callback => { disposers.push(callback); return () => {} },
  }
  t.after(() => disposers.forEach(dispose => dispose()))
  let calls = 0, ready = true
  const request: typeof fetch = async () => {
    calls++
    return Response.json({ asr: { ready, route: 'local' }, tts: { ready: true, route: 'local' } })
  }
  const base = 'http://fixture/projects/a'
  const read = () => audioStatusResource(pool, base, request).read()
  await Promise.all([read(), read()])
  assert.equal(calls, 1)
  assert.equal((await read()).asr.ready, true)
  assert.equal(calls, 1, 'recreating a view does not recreate its capability read')
  ready = false
  assert.equal((await audioStatusResource(pool, base, request).read(undefined, true)).asr.ready, false)
  assert.equal(calls, 2)
  ready = true
  observers[0].event({ type: 'event', cursor: 'fixture:1', topic: { kind: 'resources', projectId: 'a' }, payload: { event: 'invalidate', resource: 'config' } })
  await new Promise(resolve => setTimeout(resolve, 70))
  assert.equal((await read()).asr.ready, true)
  assert.equal(calls, 3)
  observers[0].reconnected()
  await new Promise(resolve => setTimeout(resolve, 70))
  await read()
  assert.equal(calls, 4)
  await audioStatusResource(pool, 'http://fixture/projects/b', request).read()
  assert.equal(calls, 5)
  const config = configResource(pool, base, request, async () => ({ agent: { model: 'fixture' } }))
  assert.deepEqual(await config.read(), { agent: { model: 'fixture' } }, 'config and audio never share a snapshot slot')
})
