import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { setImmediate } from 'node:timers/promises'
import { audioStatusResource } from './audio-status-resource.ts'
import { installFrontendNetworkLog } from './frontend-network-log.ts'
import { createProjectSettingsClient } from './project-settings.ts'
import { scopedModelCatalog } from './model-catalog.ts'
import { createLiveProjection } from './live-projection.ts'
import type { LiveObserver, LiveStatus } from './live-client.ts'
import type { RealtimeTopic } from '../../src/realtime/protocol.ts'

function harness(t: TestContext) {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const subscriptions = new Set<{ topic: RealtimeTopic; observer: LiveObserver }>()
  const statuses = new Set<(status: LiveStatus) => void>()
  let phase: LiveStatus['phase'] = 'live'
  const disposers = new Set<() => void>()
  const pool = {
    client: () => ({ subscribe(topic: RealtimeTopic, observer: LiveObserver) {
      const entry = { topic, observer }; subscriptions.add(entry)
      return { ready: async () => {}, close() { subscriptions.delete(entry) }, refreshProjection: () => phase === 'live' }
    } }),
    observeHost(_base: string, observer: (status: LiveStatus) => void) {
      statuses.add(observer); observer({ phase }); return () => { statuses.delete(observer) }
    },
    onDispose(dispose: () => void) { disposers.add(dispose); return () => { disposers.delete(dispose) } },
  }
  t.after(() => { for (const dispose of disposers) dispose() })
  return { pool, subscriptions, disposers, statuses,
    phase(next: LiveStatus['phase']) { phase = next; for (const callback of statuses) callback({ phase }) },
    async tick(ms: number, slices = 1) {
      await setImmediate()
      for (let i = 0; i < slices; i++) { t.mock.timers.tick(ms / slices); await setImmediate() }
    },
  }
}

const audio = (ready: boolean) => ({ asr: { ready, route: 'local' }, tts: { ready, route: 'local' } })
const config = (model: string) => ({ agent: { model, workspace: '/fixture', temperature: 0.4 } })

test('many Project switches and diagnostic toggles retain only one owner per endpoint and no inactive owners', async t => {
  const h = harness(t)
  const requests = new Map<string, number>()
  let model = 'initial', allowed = true, hold: (() => void) | undefined, waiting = false
  const transport: typeof fetch = async input => {
    const path = new URL(String(input)).pathname
    requests.set(path, (requests.get(path) ?? 0) + 1)
    if (!allowed) return new Response(null, { status: 403 })
    const value = path.endsWith('status') ? audio(true) : config(model)
    if (waiting && path.endsWith('config')) await new Promise<void>(resolve => { hold = resolve })
    return Response.json(value)
  }
  t.mock.method(globalThis, 'fetch', transport)
  for (let i = 0; i < 24; i++) {
    const projectId = `p-${i % 3}`
    const base = `https://lease.test/projects/${projectId}`
    const client = createProjectSettingsClient(base, globalThis.fetch, h.pool)
    const mic = audioStatusResource(h.pool, base)
    const catalog = scopedModelCatalog(base, h.pool)
    const fake = { fetch: globalThis.fetch, location: { href: base } } as Window & typeof globalThis
    const uninstall = installFrontendNetworkLog(fake, base, () => {})
    globalThis.fetch = fake.fetch
    const another = createProjectSettingsClient(base, globalThis.fetch, h.pool)
    const mic2 = audioStatusResource(h.pool, base)
    const catalog2 = scopedModelCatalog(base, h.pool)
    uninstall(); globalThis.fetch = fake.fetch
    assert.equal(h.subscriptions.size, 3, 'transparent diagnostics must not add owners')
    assert.ok([...h.subscriptions].every(({ topic }) => 'projectId' in topic && topic.projectId === projectId))
    const initial = Promise.all([client.load(), another.load(), mic.read(), mic2.read()])
    await h.tick(200, 10); await initial
    assert.equal(requests.get(`/projects/${projectId}/api/config`), Math.floor(i / 3) + 1)
    assert.equal(requests.get(`/projects/${projectId}/api/audio/status`), Math.floor(i / 3) + 1)
    another.release(); mic2.release(); catalog2.release()
    assert.equal(h.subscriptions.size, 3)
    client.release(); mic.release(); catalog.release()
    assert.equal(h.subscriptions.size, 0); assert.equal(h.statuses.size, 0); assert.equal(h.disposers.size, 0)
    const counts = [...requests]
    h.phase('reconnecting'); await h.tick(30_000); h.phase('live'); await h.tick(100)
    assert.deepEqual([...requests], counts, 'released owners neither poll nor recover')
  }
  const base = 'https://lease.test/projects/active'
  const custom: typeof fetch = async () => Response.json(config('isolated'))
  const client = createProjectSettingsClient(base, globalThis.fetch, h.pool)
  const injected = createProjectSettingsClient(base, custom, h.pool)
  let published: string | undefined
  const stop = client.subscribe(value => { published = value?.agent.model })!
  try {
    assert.equal(h.subscriptions.size, 2, 'distinct authority is not coalesced')
    const ready = Promise.all([client.load(), injected.load()]); await h.tick(250, 10)
    assert.deepEqual((await ready).map(value => value.agent.model), ['initial', 'isolated'])
    const [active] = [...h.subscriptions].map(entry => entry.observer)
    const count = () => requests.get('/projects/active/api/config')!
    for (let i = 0; i < 4; i++) {
      h.phase('reconnecting'); h.phase('live')
      const before = count()
      active.reset('epoch'); active.reconnected?.(); await h.tick(300, 10)
      active.reconnected?.(); active.reset('expired'); await h.tick(300, 10)
      assert.equal(count(), before + 1, 'one HTTP wave per recovery gap, not per callback')
    }
    waiting = true
    const before = count()
    const event = () => active.event({ type: 'event', topic: { kind: 'resources', projectId: 'active' }, cursor: 'fixture:1', payload: { event: 'invalidate', resource: 'config' } })
    event(); await h.tick(100, 5); assert.ok(hold)
    model = 'changed during GET'; event(); await h.tick(100, 5)
    waiting = false; hold!(); await h.tick(200, 10)
    assert.equal(count(), before + 2, 'a real reported change during a read gets its trailing read')
    assert.equal(published, model)
    active.reset('project-removed'); assert.equal(published, undefined)
    const revokedCount = count()
    await assert.rejects(client.load(), /unavailable/)
    await h.tick(100); assert.equal(count(), revokedCount)
    active.reset('project-restored'); await h.tick(200, 10); assert.equal(published, model)
    allowed = false; event(); await h.tick(200, 10); assert.equal(published, undefined, 'HTTP forbidden also clears state')
  } finally { stop(); client.release(); injected.release() }
})

