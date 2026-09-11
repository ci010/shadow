import assert from 'node:assert/strict'
import { createServer, type ServerResponse } from 'node:http'
import { mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { extname, join, resolve, relative, isAbsolute } from 'node:path'
import { app, BrowserWindow, session } from 'electron'

function argument(name: string): string {
  const value = process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
  assert.ok(value, `Missing ${name}`)
  return resolve(value)
}
const assets = argument('layout-assets')
const directory = argument('layout-root')
for (const name of ['userData', 'sessionData', 'logs', 'crashDumps'] as const) {
  mkdirSync(join(directory, name), { recursive: true })
  app.setPath(name, join(directory, name))
}
app.setPath('home', directory)
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
app.on('window-all-closed', () => {})

const idA = 'web:chat-diagnosis-a'
const idB = 'web:chat-diagnosis-b'
const idGroup = 'test:group-authors'
const base = Date.now() - 20000
const timestamp = (offset: number) => new Date(base + offset).toISOString()
const messagesA = [
  { role: 'user', name: '__compaction_summary__', content: 'Earlier synthetic context.' },
  { role: 'user', name: 'Direct user', content: '<sender id="direct" name="Direct user" chat="direct" />Inspect the project and explain the result.', timestamp: timestamp(100) },
  { role: 'assistant', content: 'I will inspect the project files.', timestamp: timestamp(1800) },
  { role: 'assistant', content: '', tool_calls: [{ id: 'call-a', function: { name: 'read_file', arguments: '{"path":"README.md"}' } }], timestamp: timestamp(2000) },
  { role: 'tool', name: 'read_file', tool_call_id: 'call-a', content: 'Synthetic README result: the project uses Vue.', timestamp: timestamp(3000) },
  { role: 'user', name: 'scheduler', content: '<event type="completed" title="Background task completed" status="completed" />Synthetic event details.' },
  { role: 'assistant', content: 'The project is a Vue application.\n\n' + 'A synthetic response, not provider output. '.repeat(60), reasoning_text: 'Synthetic reasoning', timestamp: timestamp(7000) },
  { role: 'user', content: 'Now check its architecture.', timestamp: timestamp(9000) },
  { role: 'assistant', content: 'The backend owns agent execution.\n\n' + 'More synthetic explanation. '.repeat(50) +
    '\n\n## Rendering compatibility\n\n**Strong text** and `inline code`.\n\n[Project docs](https://example.invalid/docs)\n\n| Name | Value |\n| --- | --- |\n| Fixture | 42 |\n\n- First item\n- Second item\n\n```ts\nconst answer = 42\n```\n\nInline $x^2$.\n\n$$\\frac{1}{2}$$\n\n<span onclick="window.unsafeMarkup = true">Safe span</span><script>window.unsafeMarkup = true</script>',
    timestamp: timestamp(10000) },
]
const groupMessages = [
  { role: 'user', name: 'Alice', content: '<sender id="alice" name="Alice" chat="group" />Please check the project structure.', timestamp: timestamp(100) },
  { role: 'assistant', name: 'Shadow', content: 'I will inspect the files and summarize the result.', timestamp: timestamp(1800) },
  messagesA[3], messagesA[4], messagesA[5],
  { role: 'user', content: '<sender id="bob" name="Bob &amp; the &lt;frontend&gt; team" chat="group" />Include the UI components, too.', timestamp: timestamp(8000) },
  { role: 'assistant', name: 'Shadow', content: 'The backend owns execution; Vue renders the conversation.\n\nThe shared corner tokens also apply to events and tool results.', usage: { promptTokens: 100, completionTokens: 25, totalTokens: 125 }, timestamp: timestamp(10000) },
]
let live = false
let fail = false
let gate: Promise<void> | undefined
let release: (() => void) | undefined
let completeSend: (() => void) | undefined
let inventoryState: 'ready' | 'error' | 'empty' | 'changed' = 'ready'
let inventoryGate: Promise<void> | undefined
let releaseInventory: (() => void) | undefined
let inventoryRequests = 0
const inventory = () => ({
  version: 1,
  nodes: [
    {
      nodeId: 'layout-fixture', displayName: 'Synthetic Main', role: 'main', connection: 'connected',
      capabilities: [
        { capabilityId: 'fixture-source', kind: 'workdir', displayName: 'Synthetic source', displayPath: 'C:\\synthetic\\source', online: true },
        { capabilityId: 'fixture-shell', kind: 'shell', displayName: 'Local shell', online: true },
      ],
    },
    {
      nodeId: 'synthetic-child', displayName: 'Synthetic Child with a deliberately long device name', role: 'child',
      connection: inventoryState === 'changed' ? 'connected' : 'offline',
      capabilities: [{ capabilityId: 'fixture-archive', kind: 'workdir', displayName: 'Project archive', online: inventoryState === 'changed' }],
    },
    {
      nodeId: 'synthetic-revoked', displayName: 'Revoked Child', role: 'child', connection: 'revoked', capabilities: [],
    },
  ],
})
const eventStreams = new Map<string, ServerResponse>()
const traceQueries: URL[] = []
const unexpected: string[] = []
const tools = [{ name: 'read_file', description: 'Read a file in the effective workdir.', parameters: { properties: { path: { type: 'string', description: 'File path' } }, required: ['path'] } }]
const span = (spanId: string, name: string, start: number, end: number, extra: Record<string, unknown> = {}) => ({
  id: end, spanId, traceId: 'trace-a', parentSpanId: 'root', name, startTime: base + start, endTime: base + end,
  live: false, attributes: {}, events: [], ...extra,
})
const trace = () => [
  span('root', 'session.processMessage', 0, 7000, { parentSpanId: undefined }),
  span('model', 'agent.chat', 200, 1800, { attributes: { model: 'synthetic-model' } }),
  span('tool', 'agent.tool', 2000, 3000, { attributes: { 'tool.name': 'read_file', 'tool.call_id': 'call-a' } }),
  span('answer', 'agent.chat', 3100, 7000, { id: live ? null : 7100, live, endTime: live ? undefined : base + 7000 }),
]
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url!, 'http://127.0.0.1')
    const path = url.pathname
    const json = (data: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)) }
    if (path === '/nodes/v1') {
      inventoryRequests += 1
      const waiting = inventoryGate
      inventoryGate = undefined
      const payload = inventoryState === 'empty' ? { version: 1, nodes: [] } : inventory()
      if (waiting) await waiting
      if (inventoryState === 'error') return json({ error: 'Synthetic unavailable' }, 503)
      return json(payload)
    }
    if (path === '/api/provider/setup') return json({ ready: true, provider: 'custom', model: 'synthetic-model', authMode: 'none', hasApiKey: false })
    if (path === '/api/projects') return json({ projects: [] })
    if (path === '/api/config') return json({ agent: { model: 'synthetic-model' } })
    if (path === '/debug/models') return json({ models: ['synthetic-model'] })
    if (path === '/api/sessions/graph') return json({ sessions: [{ sessionId: idA, title: 'Trace preview', current: 'physical-a' }, { sessionId: idB, title: 'Second conversation', current: 'physical-b' }, { sessionId: idGroup, title: 'Group conversation', current: 'physical-group' }], nodes: [] })
    if (path === '/api/sessions/stages') return json({ stages: { [idA]: live ? 'llm' : 'idle', [idB]: 'idle' } })
    if (path === '/api/chat/events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(': fixture\n\n')
      const chatId = url.searchParams.get('chatId') || ''
      eventStreams.set(chatId, response)
      response.on('close', () => { if (eventStreams.get(chatId) === response) eventStreams.delete(chatId) })
      return
    }
    if (path === '/api/chat/send') {
      let body = ''
      for await (const chunk of request) body += chunk
      const input = JSON.parse(body) as { content: string }
      if (input.content === 'Failed timestamp') return json({ error: 'Synthetic send failure' }, 503)
      response.writeHead(200, { 'Content-Type': 'text/event-stream' })
      response.write(`data: ${JSON.stringify({ event: 'response', content: 'A streamed response.', done: false })}\n\n`)
      if (input.content === 'Early EOF timestamp') { response.end(); return }
      completeSend = () => {
        for (const payload of [
          { event: 'tool_call', content: 'read_file', toolCall: { name: 'read_file', arguments: { path: 'fixture.txt' } } },
          { event: 'tool_result', content: 'Synthetic tool result' },
          { event: 'response', content: 'Final timestamped response.', done: true },
        ]) response.write(`data: ${JSON.stringify(payload)}\n\n`)
        response.end()
      }
      return
    }
    const historyFor = (id: string) => id === idGroup ? groupMessages : id.includes('diagnosis-b') ? [{ role: 'user', content: 'Only the second session.' }] : id === 'physical-older' ? [{ role: 'user', content: 'Historical segment only.' }] : messagesA
    if (path === '/api/chat/session') return json({ history: historyFor(url.searchParams.get('chatId') || ''), systemPrompt: '# Synthetic system prompt\n\nUse the project workdir. Inline $x^2$.\n\n$$\\frac{1}{2}$$', tools, previousPhysicalId: 'physical-older' })
    if (path.startsWith('/api/sessions/')) {
      const key = decodeURIComponent(path.slice('/api/sessions/'.length))
      if (key === `${idGroup}/context`) return json({ systemPrompt: 'Synthetic group context.', tools })
      return json({ messages: historyFor(key), currentPhysicalId: key === idB ? 'physical-b' : 'physical-a', previousPhysicalId: key === idA ? 'physical-older' : null })
    }
    if (path === '/v1/query/session-spans') {
      traceQueries.push(url)
      const waiting = gate
      gate = undefined
      if (waiting) await waiting
      if (fail) return json({ error: 'Synthetic unavailable' }, 503)
      return json({ sessionId: url.searchParams.get('sessionId'), physicalSessionId: url.searchParams.get('physicalSessionId'), entries: url.searchParams.get('physicalSessionId') === 'physical-a' ? trace() : [], hasMore: false })
    }
    if (path.startsWith('/api/') || path.startsWith('/v1/') || path.startsWith('/nodes/') || path.startsWith('/local/') || path.startsWith('/debug/')) {
      unexpected.push(path)
      return json({ error: 'Unstubbed endpoint' }, 404)
    }
    const file = path.startsWith('/assets/') ? resolve(assets, `.${path}`) : join(assets, 'index.html')
    const within = relative(assets, file)
    if (within.startsWith('..') || isAbsolute(within)) { response.writeHead(403).end(); return }
    response.writeHead(200, {
      'Content-Type': ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf' } as Record<string, string>)[extname(file)] ?? 'application/octet-stream',
      'Content-Security-Policy': "default-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self' data:",
    })
    response.end(await readFile(file))
  } catch (error) {
    unexpected.push(String(error))
    response.writeHead(500).end()
  }
})

