import { test } from 'node:test'
import assert from 'node:assert/strict'
import { setTimeout as delay } from 'node:timers/promises'
import { InputProcessor, InputProcessorSchema } from './input-processor.ts'

test('restricted input processing rejects imports, malformed output and infinite execution without fallback wake', async t => {
  const processor = new InputProcessor<string>()
  t.after(() => processor.stop())
  const published: string[][] = []
  const input = (code: string, id: string) => processor.accept({ key: 'authority', id,
    event: { content: 'fixture' }, item: id, policy: { code, delayMs: 50 },
    signal: new AbortController().signal, publish: async items => { published.push(items) },
  })
  await assert.rejects(input(`import fs from 'node:fs'; export function run() { return {action:'emit'} }`, 'import'))
  await assert.rejects(input(`export function run() { return {action:'unknown'} }`, 'invalid'))
  await assert.rejects(input(`export function run() { while(true) {} }`, 'timeout'))
  assert.equal(published.length, 0)
  await input(`export function run() { return {action:'emit'} }`, 'valid')
  assert.deepEqual(published, [['valid']], 'a failed program cannot poison the serialization queue')
})

test('stop discards volatile pending buffers and stops scheduled publications', async () => {
  const processor = new InputProcessor<string>()
  let calls = 0
  await processor.accept({ key: 'one', id: 'one', event: {}, item: 'one',
    policy: { code: `export function run() { return {action:'buffer'} }`, delayMs: 50 },
    publish: async () => { calls++ }, signal: new AbortController().signal,
  })
  await processor.stop()
  await delay(100)
  assert.equal(calls, 0)
  assert.equal(InputProcessorSchema.safeParse({ code: 'code', delayMs: 60_001 }).success, false)
})


test('same-partition burst is queued within capacity and fixed-window delivery runs independently', async t => {
  const processor = new InputProcessor<string>(() => {}, 4)
  t.after(() => processor.stop())
  const base = { key: 'one', event: {}, signal: new AbortController().signal,
    publish: async (_items: string[]) => {}, policy: { code: `export function run() { return {action:'buffer'} }`, delayMs: 100 } }
  let flushed = false
  await processor.accept({ ...base, id: 'buffer', item: 'buffer', publish: async () => { flushed = true } })
  const slow = processor.accept({ ...base, id: 'slow', item: 'slow',
    policy: { ...base.policy, code: `export function run() { while(true) {} }` } })
  const failed = assert.rejects(slow)
  const queued = ['a', 'b'].map(id => processor.accept({ ...base, id, item: id }))
  const start = Date.now()
  await assert.rejects(processor.accept({ ...base, id: 'overflow', item: 'overflow' }), /capacity/)
  assert(Date.now() - start < 500, 'overflow is rejected before retaining payload')
  await delay(250)
  assert.equal(flushed, true, 'batch window is independent of the classifier lane')
  await failed
  await Promise.all(queued)
})

test('global outstanding capacity is enforced before retaining another authority partition', async t => {
  const processor = new InputProcessor<string>(() => {}, 2)
  t.after(() => processor.stop())
  const release = Promise.withResolvers<void>()
  const entered = Promise.withResolvers<void>()
  let count = 0
  const request = (key: string) => processor.accept({ key, id: key, item: key, event: {},
    policy: { code: `export function run() { return {action:'emit'} }`, delayMs: 100 },
    signal: new AbortController().signal,
    publish: async () => { if (++count === 2) entered.resolve(); await release.promise },
  })
  const first = request('first'), second = request('second')
  try {
    await entered.promise
    await assert.rejects(request('third'), /capacity/)
  } finally { release.resolve(); await Promise.all([first, second]) }
})

test('durable buffered inbox recovers with fresh host authority and deduplicates accepted IDs', async () => {
  const {mkdtemp, rm, readFile} = await import('node:fs/promises')
  const {tmpdir} = await import('node:os')
  const path = await import('node:path')
  const root = await mkdtemp(path.join(tmpdir(), 'processor-inbox-'))
  const journalPath = path.join(root, 'inbox.json')
  const delivered = Promise.withResolvers<void>()
  let calls = 0, recoveries = 0
  const base = {key:'authority', id:'message', event:{}, item:'message',
    policy:{code:`export function run(){return {action:'buffer'}}`, delayMs:100},
    signal:new AbortController().signal, publish:async () => {calls++}}
  const first = new InputProcessor<string>(() => {}, 100, undefined, {journalPath, recover:() => undefined})
  let second: InputProcessor<string> | undefined
  try {
    await first.accept(base)
    await first.stop()
    assert.equal(calls, 0)
    assert.equal(JSON.parse(await readFile(journalPath, 'utf8')).rows.length, 1)
    second = new InputProcessor<string>(() => {}, 100, undefined, {journalPath, recover:row => {
      recoveries++
      assert.equal(row.id, 'message')
      return {signal:new AbortController().signal, publish:async items => {
        assert.deepEqual(items, ['message']); calls++; delivered.resolve()
      }}
    }})
    await Promise.race([delivered.promise, delay(3000).then(() => {throw new Error('Recovery did not deliver')})])
    // The publish callback signals before the processor journals its acknowledgement.
    await delay(0)
    await second.stop()
    assert.equal(recoveries, 1)
    assert.equal(calls, 1)
    assert.equal(JSON.parse(await readFile(journalPath, 'utf8')).rows.length, 0)
    second = new InputProcessor<string>(() => {}, 100, undefined, {journalPath, recover:() => {throw new Error('No completed row should recover')}})
    await second.accept(base)
    assert.equal(calls, 1, 'persisted dedupe survives restart')
  } finally { await first.stop(); await second?.stop(); await rm(root, {recursive:true,force:true}) }
})

test('publication retry uses bounded attempts without reclassifying or duplicate successful delivery', async t => {
  let now = 0
  const timers = new Map<object, () => void>()
  const clock = {now:() => now, setTimeout:(callback:() => void, _delay:number) => {
    const timer = {unref() {}}; timers.set(timer, callback); return timer
  }, clearTimeout:(timer:object) => {timers.delete(timer)}}
  let attempts = 0
  const delivered = Promise.withResolvers<void>()
  const processor = new InputProcessor<string>(() => {}, 100, clock)
  t.after(() => processor.stop())
  const input = {key:'a', id:'1', item:'1', event:{}, signal:new AbortController().signal,
    policy:{code:`export function run(){return {action:'emit'}}`, delayMs:100},
    publish:async () => {if (++attempts === 1) throw new Error('transient'); delivered.resolve()}}
  await assert.rejects(processor.accept(input), /transient/)
  await delay(0)
  now = 1000
  for (const callback of [...timers.values()]) callback()
  await delivered.promise
  await delay(0)
  await processor.accept(input)
  assert.equal(attempts, 2)
})