test('cross-Project recovery is paced per Main; a pushed snapshot or revoke cancels queued GETs', async t => {
  const h = harness(t)
  const starts: number[] = []
  const running = new Set<number>()
  const end = new Map<number, () => void>()
  let peak = 0
  const owners = Array.from({ length: 10 }, (_, n) => createLiveProjection(h.pool, {
    base: `https://budget.test/projects/p-${n}`, topic: { kind: 'folders', projectId: `p-${n}` }, legacy: false, fallbackMs: 100,
    parse: value => value as number,
    load: signal => new Promise<number>((resolve, reject) => {
      starts.push(n); running.add(n); peak = Math.max(peak, running.size)
      const abort = () => { running.delete(n); reject(signal.reason) }
      signal.addEventListener('abort', abort, { once: true })
      end.set(n, () => { signal.removeEventListener('abort', abort); running.delete(n); resolve(n) })
    }),
  }))
  t.after(() => owners.forEach(owner => owner.dispose()))
  const observers = [...h.subscriptions].map(entry => entry.observer)
  const snapshot = (n: number) => observers[n].projectionSnapshot!({ event: 'snapshot', revision: 'fresh', data: n + 100 })
  owners.forEach((_, n) => snapshot(n))
  h.phase('reconnecting')
  await h.tick(110, 11); assert.deepEqual(starts, [0], 'do not release the entire wave in one timer tick')
  await h.tick(200, 20); assert.deepEqual(starts, [0, 1, 2, 3])
  h.phase('live')
  snapshot(4); observers[5].reset('project-removed')
  snapshot(0)
  await h.tick(100, 10)
  assert.deepEqual(starts, [0, 1, 2, 3, 6], 'removed and recovered projections never dispatch their queued GETs')
  for (const finish of end.values()) finish()
  await h.tick(300, 30)
  for (const finish of end.values()) finish()
  await h.tick(100, 10)
  assert.deepEqual(starts, [0, 1, 2, 3, 6, 7, 8, 9])
  assert.equal(peak, 4)
  assert.equal(owners[0].state.value, 100)
  assert.equal(owners[4].state.value, 104)
  assert.equal(owners[5].state.status, 'forbidden')
  assert.equal(owners[5].state.value, undefined)
})

