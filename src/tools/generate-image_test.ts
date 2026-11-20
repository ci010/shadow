import assert from 'node:assert/strict'
import { test } from 'node:test'
import { generateOpenRouterImage, OPENROUTER_IMAGES_URL } from '../providers/openrouter-images.ts'
import { YieldManager } from '../sessions/yield.ts'
import type { YieldRequest } from '../sessions/yield-contract.ts'
import type { ExecutionContext } from './context.ts'
import { createGenerateImageTool } from './generate-image.ts'
import { SessionTools, Tools } from './registry.ts'
import { ToolOutcomeUnknownError } from './tool.ts'

const png = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZsAAAAASUVORK5CYII='
const response = () => Response.json({ data: [{ b64_json: png, media_type: 'image/png' }] })
const args = { prompt: 'A tiny fox', model: 'example/image-model' }
function fixture() {
  const published = Promise.withResolvers<YieldRequest>()
  const context = { sessionId: 'web:image', physicalSessionId: 'image-segment', channel: 'web', admin: true,
    inputSource: 'user', signal: new AbortController().signal } as ExecutionContext
  const yields = new YieldManager({
    getState: sessionId => ({ sessionId, segmentIndex: 0 }), getPolicy: () => ({ timeoutMs: null }),
    notifyParent: async () => {}, notifyUser: async () => {},
    changed: id => { const request = yields.get(id); if (request) published.resolve(request) },
    journal: {
      open: async request => ({ ...request, origin: { physicalId: context.physicalSessionId } }),
      write: async () => {},
    },
  })
  const calls: { url: string; init?: RequestInit }[] = []
  const provider = { apiKey: 'fixture-secret' }
  const tool = createGenerateImageTool({ providers: () => ({ openrouter: provider }), ownerSession: () => true,
    askOwner: yields.askOwner.bind(yields), send: async (url, init) => { calls.push({ url: String(url), init }); return response() } })
  const base = new Tools('.')
  base.register(tool)
  const tools = new SessionTools(base, '.')
  tools.setExecutionScope('session', [])
  context.tools = tools
  return { tool, tools, context, provider, calls, published: published.promise,
    answer: (request: YieldRequest, option: string) => yields.answerUser(context.sessionId, request.id, option) }
}

test('discoverable tool waits for exact owner confirmation then returns a validated chat image part', async () => {
  const f = fixture()
  assert.ok(f.tools.getDefinitions().some(definition => definition.function.name === 'generate_image'))
  const result = f.tools.execute('generate_image', args, f.context)
  const request = await f.published
  assert.equal(request.ownerOnly, true)
  assert.match(request.question, /example\/image-model\.\n\nA tiny fox$/)
  assert.doesNotMatch(request.question, /fixture-secret/)
  assert.equal(f.calls.length, 0)
  await f.answer(request, request.options[0])
  const output = await result
  assert.equal(f.calls.length, 1)
  const [{ url, init }] = f.calls
  assert.equal(url, OPENROUTER_IMAGES_URL)
  assert.equal(init?.method, 'POST')
  assert.equal(init?.redirect, 'error')
  assert.equal(new Headers(init?.headers).get('authorization'), 'Bearer fixture-secret')
  assert.deepEqual(JSON.parse(String(init?.body)), { ...args, response_format: 'b64_json' })
  assert.ok(typeof output !== 'string')
  assert.deepEqual(output.content[1], { type: 'image_url', image_url: { url: `data:image/png;base64,${png}`, detail: 'auto' } })
  assert.doesNotMatch(JSON.stringify(output), /fixture-secret/)
})

test('rejects non-owner and replay contexts, decline, missing credentials and credentials changed while waiting', async () => {
  for (const override of [{ admin: false }, { inputSource: 'event' as const }, { recoveringToolCall: true }]) {
    const f = fixture()
    assert.match(String(await f.tool.execute(args, { ...f.context, ...override })), /^Blocked:/)
    assert.equal(f.calls.length, 0)
  }
  const missing = fixture()
  missing.provider.apiKey = ''
  assert.match(String(await missing.tool.execute(args, missing.context)), /saved API key/)
  for (const changed of [false, true]) {
    const f = fixture()
    const result = f.tool.execute(args, f.context)
    const request = await f.published
    if (changed) f.provider.apiKey = 'rotated'
    await f.answer(request, changed ? request.options[0] : request.defaultOption)
    assert.match(String(await result), /^Blocked:/)
    assert.equal(f.calls.length, 0)
  }
})

test('cancellation while awaiting confirmation sends no request', async () => {
  const f = fixture()
  const controller = new AbortController()
  const result = f.tool.execute(args, { ...f.context, signal: controller.signal })
  const rejected = assert.rejects(result, { name: 'AbortError' })
  await f.published
  controller.abort()
  await rejected
  assert.equal(f.calls.length, 0)
})

test('request abort is forwarded, reported as ambiguous, and not retried', async () => {
  const controller = new AbortController()
  let calls = 0
  await assert.rejects(generateOpenRouterImage('fixture-secret', 'example/image', 'fox', controller.signal,
    async (_url, init) => {
      calls++
      controller.abort()
      assert.equal(init?.signal?.aborted, true)
      return response()
    }), ToolOutcomeUnknownError)
  assert.equal(calls, 1)
})

test('unsafe, oversized and ambiguous image responses are sanitized and never retried', async () => {
  const signal = new AbortController().signal
  const outcomes = [
    () => new Response('fixture-secret', { status: 503 }),
    () => Response.json({ data: [{ url: 'https://example.test/fixture-secret' }] }),
    () => Response.json({ data: [{ b64_json: png, media_type: 'image/svg+xml' }] }),
    () => new Response(new Uint8Array(8 * 1024 * 1024)),
    () => { throw new Error('fixture-secret') },
  ]
  for (const outcome of outcomes) {
    let calls = 0
    await assert.rejects(generateOpenRouterImage('fixture-secret', 'example/image', 'fox', signal,
      async () => { calls++; return outcome() }), error => error instanceof ToolOutcomeUnknownError &&
      /Charges may have occurred/.test(error.message) && !error.message.includes('fixture-secret'))
    assert.equal(calls, 1)
  }
})
