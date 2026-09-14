import assert from 'node:assert/strict'
import { mkdirSync, realpathSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { app, BrowserWindow, session } from 'electron'
import { Hono } from 'hono'
import { uiPlugin } from '../../../src/gateway/ui.ts'

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
mkdirSync(join(directory, 'Home'), { recursive: true })
mkdirSync(join(directory, 'DifferentHome'), { recursive: true })
const home = realpathSync(join(directory, 'Home'))
const differentHome = realpathSync(join(directory, 'DifferentHome'))
const one = 'heartbeat:reflector-one'
const two = 'heartbeat:soul-reflector-two'
const labels = { [one]: 'Reflection one (read-only)', [two]: 'Reflection two (read-only)' }
let normalChats = true
let secondHome = home
let failSource = ''
let graphGate: Promise<void> | undefined
let rootGate: { sessionId: string; wait: Promise<void> } | undefined
let graphRequests = 0
const files: Array<{ sessionId: string; path: string }> = []
const previews: Array<{ sessionId: string; path: string }> = []
const errors: string[] = []
let phase = 'initializing'
let window: BrowserWindow | undefined
const ui = new Hono()
uiPlugin(argument('layout-assets'))(ui)
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url!, 'http://127.0.0.1')
    const path = url.pathname
    const json = (data: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)) }
    if (path === '/api/provider/setup') return json({ ready: true, provider: 'custom', model: 'synthetic-model', authMode: 'none', hasApiKey: false })
    if (path === '/api/provider/configured') return json({ providers: [{ provider: 'custom', model: 'synthetic-model', selected: true, authMode: 'none', hasApiKey: false }] })
    if (path === '/debug/models') return json({ models: ['synthetic-model'] })
    if (path === '/api/config') return json({ agent: { model: 'synthetic-model' } })
    if (path === '/api/projects') return json({ projects: [] })
    if (path === '/api/sessions/graph') {
      graphRequests++
      if (graphGate) await graphGate
      return json({
        sessions: [
          ...(normalChats ? [{ sessionId: 'web:chat-normal', current: 'physical-normal', title: 'Ordinary chat' }] : []),
          { sessionId: one, current: 'physical-one', title: 'Reflection one' },
          { sessionId: two, current: 'physical-two', title: 'Reflection two' },
        ],
        nodes: [{ physicalId: 'physical-one', logicalId: one }, { physicalId: 'physical-two', logicalId: two }],
      })
    }
    if (path === '/api/sessions/stages') return json({ stages: { [one]: 'idle', [two]: 'idle' } })
    if (path === '/api/chat/events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(': reflection fixture\n\n')
      return
    }
    const route = path.match(/^\/api\/sessions\/([^/]+)(?:\/(.*))?$/)
    if (route) {
      const sessionId = decodeURIComponent(route[1])
      assert.ok([one, two].includes(sessionId))
      const operation = route[2]
      if (operation === 'files') {
        const folder = url.searchParams.get('path') || ''
        files.push({ sessionId, path: folder })
        if (!folder && rootGate?.sessionId === sessionId) await rootGate.wait
        if (failSource === sessionId) return json({ error: 'workdir_unavailable', message: 'Synthetic Home validation failure' }, 503)
        const names = folder === '' ? ['agents', 'memory.md'] : folder === 'agents' ? ['nested'] : [
          'stable.txt', ...Array.from({ length: 48 }, (_, index) => `item-${String(index).padStart(2, '0')}.txt`),
        ]
        return json({
          path: folder, workdir: { kind: 'local', scope: 'home', displayPath: sessionId === two ? secondHome : home },
          entries: names.map(name => ({ name, type: ['agents', 'nested'].includes(name) ? 'dir' : 'file', ext: name.includes('.') ? name.slice(name.lastIndexOf('.')) : '', size: 20, mtime: '2026-09-01T00:00:00Z' })),
        })
      }
      if (operation === 'preview') {
        previews.push({ sessionId, path: url.searchParams.get('path') || '' })
        return json({ binary: false, size: 20, content: 'Synthetic Home file\n', truncated: false })
      }
      if (operation === 'git/status') return json({ available: false, reason: 'not_repository', entries: [] })
      if (operation === 'details') return json({ sessionId, name: sessionId === one ? 'Reflection one' : 'Reflection two', workdir: { kind: 'local', displayPath: 'C:\\synthetic\\execution-only' }, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, usageScope: 'session' })
      if (operation === 'context') return json({ systemPrompt: 'Synthetic reflection context', tools: [] })
      if (!operation) return json({ messages: [{ role: 'assistant', content: sessionId === one ? 'First reflection.' : 'Second reflection.' }], currentPhysicalId: sessionId === one ? 'physical-one' : 'physical-two', previousPhysicalId: null })
    }
    if (/^\/(?:api|nodes|debug|v1|local)\//.test(path)) {
      errors.push(`Unstubbed ${request.method} ${path}`)
      return json({ error: 'Unstubbed fixture endpoint' }, 404)
    }
    const resource = await ui.request(url.toString())
    const contentType = resource.headers.get('Content-Type') || 'application/octet-stream'
    response.writeHead(resource.status, { 'Content-Type': contentType,
      'Content-Security-Policy': "default-src 'self' data:; img-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' blob:; font-src 'self' data:" })
    const body = Buffer.from(await resource.arrayBuffer())
    response.end(contentType.includes('text/html') ? body.toString().replace(/<link\b[^>]*href=["']https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>/g, '') : body)
  } catch (error) {
    errors.push(String(error))
    response.writeHead(500).end()
  }
})
const evaluate = <T = unknown>(source: string): Promise<T> => window!.webContents.executeJavaScript(source)
async function waitFor(source: string): Promise<void> {
  const end = Date.now() + 8000
  while (Date.now() < end) {
    if (await evaluate(source)) return
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  throw new Error(`${phase}: timed out ${source}; errors=${JSON.stringify(errors)}; files=${JSON.stringify(files.slice(-8))}`)
}
async function waitRequest(predicate: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 8000
  while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 30))
  assert.ok(predicate(), `${phase}: ${label}; graphRequests=${graphRequests}; files=${JSON.stringify(files.slice(-8))}`)
}
async function click(selector: string): Promise<void> {
  await waitFor(`!!document.querySelector(${JSON.stringify(selector)})`)
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
}
const sessionButton = (sessionId: string) => `.projects-sidebar .session-select[aria-label="${labels[sessionId]}"]`
const row = (path: string) => `.workbench-explorer .tree-row[data-path="${path}"]`
async function expandHome(): Promise<void> {
  await waitFor(`document.querySelector('.file-tree-root-label')?.textContent === 'Home' && !!document.querySelector(${JSON.stringify(row('agents'))})`)
  await click(row('agents'))
  await waitFor(`!!document.querySelector(${JSON.stringify(row('agents/nested'))})`)
  await click(row('agents/nested'))
  await waitFor(`!!document.querySelector(${JSON.stringify(row('agents/nested/stable.txt'))})`)
  await evaluate(`document.querySelector('.file-tree-body').scrollTop = 40`)
}
async function rememberHome(): Promise<void> {
  await evaluate(`window.homeRefs = {
    root: document.querySelector('.file-tree-root'),
    folder: document.querySelector(${JSON.stringify(row('agents'))}),
    nested: document.querySelector(${JSON.stringify(row('agents/nested'))}),
    leaf: document.querySelector(${JSON.stringify(row('agents/nested/stable.txt'))}),
    scrollTop: document.querySelector('.file-tree-body').scrollTop
  }`)
}
async function assertHomeIdentity(): Promise<void> {
  assert.deepEqual(await evaluate(`(() => {
    const selectors = { root: '.file-tree-root', folder: ${JSON.stringify(row('agents'))}, nested: ${JSON.stringify(row('agents/nested'))}, leaf: ${JSON.stringify(row('agents/nested/stable.txt'))} };
    return Object.entries(selectors).filter(([key, selector]) => !window.homeRefs[key].isConnected || window.homeRefs[key] !== document.querySelector(selector)).map(([key]) => key);
  })()`), [], `${phase}: verified Home rows retain their actual DOM objects`)
  assert.equal(await evaluate(`window.homeRefs.leaf.getClientRects().length > 0 && document.querySelector('.file-tree-body').scrollTop === window.homeRefs.scrollTop`), true, 'Nested expansion and explorer scroll position stay unchanged')
}
async function sharedSwitch(target: string, checkGeometry = true): Promise<void> {
  let releaseGraph!: () => void, releaseRoot!: () => void
  graphGate = new Promise(resolve => { releaseGraph = resolve })
  rootGate = { sessionId: target, wait: new Promise(resolve => { releaseRoot = resolve }) }
  const beforeGraph = graphRequests
  const beforeFiles = files.length
  const beforePreviews = previews.length
  await evaluate(`window.sidebarRefs = {
    toggle: document.querySelector('.self-reflection-toggle'),
    target: document.querySelector(${JSON.stringify(sessionButton(target))}),
    toggleY: document.querySelector('.self-reflection-toggle').getBoundingClientRect().y,
    rowY: document.querySelector(${JSON.stringify(sessionButton(target))}).getBoundingClientRect().y
  }`)
  await click(sessionButton(target))
  await waitRequest(() => graphRequests > beforeGraph && files.slice(beforeFiles).some(item => item.sessionId === target && item.path === ''), 'selection starts graph refresh and candidate Home validation')
  await assertHomeIdentity()
  const pendingSidebar = await evaluate<{ same: boolean; toggleDelta: number; rowDelta: number }>(`({
    same: window.sidebarRefs.toggle.isConnected && window.sidebarRefs.target.isConnected
      && window.sidebarRefs.toggle === document.querySelector('.self-reflection-toggle')
      && window.sidebarRefs.target === document.querySelector(${JSON.stringify(sessionButton(target))}),
    toggleDelta: document.querySelector('.self-reflection-toggle').getBoundingClientRect().y - window.sidebarRefs.toggleY,
    rowDelta: document.querySelector(${JSON.stringify(sessionButton(target))}).getBoundingClientRect().y - window.sidebarRefs.rowY
  })`)
  assert.equal(pendingSidebar.same, true, 'Loading graph never remounts the selected reflection row or toggle')
  if (checkGeometry) {
    assert.ok(Math.abs(pendingSidebar.toggleDelta) < 1 && Math.abs(pendingSidebar.rowDelta) < 1, `Loading conversations causes no sidebar jump: ${JSON.stringify(pendingSidebar)}`)
  }
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.file-tree-note')).some(node => node.getClientRects().length && /Loading files/i.test(node.textContent))`), false)
  assert.equal(await evaluate(`!!(window.homeRefs.folder.closest('[aria-disabled="true"]') || window.homeRefs.folder.querySelector('[aria-disabled="true"]'))`), true, 'Retained Home rows are explicitly disabled during new-source validation')
  await click(row('agents'))
  await click(row('agents/nested/stable.txt'))
  await assertHomeIdentity()
  assert.equal(previews.length, beforePreviews, 'Pending retained-file clicks cannot use the old client or open a preview')
  assert.equal(files.slice(beforeFiles).some(item => item.path !== ''), false, 'Children do not fetch before the new Home has been validated')
  graphGate = undefined
  releaseGraph()
  rootGate = undefined
  releaseRoot()
  await waitRequest(() => files.slice(beforeFiles).some(item => item.sessionId === target && item.path === 'agents/nested'), 'preserved expanded descendants refetch through the new session endpoint')
  await waitFor(`document.querySelector(${JSON.stringify(sessionButton(target))})?.getAttribute('aria-current') === 'page'`)
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  await assertHomeIdentity()
  assert.equal(files.slice(beforeFiles).every(item => item.sessionId === target), true, 'A committed shared Home never fetches children through the previous session transport')
  if (checkGeometry) assert.equal(await evaluate(`Math.abs(document.querySelector('.self-reflection-toggle').getBoundingClientRect().y - window.sidebarRefs.toggleY) < 1 && Math.abs(document.querySelector(${JSON.stringify(sessionButton(target))}).getBoundingClientRect().y - window.sidebarRefs.rowY) < 1`), true)
}
async function main(): Promise<void> {
  await app.whenReady()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith(origin + '/') || /^(data:|blob:|devtools:)/.test(details.url)
    if (!allowed) errors.push(`External request blocked: ${details.url}`)
    callback({ cancel: !allowed })
  })
  window = new BrowserWindow({ width: 1400, height: 1000, show: false, webPreferences: { offscreen: true, backgroundThrottling: false,
    preload: join(directory, 'layout-preload.cjs'), additionalArguments: [`--layout-api-base=${origin}`] } })
  window.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message) })
  await window.loadURL(`${origin}/chat/${encodeURIComponent(one)}`)
  window.webContents.debugger.attach('1.3')
  await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  await waitFor(`!!document.querySelector('.self-reflection-toggle')`)
  if (await evaluate(`document.querySelector('.self-reflection-toggle').getAttribute('aria-expanded')`) !== 'true') await click('.self-reflection-toggle')
  await expandHome()
  await rememberHome()
  phase = 'shared Home with ordinary Chats'
  await sharedSwitch(two)
  phase = 'removing ordinary Chats from fixture inventory'
  normalChats = false
  await sharedSwitch(one, false)
  await waitFor(`!document.querySelector('.legacy-chats .session-select')`)
  phase = 'shared Home with empty ordinary Chats'
  await sharedSwitch(two)
  phase = 'shared Home in collapsed Projects rail'
  await click('[aria-label="Collapse projects"]')
  await waitFor(`!!document.querySelector('.projects-sidebar.is-rail')`)
  await sharedSwitch(one)
  phase = 'different Home invalidates shared identities'
  secondHome = differentHome
  const beforeDifferent = files.length
  await click(sessionButton(two))
  await waitRequest(() => files.slice(beforeDifferent).some(item => item.sessionId === two && item.path === ''), 'different Home validation')
  await waitFor(`document.querySelector('.file-tree-root')?.getAttribute('aria-label')?.includes(${JSON.stringify(differentHome)})`)
  assert.equal(await evaluate(`window.homeRefs.folder.isConnected || window.homeRefs.nested.isConnected || window.homeRefs.leaf.isConnected`), false, 'A different canonical Home never inherits the previous subtree')
  await expandHome()
  await rememberHome()
  phase = 'failed candidate validation clears retained Home'
  failSource = one
  await click(sessionButton(one))
  await waitFor(`!document.querySelector('.workbench-explorer .tree-row[data-path]') && !!document.querySelector('.file-tree-note')`)
  assert.equal(await evaluate(`window.homeRefs.folder.isConnected || window.homeRefs.leaf.isConnected`), false)
  assert.match(await evaluate<string>(`document.querySelector('.workbench-explorer').textContent`), /unavailable|failed|retry/i)
  assert.deepEqual(errors, [], 'Reflection fixture has no unexpected native client or server failures')
  console.log('LAYOUT_RESULT ' + JSON.stringify({ ok: true, fixture: 'reflection-stability', graphRequests, listingRequests: files.length, sharedHomeCases: 4, differentHome: true, failedValidation: true }))
}
main().catch(error => {
  console.error(error)
  console.log('LAYOUT_FAILURE ' + JSON.stringify({ phase, message: String(error), errors, graphRequests, files: files.slice(-12) }))
  process.exitCode = 1
}).finally(async () => {
  if (window && !window.isDestroyed()) {
    if (window.webContents.debugger.isAttached()) {
      await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {})
      window.webContents.debugger.detach()
    }
    window.webContents.disableDeviceEmulation()
    window.destroy()
  }
  server.closeAllConnections()
  server.close()
  app.exit(process.exitCode || 0)
})
