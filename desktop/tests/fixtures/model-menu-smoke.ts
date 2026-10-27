import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
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
const live = new LiveFixture()
uiPlugin(argument('layout-assets'))(ui)
const id = 'web:chat-model-menu'
let model = 'gpt-6-astra@copilot'
let config: Record<string, unknown> = {}
const patches: Record<string, unknown>[] = []
const providerSaves: Record<string, unknown>[] = []
const sends: Array<{ chatId: string; content: string; config?: Record<string, unknown> }> = []
const sessionConfigs = new Map<string, Record<string, unknown>>()
let appDefaults: Record<string, unknown> = {}
const builtins = { model: 'gpt-6-astra@copilot', temperature: 0.7, reasoningEffort: 'medium' }
const errors: string[] = []
const requests: string[] = []
let failSettings = false
let gate: Promise<void> | undefined
let finishSend: (() => void) | undefined
let startSend: (() => void) | undefined
let phase = 'initializing'
let window: BrowserWindow | undefined
const server = createServer(async (request, response) => {
  try {
    if (live.handle(request, response)) return
    const url = new URL(request.url!, 'http://127.0.0.1')
    const path = url.pathname.replace(/^\/projects\/default(?=\/)/, '')
    requests.push(`${request.method} ${path}`)
    const json = (data: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)) }
    if (path === '/api/projects') return json({ projects: [{ id: 'default', name: 'Default', createdAt: '2026-09-16T00:00:00Z' }] })
    if (path === '/api/automations') return json({ automations: [] })
    const body = async () => {
      let text = ''
      for await (const chunk of request) text += chunk
      return JSON.parse(text)
    }
    if (path === '/api/provider/setup') {
      if (request.method === 'POST') {
        const input = await body()
        providerSaves.push(input)
        model = input.model
      }
      return json({ ready: true, provider: 'custom', model, authMode: 'none', hasApiKey: false })
    }
    if (path === '/api/provider/configured') return json({ providers: [{ provider: 'custom', model, selected: true, authMode: 'none', hasApiKey: false }] })
    if (path === '/api/models') return json({ models: ['gpt-6-astra@copilot', 'synthetic-model', 'synthetic-other'] })
    if (path === '/api/config') return json({ agent: { ...builtins, ...appDefaults, model, workspace: directory } })
    if (path === '/api/app/model-defaults') {
      if (request.method === 'PATCH') {
        const patch = await body()
        for (const [key, value] of Object.entries(patch)) {
          if (value === null) delete appDefaults[key]
          else appDefaults[key] = value
        }
        model = String(appDefaults.model ?? builtins.model)
      }
      return json({ ...builtins, ...appDefaults, overrides: appDefaults, inherited: builtins })
    }
    if (path === '/api/folders') return json({ folders: [] })
    if (path === '/api/sessions/graph') return json({
      sessions: [{ sessionId: id, current: 'physical-menu', title: 'Model menu regression', config },
        ...sends.map(send => ({ sessionId: `web:${send.chatId}`, current: 'physical-draft', title: send.content, config: sessionConfigs.get(`web:${send.chatId}`) }))],
      nodes: [{ physicalId: 'physical-menu', logicalId: id }],
    })
    if (path === '/api/sessions/stages') return json({
      stages: { [id]: 'idle', ...Object.fromEntries([...live.activeRequests.keys()].map(id => [id, 'llm'])) },
      activeRequestIds: Object.fromEntries(live.activeRequests),
    })
    if (path === '/api/chat/session') return json({ history: live.history(`web:${url.searchParams.get('chatId')}`), systemPrompt: 'Synthetic fixture.', tools: [] })
    const route = path.match(/^\/api\/sessions\/([^/]+)(?:\/(.*))?$/)
    if (route) {
      const sessionId = decodeURIComponent(route[1])
      if (route[2] === 'background-tasks') return json({ sessionId, total: 0, tasks: [] })
      if (route[2] === 'config' && request.method === 'PATCH') {
        assert.ok(sessionId === id || sessionConfigs.has(sessionId), 'Unsent drafts must not PATCH an existing session')
        const patch = await body()
        patches.push(patch)
        const waiting = gate
        gate = undefined
        if (waiting) await waiting
        if (failSettings) return json({ error: 'Synthetic settings failure' }, 503)
        const next = { ...(sessionId === id ? config : sessionConfigs.get(sessionId)) }
        for (const [name, value] of Object.entries(patch)) {
          if (value === null) delete next[name]
          else next[name] = value
        }
        if (sessionId === id) config = next
        else sessionConfigs.set(sessionId, next)
        return json({ key: sessionId, config: next })
      }
      if (route[2] === 'files') return json({ path: '', workdir: { kind: 'local', displayPath: 'C:\\synthetic\\model-menu' }, entries: [] })
      if (route[2] === 'git/status') return json({ available: false, reason: 'not_repository', entries: [] })
      if (route[2] === 'details') return json({ sessionId, name: 'Model menu regression', workdir: { kind: 'local', displayPath: 'C:\\synthetic\\model-menu' }, usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, usageScope: 'session', context: { usedTokens: null, windowTokens: null } })
      if (!route[2]) return json({ messages: [], currentPhysicalId: 'physical-menu', previousPhysicalId: null })
    }
    if (path === '/api/chat/send') {
      const input = await body()
      if (input.stream === true) return json({ error: 'stream_removed' }, 410)
      assert.ok(live.hub.stats.clients > 0, 'Subscribe before admission')
      sends.push(input)
      sessionConfigs.set(`web:${input.chatId}`, Object.fromEntries(Object.entries(input.config ?? {}).filter(([, value]) => value !== null)))
      const acknowledgement = live.admit(input.chatId)
      const sessionId = `web:${input.chatId}`
      live.history(sessionId).push({ role: 'user', content: input.content, timestamp: new Date().toISOString() })
      startSend = () => live.chat(sessionId, { event: 'response', content: 'Synthetic draft accepted.', done: false })
      finishSend = () => live.finish(sessionId)
      return json(acknowledgement)
    }
    if (/^\/(?:api|nodes|debug|v1|local)\//.test(path)) {
      errors.push(`Unexpected ${request.method} ${path}`)
      return json({ error: 'Unstubbed endpoint' }, 404)
    }
    const resource = await ui.request(url.toString())
    const type = resource.headers.get('Content-Type') || 'application/octet-stream'
    response.writeHead(resource.status, { 'Content-Type': type,
      'Content-Security-Policy': "default-src 'self' data:; img-src 'self' data: blob:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self' blob:; font-src 'self' data:" })
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
  throw new Error(`${phase}: timed out ${source}; ${JSON.stringify(errors)}`)
}
async function click(selector: string): Promise<void> {
  await waitFor(`!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`)
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
}
async function waitRequest(predicate: () => boolean, label: string): Promise<void> {
  const end = Date.now() + 8000
  while (!predicate() && Date.now() < end) await new Promise(resolve => setTimeout(resolve, 30))
  assert.ok(predicate(), `${phase}: ${label}; errors=${JSON.stringify(errors)}`)
}
async function key(keyCode: string): Promise<void> {
  window!.webContents.sendInputEvent({ type: 'keyDown', keyCode })
  window!.webContents.sendInputEvent({ type: 'keyUp', keyCode })
  await evaluate(`new Promise(resolve => requestAnimationFrame(resolve))`)
}
const trigger = '.composer-controls [aria-label="Choose model"]'
async function openEffort(): Promise<void> {
  await click(trigger)
  await click('.model-menu-effort')
  await waitFor(`document.querySelectorAll('.effort-option').length === (document.querySelector('.model-label').textContent.includes('gpt-') ? 7 : 5)`)
}
async function chooseEffort(label: string, awaitSave = true): Promise<void> {
  await openEffort()
  await evaluate(`Array.from(document.querySelectorAll('.effort-option')).find(button => button.querySelector('.setting-option-copy > span').textContent.trim() === ${JSON.stringify(label)}).click()`)
  await waitFor(`!document.querySelector('.composer-popover')`)
  if (awaitSave) await waitFor(`document.querySelector('${trigger}').getAttribute('aria-busy') !== 'true'`)
}
async function assertMenuBounds(): Promise<void> {
  await waitFor(`(() => {
    const popup = document.querySelector('.composer-popover'); if (!popup) return false;
    const rect = popup.getBoundingClientRect();
    return rect.width > 0 && rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth + 1 && rect.bottom <= innerHeight + 1;
  })()`)
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.composer-popover')).borderRadius`), '0px')
}
async function screenshot(name: string, mobile = false): Promise<void> {
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))`)
  await new Promise<void>((resolve, reject) => {
    const contents = window!.webContents
    const painted = () => { clearTimeout(timeout); resolve() }
    const timeout = setTimeout(() => { contents.removeListener('paint', painted); reject(new Error('Model menu screenshot did not repaint')) }, 5000)
    contents.once('paint', painted)
    contents.invalidate()
  })
  await assertMenuBounds()
  await writeFile(join(directory, name), (await window!.webContents.capturePage(mobile ? { x: 0, y: 0, width: 390, height: 844 } : undefined)).toPNG())
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
  await window.loadURL(`${origin}/chat/${encodeURIComponent(id)}`)
  window.webContents.debugger.attach('1.3')
  await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
  phase = 'root menu and keyboard navigation'
  await waitFor(`document.querySelector('.model-label')?.textContent === 'Project · gpt-6-astra'`)
  assert.equal(await evaluate(`document.querySelectorAll('${trigger}').length === 1 && !document.querySelector('.composer-controls [aria-label="Thinking"], .composer-controls [aria-label="Reasoning effort"]')`), true)
  await click(trigger)
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.model-menu > button'), button => button.firstElementChild.textContent)`), ['Model', 'Effort'])
  assert.equal(await evaluate(`document.querySelector('.model-menu').textContent.includes('Auto') || /context window/i.test(document.querySelector('.model-menu').textContent)`), false)
  await assertMenuBounds()
  await screenshot('model-menu-desktop.png')
  await evaluate(`document.querySelector('.model-menu-model').focus()`)
  await key('Right')
  await waitFor(`document.activeElement === document.querySelector('.model-search')`)
  await evaluate(`(() => { const search = document.querySelector('.model-search'); search.value = 'other'; search.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await waitFor(`document.querySelectorAll('.model-option').length === 1 && document.querySelector('.model-option').textContent.includes('synthetic-other')`)
  await key('Escape')
  await waitFor(`!!document.querySelector('.model-menu-model') && !document.querySelector('.model-search')`)
  await click('.model-menu-effort')
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.effort-option .setting-option-copy > span'), element => element.textContent)`), ['Default', 'None', 'Low', 'Medium', 'High', 'XHigh', 'Max'])
  await screenshot('model-menu-desktop.png')
  await click('.model-menu-back')
  await waitFor(`!!document.querySelector('.model-menu-model')`)
  await key('Escape')
  await waitFor(`!document.querySelector('.composer-popover')`)
  phase = 'mobile effort submenu'
  window.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width: 390, height: 844 }, viewPosition: { x: 0, y: 0 }, viewSize: { width: 390, height: 844 }, deviceScaleFactor: 1, scale: 1 })
  await waitFor(`innerWidth === 390`)
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 180))))`)
  await click(trigger)
  await assertMenuBounds()
  await click('.model-menu-effort')
  await assertMenuBounds()
  await screenshot('model-menu-mobile.png', true)
  await key('Escape')
  await waitFor(`!!document.querySelector('.model-menu-effort')`)
  await key('Escape')
  await waitFor(`!document.querySelector('.composer-popover')`)
  window.webContents.disableDeviceEmulation()
  await evaluate(`new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(() => setTimeout(resolve, 180))))`)
  phase = 'busy session effort save'
  await evaluate(`(() => {
    const input = document.querySelector('.composer-input textarea'); window.menuDraft = input;
    input.value = 'Preserve this conversation draft'; input.dispatchEvent(new Event('input', { bubbles: true })); input.setSelectionRange(2, 7);
  })()`)
  let release!: () => void
  gate = new Promise(resolve => { release = resolve })
  await chooseEffort('None', false)
  await waitFor(`document.querySelector('${trigger}').getAttribute('aria-busy') === 'true'`)
  await waitRequest(() => patches.length === 1, 'busy effort save reaches the gated session PATCH')
  assert.deepEqual(patches.at(-1), { thinking: { type: 'disabled' }, reasoningEffort: null })
  assert.equal(await evaluate(`document.activeElement === document.querySelector('${trigger}') && getComputedStyle(document.activeElement).opacity === '1'`), true)
  await click(trigger)
  assert.equal(await evaluate(`!!document.querySelector('.composer-popover')`), false)
  assert.equal(await evaluate(`document.querySelector('.composer-input textarea') === window.menuDraft && window.menuDraft.value === 'Preserve this conversation draft' && window.menuDraft.selectionStart === 2 && window.menuDraft.selectionEnd === 7`), true)
  release()
  await waitFor(`document.querySelector('${trigger}').getAttribute('aria-busy') !== 'true' && document.querySelector('.model-effort').textContent.includes('None')`)
  const beforeRepeat = patches.length
  await chooseEffort('None')
  assert.equal(patches.length, beforeRepeat)
  for (const level of ['Low', 'Medium', 'High', 'XHigh', 'Max']) {
    await chooseEffort(level)
    assert.deepEqual(patches.at(-1), { thinking: { type: 'enabled' }, reasoningEffort: level.toLowerCase() })
  }
  phase = 'failed effort save preserves state'
  failSettings = true
  await chooseEffort('Low')
  await waitFor(`!!document.querySelector('.composer-error')`)
  assert.equal(await evaluate(`document.querySelector('.model-effort').textContent.includes('Max') && document.activeElement === document.querySelector('${trigger}')`), true)
  assert.equal(config.reasoningEffort, 'max')
  failSettings = false
  await chooseEffort('Default')
  assert.deepEqual(patches.at(-1), { thinking: null, reasoningEffort: null })
  assert.deepEqual(config, {})
  await waitFor(`!document.querySelector('.composer-error')`)
  phase = 'conversation model selection'
  await chooseEffort('XHigh')
  await click(trigger)
  await click('.model-menu-model')
  await click('.model-option[title="synthetic-other"]')
  await waitFor(`document.querySelector('.model-label').textContent === 'synthetic-other'`)
  assert.equal(config.model, 'synthetic-other', 'Selecting a model persists before sending a message')
  await window.loadURL(window.webContents.getURL())
  await waitFor(`document.querySelector('.model-label')?.textContent === 'synthetic-other'`)
  assert.equal(providerSaves.length, 0, 'Conversation model overrides never mutate global provider defaults')
  await openEffort()
  await waitFor(`document.querySelector('.effort-options [role="status"]')?.textContent.includes('saved effort') && document.activeElement === document.querySelector('.effort-option')`)
  assert.equal(config.reasoningEffort, 'xhigh', 'Switching models must not silently replace the saved effort')
  await click('.effort-option')
  await waitFor(`!document.querySelector('.composer-popover') && document.querySelector('${trigger}').getAttribute('aria-busy') !== 'true'`)
  assert.deepEqual(config, { model: 'synthetic-other' })
  await click(trigger)
  await click('.model-menu-model')
  await click('.model-option[title="synthetic-other"]')
  await waitFor(`!document.querySelector('.composer-popover')`)
  assert.equal(providerSaves.length, 0)
  phase = 'draft settings remain local until first send'
  await click('[aria-label="New work in Default"]')
  await evaluate(`Array.from(document.querySelectorAll('.folder-menu [role="menuitem"]')).find(node => node.textContent.includes('Start from scratch')).click()`)
  await waitFor(`!!document.querySelector('.draft-heading')`)
  const writesBeforeDraft = requests.filter(request => !request.startsWith('GET ')).length
  const patchesBeforeDraft = patches.length
  await chooseEffort('None')
  await chooseEffort('High')
  assert.equal(patches.length, patchesBeforeDraft)
  assert.equal(requests.filter(request => !request.startsWith('GET ')).length, writesBeforeDraft)
  assert.equal(sends.length, 0)
  await click(trigger)
  await click('.model-menu-model')
  await click('.model-option[title="synthetic-other"]')
  await window.loadURL(window.webContents.getURL())
  await waitFor(`!!document.querySelector('.draft-heading') && document.querySelector('.model-label')?.textContent === 'synthetic-other' && document.querySelector('.model-effort').textContent.includes('High')`)
  await click(trigger)
  await click('.model-menu-model')
  await evaluate(`Array.from(document.querySelectorAll('.model-option')).find(button => button.textContent.includes('Follow project default')).click()`)
  await waitFor(`document.querySelector('.model-label').textContent === 'Project · gpt-6-astra'`)
  await evaluate(`(() => { const input = document.querySelector('.composer-input textarea'); input.value = 'Draft with paired reasoning settings'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await click('.composer-send')
  await waitRequest(() => sends.length === 1, 'first draft admission')
  await waitFor(`!document.querySelector('.draft-heading') && document.querySelector('.chat-messages').textContent.includes('Draft with paired reasoning settings')`)
  await new Promise(resolve => setTimeout(resolve, 150))
  startSend!()
  await waitFor(`document.querySelector('.chat-messages').textContent.includes('Synthetic draft accepted.')`)
  assert.equal(sends.length, 1)
  assert.notEqual(sends[0].chatId, id.slice(4))
  assert.deepEqual(sends[0].config, { model: null, thinking: { type: 'enabled' }, reasoningEffort: 'high' })
  assert.equal(patches.length, patchesBeforeDraft)
  phase = 'streaming permits next-turn model changes but disables effort'
  assert.equal(await evaluate(`document.querySelector('${trigger}').disabled`), false)
  await click(trigger)
  assert.equal(await evaluate(`document.querySelector('.model-menu-effort').disabled && !document.querySelector('.model-menu-model').disabled`), true)
  await click('.model-menu-model')
  await waitFor(`!!document.querySelector('.model-search')`)
  await click('.model-option[title="synthetic-model"]')
  await waitFor(`document.querySelector('.model-label').textContent === 'synthetic-model'`)
  assert.equal(sessionConfigs.get(`web:${sends[0].chatId}`)?.model, 'synthetic-model')
  assert.equal(sends[0].config?.model, null, 'Changing the next-turn model does not mutate the admitted request')
  assert.equal(providerSaves.length, 0, 'Changing the next-turn model does not mutate the admitted request')
  finishSend!()
  await waitFor(`!document.querySelector('.composer-input textarea').disabled`)
  phase = 'App providers do not override conversation models'
  await evaluate(`Array.from(document.querySelectorAll('.tab-nav .tab')).find(button => button.textContent.trim().toLowerCase() === 'settings').click()`)
  await waitFor(`location.pathname === '/settings' && !!document.querySelector('.provider-card')`)
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('[aria-label="Choose model"]')).some(button => button.getClientRects().length)`), false, 'App provider settings configure connections, not conversation model overrides')
  assert.equal(providerSaves.length, 0)
  phase = 'App defaults expose inheritance and survive reload'
  await click('.settings-navigation a[href="/settings/models"]')
  await waitFor(`!!document.querySelector('.model-defaults-form input:not(:disabled)') && document.querySelector('.model-defaults-form').textContent.includes('Effective now:')`)
  await evaluate(`(() => {
    const fields = document.querySelectorAll('.model-defaults-form input');
    fields[0].value = 'synthetic-model'; fields[0].dispatchEvent(new Event('input', { bubbles: true }));
    const select = document.querySelector('.model-defaults-form select'); select.value = 'high'; select.dispatchEvent(new Event('change', { bubbles: true }));
    document.querySelector('.model-defaults-form').requestSubmit();
  })()`)
  await waitFor(`document.querySelector('.model-defaults-form').textContent.includes('App defaults saved.')`)
  assert.equal(appDefaults.model, 'synthetic-model')
  assert.equal(appDefaults.reasoningEffort, 'high')
  await window.loadURL(window.webContents.getURL())
  await waitFor(`document.querySelector('.model-defaults-form input')?.value === 'synthetic-model' && document.querySelector('.model-defaults-form select')?.value === 'high'`)
  await evaluate(`Array.from(document.querySelectorAll('.model-defaults-form button')).find(button => button.textContent.includes('Use inherited values')).click()`)
  await evaluate(`document.querySelector('.model-defaults-form').requestSubmit()`)
  await waitFor(`document.querySelector('.model-defaults-form').textContent.includes('App defaults saved.')`)
  assert.deepEqual(appDefaults, {})
  await writeFile(join(directory, 'model-defaults-desktop.png'), (await window.webContents.capturePage()).toPNG())
  window.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width: 390, height: 844 }, viewPosition: { x: 0, y: 0 }, viewSize: { width: 390, height: 844 }, deviceScaleFactor: 1, scale: 1 })
  await waitFor(`innerWidth === 390 && document.documentElement.scrollWidth <= innerWidth`)
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.settings-actions button')).every(button => {
    const bounds = button.getBoundingClientRect();
    return bounds.height >= 36 && bounds.left >= 0 && bounds.right <= innerWidth;
  })`), true, 'Model-default actions remain usable and within the mobile viewport')
  await writeFile(join(directory, 'model-defaults-mobile.png'), (await window.webContents.capturePage({ x: 0, y: 0, width: 390, height: 844 })).toPNG())
  assert.deepEqual(errors, [])
  console.log('LAYOUT_RESULT ' + JSON.stringify({ ok: true, fixture: 'model-menu', patches: patches.length, providerSaves: providerSaves.length, draftSends: sends.length }))
}
main().catch(error => {
  console.error(error)
  console.log('LAYOUT_FAILURE ' + JSON.stringify({ phase, message: String(error), errors, requests: requests.slice(-15) }))
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
