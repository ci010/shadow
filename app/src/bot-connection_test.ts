import assert from 'node:assert/strict'
import test from 'node:test'
import { botConnectionDraft, botConnectionFields, botConnectionPatch, type BotInstanceStatus } from './bot-settings.ts'
import { mountBotUi, settleBotUi } from './bot-ui-test-helpers.ts'

const fixture = (patch: Partial<BotInstanceStatus> = {}): BotInstanceStatus => ({ id: 'qq-bot', projectId: 'p', platform: 'qq', displayName: 'Existing QQ', label: 'QQ', enabled: false, configured: true, state: 'disabled', config: { appId: 'saved-id', sandbox: true, allowFrom: ['alice'], adminChats: ['room'], trustedChats: ['trusted'], intents: 123 }, secrets: { secret: true }, ...patch })
const props = { apiBase: 'http://localhost/projects/p', projectId: 'p', active: true, available: true, compact: true }
const calls: (url: URL | RequestInfo, init?: RequestInit) => { path: string; method: string; body: any } = (url, init) => ({ path: new URL(String(url)).pathname, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : undefined })

test('connection-only patches preserve hidden access and saved credentials without replaying them', () => {
  const bot = fixture(), draft = botConnectionDraft('qq')
  assert.deepEqual(draft, { appId: '', secret: '' })
  assert.deepEqual(botConnectionPatch(bot, draft, true), { config: { enabled: true } })
  assert.deepEqual(botConnectionPatch(bot, { ...draft, secret: ' replacement ', allowFrom: '', sandbox: false }, false), { config: { enabled: false, secret: 'replacement' } })
  assert.deepEqual(botConnectionFields('discord').map(field => field.key), ['token'])
  assert.deepEqual(botConnectionFields('feishu').map(field => field.key), ['appId', 'appSecret'])
  assert.deepEqual(botConnectionFields('wechat'), [])
  assert.throws(() => botConnectionPatch(fixture({ config: {}, secrets: {} }), draft, true), /required/)
  assert.deepEqual(botConnectionPatch(fixture({ config: {}, secrets: {} }), draft, false), { config: { enabled: false } })
})

test('platform-first rendered selection reuses only this Project connection and connect sends enabled alone', async t => {
  let bot = fixture(); const requests: ReturnType<typeof calls>[] = []
  t.mock.method(globalThis, 'fetch', async (url: URL | RequestInfo, init?: RequestInit) => {
    requests.push(calls(url, init)); assert.equal(init?.redirect, 'error')
    if (init?.method === 'PATCH') { bot = { ...bot, enabled: true, state: 'connected' }; return Response.json({ channel: bot }) }
    return Response.json({ channels: [bot, fixture({ id: 'discord-bot', platform: 'discord', config: {}, secrets: { token: true } })] })
  })
  const view = mountBotUi(t, 'BotConnectionSetup.vue', props)
  await settleBotUi(); assert.equal(view.nodes().filter(node => node.tag === 'select').length, 1)
  await view.select(0, 'qq'); assert.doesNotMatch(view.text(), /discord-bot/)
  await view.select(1, 'connection:qq-bot'); assert.equal(view.nodes().filter(node => node.tag === 'input').length, 0)
  await view.click('Connect')
  assert.deepEqual(requests.filter(item => item.method !== 'GET'), [{ path: '/projects/p/api/channels/qq-bot', method: 'PATCH', body: { config: { enabled: true } } }])
  assert.match(view.text(), /To run a BOT, assign it to the exact conversation/)
  assert.doesNotMatch(view.text(), /saved-id|replacement/)
})

