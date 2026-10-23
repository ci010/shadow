import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { app, BrowserWindow, session } from 'electron'
import { Hono } from 'hono'
import { uiPlugin } from '../../../src/gateway/ui.ts'
import { LiveFixture } from './live-fixture.ts'
import { activeWorkspaceScript } from './active-workspace.ts'

function argument(name: string): string {
  const value = process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
  assert.ok(value)
  return resolve(value)
}
const directory = argument('layout-root')
for (const name of ['userData', 'sessionData', 'logs', 'crashDumps'] as const) {
  mkdirSync(join(directory, name), { recursive: true })
  app.setPath(name, join(directory, name))
}
app.setPath('home', directory)
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
app.on('window-all-closed', () => {})
const ui = new Hono()
uiPlugin(argument('layout-assets'))(ui)
const live = new LiveFixture()
const folders = [
  { id: 'local', projectId: 'default', name: 'Local code', path: 'C:\\fixture\\local', createdAt: '2026-09-17' },
  { id: 'other-local', projectId: 'default', name: 'Other local code', path: 'C:\\fixture\\other', createdAt: '2026-09-17' },
  { id: 'remote', projectId: 'default', name: 'Remote code', path: '/fixture/remote', createdAt: '2026-09-17', kind: 'remote',
    workdir: { version: 1, nodeId: 'child', capabilityId: 'remote' },
    identity: { version: 1, rootId: 'a'.repeat(64), ancestorIds: [] } },
]
const errors: string[] = []
const writes: Array<{ path: string; body: Record<string, unknown> }> = []
const states = new Map<string, { sessionId: string; current: string; title: string; folderId?: string; remote: boolean }>()
let window: BrowserWindow | undefined
const server = createServer(async (request, response) => {
  try {
    if (live.handle(request, response)) return
    const url = new URL(request.url!, 'http://127.0.0.1')
    const path = url.pathname.replace(/^\/projects\/default(?=\/)/, '')
    const json = (data: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)) }
    let body: Record<string, unknown> = {}
    if (request.method === 'POST') {
      let content = ''
      for await (const chunk of request) content += chunk
      body = JSON.parse(content || '{}')
      writes.push({ path, body })
    }
    if (path === '/api/projects') return json({ projects: [{ id: 'default', name: 'Fixture project', createdAt: '2026-09-17' }] })
    if (path === '/api/automations') return json({ automations: [] })
    if (path === '/api/provider/setup') return json({ ready: true, provider: 'custom', model: 'synthetic', authMode: 'none', hasApiKey: false })
    if (path === '/api/provider/configured') return json({ providers: [] })
    if (path === '/debug/models') return json({ models: ['synthetic'] })
    if (path === '/api/config') return json({ agent: { model: 'synthetic', temperature: .7, workspace: directory } })
    if (path === '/api/folders') return json({ folders })
    if (path === '/nodes/v1') return json({ version: 1, nodes: [{
      nodeId: 'child', displayName: 'Fixture laptop', role: 'child', connection: 'connected', supportsManagedSessions: true,
      capabilities: [
        { capabilityId: 'remote', kind: 'workdir', displayName: 'Remote code', online: true },
        { capabilityId: 'foreign', kind: 'workdir', displayName: 'Another project private folder', displayPath: '/foreign/secret', online: true },
      ],
    }, { nodeId: 'old', displayName: 'Older laptop', role: 'child', connection: 'connected', capabilities: [] }] })
    if (path === '/api/sessions/remote' || /^\/api\/folders\/[^/]+\/sessions$/.test(path)) {
      const folderId = path === '/api/sessions/remote' ? undefined : path.split('/')[3]
      const isRemote = folderId === undefined || folderId === 'remote'
      if (!folderId) {
        assert.deepEqual(Object.keys(body).sort(), ['nodeId', 'requestId'])
        assert.equal(body.nodeId, 'child')
        assert.match(String(body.requestId), /^[0-9a-f-]{36}$/)
      }
      const chatId = `chat-${states.size + 1}`
      const sessionId = `web:${chatId}`
      states.set(sessionId, { sessionId, current: `physical-${chatId}`, title: 'Location fixture', folderId, remote: isRemote })
      return json({ sessionId, chatId, ...(folderId ? { folderId } : {}),
        ...(isRemote ? { workdir: { version: 1, nodeId: 'child', capabilityId: folderId ? 'remote' : 'managed-fixture' } } : {}) })
    }
    if (path === '/api/sessions/graph') return json({
      sessions: [...states.values()], nodes: [...states.values()].map(state => ({ physicalId: state.current, logicalId: state.sessionId })),
    })
    if (path === '/api/sessions/stages') return json({ stages: {}, activeRequestIds: {} })
    if (path === '/api/chat/session') return json({ history: [], systemPrompt: 'Synthetic fixture.', tools: [] })
    if (path === '/api/chat/send') {
      assert.equal(typeof body.chatId, 'string')
      assert.ok(states.has(`web:${body.chatId}`), 'Preparation must create the selected-location session first')
      const accepted = live.admit(String(body.chatId))
      setTimeout(() => live.finish(`web:${body.chatId}`), 100)
      return json(accepted)
    }
    if (/^\/api\/(?:folders|sessions)\/[^/]+\/files$/.test(path)) return json({ path: '', entries: [], workdir: { kind: 'local', displayPath: 'C:\\fixture' } })
    if (/\/git\/status$/.test(path)) return json({ available: false, reason: 'not_repository', entries: [] })
    const route = path.match(/^\/api\/sessions\/([^/]+)(?:\/(.*))?$/)
    if (route) {
      const sessionId = decodeURIComponent(route[1])
      const state = states.get(sessionId)
      if (route[2] === 'background-tasks') return json({ sessionId, total: 0, tasks: [] })
      if (route[2] === 'details') return json({
        sessionId, name: 'Location fixture', folderId: state?.folderId,
        workdir: state?.remote ? { kind: 'remote', displayPath: '/fixture', nodeId: 'child', capabilityId: 'remote', displayName: 'Fixture laptop', available: true }
          : { kind: 'local', displayPath: 'C:\\fixture' },
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, usageScope: 'session', context: { usedTokens: null, windowTokens: null },
      })
      if (!route[2]) return json({ messages: [], currentPhysicalId: state?.current, previousPhysicalId: null })
    }
    if (/^\/(?:api|nodes|debug|local)\//.test(path)) {
      errors.push(`Unexpected ${request.method} ${path}`)
      return json({ error: 'Unstubbed endpoint' }, 404)
    }
    const resource = await ui.request(url.toString())
    const type = resource.headers.get('Content-Type') || 'application/octet-stream'
    response.writeHead(resource.status, { 'Content-Type': type })
    const bytes = Buffer.from(await resource.arrayBuffer())
    response.end(type.includes('text/html') ? bytes.toString().replace(/<link\b[^>]*href=["']https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>/g, '') : bytes)
  } catch (error) {
    errors.push(String(error))
    response.writeHead(500).end()
  }
})
const evaluate = <T = unknown>(source: string): Promise<T> => window!.webContents.executeJavaScript(activeWorkspaceScript(source))
async function waitFor(source: string): Promise<void> {
  const end = Date.now() + 8000
  while (Date.now() < end) {
    if (await evaluate(source)) return
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error(`Timed out ${source}; ${JSON.stringify(errors)}`)
}
async function click(selector: string): Promise<void> {
  await waitFor(`!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`)
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
}
async function main(): Promise<void> {
  await app.whenReady()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({
    cancel: !details.url.startsWith(origin + '/') && !/^(data:|blob:|devtools:)/.test(details.url),
  }))
  window = new BrowserWindow({ width: 1440, height: 1000, show: false, webPreferences: {
    offscreen: true, backgroundThrottling: false, preload: join(directory, 'layout-preload.cjs'), additionalArguments: [`--layout-api-base=${origin}`],
  } })
  window.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message) })
  for (const [width, height] of [[1440, 1000], [390, 844]]) {
    window.setContentSize(width, height)
    await window.loadURL(`${origin}/projects/default/chat`)
    await click('.composer-controls [aria-label="Execution location"]')
    await waitFor(`document.querySelectorAll('.location-option').length === 6 && !document.querySelector('.location-refresh').disabled`)
    assert.equal(await evaluate(`document.querySelector('.composer-popover').textContent.includes('Other local code')`), true)
    assert.equal(await evaluate(`document.querySelector('.composer-popover').textContent.includes('Remote code')`), true)
    assert.equal(await evaluate(`document.querySelector('.composer-popover').textContent.includes('Another project private folder')`), false)
    assert.equal(await evaluate(`document.querySelector('[aria-label="Start from scratch on Older laptop"]').disabled`), true)
    const bounded = await evaluate<boolean>(`(() => { const r = document.querySelector('.composer-popover').getBoundingClientRect(); return r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1 })()`)
    assert.equal(bounded, true, `Picker overflows at ${width}px`)
    await click('.location-option[aria-label="Other local code"]')
    await waitFor(`document.querySelector('.draft-folder strong')?.textContent === 'Other local code'`)
    assert.equal(writes.length, 0, 'Choosing another local folder must not create a conversation')
  }
  for (const [label, endpoint] of [
    ['Other local code', '/api/folders/other-local/sessions'],
    ['Remote code', '/api/folders/remote/sessions'],
    ['Start from scratch on Fixture laptop', '/api/sessions/remote'],
  ]) {
    await window.loadURL(`${origin}/projects/default/chat`)
    await click('.composer-controls [aria-label="Execution location"]')
    await click(`.location-option[aria-label="${label}"]`)
    const before = writes.length
    await evaluate(`(() => { const input = document.querySelector('.composer-input textarea'); input.value = 'Synthetic location request'; input.dispatchEvent(new Event('input', { bubbles: true })) })()`)
    await click('.composer-send')
    await waitFor(`!document.querySelector('.draft-heading')`)
    const end = Date.now() + 8000
    while (writes.length < before + 2 && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 30))
    assert.deepEqual(writes.slice(before).map(write => write.path), [endpoint, '/api/chat/send'])
  }
  assert.deepEqual(errors, [])
  console.log('LAYOUT_RESULT ' + JSON.stringify({ ok: true, viewports: 2, locations: 3, writes: writes.length }))
}
main().then(() => { window?.destroy(); server.close(); live.close(); app.exit(0) }).catch(error => {
  console.error(error)
  console.log('LAYOUT_RESULT ' + JSON.stringify({ ok: false, error: String(error), errors }))
  window?.destroy()
  server.close()
  live.close()
  app.exit(1)
})
