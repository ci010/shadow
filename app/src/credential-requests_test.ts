import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { readFile } from 'node:fs/promises'
import { createRenderer, defineComponent, reactive } from 'vue'
import { compileScript, compileStyle, compileTemplate, parse } from 'vue/compiler-sfc'
import { parseCredentialResponse, privateCredentialTransport, useCredentialRequest, type CredentialRequestSource } from './credential-requests.ts'

const requestId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const question = (projectId = 'project-a', id = requestId) => ({
  id, projectId, sessionId: 'web:chat-admin', secretRef: 'github-issues',
  purpose: 'Read issues for the reviewed repository.', createdAt: '2026-09-17T12:00:00.000Z', replacesExisting: false,
})
const settle = () => new Promise(resolve => setImmediate(resolve))

async function harness(t: TestContext, initial: Partial<CredentialRequestSource> = {}) {
  const requests: Array<{ url: string; init: RequestInit; finish: (response: Response) => void; reject: (error: Error) => void }> = []
  t.mock.method(globalThis, 'fetch', (url: string, init: RequestInit) =>
    new Promise<Response>((finish, reject) => requests.push({ url, init, finish, reject })))
  const source = reactive({
    apiBase: 'http://127.0.0.1:3123/projects/project-a', projectId: 'project-a',
    sessionId: 'web:chat-admin', active: true, stage: 'tool', canSubmit: true, ...initial,
  })
  let state!: ReturnType<typeof useCredentialRequest>
  const renderer = createRenderer<object, object>({
    createElement: () => ({}), createText: () => ({}), createComment: () => ({}),
    insert() {}, remove() {}, setText() {}, setElementText() {}, patchProp() {},
    parentNode: () => null, nextSibling: () => null,
  })
  const app = renderer.createApp(defineComponent({
    setup() { state = useCredentialRequest(() => source); return () => null },
  }))
  app.provide(Symbol.for('shadow.live-client-pool'), { client: () => ({ subscribe: () => ({ ready: async () => {}, close() {} }) }), observeHost: (_base: string, callback: (status: { phase: string }) => void) => { callback({ phase: 'live' }); return () => {} } })
  app.mount({})
  await settle()
  let mounted = true
  function unmount() { if (mounted) { mounted = false; app.unmount() } }
  t.after(unmount)
  return { state, source, requests, unmount }
}

test('private entry validates Project identity and rejects unexpected secret-bearing metadata', () => {
  assert.deepEqual(parseCredentialResponse({ request: question() }, 'project-a'), question())
  assert.equal(parseCredentialResponse({ request: null }, 'project-a'), null)
  for (const invalid of [
    {}, { request: undefined }, { request: question('foreign') },
    { request: { ...question(), sessionId: 'qq:other' } },
    { request: { ...question(), value: 'NEVER-RENDER-THIS' } },
    { request: { ...question(), secretRef: '../invalid' } },
  ]) assert.throws(() => parseCredentialResponse(invalid, 'project-a'))
  for (const url of ['https://main.example/projects/a', 'http://localhost:3123', 'http://127.0.0.1:3123', 'http://[::1]:3123']) {
    assert.equal(privateCredentialTransport(url), true)
  }
  for (const url of ['', 'invalid URL', 'http://192.168.1.2:3123', 'http://main.example', 'https://user:password@main.example', 'file:///tmp/credential']) {
    assert.equal(privateCredentialTransport(url), false)
  }
})

test('visible owner reads once regardless of tool stages and deactivation clears secret input', async t => {
  const { state, source, requests } = await harness(t, { stage: 'idle' })
  assert.equal(requests.length, 1)
  const first = requests[0]
  for (const stage of ['tool', 'thinking', 'tool', 'idle']) {
    source.stage = stage
    await settle()
    assert.equal(requests.length, 1, 'stage changes do not create credential reads')
    assert.equal(first.init.signal?.aborted, false, 'stage changes do not abort the current read')
  }
  requests[0].finish(Response.json({ request: question() }))
  await settle()
  state.secret.value = 'SYNTHETIC-SECRET'
  source.active = false
  await settle()
  assert.equal(state.secret.value, '')
  assert.equal(state.request.value, null)
  source.sessionId = 'web:ordinary-chat'
  await settle()
  source.active = true
  await settle()
  assert.equal(requests.length, 2)
  source.sessionId = 'web:chat-admin'
  await settle()
  assert.equal(requests.length, 3)
  source.canSubmit = false
  await settle()
  assert.equal(requests[2].init.signal?.aborted, true)
  assert.equal(state.enabled.value, false)
})

test('saving uses only the dedicated Project endpoint and clears the value after a matching receipt', async t => {
  const { state, requests } = await harness(t)
  requests[0].finish(Response.json({ request: question() }))
  await settle()
  state.secret.value = 'SYNTHETIC-SECRET'
  const submitted = state.submit()
  const write = requests[1]
  assert.equal(write.url, `http://127.0.0.1:3123/projects/project-a/api/agent-resources/credential-requests/${requestId}`)
  assert.equal(write.init.method, 'POST')
  assert.equal(write.init.redirect, 'error')
  assert.equal(write.init.cache, 'no-store')
  assert.deepEqual(JSON.parse(String(write.init.body)), { value: 'SYNTHETIC-SECRET' })
  assert.doesNotMatch(write.url, /SYNTHETIC-SECRET/)
  assert.equal(requests.length, 2, 'No chat-send or generic answer request is made')
  write.finish(Response.json({ result: { requestId, secretRef: 'github-issues', status: 'saved' } }))
  assert.equal(await submitted, true)
  assert.equal(state.secret.value, '')
  assert.equal(state.request.value, null)
})