test('private credential fields contain no saved values, cancel clears input, and saving cannot alter permissions', async t => {
  const requests: ReturnType<typeof calls>[] = [], bot = fixture()
  t.mock.method(globalThis, 'fetch', async (url: URL | RequestInfo, init?: RequestInit) => { requests.push(calls(url, init)); return Response.json(init?.method === 'PATCH' ? { channel: bot } : { channels: [bot] }) })
  const view = mountBotUi(t, 'BotConnectionSetup.vue', { ...props, compact: true })
  await settleBotUi(); await view.select(0, 'qq'); await view.select(1, `connection:${bot.id}`); await view.click('Update private credentials')
  assert.deepEqual(view.nodes().filter(node => node.tag === 'input').map(node => [node.props.name, node.props.inputValue]), [['appId', ''], ['secret', '']])
  assert.equal(view.nodes().find(node => node.props.name === 'secret')?.props.type, 'password')
  view.input('secret', 'synthetic-private-value'); await view.click('Cancel'); await view.click('Update private credentials')
  assert.equal(view.nodes().find(node => node.props.name === 'secret')?.props.inputValue, '')
  view.input('secret', 'synthetic-private-value'); await view.submit()
  assert.deepEqual(requests.filter(item => item.method === 'PATCH').map(item => item.body), [{ config: { enabled: true, secret: 'synthetic-private-value' } }])
  assert.doesNotMatch(view.text(), /synthetic-private-value|saved-id|Remove connection|BOT deployments|Saved service access/)
})

test('uncertain credential mutation clears inputs, never displays response secrets, and requires explicit status refresh', async t => {
  let mutations = 0
  t.mock.method(globalThis, 'fetch', async (_url: URL | RequestInfo, init?: RequestInit) => {
    if (init?.method === 'PATCH') { mutations++; return new Response('synthetic-private-value', { status: 500 }) }
    return Response.json({ channels: [fixture()] })
  })
  const view = mountBotUi(t, 'BotConnectionSetup.vue', props)
  await settleBotUi(); await view.select(0, 'qq'); await view.select(1, 'connection:qq-bot'); await view.click('Update private credentials')
  view.input('secret', 'synthetic-private-value'); await view.submit()
  assert.match(view.text(), /Private values have been cleared/); assert.doesNotMatch(view.text(), /synthetic-private-value/)
  assert.equal(view.nodes().find(node => node.tag === 'button' && node.text === 'Connect')?.props.disabled, true)
  await view.click('Refresh status'); await view.click('Connect'); assert.equal(mutations, 2)
})

test('new connection requires a platform and defaults its name, and empty state stays actionable', async t => {
  const requests: ReturnType<typeof calls>[] = []
  t.mock.method(globalThis, 'fetch', async (url: URL | RequestInfo, init?: RequestInit) => {
    requests.push(calls(url, init))
    return Response.json(init?.method === 'POST' ? { channel: fixture({ id: 'created', platform: 'discord', displayName: 'Discord', configured: false, config: {}, secrets: {} }) } : { channels: [] })
  })
  const view = mountBotUi(t, 'BotConnectionSetup.vue', props)
  await settleBotUi(); await view.select(0, 'discord'); assert.match(view.text(), /No connections for this platform/)
  await view.select(1, 'new'); assert.equal(view.nodes().filter(node => node.tag === 'select').length, 2)
  await view.submit()
  assert.deepEqual(requests.filter(item => item.method === 'POST').map(item => item.body), [{ platform: 'discord', displayName: 'Discord', config: { enabled: false } }])
  assert.deepEqual(view.nodes().filter(node => node.tag === 'input').map(node => node.props.name), ['token'])
  assert.match(view.text(), /assign it to the exact conversation/)
  assert.doesNotMatch(view.text(), /Start owner pairing|Publish and assign an Agent/)
})

test('Project changes abort in-flight private saves, clear secrets, and reject stale or foreign lists', async t => {
  let finish: ((response: Response) => void) | undefined, signal: AbortSignal | undefined
  t.mock.method(globalThis, 'fetch', async (_url: URL | RequestInfo, init?: RequestInit) => {
    if (init?.method === 'PATCH') { signal = init.signal!; return new Promise<Response>(resolve => { finish = resolve }) }
    return Response.json({ channels: [fixture()] })
  })
  const view = mountBotUi(t, 'BotConnectionSetup.vue', props)
  await settleBotUi(); await view.select(0, 'qq'); await view.select(1, 'connection:qq-bot'); await view.click('Update private credentials'); view.input('secret', 'private-stale')
  const saving = view.submit(); await settleBotUi()
  view.state.projectId = 'other'; view.state.apiBase = 'http://localhost/projects/other'; await settleBotUi()
  assert.equal(signal?.aborted, true); finish!(Response.json({ channel: fixture({ displayName: 'Stale response' }) })); await saving
  assert.doesNotMatch(view.text(), /Stale response|Existing QQ|private-stale/)
  assert.match(view.text(), /Could not load connections/)
  assert.equal(view.nodes().filter(node => node.tag === 'input').length, 0)
})

