import assert from 'node:assert/strict'
import { test, type TestContext } from 'node:test'
import { basename, join } from 'node:path'
import { Hono } from 'hono'
import { CopilotAuthenticator, CopilotProvider, copilotModelEndpoint } from './copilot.ts'
import { AggregatedProvider } from './aggregated.ts'
import { ProviderHttpError, type ModelInfo } from './provider.ts'
import { providerPlugin } from './routes.ts'
import { REASONING_EFFORTS } from '../agent/llm-config.ts'
import { ConfigSchema } from '../config/schema.ts'

const astra = {
  id: 'gpt-6-astra',
  supported_endpoints: ['/responses', 'ws:/responses'],
  capabilities: {
    type: 'chat',
    supports: { vision: true, tool_calls: true, reasoning_effort: ['low', 'medium', 'high', 'xhigh', 'max'] },
    limits: { max_context_window_tokens: 1_000_000 },
  },
}
const dual = { id: 'gpt-5-mini', supported_endpoints: ['/chat/completions', '/responses', 'ws:/responses'] }
const responsesReply = {
  id: 'resp_synthetic',
  model: astra.id,
  status: 'completed',
  output: [{ type: 'message', id: 'msg_synthetic', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Hello', annotations: [] }] }],
  usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
}
const chatReply = { model: dual.id, choices: [{ message: { content: 'Hello' }, finish_reason: 'stop' }] }

function fixture(t: TestContext, metadata: unknown = { data: [astra, dual] }, cache?: ModelInfo[]) {
  const files = new Map<string, string>([
    ['api-key.json', JSON.stringify({ token: 'synthetic-test-key', expires_at: Date.now() / 1000 + 3600 })],
  ])
  if (cache) files.set('models.json', JSON.stringify({ models: cache, fetchedAt: Date.now() }))
  const auth = new CopilotAuthenticator(join(process.cwd(), '.test-data', 'virtual-protocol-auth'), {
    storage: {
      read: (path) => files.get(basename(path)),
      write: (path, value) => { files.set(basename(path), value) },
      remove: (path) => { files.delete(basename(path)) },
    },
    fetch: async () => { throw new Error('Unexpected OAuth exchange') },
  })
  const posts: Array<{ path: string; body: Record<string, unknown> }> = []
  let modelReads = 0
  let modelResponse = metadata
  let postResponse: Response | undefined
  t.mock.method(globalThis, 'fetch', async (url: string | URL | Request, init?: RequestInit) => {
    init?.signal?.throwIfAborted()
    const path = new URL(String(url)).pathname
    if (path === '/models') {
      modelReads++
      return modelResponse instanceof Response ? modelResponse.clone() : Response.json(modelResponse)
    }
    assert.equal(init?.method, 'POST')
    posts.push({ path, body: JSON.parse(String(init.body)) })
    if (postResponse) return postResponse.clone()
    if (path === '/responses') return Response.json(responsesReply)
    assert.equal(path, '/chat/completions')
    return Response.json(chatReply)
  })
  return {
    auth, files, posts,
    provider: new CopilotProvider(auth),
    reads: () => modelReads,
    metadata: (value: unknown) => { modelResponse = value },
    reply: (value: Response) => { postResponse = value },
  }
}

test('default model and provider fallback both send Astra with configured medium effort', async t => {
  const f = fixture(t)
  const config = ConfigSchema.parse({})
  const provider = new AggregatedProvider(new Map([['copilot', f.provider]]), 'copilot')
  await provider.chat([{ role: 'user', content: 'hi' }], [], config.agent)
  await f.provider.chat([{ role: 'user', content: 'hi' }], [], { model: '', reasoningEffort: config.agent.reasoningEffort })
  assert.equal(f.posts.length, 2)
  for (const post of f.posts) {
    assert.equal(post.path, '/responses')
    assert.equal(post.body.model, 'gpt-6-astra')
    assert.deepEqual(post.body.reasoning, { effort: 'medium' })
  }
})

test('Astra capability metadata routes qualified model to Responses without substituting the model', async (t) => {
  const f = fixture(t)
  const provider = new AggregatedProvider(new Map([['copilot', f.provider]]), 'copilot')
  const result = await provider.chat([{ role: 'user', content: 'hi' }], [], { model: 'gpt-6-astra@copilot' })
  assert.equal(result.content, 'Hello')
  assert.equal(f.posts.length, 1)
  assert.equal(f.posts[0].path, '/responses')
  assert.equal(f.posts[0].body.model, astra.id)
  assert.equal(f.posts[0].body.messages, undefined)
  assert.ok(Array.isArray(f.posts[0].body.input))
  const infos = await provider.listModelInfos()
  assert.deepEqual(infos.find((info) => info.id === 'gpt-6-astra@copilot')?.supportedEndpoints, astra.supported_endpoints)
  assert.equal(f.reads(), 1)
})

test('dual-endpoint and legacy models retain chat-completions and strip Responses continuation data', async (t) => {
  const f = fixture(t, { data: [dual, { id: 'legacy-chat' }] })
  const history = [{
    role: 'assistant' as const, content: 'Earlier answer',
    reasoning_text: 'Display-only narration',
    provider_state: {
      provider: 'copilot' as const, model: astra.id,
      reasoning: [{ type: 'reasoning' as const, encrypted_content: 'synthetic-opaque-state', summary: [] }],
    },
  }, { role: 'user' as const, content: 'hi' }]
  for (const model of [dual.id, 'legacy-chat']) {
    await f.provider.chat(history, [], { model })
    const request = f.posts.at(-1)!
    assert.equal(request.path, '/chat/completions')
    assert.equal(request.body.model, model)
    assert.doesNotMatch(JSON.stringify(request.body), /provider_state|synthetic-opaque-state|Display-only narration/)
  }
})

test('new model capabilities survive cache restoration and an offline model lookup', async (t) => {
  const f = fixture(t)
  await f.provider.listModels()
  const cached = JSON.parse(f.files.get('models.json')!)
  assert.deepEqual(cached.models.find((model: ModelInfo) => model.id === astra.id).supportedEndpoints, astra.supported_endpoints)
  f.metadata(new Response('offline', { status: 503 }))
  await new CopilotProvider(f.auth).chat([{ role: 'user', content: 'hi' }], [], { model: astra.id })
  assert.equal(f.posts[0].path, '/responses')
})

test('old cache gains endpoint capabilities from the next successful metadata request', async (t) => {
  const f = fixture(t, { data: [astra] }, [{ id: astra.id }])
  await f.provider.chat([{ role: 'user', content: 'hi' }], [], { model: astra.id })
  assert.equal(f.posts[0].path, '/responses')
})

test('models hidden from the picker retain endpoint routing for saved sessions and offline caches', async (t) => {
  const f = fixture(t, { data: [{ ...astra, model_picker_enabled: false }, dual] })
  assert.deepEqual(await f.provider.listModels(), [dual.id])
  assert.deepEqual((await f.provider.listModelInfos()).map((model) => model.id), [dual.id])
  await f.provider.chat([{ role: 'user', content: 'hi' }], [], { model: astra.id })
  assert.equal(f.posts[0].path, '/responses')
  f.metadata(new Response('offline', { status: 503 }))
  await new CopilotProvider(f.auth).chat([{ role: 'user', content: 'hi' }], [], { model: astra.id })
  assert.equal(f.posts[1].path, '/responses')
})

test('unknown capability data uses explicit legacy compatibility, but explicit unsupported endpoints fail before POST', async (t) => {
  const f = fixture(t, { data: [{ id: 'ws-only', supported_endpoints: ['ws:/responses'] }] })
  assert.equal(copilotModelEndpoint(undefined), '/chat/completions')
  assert.equal(copilotModelEndpoint({ id: 'old-cache' }), '/chat/completions')
  assert.throws(() => copilotModelEndpoint({ id: 'empty', supportedEndpoints: [] }), /does not advertise/)
  await assert.rejects(f.provider.chat([{ role: 'user', content: 'hi' }], [], { model: 'ws-only' }), /does not advertise/)
  assert.equal(f.posts.length, 0)
  await f.provider.chat([{ role: 'user', content: 'hi' }], [], { model: 'new-unknown-model' })
  assert.equal(f.posts[0].path, '/chat/completions')
  assert.equal(f.posts[0].body.model, 'new-unknown-model')
})

test('unsupported_api_for_model HTTP 400 is not retried against another endpoint or treated as a 401', async (t) => {
  const f = fixture(t)
  f.reply(Response.json({ error: { code: 'unsupported_api_for_model', message: 'Unsupported endpoint, reference 401' } }, { status: 400 }))
  await assert.rejects(f.provider.chat([{ role: 'user', content: 'hi' }], [], { model: dual.id }), (error) =>
    error instanceof ProviderHttpError && error.status === 400 && error.code === 'unsupported_api_for_model')
  assert.equal(f.posts.length, 1)
  assert.equal(f.auth.hasValidApiKey(), true)
})

test('Responses reasoning effort uses declared support and does not silently lower an unsupported choice', async (t) => {
  const f = fixture(t, { data: [{ ...astra, capabilities: { supports: { reasoning_effort: ['high'] } } }] })
  await assert.rejects(f.provider.chat([{ role: 'user', content: 'hi' }], [], { model: astra.id, reasoningEffort: 'max' }), /does not support reasoning effort/)
  assert.equal(f.posts.length, 0)
  await f.provider.chat([{ role: 'user', content: 'hi' }], [], { model: astra.id, reasoningEffort: 'high' })
  assert.deepEqual(f.posts[0].body.reasoning, { effort: 'high' })
})

for (const endpoint of ['/responses', '/chat/completions']) {
  test(`${endpoint} GPT gateway preserves all effort levels including Medium and XHigh`, async (t) => {
    const f = fixture(t, { data: [{
      ...astra, supported_endpoints: [endpoint],
      capabilities: { supports: { reasoning_effort: ['none', ...REASONING_EFFORTS] } },
    }] })
    const app = new Hono()
    providerPlugin(f.provider)(app)
    for (const reasoning_effort of REASONING_EFFORTS) {
      const response = await app.request('/v1/chat/completions', {
        method: 'POST', body: JSON.stringify({
          model: astra.id, messages: [{ role: 'user', content: 'Fixture' }],
          thinking: { type: 'enabled' }, reasoning_effort,
        }),
      })
      assert.equal(response.status, 200)
      const post = f.posts.at(-1)!
      assert.equal(post.path, endpoint)
      assert.deepEqual(endpoint === '/responses' ? post.body.reasoning : post.body.reasoning_effort,
        endpoint === '/responses' ? { effort: reasoning_effort } : reasoning_effort)
      assert.equal('thinking' in post.body, false)
    }
  })

  test(`${endpoint} rejects explicit None when capabilities exclude it before fetching images or generating`, async (t) => {
    const f = fixture(t, { data: [{
      ...astra, supported_endpoints: [endpoint],
      capabilities: { supports: { reasoning_effort: ['high'] } },
    }] })
    for (const reasoningEffort of [undefined, 'high'] as const) {
      await assert.rejects(f.provider.chat([{
        role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://synthetic.invalid/image.png' } }],
      }], [], { model: astra.id, thinking: { type: 'disabled' }, reasoningEffort }),
      /does not support reasoning effort "none"/)
    }
    assert.equal(f.posts.length, 0)
  })

  for (const efforts of [undefined, ['none']]) {
    test(`${endpoint} sends None with ${efforts ? 'explicit' : 'unknown'} capabilities, overriding inherited high`, async (t) => {
      const f = fixture(t, { data: [{
        ...astra, supported_endpoints: [endpoint],
        capabilities: { supports: efforts ? { reasoning_effort: efforts } : {} },
      }] })
      for (const reasoningEffort of [undefined, 'high'] as const) {
        await f.provider.chat([{ role: 'user', content: 'hi' }], [], {
          model: astra.id, thinking: { type: 'disabled' }, reasoningEffort,
        })
      }
      assert.equal(f.posts.length, 2)
      for (const request of f.posts) {
        assert.equal(request.path, endpoint)
        if (endpoint === '/responses') assert.deepEqual(request.body.reasoning, { effort: 'none' })
        else assert.equal(request.body.reasoning_effort, 'none')
        assert.equal('thinking' in request.body, false)
      }
    })
  }
}

test('abort stops metadata lookup instead of sending a legacy or Responses POST', async (t) => {
  const f = fixture(t)
  const controller = new AbortController()
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init?: RequestInit) => {
    controller.abort(new Error('synthetic cancellation'))
    init?.signal?.throwIfAborted()
    assert.fail('Expected aborted fetch')
  })
  await assert.rejects(f.provider.chat([{ role: 'user', content: 'hi' }], [], { model: astra.id, signal: controller.signal }), /synthetic cancellation/)
  assert.equal(f.posts.length, 0)
})