test('real SSE removal clears only the deleted Project and healthy topics reconnect', { timeout: 5000 }, async () => {
  const { RealtimeHub } = await import('../../src/realtime/hub.ts')
  const { createLiveClient } = await import('./live-client.ts')
  const { createLiveClientPool } = await import('./stores/live.ts')
  const hub = new RealtimeHub()
  const a = hub.registerProject('a'), b = hub.registerProject('b')
  const connectStatuses: number[] = []
  const pool = createLiveClientPool((base, options) => createLiveClient(base, { ...options, diagnostic: () => {}, source(url) {
    const source = new EventTarget()
    const controller = new AbortController()
    const query = new URL(url).searchParams
    const response = hub.connect(JSON.parse(query.get('topics')!), controller.signal, query.get('cursor') ?? undefined)
    connectStatuses.push(response.status)
    if (response.ok) {
      const reader = response.body!.getReader(), decoder = new TextDecoder()
      void (async () => {
        try {
          while (!controller.signal.aborted) {
            const { value, done } = await reader.read()
            if (done) break
            const json = decoder.decode(value).split('\ndata: ')[1]?.trim()
            if (json) source.dispatchEvent(new MessageEvent('realtime', { data: json }))
          }
        } finally {
          if (!controller.signal.aborted) source.dispatchEvent(new Event('error'))
        }
      })()
    } else queueMicrotask(() => source.dispatchEvent(new Event('error')))
    return Object.assign(source, { close() { controller.abort() } })
  } }))
  const host = 'http://sse-removal.test'
  let currentB = 'b', readsA = 0
  const request: typeof fetch = async input => {
    const id = new URL(String(input)).pathname.split('/')[2]
    if (id === 'a') { readsA++; return Response.json(config('a')) }
    return Response.json(config(currentB))
  }
  const first = createProjectSettingsClient(`${host}/projects/a`, request, pool)
  const second = createProjectSettingsClient(`${host}/projects/b`, request, pool)
  const publishedB: Array<string | undefined> = []
  let publishedA: string | undefined
  first.subscribe(value => { publishedA = value?.agent.model })
  second.subscribe(value => { publishedB.push(value?.agent.model) })
  async function until(check: () => boolean) {
    for (let i = 0; i < 250; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)) }
    assert.fail('Timed out waiting for multiplexed SSE')
  }
  try {
    await Promise.all([first.load(), second.load()])
    assert.equal(publishedA, 'a'); assert.equal(publishedB.at(-1), 'b')
    a.close()
    await until(() => publishedA === undefined)
    assert.equal(publishedB.at(-1), 'b')
    await assert.rejects(first.load(), /unavailable/)
    await until(() => connectStatuses.length === 2 && pool.client(host).isLive())
    assert.deepEqual(connectStatuses, [200, 200], 'missing Project does not make healthy topic reconnect return 404')
    currentB = 'b updated'; b.invalidateResource!('config')
    await until(() => publishedB.at(-1) === 'b updated')
    assert.ok(publishedB.slice(1).every(Boolean), 'healthy Project never loses its cached state')
    assert.equal(readsA, 1, 'deleted Project does not poll after explicit revoke')
    let lateReads = 0
    const lateTransport: typeof fetch = async () => { lateReads++; return Response.json(config('must not fetch')) }
    const lateConfig = createProjectSettingsClient(`${host}/projects/a`, lateTransport, pool)
    const lateAudio = audioStatusResource(pool, `${host}/projects/a`, lateTransport)
    const lateProjection = createLiveProjection(pool, {
      base: `${host}/projects/a`, topic: { kind: 'folders', projectId: 'a' }, legacy: false, fallbackMs: 100,
      parse: value => value as number, load: async () => { lateReads++; return 0 },
    })
    try {
      await Promise.all([assert.rejects(lateConfig.load(), /unavailable/), assert.rejects(lateAudio.read(), /unavailable/), lateProjection.read()])
      assert.equal(lateProjection.state.status, 'forbidden')
      assert.equal(lateReads, 0, 'late config, audio and bootstrap projection owners inherit known denial')
      assert.deepEqual(connectStatuses, [200, 200], 'attaching known topics does not replace the connection')
    } finally { lateConfig.release(); lateAudio.release(); lateProjection.dispose() }
  } finally { first.release(); second.release(); pool.dispose(); hub.close() }
})

