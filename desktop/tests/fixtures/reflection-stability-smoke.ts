import assert from 'node:assert/strict'
import { mkdirSync, realpathSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { app, BrowserWindow, session } from 'electron'
import { Hono } from 'hono'
import { uiPlugin } from '../../../src/gateway/ui.ts'
import { LiveFixture } from './live-fixture.ts'

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
const one = 'cron:opaque-run-one'
const two = 'cron:opaque-run-two'
const automation = { jobId: 'learning:encapsulator', name: 'Encapsulation', runId: 'one', startedAt: '2026-09-16T00:00:00Z', contextMode: 'fresh',
  config: { source: 'learning', schedule: 'every 5m', agentType: 'encapsulator' } }
let normalChats = true
let secondHome = home
let failSource = ''
let graphGate: Promise<void> | undefined
let rootGate: { sessionId: string; wait: Promise<void> } | undefined
let detailsGate: Promise<void> | undefined
let childrenGate: Promise<void> | undefined
let graphRequests = 0
const files: Array<{ sessionId: string; path: string }> = []
const previews: Array<{ sessionId: string; path: string }> = []
const errors: string[] = []
let phase = 'initializing'
let window: BrowserWindow | undefined
const ui = new Hono()
const live = new LiveFixture()
uiPlugin(argument('layout-assets'))(ui)
const server = createServer(async (request, response) => {
  try {
    if (await live.handle(request, response)) return
    const url = new URL(request.url!, 'http://127.0.0.1')
    const path = url.pathname.replace(/^\/projects\/default(?=\/)/, '')
    const json = (data: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)) }
    if (path === '/api/projects') return json({ projects: [{ id: 'default', name: 'Default', createdAt: '2026-09-15T00:00:00Z' }] })
    if (path === '/api/provider/setup') return json({ ready: true, provider: 'custom', model: 'synthetic-model', authMode: 'none', hasApiKey: false })
    if (path === '/api/provider/configured') return json({ providers: [{ provider: 'custom', model: 'synthetic-model', selected: true, authMode: 'none', hasApiKey: false }] })
    if (path === '/debug/models') return json({ models: ['synthetic-model'] })
    if (path === '/api/config') return json({ agent: { model: 'synthetic-model', workspace: home, temperature: 0.7 } })
    if (path === '/api/folders') return json({ folders: [] })
    if (path === '/api/automations') return json({ automations: [{
      id: automation.jobId, name: automation.name, source: 'learning', session: 'fresh', schedule: 'every 5m', task: 'Review new activity', agentType: automation.config.agentType, enabled: true,
    }] })
    if (path === `/api/automations/${encodeURIComponent(automation.jobId)}/runs`) return json({ total: 2, offset: 0, runs: [
      { id: 'one', sessionId: one, startedAt: automation.startedAt, status: 'completed', title: 'Reflection one' },
      { id: 'two', sessionId: two, startedAt: '2026-09-16T01:00:00Z', status: 'completed', title: 'Reflection two' },
    ] })
    if (path === '/api/sessions/graph') {
      graphRequests++
      if (graphGate) await graphGate
      return json({
        sessions: [
          ...(normalChats ? [{ sessionId: 'web:chat-normal', projectId: 'default', current: 'physical-normal', title: 'Ordinary chat' }] : []),
          { sessionId: one, projectId: 'default', current: 'physical-one', title: 'Reflection one', automation },
          { sessionId: two, projectId: 'default', current: 'physical-two', title: 'Reflection two', automation: { ...automation, runId: 'two' } },
        ],
        nodes: [{ physicalId: 'physical-one', logicalId: one }, { physicalId: 'physical-two', logicalId: two }],
      })
    }
    if (path === '/api/sessions/stages') return json({ stages: { [one]: 'idle', [two]: 'idle' } })
    const route = path.match(/^\/api\/sessions\/([^/]+)(?:\/(.*))?$/)
    if (route) {
      const sessionId = decodeURIComponent(route[1])
      if (route[2] === 'background-tasks') return json({ sessionId, total: 0, tasks: [] })
      assert.ok([one, two].includes(sessionId))
      const operation = route[2]
      if (operation === 'files') {
        const folder = url.searchParams.get('path') || ''
        files.push({ sessionId, path: folder })
        if (!folder && rootGate?.sessionId === sessionId) await rootGate.wait
        if (folder && childrenGate) await childrenGate
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
      if (operation === 'details') {
        if (detailsGate) await detailsGate
        return json({ sessionId, name: sessionId === one ? 'Reflection one' : 'Reflection two', workdir: { kind: 'local', displayPath: 'C:\\synthetic\\execution-only' }, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, usageScope: 'session', context: { usedTokens: null, windowTokens: null } })
      }
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
const sessionButton = (sessionId: string) => `.automation-run[data-session-id="${sessionId}"]`
async function selectRun(sessionId: string) {
  await waitFor("!!document.querySelector('select[aria-label=\"Run\"]')")
  await evaluate(`(() => {
    const select = document.querySelector('select[aria-label="Run"]');
    select.value = ${JSON.stringify(sessionId)};
    select.dispatchEvent(new Event('change', { bubbles: true }));
  })()`)
}
const pane = '.project-conversation:not([style*="display: none"])'
const row = (path: string) => `${pane} .workbench-explorer .tree-row[data-path="${path}"]`
async function rememberHome(): Promise<void> {
  await evaluate(`window.homeRefs = {
    root: document.querySelector('${pane} .file-tree-root'),
    folder: document.querySelector(${JSON.stringify(row('agents'))}),
    nested: document.querySelector(${JSON.stringify(row('agents/nested'))}),
    leaf: document.querySelector(${JSON.stringify(row('agents/nested/stable.txt'))}),
    scrollTop: document.querySelector('${pane} .file-tree-body').scrollTop
  }`)
}
async function assertHomeIdentity(): Promise<void> {
  assert.deepEqual(await evaluate(`(() => {
    const selectors = { root: '${pane} .file-tree-root', folder: ${JSON.stringify(row('agents'))}, nested: ${JSON.stringify(row('agents/nested'))}, leaf: ${JSON.stringify(row('agents/nested/stable.txt'))} };
    return Object.entries(selectors).filter(([key, selector]) => !window.homeRefs[key].isConnected || window.homeRefs[key] !== document.querySelector(selector)).map(([key]) => key);
  })()`), [], `${phase}: verified Home rows retain their actual DOM objects`)
  const state = await evaluate<{ visible: boolean; scrollTop: number; savedScrollTop: number }>(`({
    visible:window.homeRefs.leaf.getClientRects().length > 0,
    scrollTop:document.querySelector('${pane} .file-tree-body').scrollTop,
    savedScrollTop:window.homeRefs.scrollTop
  })`)
  assert.deepEqual(state, { visible: true, scrollTop: state.savedScrollTop, savedScrollTop: state.savedScrollTop }, 'Nested expansion and explorer scroll position stay unchanged')
}
async function pointerClick(selector: string): Promise<void> {
  const point = await evaluate<{ x: number; y: number }>(`(() => {
    const e=document.querySelector(${JSON.stringify(selector)});e.scrollIntoView({block:'nearest'});
    const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}
  })()`)
  await window!.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
  await window!.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mousePressed', button: 'left', clickCount: 1, ...point })
  await window!.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseReleased', button: 'left', clickCount: 1, ...point })
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
  await window.loadURL(`${origin}/projects/default/chat`)
  window.webContents.debugger.attach('1.3')
  await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  await waitFor(`!!document.querySelector('.automation-entry')`)
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.folders-header [aria-haspopup="menu"]')).opacity`), '1',
    'Project new-work action remains visible independently of hover-only folder row actions')
  await click('.automation-entry')
  await waitFor(`!!document.querySelector(${JSON.stringify(sessionButton(one))})`)
  phase = 'first reflection has one stable layout while graph and details are delayed'
  let releaseGraph!: () => void, releaseDetails!: () => void
  graphGate = new Promise(resolve => { releaseGraph = resolve })
  detailsGate = new Promise(resolve => { releaseDetails = resolve })
  await pointerClick(sessionButton(one))
  await waitFor(`!!document.querySelector('${pane} .chat-workspace:not(.is-draft)')`)
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  const before = await evaluate<{ x: number; explorer: boolean; popup: boolean }>(`({
    x:document.querySelector('${pane} .chat-panel').getBoundingClientRect().x,
    explorer:!!document.querySelector('${pane} .workbench-explorer')?.getClientRects().length,
    popup:!!document.querySelector('.hover-info-popup')
  })`)
  console.log('LAYOUT_BASELINE ' + JSON.stringify(before))
  assert.equal(before.explorer, true, 'Reflection Home layout is reserved before graph/details complete')
  assert.equal(before.popup, false, 'Clicking a full session row must not flash its hover card')
  assert.match(await evaluate<string>(`document.querySelector('${pane} .chat-history').textContent`), /Loading history/, 'An unresolved conversation must not flash an empty-history state')
  graphGate = undefined
  releaseGraph()
  await waitFor(`!!document.querySelector(${JSON.stringify(row('agents'))})`)
  detailsGate = undefined
  releaseDetails()
  await waitFor(`document.querySelector('${pane} .heading-folder')?.textContent === 'execution-only'`)
  assert.equal(await evaluate(`document.querySelector('${pane} .chat-panel').getBoundingClientRect().x`), before.x, 'Details must not push the conversation sideways')

  phase = 'folder click leaves sibling geometry and other regions unchanged'
  let releaseChildren!: () => void
  childrenGate = new Promise(resolve => { releaseChildren = resolve })
  const siblingY = await evaluate<number>(`document.querySelector(${JSON.stringify(row('memory.md'))}).getBoundingClientRect().y`)
  await pointerClick(row('agents'))
  await waitRequest(() => files.some(item => item.sessionId === one && item.path === 'agents'), 'folder fetch starts')
  const pending = await evaluate(`({
    siblingY:document.querySelector(${JSON.stringify(row('memory.md'))}).getBoundingClientRect().y,
    popup:!!document.querySelector('.hover-info-popup'),
    heading:document.querySelector('${pane} .heading-folder').textContent,
    x:document.querySelector('${pane} .chat-panel').getBoundingClientRect().x
  })`)
  assert.deepEqual(pending, { siblingY, popup: false, heading: 'execution-only', x: before.x }, 'No transient loading row, popup, or conversation shift on folder click')
  childrenGate = undefined
  releaseChildren()
  await waitFor(`!!document.querySelector(${JSON.stringify(row('agents/nested'))})`)
  await click(row('agents/nested'))
  await waitFor(`!!document.querySelector(${JSON.stringify(row('agents/nested/stable.txt'))})`)
  phase = 'keyboard focus and explicit hover-card navigation remain available'
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
  await waitFor(`!!document.querySelector('.hover-info-popup')`)
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  if (!await evaluate(`!!document.querySelector('${pane} .workbench-explorer')?.getClientRects().length`)) {
    await click(`${pane} [aria-label="Toggle files"]`)
    await waitFor(`!!document.querySelector('${pane} .workbench-explorer')?.getClientRects().length`)
  }
  await evaluate(`document.querySelector('${pane} .file-tree-body').scrollTop = 40`)
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  await rememberHome()

  phase = 'another reflection reuses Home expansion without fetching loaded descendants'
  let releaseRoot!: () => void
  rootGate = { sessionId: two, wait: new Promise(resolve => { releaseRoot = resolve }) }
  const beforeSecond = files.length
  await selectRun(two)
  await waitRequest(() => files.slice(beforeSecond).some(item => item.sessionId === two), 'new reflection verifies its Home')
  assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(row('agents/nested/stable.txt'))})?.getClientRects().length`), true)
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(row('agents'))})?.getAttribute('aria-disabled')`), 'true')
  assert.equal(await evaluate(`document.querySelector('${pane} .file-tree-body').scrollTop === window.homeRefs.scrollTop`), true, 'Home scroll belongs to the workspace, not its chat')
  rootGate = undefined
  releaseRoot()
  await waitFor(`document.querySelector(${JSON.stringify(row('agents'))})?.getAttribute('aria-disabled') === 'false'`)
  assert.deepEqual(files.slice(beforeSecond), [{ sessionId: two, path: '' }], 'Only the root is verified; cached folders are not refreshed on chat switch')

  phase = 'a changed canonical Home cannot reuse another root expansion'
  secondHome = differentHome
  await click(`${pane} [aria-label="Refresh files"]`)
  await waitFor(`document.querySelector('${pane} .file-tree-root')?.getAttribute('aria-label')?.includes(${JSON.stringify(differentHome)})`)
  await waitFor(`document.querySelector('${pane} .heading-folder')?.textContent === 'execution-only'`)
  assert.equal(await evaluate(`!!document.querySelector(${JSON.stringify(row('agents/nested'))})`), false, 'A different canonical Home never inherits a cached subtree')
  phase = 'returning to a cached reflection retains resolved title and expanded Home'
  detailsGate = new Promise(resolve => { releaseDetails = resolve })
  await selectRun(one)
  await waitFor(`document.querySelector('select[aria-label="Run"]')?.value === ${JSON.stringify(one)}`)
  assert.equal(await evaluate(`document.querySelector('${pane} .heading-folder')?.textContent`), 'execution-only', 'Cached headers never flash Loading folder on activation')
  await assertHomeIdentity()
  detailsGate = undefined
  releaseDetails()
  phase = 'mobile drawer keeps directory actions local'
  window.setSize(500, 850)
  await waitFor(`innerWidth <= 700 && !!document.querySelector('${pane} .workbench-explorer.drawer')`)
  if (!await evaluate(`!!document.querySelector('${pane} .workbench-explorer')?.getClientRects().length`)) {
    await click(`${pane} [aria-label="Toggle files"]`)
  }
  await waitFor(`!!document.querySelector('${pane} .workbench-explorer.drawer')?.getClientRects().length`)
  await pointerClick(row('agents'))
  assert.equal(await evaluate(`!!document.querySelector('.hover-info-popup')`), false)
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth`), true)
  phase = 'folder failures remain explicit and recoverable'
  failSource = one
  await click(`${pane} [aria-label="Refresh files"]`)
  await waitFor(`!!document.querySelector('${pane} .file-tree-note.error')`)
  assert.match(await evaluate<string>(`document.querySelector('${pane} .file-tree-note.error').textContent`), /unavailable|failure|retry/i)
  failSource = ''
  await click(`${pane} [aria-label="Refresh files"]`)
  await waitFor(`!document.querySelector('${pane} .file-tree-note.error')`)
  assert.deepEqual(errors, [], 'Reflection fixture has no unexpected native client or server failures')
  console.log('LAYOUT_RESULT ' + JSON.stringify({ ok: true, fixture: 'reflection-stability', graphRequests, listingRequests: files.length, firstSelection: true, folderGeometry: true, cachedHome: true, keyboard: true, mobile: true }))
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
  live.close()
  server.closeAllConnections()
  server.close()
  app.exit(process.exitCode || 0)
})
