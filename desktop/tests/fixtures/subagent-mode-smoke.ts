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
const directory = argument('layout-root')
const assets = argument('layout-assets')
for (const name of ['userData', 'sessionData', 'logs', 'crashDumps'] as const) {
  mkdirSync(join(directory, name), { recursive: true })
  app.setPath(name, join(directory, name))
}
app.setPath('home', directory)
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.on('window-all-closed', () => {})

const root = 'web:chat-mode-owner'
const task = 'web:chat-mode-task'
const nested = 'web:chat-mode-nested'
const reusable = 'web:chat-mode-reusable'
const reusableCall = 'web:chat-mode-reusable-call'
const userFork = 'web:chat-mode-user-fork'
const reflection = 'heartbeat:reflector-mode-fixture'
const unplaced = 'web:chat-mode-older-execution'
const liveExecutions = new Set<string>()
const sessions = [
  { sessionId: root, title: 'Owning conversation', mode: 'session', agentType: 'general' },
  { sessionId: userFork, title: 'Quoted side chat', mode: 'session', agentType: 'general', parentSessionId: null },
  { sessionId: reusable, title: 'Reusable explorer', mode: 'session', agentType: 'explore', parentSessionId: root, waitingForCall: false },
  { sessionId: task, title: 'Inspect repository structure', mode: 'task', agentType: 'explore', parentSessionId: root, executionStatus: 'running', waitingForCall: false },
  { sessionId: nested, title: 'Verify repository findings', mode: 'call', agentType: 'explore', parentSessionId: task, executionStatus: 'pending' },
  { sessionId: reusableCall, title: 'Review reusable explorer findings', mode: 'call', agentType: 'explore', parentSessionId: reusable, executionStatus: 'pending' },
  ...(['completed', 'pending', 'failed', 'cancelled'] as const).map(status => ({
    sessionId: `web:chat-mode-${status}`, title: `${status} execution with a deliberately long descriptive title`,
    mode: 'task', agentType: 'explore', parentSessionId: root, executionStatus: status,
  })),
  { sessionId: reflection, title: 'System self reflection', mode: 'task', agentType: 'reflector', executionStatus: 'completed' },
  { sessionId: unplaced, title: 'Execution from older history', mode: 'task', agentType: 'explore', parentSessionId: root, executionStatus: 'completed' },
]
function trace(id: string) {
  const children = sessions.filter(item => item.parentSessionId === id && item.mode !== 'session' && item.sessionId !== unplaced && !liveExecutions.has(item.sessionId))
  return [
    { role: 'assistant', content: `Internal trace for ${id}.` },
    ...(children.length ? [{
      role: 'assistant', content: 'Starting delegated work.',
      tool_calls: children.map(item => ({
        id: `spawn-${item.sessionId}`, type: 'function',
        function: { name: 'subagent', arguments: JSON.stringify({ mode: item.mode, description: item.title, task: 'Synthetic assignment' }) },
      })),
    }, ...children.filter(item => item.mode !== 'call' || item.executionStatus === 'completed').map(item => ({
      role: 'tool', tool_call_id: `spawn-${item.sessionId}`, name: 'subagent',
      content: JSON.stringify({ sessionId: item.sessionId, mode: item.mode,
        status: item.mode === 'call' ? 'completed' : 'running', ...(item.mode === 'call' ? { result: 'Synthetic leaf result' } : {}) }),
    })), { role: 'assistant', content: 'Work continues after delegation.' }] : []),
  ]
}
const live = new LiveFixture()
const failures: string[] = []
const fileReads: string[] = []
const yieldReads: string[] = []
let graphRequests = 0
let malformedGraph = false
let rejectContext = ''
let rejectHistory = ''
let sends = 0
let rootStreaming = false
let reusableYield = false
const server = createServer(async (request, response) => {
  try {
    if (live.handle(request, response)) return
    const url = new URL(request.url!, 'http://127.0.0.1')
    const path = decodeURIComponent(url.pathname).replace(/^\/projects\/default(?=\/)/, '')
    const json = (data: unknown, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(data))
    }
    if (request.method !== 'GET') { sends++; return json({ error: 'Fixture forbids mutations' }, 403) }
    const provider = { ready: true, provider: 'custom', model: 'synthetic-model', authMode: 'none', hasApiKey: false }
    if (path === '/api/projects') return json({ projects: [{ id: 'default', name: 'Default', createdAt: '2026-09-16T00:00:00Z' }] })
    if (path === '/api/projects/default/status') return json({ state: 'ready' })
    if (path === '/api/automations') return json({ automations: [] })
    if (path === '/api/provider/setup') return json(provider)
    if (path === '/api/provider/configured') return json({ providers: [{ ...provider, selected: true }] })
    if (path === '/debug/models') return json({ models: ['synthetic-model'] })
    if (path === '/api/config') return json({ agent: { model: 'synthetic-model', workspace: directory, temperature: 0.7 } })
    if (path === '/api/folders') return json({ folders: [] })
    if (path === '/api/sessions/graph') {
      graphRequests++
      if (malformedGraph) return json({ sessions: [{ sessionId: task, mode: 'ephemeral' }], nodes: [] })
      return json({
        sessions: sessions.map(item => ({ ...item, parentToolCallId: item.mode !== 'session' ? `spawn-${item.sessionId}` : undefined,
          current: item.executionStatus === 'pending' ? undefined : `physical-${item.sessionId}` })),
        // Delegated records use logical owners; the user fork has only a physical context edge.
        nodes: sessions.map(item => ({
          physicalId: `physical-${item.sessionId}`, logicalId: item.sessionId,
          parentPhysicalId: item.sessionId === userFork ? `physical-${root}` : null,
        })),
      })
    }
    if (path === '/api/sessions/stages') return json({ stages: {
      [root]: rootStreaming ? 'llm' : 'idle',
      [userFork]: 'idle',
      [task]: sessions.find(item => item.sessionId === task)!.waitingForCall ? 'waiting' : 'tool',
      [reusable]: reusableYield || sessions.find(item => item.sessionId === reusable)!.waitingForCall ? 'waiting' : 'idle',
      [nested]: sessions.find(item => item.sessionId === nested)!.executionStatus === 'running' ? 'llm' : 'idle',
      [reflection]: 'idle',
    }, waitingForCalls: Object.fromEntries(sessions.map(item => [item.sessionId, !!item.waitingForCall])) })
    if (path === '/api/chat/session') return json({
      history: url.searchParams.get('chatId') === userFork.replace('web:', '')
        ? [{ role: 'assistant', content: 'Side chat quotation source.' }]
        : [{ role: 'user', content: 'Inspect this folder without changing my draft.' }, ...trace(url.searchParams.get('chatId') === reusable.replace('web:', '') ? reusable : root),
          ...live.history(`web:${url.searchParams.get('chatId')}`)],
      systemPrompt: '', tools: [],
    })
    const match = path.match(/^\/api\/sessions\/([^/]+)(?:\/(.*))?$/)
    if (match) {
      const id = match[1]
      const operation = match[2]
      if (operation === 'background-tasks') return json({ sessionId: id, total: 0, tasks: [] })
      assert.ok(sessions.some(item => item.sessionId === id), `Unknown fixture session: ${id}`)
      if (operation === 'details') return json({ sessionId: id, name: sessions.find(item => item.sessionId === id)!.title, workdir: { kind: 'local', displayPath: 'C:\\fixtures\\subagent-modes' }, usage: null, usageScope: 'session', context: { usedTokens: null, windowTokens: null } })
      if (operation === 'context') return id === rejectContext
        ? json({ error: 'Synthetic closed execution context' }, 409)
        : json({ systemPrompt: 'Synthetic context snapshot', tools: [] })
      if (operation === 'yield') {
        yieldReads.push(id)
        return json({ request: id === reusable && reusableYield ? {
          id: 'reusable-question', sessionId: reusable, question: 'Which verification should continue?',
          options: ['Check tests', 'Check types', 'Check documentation'], defaultOption: 'Check tests',
          recipient: { kind: 'user', sessionId: reusable }, createdAt: '2026-09-13T12:00:00Z', deadline: null,
        } : null })
      }
      if (operation === 'files') {
        fileReads.push(id)
        return json({ path: '', entries: [{ name: 'fixture.txt', type: 'file', ext: '.txt', size: 20, mtime: '2026-09-01T00:00:00Z' }], workdir: { kind: 'local', displayPath: directory } })
      }
      if (operation === 'preview') return json({ binary: false, content: 'Synthetic preview content', size: 20, truncated: false })
      if (operation === 'git/status') return json({ available: false, entries: [], reason: 'not_repository' })
      if (!operation) return id === rejectHistory
        ? json({ error: 'Synthetic closed execution' }, 410)
        : json({ messages: trace(id), previousPhysicalId: null })
    }
    if (/^\/(?:api|debug|nodes|local)\//.test(path)) {
      failures.push(`Unstubbed ${request.method} ${path}`)
      return json({ error: 'Unstubbed fixture endpoint' }, 404)
    }
    const assetIndex = path.indexOf('/assets/')
    const file = assetIndex >= 0 ? resolve(assets, `.${path.slice(assetIndex)}`) : join(assets, 'index.html')
    const within = relative(assets, file)
    assert.ok(!within.startsWith('..') && !isAbsolute(within))
    const contentType = ({ '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' } as Record<string, string>)[extname(file)] ?? 'application/octet-stream'
    response.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'no-store' })
    const content = await readFile(file)
    response.end(contentType === 'text/html' ? content.toString().replace(/<link\b[^>]*href=["']https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>/g, '') : content)
  } catch (cause) {
    failures.push(String(cause))
    if (!response.headersSent) response.writeHead(500)
    response.end()
  }
})
const evaluate = <T = unknown>(window: BrowserWindow, source: string): Promise<T> => window.webContents.executeJavaScript(source)
async function waitFor(window: BrowserWindow, source: string): Promise<void> {
  const deadline = Date.now() + 15000
  while (!await evaluate(window, source)) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${source}; failures=${JSON.stringify(failures)}`)
    await new Promise(resolve => setTimeout(resolve, 40))
  }
}
async function click(window: BrowserWindow, selector: string): Promise<void> {
  await waitFor(window, `(() => {
    const target = document.querySelector(${JSON.stringify(selector)});
    return !!target?.getClientRects().length && !target.disabled && target.getAttribute('aria-disabled') !== 'true';
  })()`)
  await evaluate(window, `document.querySelector(${JSON.stringify(selector)}).click()`)
}
const card = (id: string, pane = '.primary-conversation') => `${pane} [data-execution-id="${id}"] .execution-inspect`
async function screenshot(window: BrowserWindow, name: string) {
  await evaluate(window, 'document.fonts.ready')
  await evaluate(window, 'new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))')
  assert.equal(await evaluate(window, 'document.documentElement.scrollWidth <= innerWidth'), true, `${name}: no horizontal viewport overflow`)
  await writeFile(join(directory, `${name}.png`), (await window.webContents.capturePage()).toPNG())
}
async function runViewport(origin: string, width: number, height: number) {
  malformedGraph = false
  rejectHistory = ''
  rejectContext = ''
  rootStreaming = false
  reusableYield = false
  liveExecutions.clear()
  live.histories.clear()
  sessions.find(item => item.sessionId === task)!.executionStatus = 'running'
  sessions.find(item => item.sessionId === task)!.waitingForCall = false
  sessions.find(item => item.sessionId === reusable)!.waitingForCall = false
  sessions.find(item => item.sessionId === nested)!.executionStatus = 'pending'
  sessions.find(item => item.sessionId === reusableCall)!.executionStatus = 'pending'
  const isolated = session.fromPartition(`subagent-mode-${width}`, { cache: false })
  isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(`${origin}/`) }))
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  const window = new BrowserWindow({ width, height, show: false, frame: false, useContentSize: true,
    webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(`${origin}/`)) event.preventDefault() })
  const viewport = width > 700 ? 'desktop' : 'mobile'
  try {
    await window.loadURL(`${origin}/chat/${encodeURIComponent(root)}`)
    await waitFor(window, `!!document.querySelector(${JSON.stringify(card(task))}) && !!document.querySelector('.primary-conversation textarea')`)
    assert.equal(await evaluate(window, `(() => {
      const spinner = document.querySelector(${JSON.stringify(card(task))})?.querySelector('.activity-spinner');
      if (!spinner) return false;
      const ring = getComputedStyle(spinner), center = getComputedStyle(spinner.parentElement, '::after');
      return ring.borderRadius === '50%' && ring.width === '14px' && ring.height === '14px'
        && center.borderRadius === '50%' && ring.animationName.includes('activity-spin');
    })()`), true, 'Loading remains circular on desktop and mobile despite square interface tokens')
    await waitFor(window, `!document.querySelector('.primary-conversation .chat-messages')?.textContent.includes('Loading history') && document.querySelector('.primary-conversation .heading-folder')?.textContent.includes('subagent-modes')`)
    if (width > 700) await waitFor(window, `!!document.querySelector('.primary-conversation .tree-row[data-path="fixture.txt"]')`)
    assert.equal(await evaluate(window, `!!document.querySelector('.primary-conversation .chat-working, .primary-conversation .yield-question')`), false, 'Async child execution does not suspend the idle parent or invite a human response')
    assert.equal(await evaluate(window, `document.querySelector('.primary-conversation textarea').disabled`), false, 'Caller can continue while async children execute')
    await evaluate(window, `(() => {
      const input = document.querySelector('.primary-conversation textarea');
      input.value = 'Keep this exact unsent draft'; input.dispatchEvent(new Event('input', { bubbles: true }));
      window.modeRefs = { card: document.querySelector(${JSON.stringify(card(task))}), input, tree: document.querySelector('.folders-sidebar .session-select') };
    })()`)
    assert.equal(await evaluate(window, `Array.from(document.querySelectorAll('.folders-sidebar .session-select')).some(node => /Inspect repository|execution with|Verify repository findings/.test(node.textContent))`), false)
    assert.equal(await evaluate(window, `Array.from(document.querySelectorAll('.folders-sidebar .session-select')).some(node => node.textContent.includes('Reusable explorer'))`), true)
    assert.equal(await evaluate(window, `Array.from(document.querySelectorAll('.folders-sidebar .session-select')).filter(node => node.textContent.includes('System self reflection')).length`), 1, 'Legacy records without automation metadata remain inspectable')
    await click(window, '.primary-conversation .unlinked-executions summary')
    await click(window, '.primary-conversation .unlinked-executions button')
    await waitFor(window, `document.querySelector('.child-conversation .chat-content')?.textContent.includes(${JSON.stringify(unplaced)})`)
    await click(window, '.close-child')
    await waitFor(window, `!document.querySelector('.child-conversation')`)
    await click(window, '.primary-conversation .unlinked-executions summary')
    await evaluate(window, `document.querySelector(${JSON.stringify(card(task))}).scrollIntoView({ block: 'start' })`)
    assert.equal(await evaluate(window, `(() => { const r = document.querySelector(${JSON.stringify(card(task))}).getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })()`), true, 'Inline execution card stays bounded')
    assert.equal(await evaluate(window, `!!document.querySelector('.execution-list, .execution-cards')`), false, 'There is no detached execution footer')
    assert.equal(await evaluate(window, `(() => {
      const card = document.querySelector(${JSON.stringify(card(task))}).closest('.execution-card');
      const after = Array.from(document.querySelectorAll('.primary-conversation .chat-content')).find(item => item.textContent.includes('Work continues after'));
      return !!(card.compareDocumentPosition(after) & Node.DOCUMENT_POSITION_FOLLOWING);
    })()`), true, 'Task box appears at its tool call before later prose')
    await screenshot(window, `subagent-mode-cards-${viewport}`)

    const before = graphRequests
    sessions.find(item => item.sessionId === task)!.executionStatus = 'waiting'
    sessions.find(item => item.sessionId === task)!.waitingForCall = true
    sessions.find(item => item.sessionId === nested)!.executionStatus = 'running'
    live.publisher.invalidateSessions(task)
    await waitFor(window, `document.querySelector(${JSON.stringify(card(task))})?.textContent.includes('Waiting for call')`)
    assert.ok(graphRequests > before)
    assert.equal(await evaluate(window, `window.modeRefs.card === document.querySelector(${JSON.stringify(card(task))}) && window.modeRefs.input === document.querySelector('.primary-conversation textarea') && window.modeRefs.tree.isConnected`), true, 'Graph refresh preserves actual card, tree and composer DOM identity')
    malformedGraph = true
    live.publisher.invalidateSessions()
    await waitFor(window, `document.querySelector('.folders-sidebar')?.textContent.includes('Cannot read conversations')`)
    assert.equal(await evaluate(window, `window.modeRefs.card.isConnected && document.querySelector('.primary-conversation textarea').value === 'Keep this exact unsent draft'`), true)
    malformedGraph = false
    live.publisher.invalidateSessions()
    await waitFor(window, `!document.querySelector('.folders-sidebar')?.textContent.includes('Cannot read conversations')`)

    await click(window, card(task))
    await waitFor(window, `document.querySelector('.child-conversation .chat-content')?.textContent.includes(${JSON.stringify(task)})`)
    assert.equal(await evaluate(window, `!!document.querySelector('.child-conversation textarea') || !!document.querySelector('.child-conversation .workbench-explorer') || !!document.querySelector('.child-conversation .explorer-toggle')`), false, 'Execution inspection has no composer or file tree')
    assert.equal(fileReads.includes(task), false)
    assert.equal(await evaluate(window, `document.querySelector('.primary-conversation textarea').value`), 'Keep this exact unsent draft')
    assert.equal(await evaluate(window, `document.querySelector('.child-conversation .execution-summary').textContent.includes('Waiting for call')`), true)
    assert.equal(await evaluate(window, `!!document.querySelector('.child-conversation .execution-summary .activity-spinner, .child-conversation .working-wave, .child-conversation .yield-question')`), false, 'Task suspended on a call is neither thinking nor waiting for human input')
    await screenshot(window, `subagent-mode-inspect-${viewport}`)
    await click(window, card(nested, '.child-conversation'))
    await waitFor(window, `document.querySelector('.child-conversation .chat-content')?.textContent.includes(${JSON.stringify(nested)})`)
    assert.equal(await evaluate(window, `!!document.querySelector('.child-conversation textarea, .child-conversation .yield-question, .child-conversation .execution-cards')`), false, 'Leaf call has no message, yield, or child-execution controls')
    assert.equal(await evaluate(window, `document.querySelector('.child-conversation .execution-summary').textContent.includes('Call · inherited context · blocking')`), true)
    assert.equal(fileReads.includes(nested), false)
    assert.equal(yieldReads.includes(nested), false, 'Call inspector must not poll the yield endpoint')
    sessions.find(item => item.sessionId === nested)!.executionStatus = 'completed'
    sessions.find(item => item.sessionId === task)!.waitingForCall = false
    sessions.find(item => item.sessionId === task)!.executionStatus = 'running'
    live.publisher.invalidateSessions(nested)
    await waitFor(window, `document.querySelector('.child-conversation .execution-summary')?.textContent.includes('Completed')`)
    assert.equal(await evaluate(window, `!!document.querySelector('.child-conversation .execution-summary .activity-spinner')`), false, 'Terminal call never remains animated')
    await screenshot(window, `subagent-mode-nested-${viewport}`)
    await click(window, '.child-conversation [aria-label="Back to owning execution"]')
    await waitFor(window, `!!document.querySelector(${JSON.stringify(card(nested, '.child-conversation'))})`)

    rejectContext = nested
    await click(window, card(nested, '.child-conversation'))
    await waitFor(window, `document.querySelector('.child-conversation .composer-error')?.textContent.includes('Could not load execution context')`)
    rejectContext = ''
    await click(window, '.child-conversation [aria-label="Back to owning execution"]')
    await waitFor(window, `!!document.querySelector(${JSON.stringify(card(nested, '.child-conversation'))})`)
    rejectHistory = nested
    await click(window, card(nested, '.child-conversation'))
    await waitFor(window, `document.querySelector('.child-conversation .composer-error')?.textContent.includes('Could not update this conversation')`)
    rejectHistory = ''
    await click(window, '.close-child')
    await waitFor(window, `!document.querySelector('.child-conversation')`)
    assert.equal(await evaluate(window, `document.querySelector('.primary-conversation textarea').value`), 'Keep this exact unsent draft')

    if (width <= 700) await click(window, '.projects-toggle')
    await click(window, '.folders-sidebar .session-select[aria-label="Quoted side chat"]')
    await waitFor(window, `document.querySelector('.child-conversation .chat-content')?.textContent.includes('Side chat quotation source.') && !!document.querySelector('.child-conversation textarea') && !document.querySelector('.child-conversation .chat-messages')?.textContent.includes('Loading history')`)
    assert.equal(await evaluate(window, `document.querySelector('.primary-conversation textarea') === window.modeRefs.input && window.modeRefs.input.value === 'Keep this exact unsent draft'`), true, 'Context-only fork must retain its original primary pane and draft')
    assert.equal(await evaluate(window, `new URLSearchParams(location.search).get('child')`), userFork)
    assert.equal(await evaluate(window, `!!document.querySelector('.child-conversation .workbench-explorer, .child-conversation .explorer-toggle')`), false)
    const beforeForkRefresh = graphRequests
    await evaluate(window, `(() => {
      const input = document.querySelector('.child-conversation textarea');
      input.focus(); input.value = 'Side chat draft'; input.dispatchEvent(new Event('input', { bubbles: true }));
      input.blur(); window.forkInput = input;
    })()`)
    await evaluate(window, 'new Promise(resolve => requestAnimationFrame(resolve))')
    await evaluate(window, `(() => {
      const paragraph = document.querySelector('.child-conversation .chat-content p');
      const range = document.createRange(); range.selectNodeContents(paragraph);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    })()`)
    await click(window, '.selection-menu button[aria-keyshortcuts="Q"]')
    await waitFor(window, `document.querySelector('.child-conversation textarea')?.value.includes('> Side chat quotation source.')`)
    live.publisher.invalidateSessions(userFork)
    const refreshDeadline = Date.now() + 10000
    while (graphRequests <= beforeForkRefresh && Date.now() < refreshDeadline) await new Promise(resolve => setTimeout(resolve, 50))
    assert.ok(graphRequests > beforeForkRefresh)
    assert.equal(await evaluate(window, `document.querySelector('.child-conversation textarea') === window.forkInput && window.forkInput.value.includes('Side chat draft') && window.forkInput.value.includes('> Side chat quotation source.') && window.modeRefs.input.value === 'Keep this exact unsent draft'`), true, 'Quoting and graph refresh retain side-chat input identity without touching the primary draft')
    assert.equal(fileReads.includes(userFork), false)
    await click(window, '.close-child')
    await waitFor(window, `!document.querySelector('.child-conversation')`)

    if (width <= 700) await click(window, '.projects-toggle')
    await click(window, '.folders-sidebar .session-select[aria-label="Reusable explorer"]')
    await waitFor(window, `!!document.querySelector('.child-conversation textarea')`)
    await evaluate(window, `(() => {
      const input = document.querySelector('.child-conversation textarea');
      input.value = 'Keep reusable draft'; input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    sessions.find(item => item.sessionId === reusable)!.waitingForCall = true
    sessions.find(item => item.sessionId === reusableCall)!.executionStatus = 'running'
    live.publisher.invalidateSessions(reusable)
    await waitFor(window, `document.querySelector('.child-conversation .chat-working')?.textContent.includes('Waiting for call') && document.querySelector('.child-conversation textarea')?.disabled === false`)
    assert.equal(await evaluate(window, `!!document.querySelector('.child-conversation .chat-working .activity-spinner, .child-conversation .working-wave, .child-conversation .yield-question')`), false)
    assert.equal(await evaluate(window, `document.querySelector('.primary-conversation textarea').value`), 'Keep this exact unsent draft')
    sessions.find(item => item.sessionId === reusable)!.waitingForCall = false
    sessions.find(item => item.sessionId === reusableCall)!.executionStatus = 'completed'
    live.publisher.invalidateSessions(reusable)
    await waitFor(window, `document.querySelector('.child-conversation textarea')?.disabled === false`)
    assert.equal(await evaluate(window, `document.querySelector('.child-conversation textarea').value`), 'Keep reusable draft')
    reusableYield = true
    live.publisher.invalidateSessions(reusable)
    await waitFor(window, `document.querySelector('.child-conversation .yield-question')?.textContent.includes('Which verification should continue?')`)
    assert.equal(await evaluate(window, `document.querySelector('.child-conversation .chat-working').textContent.includes('Waiting for a response')`), true)
    reusableYield = false
    live.publisher.invalidateSessions(reusable)
    await waitFor(window, `!document.querySelector('.child-conversation .yield-question')`)
    await click(window, '.close-child')
    await waitFor(window, `!document.querySelector('.child-conversation')`)

    // Root chat events and file previews remain independent of execution inspection.
    if (width > 700) {
      await click(window, '.primary-conversation .tree-row[data-path="fixture.txt"]')
      await waitFor(window, `document.querySelector('.primary-conversation .file-document')?.textContent.includes('Synthetic preview content')`)
      rootStreaming = true
      live.chat(root, { event: 'response', content: 'Synthetic live response', done: false })
      await waitFor(window, `!!document.querySelector('.primary-conversation [aria-label="Stop current request"]') && document.querySelector('.primary-conversation textarea')?.disabled === false`)
      assert.equal(await evaluate(window, `document.querySelector('.primary-conversation .conversation-document').getClientRects().length`), 0)
      await click(window, '.primary-conversation .conversation-tab button')
      await click(window, card(task))
      await waitFor(window, `!!document.querySelector('.child-conversation .execution-summary')`)
      assert.equal(await evaluate(window, `document.querySelector('.primary-conversation textarea').value`), 'Keep this exact unsent draft')
      await click(window, '.close-child')
      rootStreaming = false
      live.finish(root)
    }
    await waitFor(window, `document.querySelector('.primary-conversation textarea')?.disabled === false`)
    const emit = (payload: Parameters<LiveFixture['chat']>[1]) => live.chat(root, payload)
    const liveId = `web:chat-mode-live-${width}`
    liveExecutions.add(liveId)
    emit({ event: 'tool_call', toolCallId: `spawn-${liveId}`, toolName: 'subagent',
      toolCall: { name: 'subagent', arguments: { mode: 'task', description: 'Live delegated work', task: 'Synthetic assignment' } }, done: false })
    await waitFor(window, `Array.from(document.querySelectorAll('.primary-conversation .execution-inspect')).some(button => button.disabled && button.textContent.includes('Live delegated work'))`)
    const parallelId = `web:chat-mode-parallel-${width}`
    emit({ event: 'tool_call', toolCallId: `spawn-${parallelId}`, toolName: 'subagent',
      toolCall: { name: 'subagent', arguments: { mode: 'task', description: 'Parallel delegated work', task: 'Second synthetic assignment' } }, done: false })
    emit({ event: 'tool_result', toolCallId: `spawn-${parallelId}`, toolName: 'subagent',
      content: JSON.stringify({ sessionId: parallelId, mode: 'task', status: 'completed' }), done: false })
    sessions.push({ sessionId: liveId, title: 'Live delegated work', mode: 'task', agentType: 'explore', parentSessionId: root, executionStatus: 'running' })
    live.publisher.invalidateSessions(liveId)
    await waitFor(window, `!!document.querySelector(${JSON.stringify(card(liveId))}) && !document.querySelector(${JSON.stringify(card(liveId))}).disabled`)
    emit({ event: 'tool_result', toolCallId: `spawn-${liveId}`, toolName: 'subagent',
      content: JSON.stringify({ sessionId: liveId, mode: 'task', status: 'running' }), done: false })
    emit({ event: 'response', content: 'Parent continues after admission.', done: true })
    live.finish(root)
    await waitFor(window, `document.querySelector('.primary-conversation textarea')?.disabled === false`)
    assert.equal(await evaluate(window, `document.querySelector(${JSON.stringify(card(parallelId))})?.textContent.includes('Parallel delegated work')`), true, 'Parallel results keep their originating tool card')
    assert.equal(await evaluate(window, `document.querySelector(${JSON.stringify(card(liveId))})?.textContent.includes('Live delegated work')`), true, 'The later result cannot overwrite the earlier parallel result')
    const completion = {
      role: 'user', timestamp: '2026-09-14T00:00:00Z',
      content: [
        { type: 'text', text: `<event type="subagent-complete" source="subagent" event-id="inline-result" source-session-id="${liveId}" mode="task" />` },
        { type: 'text', text: '**Task result is visible inline.**\n\nSynthetic result: 56' },
      ],
    }
    sessions.find(item => item.sessionId === liveId)!.executionStatus = 'completed'
    live.publisher.invalidateSessions(liveId)
    emit({ event: 'session_message', message: completion })
    live.publisher.chat(root, { event: 'session_message', message: completion })
    await waitFor(window, `document.querySelector('[data-event-id="inline-result"] .event-body')?.innerText.includes('Synthetic result: 56')`)
    assert.equal(await evaluate(window, `document.querySelector('.primary-conversation textarea').disabled`), false, 'Receiving a task result does not pretend the parent is working')
    emit({ event: 'response', content: 'Parent acknowledges the completed task.', done: true })
    live.finish(root)
    await waitFor(window, `document.querySelector('.primary-conversation .chat-messages')?.textContent.includes('Parent acknowledges')`)
    assert.equal(await evaluate(window, `document.querySelectorAll('[data-event-id="inline-result"]').length`), 1, 'Event ID deduplicates live delivery')
    assert.equal(await evaluate(window, `(() => {
      const event = document.querySelector('[data-event-id="inline-result"]');
      const reply = Array.from(document.querySelectorAll('.primary-conversation .chat-content')).find(node => node.textContent.includes('Parent acknowledges'));
      return event.open && !event.querySelector('.event-metadata').open && !!(event.compareDocumentPosition(reply) & Node.DOCUMENT_POSITION_FOLLOWING);
    })()`), true, 'Completion body is expanded before the parent response; metadata remains secondary')
    assert.equal(await evaluate(window, `document.querySelector('.primary-conversation textarea').value`), 'Keep this exact unsent draft')
    await screenshot(window, `subagent-mode-events-${viewport}`)
    await window.reload()
    await waitFor(window, `document.querySelector('[data-event-id="inline-result"] .event-body')?.innerText.includes('Synthetic result: 56')`)
    assert.equal(await evaluate(window, `document.querySelector('[data-event-id="inline-result"]').open`), true, 'Persisted completion renders identically on reload')
    sessions.splice(sessions.findIndex(item => item.sessionId === liveId), 1)
    assert.equal(sends, 0, 'Inspecting executions must never invoke send, create, cancel or config mutation routes')
    assert.equal(yieldReads.includes(nested) || yieldReads.includes(reusableCall), false)
  } catch (cause) {
    await screenshot(window, `subagent-mode-failure-${viewport}`)
    console.log(`LAYOUT_SUBAGENT_MODE_FAILURE ${JSON.stringify(await evaluate(window, 'document.body.innerText.slice(0, 3500)'))}`)
    if (sessions.find(item => item.sessionId === task)?.waitingForCall) {
      const beforeReload = await evaluate(window, `document.querySelector(${JSON.stringify(card(task))})?.textContent`)
      await window.reload()
      await waitFor(window, `!!document.querySelector(${JSON.stringify(card(task))})`)
      console.log(`LAYOUT_SUBAGENT_MODE_REFRESH ${JSON.stringify({
        beforeReload, afterReload: await evaluate(window, `document.querySelector(${JSON.stringify(card(task))})?.textContent`),
        task: sessions.find(item => item.sessionId === task), graphRequests, topics: live.connections.filter(connection => !connection.closed).map(connection => connection.topics),
      })}`)
    }
    throw cause
  } finally { window.destroy() }
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
    assert.deepEqual(failures, [])
    console.log(`LAYOUT_RESULT ${JSON.stringify({ ok: true, graphRequests, sends })}`)
  } catch (cause) {
    console.error(cause)
    console.log(`LAYOUT_RESULT ${JSON.stringify({ ok: false, error: String(cause), failures })}`)
    process.exitCode = 1
  } finally {
    live.close()
    server.closeAllConnections()
    server.close()
    app.exit(Number(process.exitCode ?? 0))
  }
}
void main()