test('inactive or insecure cards do not fetch; hiding clears all private inputs', async t => {
  let count = 0
  t.mock.method(globalThis, 'fetch', async () => { count++; return Response.json({ channels: [fixture()] }) })
  const view = mountBotUi(t, 'BotConnectionSetup.vue', { ...props, active: false })
  await settleBotUi(); assert.equal(count, 0)
  view.state.active = true; await settleBotUi(); await view.select(0, 'qq'); await view.select(1, 'connection:qq-bot'); await view.click('Update private credentials'); view.input('secret', 'unsaved')
  view.state.active = false; await settleBotUi(); assert.equal(view.nodes().filter(node => node.tag === 'input').length, 0)
  view.state.apiBase = 'http://untrusted.example/projects/p'; view.state.active = true; await settleBotUi(); assert.equal(count, 1)
  assert.match(view.text(), /HTTPS or loopback/)
})


test('an uncertain create refreshes the server list and requires a fresh reuse choice, never silently repeats POST', async t => {
  let created = false, posts = 0
  t.mock.method(globalThis, 'fetch', async (_url: URL | RequestInfo, init?: RequestInit) => {
    if (init?.method === 'POST') { posts++; created = true; return new Response('', { status: 500 }) }
    return Response.json({ channels: created ? [fixture()] : [] })
  })
  const view = mountBotUi(t, 'BotConnectionSetup.vue', props)
  await settleBotUi(); await view.select(0, 'qq'); await view.select(1, 'new'); await view.submit()
  assert.equal(view.nodes().find(node => node.text === 'Create connection')?.props.disabled, true)
  await view.click('Refresh status')
  assert.equal(view.nodes().filter(node => node.tag === 'form').length, 0)
  await view.select(1, 'connection:qq-bot')
  assert.match(view.text(), /Existing QQ/); assert.equal(posts, 1)
})

test('WeChat QR stays private and login does not imply BOT access', async t => {
  let connected = false
  t.mock.method(globalThis, 'fetch', async (url: URL | RequestInfo) => {
    if (String(url).endsWith('/wechat/login')) return Response.json({ qrcodeUrl: 'synthetic-qr-content' })
    if (String(url).endsWith('/wechat/wait')) { connected = true; return Response.json({ connected: true }) }
    return Response.json({ channels: [fixture({ id: 'wechat-bot', platform: 'wechat', config: {}, secrets: {}, enabled: true, configured: true, state: connected ? 'connected' : 'connecting' })] })
  })
  const view = mountBotUi(t, 'BotConnectionSetup.vue', { ...props, compact: true })
  await settleBotUi(); await view.select(0, 'wechat'); await view.select(1, 'connection:wechat-bot')
  await view.click('Generate WeChat login QR code')
  assert.match(view.nodes().find(node => node.tag === 'img')?.props.src ?? '', /^data:image\/gif;base64,/)
  assert.doesNotMatch(view.text(), /synthetic-qr-content|Ready for your messages/)
  await view.click('Check WeChat login')
  assert.equal(view.nodes().some(node => node.tag === 'img'), false)
  assert.match(view.text(), /QR login connects the transport only.*Assign a Personal BOT to an exact recorded private inbox/)
  assert.doesNotMatch(view.text(), /To run a BOT, assign it to the exact conversation/)
  assert.equal(view.nodes().some(node => node.text === 'Generate WeChat login QR code'), false)
  view.state.active = false; await settleBotUi()
  assert.equal(view.nodes().some(node => node.tag === 'img'), false)
})