test('settings events and recovery fold into a GET that has not dispatched yet', async t => {
  const { budgetLiveHttp } = await import('./live-http-budget.ts')
  const h = harness(t)
  const base = 'https://settings-queue.test/projects/p'
  const release = Promise.withResolvers<void>()
  const requests = Array.from({ length: 4 }, () => budgetLiveHttp(base, new AbortController().signal, () => release.promise))
  t.after(() => release.resolve())
  await h.tick(200, 20)
  let reads = 0
  const model = 'latest'
  const settings = createProjectSettingsClient(base, async () => { reads++; return Response.json(config(model)) }, h.pool)
  t.after(settings.release)
  const initial = settings.load()
  await h.tick(100, 10)
  assert.equal(reads, 0, 'all four host slots are occupied')
  const observer = [...h.subscriptions][0].observer
  h.phase('reconnecting'); h.phase('live'); observer.reconnected?.()
  observer.event({ type: 'event', cursor: 'fixture:1', topic: { kind: 'resources', projectId: 'p' }, payload: { event: 'invalidate', resource: 'config' } })
  await h.tick(100, 10)
  release.resolve(); await Promise.all(requests); await h.tick(200, 20)
  assert.equal((await initial).agent.model, model)
  assert.equal(reads, 1, 'a read starting after the changes needs no redundant tail')
})

test('late owners inherit known denial throughout an SSE reconnect before new ready', async t => {
  const { createLiveClient } = await import('./live-client.ts')
  const { createLiveClientPool } = await import('./stores/live.ts')
  t.mock.timers.enable({ apis: ['setTimeout'] })
  class Source extends EventTarget {
    close() {}
    send(data: object) { this.dispatchEvent(new MessageEvent('realtime', { data: JSON.stringify({ cursor: 'fixture:1', ...data }) })) }
  }
  const sources: Source[] = []
  const pool = createLiveClientPool((base, options) => createLiveClient(base, { ...options, source() {
    const source = new Source(); sources.push(source); return source
  }, diagnostic: () => {} }))
  t.after(() => pool.dispose())
  const base = 'https://sticky-sse.test/projects/a'
  const initial = createProjectSettingsClient(base, async () => Response.json(config('original')), pool)
  const attempt = initial.load()
  t.mock.timers.tick(0)
  const old = sources[0]
  old.send({ type: 'ready' })
  async function time(ms: number, slices = 1) {
    for (let i = 0; i < slices; i++) { await setImmediate(); t.mock.timers.tick(ms / slices) }
    await setImmediate()
  }
  await time(150, 6); await attempt
  old.send({ type: 'reset', reason: 'project-removed' })
  old.send({ type: 'unavailable', topics: [{ kind: 'resources', projectId: 'a' }] })
  old.dispatchEvent(new Event('error'))
  await time(500)
  assert.equal(sources.length, 2, 'new wire connection does not have a ready frame or current unavailability yet')
  let lateReads = 0
  const transport: typeof fetch = async input => { lateReads++; return Response.json(String(input).endsWith('/status') ? audio(true) : config('restored')) }
  const lateConfig = createProjectSettingsClient(base, transport, pool)
  const lateAudio = audioStatusResource(pool, base, transport)
  const lateProjection = createLiveProjection(pool, {
    base, topic: { kind: 'folders', projectId: 'a' }, legacy: false, fallbackMs: 100,
    parse: value => value as number, load: async () => { lateReads++; return 42 },
  })
  t.after(() => { initial.release(); lateConfig.release(); lateAudio.release(); lateProjection.dispose() })
  const denied = Promise.all([assert.rejects(lateConfig.load(), /unavailable/), assert.rejects(lateAudio.read(), /unavailable/), lateProjection.read()])
  await time(1500, 15); await denied
  assert.equal(lateProjection.state.status, 'forbidden')
  assert.equal(lateReads, 0, 'old denial prevents fallback during the new readiness gap')
  sources[1].send({ type: 'ready' }) // same mapped resources scope is now confirmed available
  await time(350, 14)
  assert.equal((await lateConfig.load()).agent.model, 'restored')
  assert.equal((await lateAudio.read()).asr.ready, true)
  assert.equal(lateProjection.state.value, 42)
  assert.equal(lateReads, 3)
})
