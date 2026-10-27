import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { app, BrowserWindow, session } from 'electron'
import { LiveFixture } from './live-fixture.ts'

function argument(name: string): string {
  const value = process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
  assert.ok(value, `Missing ${name}`)
  return resolve(value)
}
const assets = argument('layout-assets')
const directory = argument('layout-root')
const artifacts = argument('slash-artifacts')
for (const name of ['userData', 'sessionData', 'logs', 'crashDumps'] as const) {
  mkdirSync(join(directory, name), { recursive: true })
  app.setPath(name, join(directory, name))
}
app.setPath('home', directory)
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
app.commandLine.appendSwitch('disable-features', 'Translate,MediaRouter')
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.on('window-all-closed', () => {})

const root = 'web:chat-slash-fixture'
const administrator = 'web:chat-admin'
const sessions = [root, administrator].map((sessionId, index) => ({
  sessionId, title: index ? 'Project coordination' : 'Slash command fixture', current: `slash-physical-${index}`,
}))
const commands = [
  { name: 'help', description: 'Show available commands and their usage.' },
  { name: 'history', description: 'Show conversation history without leaving the composer.' },
  ...Array.from({ length: 18 }, (_, index) => ({
    name: `test-${String(index).padStart(2, '0')}`,
    description: `Synthetic command ${index}: ${'Long descriptions must wrap within the viewport. '.repeat(3)}`,
  })),
]
const live = new LiveFixture()
const errors: string[] = []
const results: Array<{ label: string; ok: boolean; error?: string }> = []
const reads: string[] = []
const sends: Array<{ chatId: string; content: string }> = []
let rejectCatalog = false
let catalogGate: Promise<void> | undefined
let releaseCatalog: (() => void) | undefined
const server = createServer(async (request, response) => {
  try {
    if (live.handle(request, response)) return
    const url = new URL(request.url!, 'http://127.0.0.1')
    const path = decodeURIComponent(url.pathname).replace(/^\/projects\/default(?=\/)/, '')
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(value))
    }
    const status = { provider: 'copilot', model: 'gpt-5-mini@copilot', authMode: 'copilot', ready: true, hasApiKey: false }
    if (path === '/api/projects') return json({ projects: [{ id: 'default', name: 'Default', createdAt: '2026-09-16T00:00:00Z' }] })
    if (path === '/api/automations') return json({ automations: [] })
    if (path === '/api/provider/setup') return json(status)
    if (path === '/api/provider/configured') return json({ providers: [{ ...status, selected: true }] })
    if (path === '/api/models') return json({ models: [status.model] })
    if (path === '/api/config') return json({ agent: { ...status, workspace: directory, temperature: 0.7 } })
    if (path === '/api/folders') return json({ folders: [] })
    if (path === '/api/agent-resources/publication-requests') return json({ request: null })
    if (path === '/api/sessions/graph') return json({
      sessions, nodes: sessions.map(item => ({ physicalId: item.current, logicalId: item.sessionId, parentPhysicalId: null, isCurrent: true })),
    })
    if (path === '/api/sessions/stages') return json({
      stages: Object.fromEntries(sessions.map(item => [item.sessionId, live.activeRequests.has(item.sessionId) ? 'llm' : 'idle'])),
      activeRequestIds: Object.fromEntries(live.activeRequests),
    })
    if (path === '/api/chat/session') return json({
      history: [{ role: 'assistant', content: 'Synthetic slash completion fixture.' }, ...live.history(`web:${url.searchParams.get('chatId')}`)],
      tools: [], systemPrompt: '',
    })
    if (path === '/api/chat/commands') {
      assert.equal(request.method, 'GET')
      assert.equal(url.pathname, '/projects/default/api/chat/commands')
      const id = url.searchParams.get('sessionId')!
      assert.ok(id === root || id === administrator, 'Catalog must use the active logical session')
      reads.push(id)
      if (catalogGate) await catalogGate
      if (rejectCatalog) return json({ error: 'Synthetic unavailable catalog' }, 503)
      return json({ commands: [...commands, { name: 'agent-publish', description: 'Publish a reviewed reusable agent.' }] })
    }
    if (path === '/api/chat/send') {
      let body = ''
      for await (const chunk of request) body += chunk
      const input = JSON.parse(body)
      sends.push(input)
      const acknowledgement = live.admit(input.chatId)
      live.history(`web:${input.chatId}`).push({ role: 'user', content: input.content })
      json(acknowledgement)
      setTimeout(() => live.finish(`web:${input.chatId}`), 50)
      return
    }
    const match = path.match(/^\/api\/sessions\/([^/]+)(?:\/(.*))?$/)
    if (match) {
      const id = match[1]!
      if (match[2] === 'background-tasks') return json({ sessionId: id, total: 0, tasks: [] })
      if (match[2] === 'details') return json({
        sessionId: id, name: null, sessionKind: 'topic',
        workdir: { kind: 'local', displayPath: directory }, usage: null, usageScope: 'session',
        context: { usedTokens: null, windowTokens: null },
      })
      if (match[2] === 'context') return json({ systemPrompt: '', tools: [] })
      if (match[2] === 'files') return json({ path: '', entries: [], workdir: { kind: 'local', displayPath: directory } })
      if (match[2] === 'git/status') return json({ available: false, entries: [], reason: 'not_repository' })
      if (!match[2]) return json({ messages: [], previousPhysicalId: null, systemPrompt: '', tools: [] })
    }
    if (/^\/(?:api|debug|nodes|v1|local)\//.test(path)) {
      errors.push(`Unstubbed ${request.method} ${path}`)
      return json({ error: 'not_found' }, 404)
    }
    const assetIndex = path.indexOf('/assets/')
    const file = assetIndex >= 0 ? resolve(assets, `.${path.slice(assetIndex)}`) : join(assets, 'index.html')
    const within = relative(assets, file)
    assert.ok(!within.startsWith('..') && !isAbsolute(within))
    const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }
    response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream' })
    response.end(await readFile(file))
  } catch (cause) {
    errors.push(String(cause))
    if (!response.headersSent) response.writeHead(500)
    response.end()
  }
})