test('deep-linked connection selects exact ID after load, restores on mount, and never crosses Projects or mutates', async t => {
  const requests: ReturnType<typeof calls>[] = []
  let deleted = false
  t.mock.method(globalThis, 'fetch', async (url: URL | RequestInfo, init?: RequestInit) => {
    const request = calls(url, init); requests.push(request)
    const projectId = request.path.includes('/projects/q/') ? 'q' : 'p'
    return Response.json({ channels: projectId === 'q' ? [fixture({ id: 'other', projectId })] : [fixture(), ...deleted ? [] : [fixture({ id: 'second', displayName: 'Second QQ' })]] })
  })
  const view = mountBotUi(t, 'BotConnectionSetup.vue', { ...props, requestedConnectionId: 'second' })
  await settleBotUi()
  assert.match(view.text(), /Second QQ/)
  assert.equal(view.nodes().find(n => n.props.class === 'connection-id')?.text, 'second')
  view.state.requestedConnectionId = 'qq-bot'; await settleBotUi()
  assert.equal(view.nodes().find(n => n.props.class === 'connection-id')?.text, 'qq-bot')
  view.state.requestedConnectionId = 'missing'; await settleBotUi()
  assert.match(view.text(), /requested connection is unavailable/)
  assert(!view.nodes().some(n => n.props.class === 'selected-connection'))
  view.state.requestedConnectionId = 'second'; await settleBotUi()
  deleted = true; await view.click('Refresh status')
  assert.match(view.text(), /requested connection is unavailable/)
  assert(!view.nodes().some(n => n.props.class === 'selected-connection'))
  deleted = false
  view.unmount()
  const restored = mountBotUi(t, 'BotConnectionSetup.vue', { ...props, requestedConnectionId: 'second' })
  await settleBotUi()
  assert.equal(restored.nodes().find(n => n.props.class === 'connection-id')?.text, 'second')
  restored.state.apiBase = 'http://localhost/projects/q'; restored.state.projectId = 'q'; await settleBotUi()
  assert.match(restored.text(), /requested connection is unavailable/)
  assert(!restored.nodes().some(n => n.props.class === 'selected-connection'))
  assert(requests.some(r => r.path === '/projects/q/api/channels'))
  assert(requests.every(r => r.method === 'GET'))
})

test('configured connection cards stay visible across platforms and configure exact IDs without effects', async t => {
  const requests: ReturnType<typeof calls>[] = []
  t.mock.method(globalThis, 'fetch', async (url: URL | RequestInfo, init?: RequestInit) => {
    requests.push(calls(url, init))
    return Response.json({ channels: [fixture(), fixture({ id: 'discord-bot', platform: 'discord', displayName: 'Discord service', state: 'connected', config: {}, secrets: { token: true } })] })
  })
  const view = mountBotUi(t, 'BotConnectionSetup.vue', { ...props, compact: false, requestedConnectionId: 'discord-bot' })
  await settleBotUi()
  assert.equal(view.nodes().filter(n => n.props.class === 'connection-card').length, 2)
  assert.equal(view.nodes().filter(n => n.tag === 'select').length, 0)
  assert.equal(view.nodes().find(n => n.props.class === 'connection-id')?.text, 'discord-bot')
  const configure = view.nodes().find(n => n.tag === 'button' && n.props['aria-label'] === 'Configure Existing QQ')!
  await configure.props.onClick(); await settleBotUi()
  assert.equal(view.nodes().find(n => n.props.class === 'connection-id')?.text, 'qq-bot')
  assert.equal(view.nodes().filter(n => n.props.class === 'connection-card').length, 2)
  await view.click('Create a new connection')
  assert.equal(view.nodes().filter(n => n.props.class === 'connection-card').length, 2)
  await view.select(0, 'qq')
  assert(view.nodes().some(n => n.props.class === 'new-connection'))
  assert(requests.every(r => r.method === 'GET'))
})
