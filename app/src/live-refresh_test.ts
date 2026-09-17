import assert from 'node:assert/strict'
import test from 'node:test'
import { createLiveRefresh } from './live-refresh.ts'

const flush = () => new Promise<void>(resolve => setImmediate(resolve))

test('live invalidations batch bursts and serialize snapshots with one follow-up', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let reads = 0
  let finish: ((value: number) => void) | undefined
  const values: number[] = []
  const refresh = createLiveRefresh({
    load: () => { reads++; return new Promise<number>(resolve => { finish = resolve }) },
    apply: value => values.push(value),
    onError: error => { throw error },
  })
  t.after(() => refresh.dispose())
  for (let i = 0; i < 100; i++) refresh.refresh()
  t.mock.timers.tick(50)
  assert.equal(reads, 1)
  for (let i = 0; i < 100; i++) refresh.refresh()
  t.mock.timers.tick(1000)
  assert.equal(reads, 1, 'never overlap snapshot requests')
  finish!(1)
  await flush()
  t.mock.timers.tick(50)
  assert.equal(reads, 2, 'changes during a read trigger one fresh snapshot')
  finish!(2)
  await flush()
  assert.deepEqual(values, [1, 2])
  t.mock.timers.tick(1000)
  assert.equal(reads, 2)
})

test('disposal aborts reads and prevents late snapshots from crossing resource lifetimes', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let signal: AbortSignal | undefined
  let finish: ((value: string) => void) | undefined
  const values: string[] = []
  const errors: unknown[] = []
  const refresh = createLiveRefresh({
    load: current => { signal = current; return new Promise<string>(resolve => { finish = resolve }) },
    apply: value => values.push(value), onError: error => errors.push(error),
  })
  refresh.refresh()
  t.mock.timers.tick(50)
  refresh.refresh()
  refresh.dispose()
  assert.equal(signal!.aborted, true)
  finish!('old project')
  await flush()
  t.mock.timers.tick(1000)
  assert.deepEqual(values, [])
  assert.deepEqual(errors, [])
})

test('snapshot failures are explicit and a subsequent invalidation can retry', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let reads = 0
  const values: number[] = []
  const errors: unknown[] = []
  const failure = new Error('Synthetic unavailable snapshot')
  const refresh = createLiveRefresh({
    load: async () => { if (++reads === 1) throw failure; return reads },
    apply: value => values.push(value), onError: error => errors.push(error),
  })
  t.after(() => refresh.dispose())
  refresh.refresh()
  t.mock.timers.tick(50)
  await flush()
  assert.deepEqual(errors, [failure])
  refresh.refresh()
  t.mock.timers.tick(50)
  await flush()
  assert.deepEqual(values, [2])
})