async function evaluate<T = unknown>(window: BrowserWindow, script: string): Promise<T> {
  assert.equal(window.isVisible(), false, 'Only inspect the isolated hidden renderer')
  return window.webContents.executeJavaScript(script) as Promise<T>
}
async function settle(window: BrowserWindow) {
  await evaluate(window, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
}
async function waitFor(window: BrowserWindow, expression: string) {
  const deadline = Date.now() + 5000
  while (!await evaluate(window, expression)) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${expression}`)
    await new Promise(resolve => setTimeout(resolve, 30))
  }
}
async function screenshot(window: BrowserWindow, label: string) {
  await writeFile(join(artifacts, `${label}.png`), (await window.webContents.capturePage()).toPNG())
}
async function check(window: BrowserWindow, label: string, run: () => Promise<void>) {
  try {
    await run()
    results.push({ label, ok: true })
  } catch (cause) {
    results.push({ label, ok: false, error: String(cause) })
    await screenshot(window, `${label}-failure`)
  }
  console.log(`LAYOUT_SLASH ${JSON.stringify(results.at(-1))}`)
}
async function key(window: BrowserWindow, keyCode: string) {
  keyCode = keyCode.replace(/^Arrow/, '')
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode })
  await settle(window)
}
async function pointerClick(window: BrowserWindow, selector: string) {
  const point = await evaluate<{ x: number; y: number }>(window, `(() => {
    const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
    return { x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) };
  })()`)
  window.webContents.sendInputEvent({ type: 'mouseMove', ...point })
  window.webContents.sendInputEvent({ type: 'mouseDown', button: 'left', clickCount: 1, ...point })
  window.webContents.sendInputEvent({ type: 'mouseUp', button: 'left', clickCount: 1, ...point })
  await settle(window)
}
async function setText(window: BrowserWindow, selector: string, text: string, start = text.length, end = start) {
  await evaluate(window, `(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    input.focus(); input.value = ${JSON.stringify(text)};
    input.setSelectionRange(${start}, ${end});
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('select', { bubbles: true }));
  })()`)
  await settle(window)
}
async function assertCompleted(window: BrowserWindow, selector: string, value: string, before: number) {
  assert.deepEqual(await evaluate(window, `(() => {
    const input = document.querySelector(${JSON.stringify(selector)});
    return { value: input.value, focus: document.activeElement === input, start: input.selectionStart, end: input.selectionEnd,
      open: input.getAttribute('aria-expanded'), menu: !!document.querySelector('.slash-menu') };
  })()`), { value, focus: true, start: value.length, end: value.length, open: 'false', menu: false })
  assert.equal(sends.length, before, 'Completion must never admit a chat request')
}
async function inspect(window: BrowserWindow, selector: string, label: string, width: number) {
  await evaluate(window, 'document.fonts.ready')
  await settle(window)
  const geometry = await evaluate<{
    bounded: boolean; above: boolean; overflow: boolean; focus: boolean; active: boolean; visible: boolean
    direction: string; background: string; expectedBackground: string; teleported: boolean; scrollTop: number
  }>(window, `(() => {
    const input = document.querySelector(${JSON.stringify(selector)}), menu = document.querySelector('.slash-menu');
    const list = menu.querySelector('[role="listbox"]'), option = menu.querySelector('[aria-selected="true"]');
    const r = menu.getBoundingClientRect(), a = input.closest('.composer-box').getBoundingClientRect();
    const l = list.getBoundingClientRect(), o = option.getBoundingClientRect();
    const style = getComputedStyle(menu);
    const probe = document.createElement('span'); probe.style.backgroundColor = 'var(--c-bg-card)'; menu.append(probe);
    const expectedBackground = getComputedStyle(probe).backgroundColor; probe.remove();
    return { bounded: r.left >= 0 && r.top >= 0 && r.right <= innerWidth + 1 && r.bottom <= innerHeight + 1,
      above: r.bottom <= a.top, overflow: document.documentElement.scrollWidth > innerWidth ||
        menu.scrollWidth > menu.clientWidth || list.scrollWidth > list.clientWidth,
      focus: document.activeElement === input, active: input.getAttribute('aria-controls') === list.id &&
        input.getAttribute('aria-activedescendant') === option.id && input.getAttribute('aria-expanded') === 'true',
      visible: o.top >= l.top - 1 && o.bottom <= l.bottom + 1,
      direction: getComputedStyle(option).flexDirection, background: style.backgroundColor, expectedBackground,
      teleported: menu.parentElement === document.body, scrollTop: list.scrollTop };
  })()`)
  await screenshot(window, label)
  console.log(`LAYOUT_SLASH_GEOMETRY ${JSON.stringify({ label, ...geometry })}`)
  assert.equal(geometry.bounded, true, 'Popup stays inside the viewport')
  assert.equal(geometry.above, true, 'Popup stays above the composer')
  assert.equal(geometry.overflow, false, 'No horizontal document, popup or list overflow')
  assert.equal(geometry.focus, true, 'Textarea retains keyboard focus')
  assert.equal(geometry.active, true, 'Textarea references the rendered active listbox option')
  assert.equal(geometry.visible, true, 'Selected option scrolls fully into view')
  assert.equal(geometry.teleported, true)
  assert.equal(geometry.direction, width === 390 ? 'column' : 'row')
  assert.equal(geometry.background, geometry.expectedBackground, 'Popup uses the current theme token')
}

async function runViewport(origin: string, width: number, height: number) {
  const isolated = session.fromPartition(`slash-${width}`, { cache: false })
  isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(`${origin}/`) }))
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  const window = new BrowserWindow({
    show: false, frame: false, width, height, useContentSize: true,
    webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(`${origin}/`)) event.preventDefault() })
  const input = '.primary-conversation .composer-input textarea'
  const options = `document.querySelectorAll('.slash-option').length`
  const names = `Array.from(document.querySelectorAll('.slash-name'), element => element.textContent)`
  const ready = async (selector: string, text: string, count: number) => {
    await setText(window, selector, text)
    await waitFor(window, `${options} === ${count}`)
  }
  const beforeViewportSends = sends.length
  try {
    const beforeReads = reads.length
    await window.loadURL(`${origin}/chat/${encodeURIComponent(root)}`)
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await waitFor(window, `!!document.querySelector(${JSON.stringify(input)}) && !!document.querySelector('.chat-bubble')`)
    await check(window, `lazy-trigger-${width}`, async () => {
      assert.equal(reads.length, beforeReads, 'Mounting idle chat does not fetch a catalog')
      for (const text of ['ordinary draft', 'body /he', 'C:/project/file', '/help argument', '/he\n']) {
        await setText(window, input, text)
        assert.equal(await evaluate(window, `!!document.querySelector('.slash-menu')`), false, text)
      }
      await setText(window, input, '/he', 1)
      assert.equal(await evaluate(window, `!!document.querySelector('.slash-menu')`), false, 'Caret must be at the end')
      await setText(window, input, '/he', 0, 3)
      assert.equal(await evaluate(window, `!!document.querySelector('.slash-menu')`), false, 'Selected text does not trigger')
      assert.equal(reads.length, beforeReads)
      await evaluate(window, `(() => {
        const input = document.querySelector(${JSON.stringify(input)});
        input.blur(); input.setSelectionRange(input.value.length, input.value.length);
        input.dispatchEvent(new Event('select', { bubbles: true }));
      })()`)
      await settle(window)
      assert.equal(await evaluate(window, `!!document.querySelector('.slash-menu')`), false, 'Unfocused prefix does not trigger')
      assert.equal(reads.length, beforeReads)
    })
    await check(window, `loading-retry-${width}`, async () => {
      rejectCatalog = true
      catalogGate = new Promise(resolve => { releaseCatalog = resolve })
      await setText(window, input, '/')
      await waitFor(window, `document.querySelector('.slash-status')?.textContent.includes('Loading commands')`)
      await key(window, 'Enter')
      assert.equal(sends.length, beforeViewportSends, 'Enter while loading does not send')
      await screenshot(window, `slash-loading-${width}`)
      releaseCatalog!()
      catalogGate = undefined
      await waitFor(window, `!!document.querySelector('.slash-status[role="alert"] button')`)
      await screenshot(window, `slash-error-${width}`)
      rejectCatalog = false
      await pointerClick(window, '.slash-status button')
      await waitFor(window, `${options} === ${commands.length}`)
      assert.equal(await evaluate(window, `document.activeElement === document.querySelector(${JSON.stringify(input)})`), true)
      assert.equal(await evaluate<string[]>(window, names).then(items => items.includes('/agent-publish')), false)
    })
    rejectCatalog = false
    releaseCatalog?.()
    catalogGate = undefined
    await check(window, `geometry-keyboard-${width}`, async () => {
      await ready(input, '/', commands.length)
      for (const theme of ['light', 'dark']) {
        await evaluate(window, `document.documentElement.classList.toggle('dark', ${theme === 'dark'})`)
        await inspect(window, input, `slash-${theme}-${width}`, width)
      }
      await key(window, 'ArrowUp')
      assert.equal(await evaluate(window, `document.querySelector('.slash-option[aria-selected="true"] .slash-name').textContent`), '/test-17')
      await inspect(window, input, `slash-scrolled-${width}`, width)
      assert.ok(await evaluate<number>(window, `document.querySelector('.slash-options').scrollTop`) > 0)
      await key(window, 'ArrowDown')
      assert.equal(await evaluate(window, `document.querySelector('.slash-option[aria-selected="true"] .slash-name').textContent`), '/help')
      await key(window, 'ArrowDown')
      await key(window, 'Enter')
      await assertCompleted(window, input, '/history ', beforeViewportSends)
    })
    await check(window, `prefix-tab-pointer-${width}`, async () => {
      await ready(input, '/is', 0)
      await waitFor(window, `document.querySelector('.slash-status')?.textContent.includes('No matching commands')`)
      await ready(input, '  /he', 1)
      assert.deepEqual(await evaluate(window, names), ['/help'])
      await key(window, 'Tab')
      await assertCompleted(window, input, '  /help ', beforeViewportSends)
      await ready(input, '/hi', 1)
      await pointerClick(window, '.slash-option')
      await assertCompleted(window, input, '/history ', beforeViewportSends)
    })
    await check(window, `escape-shift-ime-${width}`, async () => {
      await ready(input, '/he', 1)
      await key(window, 'Escape')
      await assertCompleted(window, input, '/he', beforeViewportSends)
      await ready(input, '/h', 2)
      await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
        modifiers: 8, text: '\r', unmodifiedText: '\r',
      })
      await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', {
        type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, modifiers: 8,
      })
      await settle(window)
      await assertCompleted(window, input, '/h\n', beforeViewportSends)
      await ready(input, '/he', 1)
      await evaluate(window, `(() => {
        const input = document.querySelector(${JSON.stringify(input)});
        input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true, data: '' }));
      })()`)
      await settle(window)
      assert.equal(await evaluate(window, `!!document.querySelector('.slash-menu')`), false)
      await evaluate(window, `(() => {
        const input = document.querySelector(${JSON.stringify(input)});
        input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, cancelable: true, key: 'Enter', isComposing: true, keyCode: 229 }));
        input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true, data: '' }));
      })()`)
      await settle(window)
      assert.equal(await evaluate(window, `document.querySelector(${JSON.stringify(input)}).value`), '/he')
      assert.equal(sends.length, beforeViewportSends, 'IME confirmation must not send or complete')
    })
    await check(window, `complete-then-send-${width}`, async () => {
      await ready(input, '/he', 1)
      await key(window, 'Enter')
      await assertCompleted(window, input, '/help ', beforeViewportSends)
      await key(window, 'Enter')
      await waitFor(window, `document.querySelector(${JSON.stringify(input)}).value === '' && !document.querySelector(${JSON.stringify(input)}).disabled`)
      assert.equal(sends.length, beforeViewportSends + 1, 'Only the second Enter sends')
      assert.equal(sends.at(-1)?.chatId, root.slice(4))
      assert.equal(sends.at(-1)?.content, '/help')
    })
    await check(window, `embedded-administrator-${width}`, async () => {
      await window.loadURL(`${origin}/projects/default/chat/${encodeURIComponent(root)}?child=${encodeURIComponent(administrator)}`)
      const childInput = '.child-conversation .composer-input textarea'
      await waitFor(window, `!!document.querySelector(${JSON.stringify(childInput)}) && !!document.querySelector('.child-conversation .is-embedded')`)
      const before = sends.length
      await ready(childInput, '/agent', 1)
      assert.equal(reads.at(-1), administrator)
      assert.deepEqual(await evaluate(window, names), ['/agent-publish'])
      await inspect(window, childInput, `slash-administrator-${width}`, width)
      await key(window, 'Tab')
      await assertCompleted(window, childInput, '/agent-publish ', before)
    })
  } catch (cause) {
    results.push({ label: `viewport-${width}`, ok: false, error: String(cause) })
    await screenshot(window, `slash-viewport-failure-${width}`)
  } finally {
    releaseCatalog?.()
    catalogGate = undefined
    rejectCatalog = false
    if (window.webContents.debugger.isAttached()) window.webContents.debugger.detach()
    window.destroy()
  }
}

async function main() {
  try {
    await app.whenReady()
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    await runViewport(origin, 1440, 1000)
    await runViewport(origin, 390, 844)
    assert.deepEqual(errors, [])
    assert.deepEqual(live.errors, [])
    assert.equal(results.length, 14, 'Both viewports complete all seven scenario groups')
    assert.equal(results.filter(result => !result.ok).length, 0, 'All bounded renderer scenarios pass')
    assert.equal(sends.length, 2, 'Exactly one intentional normal chat submission per viewport')
  } catch (cause) {
    process.exitCode = 1
    console.error(cause)
  } finally {
    const summary = { ok: !process.exitCode, fixture: 'slash-command', artifacts, results, errors, reads, sends }
    await writeFile(join(artifacts, 'results.json'), JSON.stringify(summary, null, 2))
    console.log(`LAYOUT_RESULT ${JSON.stringify(summary)}`)
    live.close()
    server.closeAllConnections()
    server.close()
    app.exit(Number(process.exitCode ?? 0))
  }
}
void main()