test('secret submissions never render exception text or response bodies, including misleading success bodies', async t => {
  const { state, requests } = await harness(t)
  requests[0].finish(Response.json({ request: question() }))
  await settle()
  for (const response of [
    Response.json({ message: 'SYNTHETIC-SECRET' }, { status: 500 }),
    Response.json({ result: { requestId, secretRef: 'github-issues', status: 'saved', value: 'SYNTHETIC-SECRET' } }),
    Response.json({ result: { requestId, secretRef: 'another-reference', status: 'saved' } }),
  ]) {
    state.secret.value = 'SYNTHETIC-SECRET'
    const submitted = state.submit()
    requests.at(-1)!.finish(response)
    assert.equal(await submitted, false)
    assert.equal(state.secret.value, '')
    assert.ok(state.request.value)
    assert.doesNotMatch(state.error.value, /SYNTHETIC-SECRET|another-reference/)
  }
  state.secret.value = 'SYNTHETIC-SECRET'
  const submitted = state.submit()
  requests.at(-1)!.reject(new Error('SYNTHETIC-SECRET'))
  assert.equal(await submitted, false)
  assert.doesNotMatch(state.error.value, /SYNTHETIC-SECRET/)
})

test('cancellation sends no credential value, and unmount clears pending input', async t => {
  const { state, requests, unmount } = await harness(t)
  requests[0].finish(Response.json({ request: question() }))
  await settle()
  state.secret.value = 'UNSAVED-SYNTHETIC-SECRET'
  const cancelled = state.cancel()
  assert.equal(state.operation.value, 'cancelling')
  assert.equal(requests[1].init.method, 'DELETE')
  assert.equal(requests[1].init.body, undefined)
  requests[1].finish(Response.json({ result: { requestId, secretRef: 'github-issues', status: 'cancelled' } }))
  assert.equal(await cancelled, true)
  assert.equal(state.secret.value, '')
  state.secret.value = 'UNSAVED-SYNTHETIC-SECRET'
  unmount()
  assert.equal(state.secret.value, '')
})

test('Project switches abort old writes and stale responses cannot clear or populate another Project input', async t => {
  const { state, source, requests } = await harness(t)
  requests[0].finish(Response.json({ request: question() }))
  await settle()
  state.secret.value = 'PROJECT-A-SECRET'
  const submitted = state.submit()
  const write = requests[1]
  source.apiBase = 'http://127.0.0.1:3123/projects/project-b'
  await settle()
  source.projectId = 'project-b'
  await settle()
  assert.equal(write.init.signal?.aborted, true)
  assert.equal(state.secret.value, '')
  requests.at(-1)!.finish(Response.json({ request: question('project-b') }))
  await settle()
  state.secret.value = 'PROJECT-B-SECRET'
  write.finish(Response.json({ result: { requestId, secretRef: 'github-issues', status: 'saved' } }))
  assert.equal(await submitted, false)
  assert.equal(state.secret.value, 'PROJECT-B-SECRET')
  assert.equal(state.request.value?.projectId, 'project-b')
})

test('insecure remote transport never receives a secret submission', async t => {
  const { state, requests } = await harness(t, { apiBase: 'http://main.example/projects/project-a' })
  requests[0].finish(Response.json({ request: question() }))
  await settle()
  state.secret.value = 'SYNTHETIC-SECRET'
  assert.equal(await state.submit(), false)
  assert.equal(requests.length, 1)
  assert.equal(state.secret.value, '')
  assert.match(state.error.value, /HTTPS/)
})

test('private credential UI is a masked local form, not a generic chat answer', async () => {
  const filename = 'CredentialRequest.vue'
  const source = await readFile(new URL(`./components/${filename}`, import.meta.url), 'utf8')
  const { descriptor, errors } = parse(source, { filename })
  assert.deepEqual(errors, [])
  const script = compileScript(descriptor, { id: filename })
  assert.deepEqual(compileTemplate({ source: descriptor.template!.content, filename, id: filename,
    compilerOptions: { bindingMetadata: script.bindings } }).errors, [])
  for (const style of descriptor.styles) assert.deepEqual(compileStyle({
    source: style.content, filename, id: filename, scoped: true,
  }).errors, [])
  assert.match(source, /type="password" autocomplete="off"/)
  assert.match(source, /role="alert"/)
  assert.match(source, /Shadow does not encrypt that file/)
  assert.doesNotMatch(source, /defineEmits|localStorage|sessionStorage|console\./)
})

test('ordinary admin session shows only its own private credential card', async t => {
  const { state, requests } = await harness(t, { sessionId: 'web:ordinary' })
  requests[0].finish(Response.json({ request: { ...question(), sessionId: 'web:other' } }))
  await settle()
  assert.equal(state.request.value, null)
  const refreshed = state.refresh()
  requests[1].finish(Response.json({ request: { ...question(), sessionId: 'web:ordinary' } }))
  await refreshed
  await settle()
  assert.equal(state.request.value?.sessionId, 'web:ordinary')
})
