import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { app, BrowserWindow, session } from 'electron'
import type { CommandReceipt } from '../../../src/slash-commands/receipt.ts'
import { LiveFixture } from './live-fixture.ts'

function argument(name: string): string {
  const value = process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
  assert.ok(value, `Missing ${name}`)
  return resolve(value)
}
const assets = argument('layout-assets')
const directory = argument('layout-root')
const artifacts = argument('command-artifacts')
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

type Delivery = 'http-only' | 'live-before-http' | 'live-after-http'
type CommandPlan = { delivery: Delivery; output: string; failed: boolean; release?: () => void }
type Admission = { sessionId: string; requestId: string; receipt?: CommandReceipt }
type SyntheticSession = { sessionId: string; current: string; title: string; workdir: { kind: 'local'; displayPath: string } }
const live = new LiveFixture()
const sessions = new Map<string, SyntheticSession>()
const receipts = new Map<string, CommandReceipt[]>()
const previous = new Map<string, string>()
const errors: string[] = []
const requests: string[] = []
const admissions: Admission[] = []
const cancellations: Array<{ sessionId: string; requestId: string }> = []
const results: Array<{ label: string; ok: boolean; error?: string }> = []
const geometries: Array<Record<string, unknown>> = []
let plan: CommandPlan | undefined
let sequence = 0
function publish(admission: Admission) {
  assert.ok(admission.receipt)
  live.publisher.chat(admission.sessionId, { event: 'command_result', done: true, receipt: admission.receipt }, admission.requestId)
}
function initialize(chatId: string): SyntheticSession {
  const sessionId = `web:${chatId}`
  let value = sessions.get(sessionId)
  if (!value) {
    const displayPath = join(directory, `scratch-${sessions.size + 1}`)
    mkdirSync(displayPath)
    value = { sessionId, current: `command-physical-${sessions.size + 1}`, title: 'Synthetic scratch conversation',
      workdir: { kind: 'local', displayPath } }
    sessions.set(sessionId, value)
    receipts.set(sessionId, [])
  }
  return value
}
const server = createServer(async (request, response) => {
  try {
    if (live.handle(request, response)) return
    const url = new URL(request.url!, 'http://127.0.0.1')
    const path = decodeURIComponent(url.pathname).replace(/^\/projects\/default(?=\/)/, '')
    if (!path.includes('/assets/')) requests.push(`${request.method} ${path}`)
    const json = (value: unknown, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(value))
    }
    const status = { provider: 'copilot', model: 'gpt-5-mini@copilot', authMode: 'copilot', ready: true, hasApiKey: false }
    if (path === '/api/web-auth/session') return json({ version: 1, required: false, authenticated: true })
    if (path === '/api/projects') return json({ projects: [{ id: 'default', name: 'Default', createdAt: '2026-09-16T00:00:00Z' }] })
    if (path === '/api/automations') return json({ automations: [] })
    if (path === '/api/provider/setup') return json(status)
    if (path === '/api/provider/configured') return json({ providers: [{ ...status, selected: true }] })
    if (path === '/api/models') return json({ models: [status.model] })
    if (path === '/api/config') return json({ agent: { ...status, workspace: directory, temperature: 0.7 } })
    if (path === '/api/folders') return json({ folders: [] })
    if (path === '/api/agent-resources/publication-requests') return json({ request: null })
    if (path === '/api/chat/commands') return json({ commands: [{ name: 'help', description: 'Show command help.' }] })
    if (path === '/api/sessions/graph') return json({
      sessions: [...sessions.values()],
      nodes: [...sessions.values()].map(item => ({
        physicalId: item.current, logicalId: item.sessionId, parentPhysicalId: null, isCurrent: true,
      })),
    })
    if (path === '/api/sessions/stages') return json({
      stages: Object.fromEntries([...sessions.keys()].map(id => [id, live.activeRequests.has(id) ? 'llm' : 'idle'])),
      activeRequestIds: Object.fromEntries(live.activeRequests),
    })
    if (path === '/api/chat/session') {
      const id = `web:${url.searchParams.get('chatId')}`
      assert.ok(sessions.has(id), 'An unsent scratch draft must not materialize via history')
      return json({ history: live.history(id), commandResults: receipts.get(id) ?? [], systemPrompt: '', tools: [] })
    }
    if (path === '/api/chat/send') {
      assert.equal(request.method, 'POST')
      let body = ''
      for await (const chunk of request) body += chunk
      const input: { chatId: string; content: string; stream: boolean } = JSON.parse(body)
      assert.ok(input.chatId.startsWith('chat-'))
      assert.equal(input.stream, false)
      const item = initialize(input.chatId)
      assert.ok(live.hub.stats.clients > 0, 'Subscribe to real live transport before admission')
      if (input.content.trimStart().startsWith('/')) {
        assert.ok(plan, 'Each command must have an explicit fixture delivery plan')
        const current = plan
        const requestId = `command-request-${++sequence}`
        const receipt: CommandReceipt = {
          id: `receipt-${sequence}`, command: input.content, output: current.output,
          timestamp: new Date().toISOString(), failed: current.failed,
        }
        receipts.get(item.sessionId)!.push(receipt)
        const admission = { sessionId: item.sessionId, requestId, receipt }
        admissions.push(admission)
        // Commands do not replace LiveFixture's active model request or its history.
        if (current.delivery === 'live-before-http') {
          const gate = new Promise<void>(resolve => { current.release = resolve })
          publish(admission)
          await gate
        }
        json({ chatId: input.chatId, requestId,
          ...(current.delivery !== 'live-after-http' ? { commandReceipt: receipt } : {}) })
        live.publisher.invalidateSessions(item.sessionId)
        return
      }
      assert.equal(plan, undefined, 'Normal requests must not consume a command plan')
      const acknowledgement = live.admit(input.chatId)
      live.history(item.sessionId).push({ role: 'user', content: input.content, timestamp: new Date().toISOString() })
      admissions.push({ sessionId: item.sessionId, requestId: acknowledgement.requestId })
      return json(acknowledgement)
    }
    const match = path.match(/^\/api\/sessions\/([^/]+)(?:\/(.*))?$/)
    if (match) {
      const id = match[1]!
      const item = sessions.get(id)
      if (match[2] === 'background-tasks') return json({ sessionId: id, total: 0, tasks: [] })
      if (match[2] === 'details') return json({
        sessionId: id, name: null, workdir: item?.workdir ?? null, usage: null, usageScope: 'session',
        context: { usedTokens: null, windowTokens: null },
      })
      if (match[2] === 'context') return json({ systemPrompt: '', tools: [] })
      if (match[2] === 'files') return json({ path: '', entries: [], workdir: item?.workdir ?? { kind: 'local', displayPath: directory } })
      if (match[2] === 'git/status') return json({ available: false, entries: [], reason: 'not_repository' })
      if (match[2] === 'cancel' && request.method === 'POST') {
        let body = ''
        for await (const chunk of request) body += chunk
        const input: { requestId: string } = JSON.parse(body)
        cancellations.push({ sessionId: id, requestId: input.requestId })
        assert.equal(input.requestId, live.activeRequests.get(id), 'Stop must still target the original model request')
        return json({ sessionId: id, status: 'requested' })
      }
      if (!match[2]) return json({
        messages: live.history(id), commandResults: receipts.get(id) ?? [],
        currentPhysicalId: item?.current ?? id, previousPhysicalId: previous.get(id) ?? null, systemPrompt: '', tools: [],
      })
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
  assert.equal(window.isVisible(), false)
  try {
    return await window.webContents.executeJavaScript(script) as T
  } catch (cause) {
    throw new Error(`Renderer evaluation failed: ${script}`, { cause })
  }
}
async function waitFor(window: BrowserWindow, expression: string) {
  const deadline = Date.now() + 5000
  while (!await evaluate(window, expression)) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${expression}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
async function waitServer(predicate: () => boolean, label: string) {
  const deadline = Date.now() + 5000
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${label}`)
    await new Promise(resolve => setTimeout(resolve, 25))
  }
}
async function settle(window: BrowserWindow) {
  await evaluate(window, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
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
  } finally {
    plan?.release?.()
    plan = undefined
  }
  console.log(`LAYOUT_COMMAND ${JSON.stringify(results.at(-1))}`)
}
const input = '.primary-conversation .composer-input textarea'
const stop = '[aria-label="Stop current request"]'
const card = (receipt: CommandReceipt) => `article.command-result[data-command-id="${receipt.id}"]`
async function submit(window: BrowserWindow, content: string): Promise<Admission> {
  const before = admissions.length
  await waitFor(window, `!!document.querySelector(${JSON.stringify(input)}) && !document.querySelector(${JSON.stringify(input)}).disabled`)
  await evaluate(window, `(() => {
    const input = document.querySelector(${JSON.stringify(input)});
    input.focus(); input.value = ${JSON.stringify(content)}; input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  })()`)
  await waitFor(window, `!!document.querySelector('.composer-send:not(:disabled)')`)
  // The completion menu is independently covered by slash-command-smoke.
  await evaluate(window, `document.querySelector('.composer-send').click()`)
  await waitServer(() => admissions.length > before, `admission for ${content.slice(0, 40)}`)
  assert.equal(admissions.length, before + 1)
  return admissions.at(-1)!
}
async function visibleReceipt(window: BrowserWindow, receipt: CommandReceipt) {
  const selector = JSON.stringify(card(receipt))
  await waitFor(window, `!!document.querySelector(${selector})`)
  assert.equal(await evaluate(window, `document.querySelectorAll(${selector}).length`), 1, 'Receipt is deduplicated by id')
  assert.equal(await evaluate(window, `document.querySelector(${selector} + ' .command-header code').textContent`), receipt.command)
  assert.equal(await evaluate(window, `document.querySelector(${selector} + ' .command-caption').textContent`),
    `${receipt.failed ? 'Command error' : 'Command result'} \u00b7 Not sent to AI`)
}
async function idle(window: BrowserWindow) {
  await waitFor(window, `!document.querySelector(${JSON.stringify(stop)}) && !document.querySelector('.chat-working') &&
    document.querySelector(${JSON.stringify(input)})?.value === '' && !document.querySelector(${JSON.stringify(input)}).disabled`)
}
async function watchCommandOnly(window: BrowserWindow) {
  await evaluate(window, `(() => {
    window.commandObserver?.disconnect();
    window.commandViolations = [];
    window.commandObserver = new MutationObserver(() => {
      if (document.querySelector('.chat-bubble')) window.commandViolations.push('model bubble');
      if (document.querySelector('.chat-working')) window.commandViolations.push('thinking status');
    });
    window.commandObserver.observe(document.querySelector('.project-conversations'), { childList: true, subtree: true });
  })()`)
}
async function assertCommandOnly(window: BrowserWindow, sessionId: string) {
  await settle(window)
  assert.equal(await evaluate(window, `document.querySelectorAll('.chat-bubble').length`), 0)
  assert.deepEqual(await evaluate(window, 'window.commandViolations'), [], 'No transient command user/assistant bubble or thinking status')
  assert.deepEqual(live.history(sessionId), [], 'Receipts must stay out of synthetic model history')
}
async function inspectLong(window: BrowserWindow, receipt: CommandReceipt, width: number) {
  const selector = JSON.stringify(`${card(receipt)} .command-output`)
  await evaluate(window, `(() => {
    const output = document.querySelector(${selector});
    output.scrollIntoView({ block: 'center' }); output.focus(); output.scrollTop = 0;
  })()`)
  await settle(window)
  const geometry = await evaluate<{
    horizontal: boolean; regionBounded: boolean; scrollable: boolean; focusable: boolean; commandWrap: boolean; maxHeight: number
  }>(window, `(() => {
    const output = document.querySelector(${selector}), article = output.closest('article');
    const code = article.querySelector('.command-header code'), r = output.getBoundingClientRect(), a = article.getBoundingClientRect();
    return { horizontal: document.documentElement.scrollWidth <= innerWidth && article.scrollWidth <= article.clientWidth &&
      output.scrollWidth <= output.clientWidth && a.left >= 0 && a.right <= innerWidth + 1,
      regionBounded: r.top >= 0 && r.bottom <= innerHeight + 1 && r.height <= Math.min(440, innerHeight * .55) + 1,
      scrollable: output.scrollHeight > output.clientHeight && ['auto', 'scroll'].includes(getComputedStyle(output).overflowY),
      focusable: output.tabIndex === 0 && document.activeElement === output && output.getAttribute('role') === 'region',
      commandWrap: code.scrollWidth <= article.clientWidth, maxHeight: r.height };
  })()`)
  geometries.push({ width, ...geometry })
  await screenshot(window, `command-long-${width}`)
  assert.equal(geometry.horizontal, true, 'Long command and plain-text output must not introduce horizontal overflow')
  assert.equal(geometry.regionBounded, true, 'Command output stays in a viewport-bounded scroll region')
  assert.equal(geometry.scrollable, true)
  assert.equal(geometry.focusable, true)
  assert.equal(geometry.commandWrap, true)
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'PageDown' })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'PageDown' })
  await waitFor(window, `document.querySelector(${selector}).scrollTop > 0`)
  assert.equal(await evaluate(window, `document.activeElement === document.querySelector(${selector})`), true)
  await screenshot(window, `command-keyboard-scroll-${width}`)
}

async function runViewport(origin: string, width: number, height: number) {
  const isolated = session.fromPartition(`command-result-${width}`, { cache: false })
  isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(`${origin}/`) }))
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  const window = new BrowserWindow({
    show: false, frame: false, width, height, useContentSize: true,
    webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(`${origin}/`)) event.preventDefault() })
  let sessionId = ''
  let first: CommandReceipt | undefined
  try {
    await window.loadURL(`${origin}/projects/default/chat`)
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await waitFor(window, `!!document.querySelector(${JSON.stringify(input)}) && !!document.querySelector('.draft-heading')`)
    await watchCommandOnly(window)
    await check(window, `scratch-http-only-${width}`, async () => {
      const before = sessions.size
      plan = { delivery: 'http-only', output: '**Available commands**\n\n- /help: Show help.\n- /status: Show status.', failed: false }
      const admission = await submit(window, '/help')
      sessionId = admission.sessionId
      first = admission.receipt!
      assert.equal(sessions.size, before + 1, 'First command registers the scratch session in the graph')
      assert.ok(sessions.get(sessionId)?.workdir.displayPath.startsWith(directory))
      await visibleReceipt(window, first)
      await idle(window)
      await assertCommandOnly(window, sessionId)
      await waitFor(window, `!document.querySelector('.draft-heading')`)
      assert.equal(await evaluate(window, `document.querySelector(${JSON.stringify(card(first))} + ' strong').textContent`), 'Available commands')
      await screenshot(window, `command-scratch-${width}`)
    })
    await check(window, `reload-receipt-${width}`, async () => {
      assert.ok(first && sessionId)
      await window.loadURL(window.webContents.getURL())
      await visibleReceipt(window, first)
      await idle(window)
      await watchCommandOnly(window)
      await assertCommandOnly(window, sessionId)
      await screenshot(window, `command-reloaded-${width}`)
    })
    await check(window, `live-before-http-dedupe-${width}`, async () => {
      plan = { delivery: 'live-before-http', output: 'Live result arrived before HTTP admission.', failed: false }
      const admission = await submit(window, '/help early')
      try {
        await visibleReceipt(window, admission.receipt!)
        await assertCommandOnly(window, sessionId)
      } finally { plan.release?.() }
      await idle(window)
      publish(admission)
      publish(admission)
      await settle(window)
      await visibleReceipt(window, admission.receipt!)
      await assertCommandOnly(window, sessionId)
      await screenshot(window, `command-deduplicated-${width}`)
    })
    await check(window, `live-only-completion-${width}`, async () => {
      plan = { delivery: 'live-after-http', output: 'Result delivered only through the live transport.', failed: false }
      const admission = await submit(window, '/help live')
      await waitFor(window, `document.querySelector(${JSON.stringify(input)}).value === ''`)
      publish(admission)
      await visibleReceipt(window, admission.receipt!)
      await idle(window)
      await assertCommandOnly(window, sessionId)
    })
    await check(window, `failed-sanitized-${width}`, async () => {
      plan = { delivery: 'http-only', failed: true, output:
        '**Failure detail**\n\n&lt;img src=x onerror=alert(1)&gt;\n\n<script>window.commandInjected = true</script>\n\n' +
        '<img src="data:image/png;base64,AA==" onerror="window.commandInjected = true">\n\n[unsafe](javascript:alert(1))' }
      const admission = await submit(window, '/help <script>not executable</script>')
      await visibleReceipt(window, admission.receipt!)
      await idle(window)
      const selector = JSON.stringify(card(admission.receipt!))
      assert.equal(await evaluate(window, `document.querySelector(${selector}).classList.contains('command-failed')`), true)
      assert.equal(await evaluate(window, `document.querySelector(${selector} + ' .command-output').textContent.includes('<img src=x onerror=alert(1)>')`), true)
      assert.equal(await evaluate(window, `!!document.querySelector(${selector} + ' script, ' + ${selector} + ' [onerror], ' + ${selector} + ' a[href^="javascript:"]') || window.commandInjected === true`), false)
      await assertCommandOnly(window, sessionId)
      await screenshot(window, `command-failed-${width}`)
    })
    await check(window, `long-output-keyboard-${width}`, async () => {
      plan = { delivery: 'http-only', failed: false, output:
        `${'unbroken-output-'.repeat(35)}\n\n${Array.from({ length: 55 }, (_, index) => `Output line ${index}: bounded command details.`).join('\n\n')}` }
      const admission = await submit(window, `/help ${'very-long-command-argument-'.repeat(12)}`)
      await visibleReceipt(window, admission.receipt!)
      await idle(window)
      await inspectLong(window, admission.receipt!, width)
      await assertCommandOnly(window, sessionId)
    })
    await evaluate(window, 'window.commandObserver?.disconnect()')
    await check(window, `normal-turn-after-command-${width}`, async () => {
      const admission = await submit(window, 'A normal model turn after commands.')
      assert.equal(admission.receipt, undefined)
      await waitFor(window, `document.querySelector('.chat-user')?.textContent.includes('A normal model turn') && !!document.querySelector(${JSON.stringify(stop)})`)
      live.chat(sessionId, { event: 'response', content: 'Normal model response.', done: false }, admission.requestId)
      await waitFor(window, `document.querySelector('.chat-assistant')?.textContent.includes('Normal model response.')`)
      live.finish(sessionId)
      await idle(window)
      assert.equal(await evaluate(window, `document.querySelectorAll('.chat-user').length`), 1)
      assert.equal(await evaluate(window, `document.querySelectorAll('.chat-assistant').length`), 1)
      assert.ok(live.history(sessionId).every(message => !String(message.content).startsWith('/')))
      await screenshot(window, `command-next-normal-turn-${width}`)
    })
    await check(window, `command-during-model-request-${width}`, async () => {
      const original = await submit(window, 'Keep this real model request running.')
      live.chat(sessionId, { event: 'response', content: 'Original stream prefix. ', done: false }, original.requestId)
      await waitFor(window, `document.querySelector('.chat-messages').textContent.includes('Original stream prefix.') && !!document.querySelector(${JSON.stringify(stop)})`)
      plan = { delivery: 'live-before-http', output: 'Independent command while model is running.', failed: false }
      const command = await submit(window, '/help busy')
      try { await visibleReceipt(window, command.receipt!) } finally { plan.release?.() }
      await waitFor(window, `document.querySelector(${JSON.stringify(input)}).value === '' && !document.querySelector(${JSON.stringify(input)}).disabled`)
      assert.equal(live.activeRequests.get(sessionId), original.requestId)
      assert.equal(await evaluate(window, `!!document.querySelector(${JSON.stringify(stop)}) && !!document.querySelector('.chat-working')`), true)
      live.chat(sessionId, { event: 'response', content: 'Original stream continues.', done: false }, original.requestId)
      await waitFor(window, `Array.from(document.querySelectorAll('.chat-assistant')).some(element => element.textContent.includes('Original stream prefix. Original stream continues.'))`)
      const before = cancellations.length
      await evaluate(window, `document.querySelector(${JSON.stringify(stop)}).click()`)
      await waitServer(() => cancellations.length > before, 'original request cancellation')
      assert.deepEqual(cancellations.at(-1), { sessionId, requestId: original.requestId })
      await screenshot(window, `command-preserves-busy-request-${width}`)
      live.finish(sessionId, 'cancelled')
      await idle(window)
      await visibleReceipt(window, command.receipt!)
      assert.equal(await evaluate(window, `document.querySelectorAll('.chat-user').length`), 2)
      assert.equal(await evaluate(window, `document.querySelectorAll('.chat-assistant').length`), 2)
    })
    await check(window, `historical-command-segment-${width}`, async () => {
      const physical = `historical-command-${width}`
      const receipt: CommandReceipt = { id: `historical-receipt-${width}`, command: '/help historical',
        output: 'Display-only receipt from the previous physical segment.', timestamp: '2026-09-01T00:00:00.000Z', failed: false }
      receipts.set(physical, [receipt])
      const older = `older-command-${width}`
      const olderReceipt = { ...receipt, id: `older-receipt-${width}`, output: 'An older physical segment.' }
      receipts.set(older, [olderReceipt])
      previous.set(physical, older)
      previous.set(sessionId, physical)
      await window.loadURL(window.webContents.getURL())
      await waitFor(window, `document.querySelector('[aria-label="View previous session"]')?.disabled === false`)
      const heading = await evaluate(window, `document.querySelector('.conversation-heading-row').getBoundingClientRect().height`)
      assert.equal(await evaluate(window, `document.querySelectorAll('.chat-messages .segment-nav').length`), 0)
      await evaluate(window, `document.querySelector('[aria-label="View previous session"]').click()`)
      await visibleReceipt(window, receipt)
      assert.equal(await evaluate(window, `document.querySelectorAll('.command-result').length`), 1, 'Only receipts from the viewed segment are shown')
      assert.equal(await evaluate(window, `document.querySelectorAll('.chat-bubble').length`), 0)
      await screenshot(window, `command-historical-${width}`)
      await evaluate(window, `document.querySelector('[aria-label="View previous session"]').click()`)
      await visibleReceipt(window, olderReceipt)
      assert.equal(await evaluate(window, `document.querySelector('[aria-label="View previous session"]').disabled`), true)
      await evaluate(window, `document.querySelector('[aria-label="View next session"]').click()`)
      await visibleReceipt(window, receipt)
      assert.equal(await evaluate(window, `document.querySelector('.conversation-heading-row').getBoundingClientRect().height`), heading)
      await evaluate(window, `document.querySelector('[aria-label="View next session"]').click()`)
      await visibleReceipt(window, first!)
      await waitFor(window, `document.querySelector('[aria-label="View previous session"]')?.disabled === false`)
      await evaluate(window, `document.querySelector('[aria-label="View previous session"]').click()`)
      await visibleReceipt(window, receipt)
      assert.equal(await evaluate(window, `(() => {
        const back = document.querySelector('[aria-label="Back to current session"]');
        if (!back) return false;
        back.click(); return true;
      })()`), true, 'Historical segment must remain selected until Back to current is clicked')
      await visibleReceipt(window, first!)
      await waitFor(window, `!document.querySelector(${JSON.stringify(card(receipt))})`)
      await idle(window)
    })
  } catch (cause) {
    results.push({ label: `viewport-${width}`, ok: false, error: String(cause) })
    await screenshot(window, `command-viewport-failure-${width}`)
  } finally {
    plan?.release?.()
    plan = undefined
    if (sessionId && live.activeRequests.has(sessionId)) live.finish(sessionId, 'cancelled')
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
    assert.equal(results.length, 18, 'Nine bounded scenarios execute at each viewport')
    assert.equal(results.filter(result => !result.ok).length, 0, 'All command receipt scenarios pass')
    assert.equal(admissions.filter(admission => !!admission.receipt).length, 12)
    assert.equal(admissions.filter(admission => !admission.receipt).length, 4)
  } catch (cause) {
    process.exitCode = 1
    console.error(cause)
  } finally {
    const summary = { ok: !process.exitCode, fixture: 'command-result', artifacts, results, geometries,
      errors, liveErrors: live.errors, requests, admissions, cancellations }
    await writeFile(join(artifacts, 'results.json'), JSON.stringify(summary, null, 2))
    console.log(`LAYOUT_RESULT ${JSON.stringify({
      ok: summary.ok, fixture: summary.fixture, artifacts, results, geometries, errors, liveErrors: live.errors,
      commandAdmissions: admissions.filter(admission => !!admission.receipt).length,
      modelAdmissions: admissions.filter(admission => !admission.receipt).length, cancellations,
    })}`)
    live.close()
    server.closeAllConnections()
    server.close()
    app.exit(Number(process.exitCode ?? 0))
  }
}
void main()
