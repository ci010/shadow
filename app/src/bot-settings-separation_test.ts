import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import test from 'node:test'
import { mountBotUi, settleBotUi } from './bot-ui-test-helpers.ts'

const props = { apiBase: 'http://localhost/projects/p', projectId: 'p', active: true, available: true }
const bot = { id: 'qq-service', projectId: 'p', platform: 'qq', displayName: 'Shared QQ', purpose: 'service', label: 'QQ', enabled: false, configured: true, state: 'disabled', config: { appId: 'saved-app-id' }, secrets: { secret: true } }

test('Connections is a separate Project route and navigation; legacy channels goes to connections', () => {
  const router = readFileSync(new URL('./router.ts', import.meta.url), 'utf8')
  const settings = readFileSync(new URL('./components/ProjectSettings.vue', import.meta.url), 'utf8')
  assert.match(router, /section\(general\|models\|connections\|bots\|agents\)/)
  assert.match(router, /path: '\/settings\/channels', redirect: '\/projects\/default\/settings\/connections'/)
  assert.match(settings, /id: 'connections', get label\(\) \{ return t\('Connections'\)/)
  assert.match(settings, /:section="section === 'connections' \? 'connections' : 'bots'"/)
})

test('BOT settings is read-only deployment inventory with an explicit project chat entry and connection link', async t => {
  const paths: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: URL | RequestInfo, init?: RequestInit) => {
    assert.equal(init?.method ?? 'GET', 'GET')
    const path = new URL(String(input)).pathname; paths.push(path)
    assert.equal(path, '/projects/p/api/bot-package')
    return Response.json({ deployments: [{ id: 'support', revision: 'abc123', mode: 'bounded', source: { folderId: 'source', directory: 'support' } }], pending: [] })
  })
  const view = mountBotUi(t, 'ChannelsView.vue', { ...props, section: 'bots' })
  await settleBotUi()
  assert.match(view.text(), /BOT.md and bot.json/)
  assert.match(view.text(), /does not maintain a second binding configuration/)
  assert.match(view.text(), /support/)
  assert.equal(view.nodes().filter(node => node.tag === 'input' || node.tag === 'form' || node.tag === 'select').length, 0)
  const chat = view.nodes().find(node => node.tag === 'a' && node.props.to?.name === 'chat')
  assert.deepEqual(chat?.props.to, { name: 'chat', params: { projectId: 'p' } })
  assert.ok(view.nodes().some(node => node.tag === 'a' && node.props.to?.params.section === 'connections'))
  assert.deepEqual(paths, ['/projects/p/api/bot-package'])
})

test('switching Connections to BOT inventory destroys private drafts and never writes bindings or credentials', async t => {
  const requests: string[] = []
  t.mock.method(globalThis, 'fetch', async (input: URL | RequestInfo, init?: RequestInit) => {
    assert.equal(init?.method ?? 'GET', 'GET')
    const path = new URL(String(input)).pathname; requests.push(path)
    if (path.endsWith('/api/channels')) return Response.json({ channels: [bot] })
    assert.ok(path.endsWith('/api/bot-package'))
    return Response.json({ deployments: [], pending: [] })
  })
  const view = mountBotUi(t, 'ChannelsView.vue', { ...props, section: 'connections' })
  await settleBotUi()
  assert.match(view.text(), /Multiple BOTs can reuse one service connection/)
  assert.match(view.text(), /QQ and Discord chats cannot open this private card/)
  assert.ok(!requests.some(path => path.endsWith('/api/bot-package')))
  await view.select(0, 'qq'); await view.select(1, 'connection:qq-service')
  await view.click('Update private credentials')
  view.input('secret', 'synthetic-unsaved')
  view.state.section = 'bots'; await settleBotUi()
  assert.equal(view.nodes().filter(node => node.tag === 'input').length, 0)
  view.state.section = 'connections'; await settleBotUi()
  await view.select(0, 'qq'); await view.select(1, 'connection:qq-service')
  await view.click('Update private credentials')
  assert.equal(view.nodes().find(node => node.tag === 'input' && node.props.name === 'secret')?.props.inputValue, '')
})