let window: BrowserWindow | undefined
const evaluate = <T = unknown>(source: string): Promise<T> => window!.webContents.executeJavaScript(source)
async function waitFor(source: string): Promise<void> {
  const end = Date.now() + 12000
  while (Date.now() < end) {
    if (await evaluate(source)) return
    await new Promise(resolve => setTimeout(resolve, 40))
  }
  throw new Error(`Timed out: ${source}`)
}
async function click(selector: string): Promise<void> {
  assert.equal(await evaluate(`Boolean(document.querySelector(${JSON.stringify(selector)}))`), true, `Missing click target: ${selector}`)
  await evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
}

async function main(): Promise<void> {
  await app.whenReady()
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith(origin + '/') || details.url.startsWith('devtools:') || details.url.startsWith('data:')
    if (!allowed) unexpected.push(`External request: ${details.url}`)
    callback({ cancel: !allowed })
  })
  window = new BrowserWindow({ width: 1400, height: 1000, show: false, webPreferences: { offscreen: true, backgroundThrottling: false, preload: join(directory, 'layout-preload.cjs'), additionalArguments: [`--layout-api-base=${origin}`] } })
  await window.loadURL(`${origin}/chat`)
  await waitFor(`document.querySelectorAll('.session-select').length === 3`)
  await evaluate(`Array.from(document.querySelectorAll('.session-select')).find(node => node.title.includes(${JSON.stringify(idA)})).click()`)
  await waitFor(`document.querySelectorAll('.chat-bubble').length >= 4`)
  await waitFor(`Boolean(document.querySelector('.chat-user .message-time'))`)
  assert.equal(await evaluate(`document.querySelector('.chat-user .message-time').dateTime`), timestamp(100))
  assert.equal(await evaluate(`document.querySelector('.chat-assistant .message-time').dateTime`), timestamp(1800))
  const spacing = await evaluate<{ margin: string; footerGap: number; bottomGap: number }>(`(() => {
    const bubble = document.querySelector('.chat-user');
    const content = bubble.querySelector('.chat-content > :last-child');
    const footer = bubble.querySelector('.chat-footer');
    return { margin: getComputedStyle(content).marginBottom, footerGap: footer.getBoundingClientRect().top - content.getBoundingClientRect().bottom, bottomGap: bubble.getBoundingClientRect().bottom - footer.getBoundingClientRect().bottom };
  })()`)
  assert.equal(spacing.margin, '0px', 'Markdown paragraph margin must not add empty padding below the text')
  assert.ok(spacing.footerGap >= 0 && spacing.footerGap <= 10)
  assert.ok(spacing.bottomGap >= 0 && spacing.bottomGap <= 10)
  assert.equal(await evaluate(`document.querySelectorAll('.chat-role, .chat-sender').length`), 0, 'Direct chat must not display role or sender labels')
  assert.match(await evaluate<string>(`document.querySelector('.chat-content h2').textContent`), /Rendering compatibility/)
  assert.equal(await evaluate(`document.querySelector('.chat-content strong').textContent`), 'Strong text')
  assert.equal(await evaluate(`document.querySelector('.chat-content table td').textContent`), 'Fixture')
  assert.equal(await evaluate(`document.querySelectorAll('.chat-content ul li').length`), 2)
  assert.match(await evaluate<string>(`document.querySelector('.chat-content pre code').textContent`), /const answer = 42/)
  assert.equal(await evaluate(`document.querySelector('.chat-content a').target`), '_blank')
  assert.equal(await evaluate(`document.querySelector('.chat-content a').rel`), 'noopener noreferrer')
  assert.equal(await evaluate(`document.querySelectorAll('.chat-content .katex math').length`), 2)
  assert.equal(await evaluate(`Boolean(document.querySelector('.chat-content .katex-display'))`), true)
  assert.equal(await evaluate(`Boolean(window.unsafeMarkup || document.querySelector('.chat-content [onclick], .chat-content script'))`), false)
  for (const selector of ['.theme-toggle span', '.model-chevron', '.composer-send span', '#diagnosis-tab span']) {
    assert.equal(await evaluate(`(() => { const icon = document.querySelector(${JSON.stringify(selector)}); const css = getComputedStyle(icon); return icon.getAttribute('aria-hidden') === 'true' && css.maskImage.includes('data:image/svg+xml') && icon.getBoundingClientRect().width >= 12; })()`), true, `Missing generated icon: ${selector}`)
  }
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.chat-content > :first-child')).marginTop`), '0px')
  for (const selector of ['.chat-bubble', '.tool-group', '.system-event', '.compaction-summary']) {
    assert.equal(await evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).borderRadius`), '14px', selector)
  }
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.composer-box')).borderRadius`), '18px')
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('.btn')).borderRadius`), '8px')
  await evaluate(`document.documentElement.style.setProperty('--radius-surface', '22px')`)
  for (const selector of ['.chat-bubble', '.tool-group', '.system-event', '.compaction-summary']) {
    assert.equal(await evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(selector)})).borderRadius`), '22px', 'Changing one token must update all conversation surfaces')
  }
  await evaluate(`document.documentElement.style.removeProperty('--radius-surface')`)
  assert.equal(traceQueries.length, 0, 'Opening conversation must not eagerly fetch diagnosis')
  await evaluate(`(() => { const input = document.querySelector('.composer-input textarea'); window.retainedInput = input; input.value = 'Keep this unsent draft'; input.dispatchEvent(new Event('input', { bubbles: true })); document.querySelector('.chat-messages').scrollTop = 120; window.retainedScroll = document.querySelector('.chat-messages').scrollTop; })()`)
  await click('#diagnosis-tab')
  await waitFor(`document.querySelectorAll('.lane-bar.model').length === 2`)
  assert.equal(traceQueries.at(-1)?.searchParams.get('sessionId'), idA)
  assert.equal(traceQueries.at(-1)?.searchParams.get('physicalSessionId'), 'physical-a')
  assert.equal(await evaluate(`document.querySelector('.composer-input textarea').getClientRects().length`), 0)
  assert.equal(await evaluate(`Boolean(document.querySelector('.right-pane'))`), false)
  await click('[aria-label="Zoom into trace"]')
  await waitFor(`Boolean(document.querySelector('[aria-label="Pan trace timeline"]'))`)
  await evaluate(`(() => { const slider = document.querySelector('[aria-label="Pan trace timeline"]'); slider.value = '100'; slider.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await evaluate(`Array.from(document.querySelectorAll('.timeline-controls button')).find(button => button.textContent === 'Reset').click()`)
  await waitFor(`!document.querySelector('[aria-label="Pan trace timeline"]')`)
  await evaluate(`Array.from(document.querySelectorAll('.event-fold-controls button')).find(button => button.textContent === 'Collapse turns').click()`)
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.trace-event')).every(event => !event.getClientRects().length)`), true)
  await evaluate(`Array.from(document.querySelectorAll('.event-fold-controls button')).find(button => button.textContent === 'Expand turns').click()`)
  await evaluate(`Array.from(document.querySelectorAll('.event-fold-controls button')).find(button => button.textContent === 'Expand calls').click()`)
  await waitFor(`document.querySelector('.trace-event-detail')?.textContent.includes('Synthetic README result')`)
  await evaluate(`document.body.focus(); document.body.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', bubbles: true, cancelable: true }))`)
  assert.equal(await evaluate(`document.querySelector('.composer-input textarea').value`), 'Keep this unsent draft')
  await click('.lane-bar.tools')
  await waitFor(`document.querySelector('.span-inspector')?.textContent.includes('Synthetic README result')`)
  await evaluate(`(() => { const input = document.querySelector('[aria-label="Search session trace"]'); input.value = 'Vue'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  await waitFor(`document.querySelectorAll('.trace-event').length === 2`)
  await click('#diagnosis-tools-tab')
  assert.equal(await evaluate(`document.querySelectorAll('#diagnosis-tools .tool-def').length`), 1)
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#diagnosis-tools .rounded-md')).borderRadius`), '14px', 'UnoCSS cards must share surface tokens')
  await click('#diagnosis-prompt-tab')
  assert.match(await evaluate<string>(`document.querySelector('#diagnosis-prompt').textContent`), /Synthetic system prompt/)
  assert.equal(await evaluate(`document.querySelectorAll('.system-prompt-content .katex math').length`), 2)
  assert.equal(await evaluate(`getComputedStyle(document.querySelector('#diagnosis-prompt .i-lucide-copy')).maskImage.includes('data:image/svg+xml')`), true)
  await click('#conversation-tab')
  assert.equal(await evaluate(`document.querySelector('.composer-input textarea') === window.retainedInput`), true)
  assert.equal(await evaluate(`document.querySelector('.composer-input textarea').value`), 'Keep this unsent draft')
  assert.equal(await evaluate(`document.querySelector('.chat-messages').scrollTop === window.retainedScroll`), true)
  await click('#diagnosis-tab')
  await click('#diagnosis-trace-tab')
  await evaluate(`(() => { const input = document.querySelector('[aria-label="Search session trace"]'); input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
  live = true
  await waitFor(`!document.querySelector('.trace-heading button').disabled`)
  await click('.trace-heading button')
  await waitFor(`document.querySelectorAll('.lane-bar.running').length === 1`)
  live = false
  fail = true
  await waitFor(`!document.querySelector('.trace-heading button').disabled`)
  await click('.trace-heading button')
  await waitFor(`document.querySelector('.diagnosis-error')?.textContent.includes('503')`)
  fail = false
  await click('.trace-heading button')
  await waitFor(`!document.querySelector('.diagnosis-error') && document.querySelectorAll('.lane-bar.running').length === 0`)
  await click('.span-inspector [aria-label="Close span details"]')
  await evaluate(`document.querySelector('.diagnosis-scroll').scrollTop = 0`)
  await new Promise(resolve => setTimeout(resolve, 200))
  await writeFile(join(directory, 'diagnosis-desktop.png'), (await window.webContents.capturePage()).toPNG())
  const wideBounds = await evaluate<boolean>(`document.documentElement.scrollWidth <= innerWidth && document.querySelector('.session-diagnosis').getBoundingClientRect().bottom <= innerHeight`)
  assert.equal(wideBounds, true)
  window.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width: 390, height: 844 }, viewPosition: { x: 0, y: 0 }, viewSize: { width: 390, height: 844 }, deviceScaleFactor: 1, scale: 1 })
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth && document.querySelector('.trace-search').getBoundingClientRect().right <= innerWidth`), true)
  await writeFile(join(directory, 'diagnosis-mobile.png'), (await window.webContents.capturePage({ x: 0, y: 0, width: 390, height: 844 })).toPNG())
  window.webContents.disableDeviceEmulation()
  await click('#conversation-tab')
  await click('.segment-nav-btn')
  await waitFor(`document.querySelector('.chat-messages').textContent.includes('Historical segment only')`)
  await click('#diagnosis-tab')
  await waitFor(`document.querySelector('#diagnosis-trace').textContent.includes('Historical segment only') && document.querySelectorAll('.lane-bar.model').length === 0`)
  assert.equal(traceQueries.at(-1)?.searchParams.get('physicalSessionId'), 'physical-older')
  await click('#conversation-tab')
  await click('.segment-nav-btn')
  await waitFor(`document.querySelectorAll('.chat-bubble').length >= 4`)
  await click('#diagnosis-tab')
  await waitFor(`document.querySelectorAll('.lane-bar.model').length === 2`)
  gate = new Promise<void>(resolve => { release = resolve })
  const count = traceQueries.length
  await click('.trace-heading button')
  await waitFor(`document.querySelector('.trace-heading button').disabled`)
  while (traceQueries.length === count) await new Promise(resolve => setTimeout(resolve, 20))
  await evaluate(`Array.from(document.querySelectorAll('.session-select')).find(node => node.title.includes(${JSON.stringify(idB)})).click()`)
  release!()
  await waitFor(`document.querySelector('.chat-messages').textContent.includes('Only the second session')`)
  assert.equal(await evaluate(`document.querySelector('.chat-user .message-time').textContent`), 'Time unavailable')
  await click('#diagnosis-tab')
  await waitFor(`document.querySelector('#diagnosis-trace').textContent.includes('Only the second session')`)
  assert.equal(await evaluate(`document.querySelectorAll('.lane-bar.model').length`), 0)
  assert.equal(await evaluate(`document.querySelector('#diagnosis-trace').textContent.includes('Synthetic README result')`), false)
  await click('#conversation-tab')
  const send = async (text: string) => {
    await evaluate(`(() => { const input = document.querySelector('.composer-input textarea'); input.value = ${JSON.stringify(text)}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
    await click('.composer-send')
  }
  await send('Timestamp input')
  await waitFor(`document.querySelector('.chat-assistant:last-child')?.textContent.includes('A streamed response')`)
  assert.equal(await evaluate(`document.querySelectorAll('.chat-role, .chat-sender').length`), 0, 'Streaming must not restore role labels')
  const partialTime = await evaluate<string>(`document.querySelector('.chat-assistant:last-child .message-time').dateTime`)
  assert.ok(Number.isFinite(Date.parse(partialTime)))
  assert.ok(await evaluate(`Array.from(document.querySelectorAll('.chat-user')).at(-1).querySelector('.message-time').dateTime.length > 0`))
  assert.ok(completeSend)
  completeSend()
  await waitFor(`document.querySelector('.chat-messages').textContent.includes('Final timestamped response') && !document.querySelector('.composer-input textarea').disabled`)
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.chat-assistant')).find(bubble => bubble.textContent.includes('A streamed response')).querySelector('.message-time').dateTime`), partialTime)
  assert.ok(await evaluate(`Array.from(document.querySelectorAll('.chat-assistant .message-time')).every(time => Number.isFinite(Date.parse(time.dateTime)))`))
  await send('Early EOF timestamp')
  await waitFor(`Array.from(document.querySelectorAll('.chat-assistant')).filter(bubble => bubble.textContent.includes('A streamed response')).length === 2 && !document.querySelector('.composer-input textarea').disabled`)
  await send('Failed timestamp')
  await waitFor(`document.querySelector('.chat-messages').textContent.includes('Error:') && !document.querySelector('.composer-input textarea').disabled`)
  const background = eventStreams.get('chat-diagnosis-b')
  assert.ok(background)
  background.write(`data: ${JSON.stringify({ event: 'response', content: 'Background timestamped reply.', done: true })}\n\n`)
  await waitFor(`document.querySelector('.chat-messages').textContent.includes('Background timestamped reply')`)
  assert.ok(await evaluate(`Array.from(document.querySelectorAll('.chat-assistant .message-time')).every(time => Number.isFinite(Date.parse(time.dateTime)))`))
  await new Promise(resolve => setTimeout(resolve, 150))
  await writeFile(join(directory, 'bubble-timestamps.png'), (await window.webContents.capturePage()).toPNG())
  await evaluate(`Array.from(document.querySelectorAll('.session-select')).find(node => node.title.includes(${JSON.stringify(idGroup)})).click()`)
  await waitFor(`document.querySelectorAll('.chat-sender').length === 2`)
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.chat-sender'), node => node.textContent)`), ['Alice', 'Bob & the <frontend> team'])
  assert.equal(await evaluate(`document.querySelectorAll('.chat-role, .chat-assistant .chat-sender, .chat-sender frontend').length`), 0)
  assert.equal(await evaluate(`document.querySelectorAll('.chat-footer .usage-badge').length`), 3)
  assert.equal(await evaluate(`document.querySelectorAll('.chat-bubble .message-time').length`), 4)
  await click('.tool-call-header')
  await click('.tool-result-header')
  await click('.system-event-header')
  await waitFor(`Boolean(document.querySelector('.tool-call-detail')) && Boolean(document.querySelector('.system-event-body'))`)
  await evaluate(`document.querySelector('.chat-messages').scrollTop = 0; document.documentElement.classList.add('dark')`)
  await new Promise(resolve => setTimeout(resolve, 150))
  await writeFile(join(directory, 'rounded-chat-desktop.png'), (await window.webContents.capturePage()).toPNG())
  await evaluate(`document.documentElement.classList.remove('dark')`)
  await new Promise(resolve => setTimeout(resolve, 150))
  await writeFile(join(directory, 'rounded-chat-light.png'), (await window.webContents.capturePage()).toPNG())
  await evaluate(`document.documentElement.classList.add('dark')`)
  window.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width: 390, height: 844 }, viewPosition: { x: 0, y: 0 }, viewSize: { width: 390, height: 844 }, deviceScaleFactor: 1, scale: 1 })
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth && Array.from(document.querySelectorAll('.chat-bubble, .tool-group, .system-event')).every(node => node.getBoundingClientRect().right <= innerWidth)`), true)
  await writeFile(join(directory, 'rounded-chat-mobile.png'), (await window.webContents.capturePage({ x: 0, y: 0, width: 390, height: 844 })).toPNG())
  window.webContents.disableDeviceEmulation()
  await waitFor(`innerWidth > 700`)
  await new Promise(resolve => setTimeout(resolve, 150))
  await click('[aria-label="Add project"]')
  await waitFor(`document.querySelectorAll('#project-actions [role="menuitem"]').length === 3`)
  await evaluate(`Array.from(document.querySelectorAll('#project-actions [role="menuitem"]')).find(node => node.textContent.includes('Start from scratch')).click()`)
  await waitFor(`Boolean(document.querySelector('.draft-heading'))`)
  const draftCount = traceQueries.length
  await new Promise(resolve => setTimeout(resolve, 2200))
  assert.equal(traceQueries.length, draftCount, 'Unsent draft must not query or materialize diagnosis')
  assert.equal(await evaluate(`Boolean(document.querySelector('.session-diagnosis'))`), false)
  inventoryGate = new Promise(resolve => { releaseInventory = resolve })
  await window.loadURL(`${origin}/workspaces`)
  await waitFor(`document.querySelector('.inventory-status')?.textContent.includes('Loading devices')`)
  assert.equal(await evaluate(`document.querySelectorAll('.node-admin-row').length`), 0)
  releaseInventory!()
  await waitFor(`location.pathname === '/nodes' && document.querySelectorAll('.node-admin-row').length === 3`)
  assert.deepEqual(await evaluate(`Array.from(document.querySelectorAll('.tab-nav [aria-current="page"]'), node => node.textContent.trim())`), ['Nodes'])
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.tab-nav .tab')).some(node => node.textContent.trim() === 'Workspaces')`), false)
  assert.equal(await evaluate(`Boolean(document.querySelector('.fixture-notice'))`), false)
  assert.equal(await evaluate(`document.querySelector('.capability-overview').textContent`), 'Workdir (1) · Shell (1)')
  assert.equal(await evaluate(`document.querySelectorAll('.node-admin-row .local-mark').length`), 1)
  assert.equal(await evaluate(`Array.from(document.querySelectorAll('.node-facts dt')).some(node => /Version|Last seen/.test(node.textContent))`), false)
  assert.equal(await evaluate(`document.querySelectorAll('.admin-actions').length`), 0)
  assert.equal(await evaluate(`document.querySelectorAll('.node-capabilities[open]').length`), 0)
  await evaluate(`document.querySelector('.node-capabilities summary').focus()`)
  assert.equal(await evaluate(`document.activeElement === document.querySelector('.node-capabilities summary')`), true)
  await click('.node-capabilities summary')
  await waitFor(`Boolean(document.querySelector('.node-capabilities[open]'))`)
  assert.equal(await evaluate(`document.querySelectorAll('.node-capabilities[open] .capability-row').length`), 2)
  assert.match(await evaluate<string>(`document.querySelector('.node-capabilities[open] .path').textContent`), /synthetic/)
  assert.equal(await evaluate(`document.querySelector('.node-admin-list').textContent.includes('fixture-source')`), false)
  assert.equal(await evaluate(`document.querySelector('.node-admin-list').textContent.includes('Approval')`), false)
  await evaluate(`document.querySelectorAll('.node-capabilities').forEach(details => details.open = true)`)
  assert.equal(await evaluate(`document.querySelectorAll('.capability-row .availability.unavailable').length`), 1)
  assert.equal(await evaluate(`document.querySelectorAll('.node-admin-row .status-dot.revoked').length`), 1)
  assert.equal(await evaluate(`document.querySelectorAll('.capability-row .path').length`), 1, 'Never invent remote paths')
  await new Promise(resolve => setTimeout(resolve, 200))
  await writeFile(join(directory, 'nodes-capabilities-desktop.png'), (await window.webContents.capturePage()).toPNG())
  window.webContents.enableDeviceEmulation({ screenPosition: 'desktop', screenSize: { width: 390, height: 844 }, viewPosition: { x: 0, y: 0 }, viewSize: { width: 390, height: 844 }, deviceScaleFactor: 1, scale: 1 })
  await new Promise(resolve => setTimeout(resolve, 150))
  assert.equal(await evaluate(`document.documentElement.scrollWidth <= innerWidth && Array.from(document.querySelectorAll('.node-admin-row, .capability-row, .capability-row .path')).every(node => node.getBoundingClientRect().right <= innerWidth)`), true)
  await writeFile(join(directory, 'nodes-capabilities-mobile.png'), (await window.webContents.capturePage({ x: 0, y: 0, width: 390, height: 844 })).toPNG())
  window.webContents.disableDeviceEmulation()
  inventoryState = 'changed'
  await waitFor(`document.querySelectorAll('.capability-row .availability.online').length === 3`)
  assert.equal(await evaluate(`document.querySelectorAll('.node-capabilities[open]').length`), 2, 'Polling must preserve expanded devices')
  inventoryState = 'error'
  await click('.context-strip button')
  await waitFor(`document.querySelector('.inventory-error')?.textContent.includes('503')`)
  assert.equal(await evaluate(`document.querySelectorAll('.node-admin-row').length`), 0, 'Unavailable API must not display stale online statuses')
  inventoryState = 'empty'
  await click('.context-strip button')
  await waitFor(`document.querySelector('.empty-panel')?.textContent.includes('No devices registered')`)
  assert.equal(await evaluate(`Boolean(document.querySelector('.inventory-error'))`), false)
  inventoryState = 'ready'
  await click('.context-strip button')
  await waitFor(`document.querySelectorAll('.node-admin-row').length === 3`)
  inventoryGate = new Promise(resolve => { releaseInventory = resolve })
  await click('.context-strip button')
  await waitFor(`document.querySelector('.context-strip button').disabled`)
  await evaluate(`Array.from(document.querySelectorAll('.tab-nav .tab')).find(node => node.textContent.trim() === 'Chat').click()`)
  await waitFor(`location.pathname === '/chat' && !document.querySelector('.node-admin-list')`)
  releaseInventory!()
  const stoppedInventoryRequests = inventoryRequests
  await new Promise(resolve => setTimeout(resolve, 5200))
  assert.equal(inventoryRequests, stoppedInventoryRequests, 'Unmounted Nodes must stop polling')
  assert.deepEqual(unexpected, [])
  assert.equal(window.isVisible(), false)
  console.log(`LAYOUT_RESULT ${JSON.stringify({ ok: true, diagnosis: true, messageTimestamps: true, roundedSurfaces: true, groupAuthors: true, traceRequests: traceQueries.length, screenshotDirectory: directory })}`)
}
main().then(() => app.exit(0), error => {
  console.error(error)
  app.exit(1)
}).finally(() => {
  release?.()
  releaseInventory?.()
  window?.destroy()
  server.closeAllConnections()
  server.close()
})
