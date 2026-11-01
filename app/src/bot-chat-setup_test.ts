import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test, { type TestContext } from 'node:test'
import { privateCredentialTransport } from './credential-requests.ts'
import { mountBotUi, settleBotUi } from './bot-ui-test-helpers.ts'
import type { LiveObserver } from './live-client.ts'
const card = readFileSync(new URL('./components/BotChatSetup.vue', import.meta.url), 'utf8')
const chat = readFileSync(new URL('./components/ChatTab.vue', import.meta.url), 'utf8')
const editor = readFileSync(new URL('./components/BotConnectionSetup.vue', import.meta.url), 'utf8')

test('Chat mounts only compact private setup, keeps credentials out of ordinary chat and owns input lifecycle', () => {
  assert.match(chat, /<BotChatSetup :api-base="apiBase"/)
  assert.match(card, /<BotConnectionSetup v-if="request && !busy" :key="request.id".* compact/)
  assert.doesNotMatch(card, /ChannelsView|BotPackage|DiscordAccess/)
  assert.match(card, /privateCredentialTransport\(props.apiBase\)/)
  assert.match(card, /next.projectId === props.projectId && next.sessionId === props.sessionId/)
  assert.match(card, /onBeforeUnmount\(stop\)/)
  assert.match(editor, /window.confirm\(t\('Bind platform user/)
  assert.match(editor, /field.kind === 'password' \? 'new-password'/)
  assert.match(editor, /draft.value = platform.value \? botConnectionDraft/)
})

test('Private setup rejects nonloopback cleartext and credential-bearing URLs', () => {
  assert.equal(privateCredentialTransport('http://example.com'), false)
  assert.equal(privateCredentialTransport('https://user:pass@example.com'), false)
  assert.equal(privateCredentialTransport('http://127.0.0.1:3000/projects/p'), true)
  assert.equal(privateCredentialTransport('https://example.com/projects/p'), true)
})

const invitation = (patch: Record<string, unknown> = {}) => ({ id: 'setup-p', projectId: 'p', sessionId: 'web:topic', expiresAt: Date.now() + 60_000, ...patch })
const bot = { id: 'qq-bot', projectId: 'p', platform: 'qq', displayName: 'Existing connection', purpose: 'personal', ownerVerified: false, label: 'QQ', enabled: false, configured: false, state: 'disabled', config: {}, secrets: {} }
function harness(t: TestContext, initial: unknown = null) {
  let pending = initial, closes = 0, failClose = false
  const observers: LiveObserver[] = [], disposers: Array<() => void> = []
  const calls: Array<{ path: string; method: string; body?: unknown; signal?: AbortSignal | null }> = []
  const pool = {
    onDispose(callback: () => void) { disposers.push(callback); return () => {} },
    client: () => ({ subscribe: (_topic: unknown, observer: LiveObserver) => { observers.push(observer); return { ready: async () => {}, close() { closes++ } } } }),
    observeHost: (_base: string, notify: (value: unknown) => void) => { notify({ phase: 'live' }); return () => {} },
  }
  t.mock.method(globalThis, 'fetch', async (url: URL | RequestInfo, init?: RequestInit) => {
    const path = String(url), method = init?.method ?? 'GET'; calls.push({ path, method, body: init?.body ? JSON.parse(String(init.body)) : undefined, signal: init?.signal })
    if (path.includes('/api/channels')) return Response.json({ channels: [bot] })
    if (method === 'POST') {
      assert.equal(init?.redirect, 'error')
      if (failClose) return new Response('untrusted-server-detail', { status: 500 })
      pending = null; return Response.json({ closed: true })
    }
    return Response.json({ request: pending })
  })
  const view = mountBotUi(t, 'BotChatSetup.vue', { apiBase: 'http://127.0.0.1/projects/p', projectId: 'p', sessionId: 'web:topic', active: true, canSubmit: true }, { provide: new Map([[Symbol.for('shadow.live-client-pool'), pool]]) })
  // Release invalidation caches as well as mounted components; no timers survive tests.
  t.after(() => { view.unmount(); for (const dispose of disposers) dispose() })
  return { view, calls, setPending: (value: unknown) => { pending = value }, failClose: (value: boolean) => { failClose = value }, closes: () => closes,
    async invalidate() { for (const observer of observers) observer.event?.({ payload: { event: 'invalidate', resource: 'interactions' } } as never); await new Promise(resolve => setTimeout(resolve, 80)); await settleBotUi() } }
}

test('live invalidation mounts scoped setup without idle polling and chat switching clears private inputs', async t => {
  const fixture = harness(t), { view, calls } = fixture
  await settleBotUi(); assert.equal(calls.length, 1); assert.equal(view.nodes().filter(node => node.tag === 'select').length, 0)
  await new Promise(resolve => setTimeout(resolve, 1100)); assert.equal(calls.length, 1)
  fixture.setPending(invitation()); await fixture.invalidate()
  await view.select(0, 'qq'); await view.select(1, 'connection:qq-bot'); view.input('secret', 'synthetic-secret')
  assert.doesNotMatch(view.text(), /synthetic-secret|BOT deployments/)
  view.state.sessionId = 'web:other'; await settleBotUi()
  assert.equal(view.nodes().filter(node => node.tag === 'input').length, 0)
  assert.equal(calls.filter(call => call.method === 'POST').length, 0)
  view.state.sessionId = 'web:topic'; await settleBotUi()
  await view.select(0, 'qq'); await view.select(1, 'connection:qq-bot')
  assert.equal(view.nodes().find(node => node.props.name === 'secret')?.props.inputValue, '')
  assert.equal(calls.filter(call => call.path.includes('bot-chat-setup')).length, 3, 'returning reuses the invalidated session envelope')
  view.unmount(); assert.equal(fixture.closes(), 0, 'idle cache retains only invalidation subscriptions until pool disposal')
})

test('Cancel sends only the scoped invitation status, clears private inputs, and does not save credentials', async t => {
  const { view, calls } = harness(t, invitation())
  await settleBotUi(); await view.select(0, 'qq'); await view.select(1, 'connection:qq-bot'); view.input('secret', 'synthetic-secret')
  await view.click('Cancel')
  assert.deepEqual(calls.filter(call => call.method === 'POST').map(call => call.body), [{ id: 'setup-p', sessionId: 'web:topic', status: 'cancelled' }])
  assert.equal(calls.some(call => call.method === 'PATCH'), false)
  assert.doesNotMatch(JSON.stringify(calls), /synthetic-secret/)
  assert.equal(view.nodes().filter(node => node.tag === 'input').length, 0)
})

test('failed close preserves truthful retry state but destroys private drafts; Done never asserts readiness', async t => {
  const fixture = harness(t, invitation()), { view, calls } = fixture
  await settleBotUi(); await view.select(0, 'qq'); await view.select(1, 'connection:qq-bot'); view.input('secret', 'synthetic-secret')
  fixture.failClose(true); await view.click('Done'); await settleBotUi()
  assert.match(view.text(), /Could not close setup/)
  assert.doesNotMatch(view.text(), /synthetic-secret|untrusted-server-detail|Ready for your messages/)
  await view.select(0, 'qq'); await view.select(1, 'connection:qq-bot')
  assert.equal(view.nodes().find(node => node.props.name === 'secret')?.props.inputValue, '')
  fixture.failClose(false); await view.click('Reload'); await view.click('Done')
  assert.deepEqual(calls.filter(call => call.method === 'POST').map(call => call.body), [
    { id: 'setup-p', sessionId: 'web:topic', status: 'closed' }, { id: 'setup-p', sessionId: 'web:topic', status: 'closed' },
  ])
  assert.doesNotMatch(view.text(), /Private Bot connection/)
})

test('expiry unmounts private form without waiting for an SSE event or sending a save', async t => {
  const { view, calls } = harness(t, invitation({ expiresAt: Date.now() + 1000 }))
  await settleBotUi(); await view.select(0, 'qq'); await view.select(1, 'connection:qq-bot'); view.input('secret', 'synthetic-secret')
  await new Promise(resolve => setTimeout(resolve, 1100)); await settleBotUi()
  assert.equal(view.nodes().filter(node => node.tag === 'input').length, 0)
  assert.equal(calls.some(call => call.method === 'POST' || call.method === 'PATCH'), false)
})

test('foreign, malformed or already expired invitation never mounts a connection form', async t => {
  const fixture = harness(t, invitation({ projectId: 'foreign' })), { view } = fixture
  await settleBotUi(); assert.equal(view.nodes().filter(node => node.tag === 'select').length, 0)
  for (const patch of [{ sessionId: 'web:other' }, { expiresAt: 0 }, { expiresAt: Number.MAX_SAFE_INTEGER }]) {
    fixture.setPending(invitation(patch)); await fixture.invalidate()
    assert.equal(view.nodes().filter(node => node.tag === 'select').length, 0)
  }
  fixture.setPending(invitation()); await fixture.invalidate(); assert.equal(view.nodes().filter(node => node.tag === 'select').length, 1)
  view.state.projectId = 'other'; view.state.apiBase = 'http://127.0.0.1/projects/other'; await settleBotUi()
  assert.equal(view.nodes().filter(node => node.tag === 'select').length, 0)
})
