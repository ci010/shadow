import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ProviderHttpError, ProviderTransportError } from './provider.ts'
import { providerRetryScope, retryAfterMs, withProviderRetry, withRateLimitWaiting, type RateLimitWait } from './retry.ts'
import { openaiChat } from './openai-compatible.ts'

const rejected = (retryAfter?: string, code?: string) => new ProviderHttpError(429, 'private upstream body', code, { rejectedRequest: true, retryAfter })
function clock() {
  let now = 1_000_000
  const waits: number[] = []
  return { waits, clock: () => now, random: () => 0.5, sleep: async (ms: number) => { waits.push(ms); now += ms } }
}
test('Retry-After parses seconds and HTTP-date; malformed headers fall back', () => {
  assert.equal(retryAfterMs('2'), 2000)
  assert.equal(retryAfterMs('0.5'), 500)
  assert.equal(retryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('2015-10-21T07:27:55Z')), 5000)
  assert.equal(retryAfterMs('Wed, 21 Oct 2015 07:28:00 GMT', Date.parse('2015-10-22T00:00:00Z')), 0)
  assert.equal(retryAfterMs('Wednesday, 21-Oct-15 07:28:00 GMT', Date.parse('2015-10-21T07:27:55Z')), 5000)
  assert.equal(retryAfterMs('Wed Oct 21 07:28:00 2015', Date.parse('2015-10-21T07:27:55Z')), 5000)
  for (const value of ['', '-1', 'tomorrow', '2026-01-01', 'Infinity']) assert.equal(retryAfterMs(value), undefined)
})
test('429 waits exactly server delay, emits safe status and clears it', async () => {
  const c = clock(); let calls = 0
  const states: Array<RateLimitWait | undefined> = []
  const result = await withRateLimitWaiting(state => states.push(state), () => withProviderRetry(async () => {
    if (++calls === 1) throw rejected('3')
    return 'ok'
  }, undefined, { ...c, provider: 'agnes', model: 'test' }))
  assert.equal(result, 'ok'); assert.deepEqual(c.waits, [3000]); assert.equal(calls, 2)
  assert.deepEqual(states[0], { status: 429, delayMs: 3000, attempt: 2, retryAt: 1003000, provider: 'agnes', model: 'test' })
  assert.equal(states[1], undefined)
  assert.ok(!JSON.stringify(states).includes('private'))
})
test('blank-code rate limits use bounded jitter/backoff; attempts never exceed six', async () => {
  const c = clock(); let calls = 0
  const error = rejected(undefined, '')
  await assert.rejects(withProviderRetry(async () => { calls++; throw error }, undefined, c), e => e === error)
  assert.equal(calls, 6); assert.deepEqual(c.waits, [2000, 4000, 8000, 16000, 30000])
})
test('total wait budget never truncates Retry-After or permits premature retry', async () => {
  const c = clock(); let calls = 0
  await assert.rejects(withProviderRetry(async () => { calls++; throw rejected('70') }, undefined, c))
  assert.equal(calls, 2); assert.deepEqual(c.waits, [70000])
  const d = clock(); calls = 0
  await assert.rejects(withProviderRetry(async () => { calls++; throw rejected('121') }, undefined, d))
  assert.equal(calls, 1); assert.deepEqual(d.waits, [])
})
test('quota, non-429 HTTP, uncertain transport and non-rejected stream errors never replay', async () => {
  for (const error of [rejected('0', 'insufficient_quota'), rejected('0', 'billing_hard_limit_reached'),
    new ProviderHttpError(429, 'stream error'), new ProviderHttpError(503, 'error', undefined, { rejectedRequest: true }),
    new ProviderTransportError('response', 'ECONNRESET'), new TypeError('fetch failed')]) {
    const c = clock(); let calls = 0
    await assert.rejects(withProviderRetry(async () => { calls++; throw error }, undefined, c), e => e === error)
    assert.equal(calls, 1); assert.deepEqual(c.waits, [])
  }
})
test('waiting is abortable, clears status and never replays', async () => {
  const controller = new AbortController(); const reason = new Error('stop')
  const states: Array<RateLimitWait | undefined> = []; let calls = 0
  await assert.rejects(withRateLimitWaiting(state => {
    states.push(state); if (state) controller.abort(reason)
  }, () => withProviderRetry(async () => { calls++; throw rejected('30') }, controller.signal)), e => e === reason || e instanceof Error && e.name === 'AbortError')
  assert.equal(calls, 1); assert.equal(states.at(-1), undefined)
})
test('cooldown coordinates same credential/endpoint, not another credential', async () => {
  const c = clock(); const scope = providerRetryScope('endpoint', 'secret')
  assert.notEqual(scope, providerRetryScope('endpoint', 'different'))
  assert.equal(providerRetryScope('https://example.invalid/v1/chat/completions', 'secret'), providerRetryScope('https://example.invalid/v1/responses', 'secret'))
  let unblock!: () => void; let waitingStarted!: () => void
  const started = new Promise<void>(resolve => { waitingStarted = resolve })
  const first = withProviderRetry(async () => { throw rejected('10') }, undefined, {
    ...c, scope, sleep: async () => { waitingStarted(); await new Promise<void>(resolve => { unblock = resolve }) ; throw new Error('test stop') },
  })
  await started
  let calls = 0
  await withProviderRetry(async () => { calls++; return true }, undefined, { ...c, scope: providerRetryScope('endpoint', 'different') })
  assert.deepEqual(c.waits, [])
  await withProviderRetry(async () => { calls++; return true }, undefined, { ...c, scope })
  assert.deepEqual(c.waits, [10000]); assert.equal(calls, 2)
  unblock(); await assert.rejects(first, /test stop/)
})
test('compatible HTTP 429 retries at adapter boundary without replaying tool execution', async t => {
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => {
    calls++
    return calls === 1 ? new Response(JSON.stringify({ error: { code: '', message: 'free-user rate limit' } }), { status: 429, headers: { 'Retry-After': '0' } })
      : Response.json({ choices: [{ message: { content: 'ok' } }] })
  })
  const response = await openaiChat({ url: 'https://example.invalid/chat', apiKey: 'test', model: 'test', messages: [], tools: [], providerName: 'agnes' })
  assert.equal(response.content, 'ok'); assert.equal(calls, 2)
})