test('the compatible gateway carries provider-only continuity through a tool round without changing its message contract', async () => {
  const state = {
    provider: 'copilot' as const, model: astra.id,
    reasoning: [{ type: 'reasoning' as const, encrypted_content: 'synthetic-encrypted-continuation', summary: [] }],
  }
  let calls = 0
  const app = new Hono()
  providerPlugin({
    name: 'copilot',
    listModels: () => [astra.id],
    chat: async (messages, _tools, options) => {
      assert.ok(options.signal instanceof AbortSignal)
      calls++
      if (calls === 2) {
        assert.deepEqual(messages[1].provider_state, state)
        assert.equal(messages[2].tool_call_id, 'call_fixture')
        return { content: 'done', toolCalls: [] }
      }
      return {
        content: null, providerState: state,
        toolCalls: [{ id: 'call_fixture', name: 'fixture_tool', arguments: {} }],
      }
    },
  })(app)
  const user = { role: 'user', content: 'hi' }
  const first = await app.request('/v1/chat/completions', {
    method: 'POST', body: JSON.stringify({ model: astra.id, messages: [user] }),
  })
  const payload = await first.json()
  assert.equal(first.status, 200)
  assert.equal(payload.choices[0].finish_reason, 'tool_calls')
  const assistant = payload.choices[0].message
  assert.deepEqual(assistant.provider_state, state)
  const second = await app.request('/v1/chat/completions', {
    method: 'POST',
    body: JSON.stringify({
      model: astra.id,
      messages: [user, assistant, { role: 'tool', tool_call_id: 'call_fixture', content: 'result' }],
    }),
  })
  assert.equal(second.status, 200)
  assert.equal((await second.json()).choices[0].message.content, 'done')
})
