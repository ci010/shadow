import assert from 'node:assert/strict'
import { test } from 'node:test'
import { installFrontendLog, summarizeFrontendArgs } from './frontend-log.ts'

test('bounded safe summaries omit secrets, URLs, accessors and cycles', () => {
  const obj: Record<string, unknown> = { token: 'fixture-secret', nested: {} }
  obj.self = obj
  Object.defineProperty(obj, 'getter', { enumerable: true, get() { throw Error('must not run') } })
  const result = summarizeFrontendArgs([obj, new Error('failure at https://example.test/?token=abc'), 'password=fixture-secret'])
  assert.doesNotMatch(result, /fixture-secret|example.test/)
  assert.match(result, /circular/)
  assert.match(result, /accessor/)
  assert.ok(summarizeFrontendArgs(['x'.repeat(10_000)]).length <= 4096)
  assert.doesNotThrow(() => summarizeFrontendArgs([new Proxy({}, { ownKeys() { throw Error('proxy') } }), 2n]))
})

test('console behavior, bounded queue, silent transport, no recursion and disposal', async () => {
  const events = new EventTarget()
  let tick: () => void = () => {}
  let calls = 0
  const logger = Object.fromEntries(['log', 'info', 'warn', 'error'].map(level => [level, function(this: unknown, ..._args: unknown[]) { assert.equal(this, logger); calls++; return 'original' }]))
  const original = logger.log
  const target = { console: logger, addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
    setInterval(fn: () => void) { tick = fn; return 1 }, clearInterval() {} } as unknown as Window & { console: Console }
  const batches: unknown[][] = []
  const stop = installFrontendLog(target, async batch => { batches.push(batch); logger.warn!('transport console'); throw Error('offline') })
  assert.equal(logger.log!('ordinary'), 'original')
  for (let i = 0; i < 50; i++) logger.info!('burst')
  tick(); await new Promise(resolve => setImmediate(resolve))
  assert.equal(batches.length, 1); assert.equal(batches[0]!.length, 20)
  tick(); await new Promise(resolve => setImmediate(resolve)); assert.equal(batches.length, 1)
  events.dispatchEvent(Object.assign(new Event('error'), { error: new Error('window failure') }))
  events.dispatchEvent(Object.assign(new Event('unhandledrejection'), { reason: 'rejection' }))
  tick(); await new Promise(resolve => setImmediate(resolve)); assert.equal(batches[1]!.length, 2)
  stop(); stop(); assert.equal(logger.log, original)
  events.dispatchEvent(Object.assign(new Event('error'), { message: 'after stop' }))
  tick(); await new Promise(resolve => setImmediate(resolve)); assert.equal(batches.length, 2)
  assert.equal(calls, 53)
})
