import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { app, BrowserWindow, session } from 'electron'
import { Hono } from 'hono'
import { uiPlugin } from '../../../src/gateway/ui.ts'
import { LiveFixture } from './live-fixture.ts'
import { installDocumentTabShortcuts } from '../../src/document-tabs.js'

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

const chats = Array.from({ length: 8 }, (_, index) => `chat-connection-${index}`)
const sessions = chats.map((chatId, index) => ({
  sessionId: `web:${chatId}`, projectId: 'default', current: `physical-${index}`, title: `Connection chat ${index}`,
}))
const automationDefinitions = [
  { id: 'daily-report', name: 'Daily report', source: 'cron', session: 'fresh', schedule: 'every 1h', task: 'Summarize recent folder changes.', agentType: 'general', enabled: true },
  { id: 'encapsulation', name: 'Encapsulation', source: 'learning', session: 'fresh', schedule: 'every 2h', task: 'Review recurring activity.', agentType: 'encapsulator', enabled: true },
  { id: 'archived-job', name: 'Archived report', source: 'cron', session: 'fresh', schedule: 'every 1d', enabled: false },
]
const automationSessions = Array.from({ length: 35 }, (_, index) => ({
  sessionId: `cron:daily-report:run-${index}`, projectId: 'default', current: `run-physical-${index}`,
  title: `Report ${index}`, mode: 'task', executionStatus: 'completed',
  automation: { jobId: 'daily-report', name: 'Daily report', runId: `run-${index}`,
    startedAt: new Date(Date.UTC(2026, 8, 16, 0, 0, index)).toISOString(), contextMode: 'fresh' },
}))
const live = new LiveFixture()
const activeRequests = new Map<string, string>()
const histories = new Map(chats.map(chatId => [chatId, [{ role: 'assistant', content: `History for ${chatId}` }]]))
histories.get(chats[1])!.push(
  { role: 'user', content: 'Record a sample' },
  { role: 'assistant', content: 'Saved recording.wav' },
  { role: 'user', content: '<event type="io-complete" source="io" />Capture completed' },
  { role: 'user', content: '<event type="exec-complete" source="exec" />Background processing completed' },
)
histories.get(chats[2])!.push({ role: 'user', content: 'Unanswered human message' })
const background = new Map<string, Array<{ id: string; sessionId: string; kind: string; title: string; status: string; createdAt: string }>>()
const errors: string[] = []
let nodeRequests = 0
let providerRequests = 0
let sends = 0
let legacyStreams = 0
let rejectNext = false
let finishBeforeAck = false
let steerNext = false
let interruptNext = false
let waitingForCall = false
const cancellations: string[] = []
const deferredGuidance = new Map<string, { role: string; content: string }[]>()
let admissionGate: Promise<void> | undefined
let deletionGate: Promise<void> | undefined
let rejectDeletion = false
const deletions: string[] = []
let nodeOffline = false
let window: BrowserWindow | undefined
let phase = 'startup'
const ui = new Hono()
uiPlugin(argument('layout-assets'))(ui)
const server = createServer(async (request, response) => {
  try {
    if (await live.handle(request, response)) return
    const url = new URL(request.url!, 'http://127.0.0.1')
    const path = url.pathname.replace(/^\/projects\/default(?=\/)/, '')
    const json = (data: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json' }); response.end(JSON.stringify(data)) }
    if (path === '/api/projects') return json({ projects: [{ id: 'default', name: 'Default', createdAt: '2026-01-01T00:00:00Z' }] })
    if (path === '/api/provider/setup') return json({ ready: true, provider: 'custom', model: 'synthetic-model', authMode: 'none', hasApiKey: false })
    if (path === '/api/provider/configured') {
      providerRequests++
      return json({ providers: [{ provider: 'custom', model: 'synthetic-model', selected: true, authMode: 'none', hasApiKey: false }] })
    }
    if (path === '/nodes/v1') {
      nodeRequests++
      return json({ version: 1, nodes: [{ nodeId: 'fixture-main', displayName: 'Fixture Main', role: 'main', connection: 'connected', capabilities: [] }] })
    }
    if (path === '/debug/models') return json({ models: ['synthetic-model'] })
    if (path === '/api/config') return json({ agent: { model: 'synthetic-model', workspace: directory, temperature: 0.7 } })
    if (path === '/api/folders') return json({ folders: [] })
    if (path === '/api/automations') return json({ automations: automationDefinitions })
    const automationMatch = path.match(/^\/api\/automations\/([^/]+)\/runs$/)
    if (automationMatch) {
      const id = decodeURIComponent(automationMatch[1])
      const offset = Number(url.searchParams.get('offset') ?? 0)
      const limit = Number(url.searchParams.get('limit') ?? 30)
      const runs = automationSessions.filter(session => session.automation.jobId === id).slice().reverse()
      return json({ total: runs.length, offset, runs: runs.slice(offset, offset + limit).map(session => ({
        id: session.automation.runId, sessionId: session.sessionId, startedAt: session.automation.startedAt, status: session.executionStatus, title: session.title,
      })) })
    }
    if (path === '/api/sessions/graph') return json({ sessions: [...sessions, ...automationSessions], nodes: [] })
    if (path === '/api/sessions/stages') return json({
      stages: Object.fromEntries(chats.map(chat => [`web:${chat}`, activeRequests.has(chat) ? waitingForCall ? 'waiting-for-call' : 'llm' : 'idle'])),
      activeRequestIds: Object.fromEntries([...activeRequests].map(([chat, id]) => [`web:${chat}`, id])),
    })
    if (path === '/api/chat/session') return json({ history: histories.get(url.searchParams.get('chatId')!), systemPrompt: 'Synthetic context', tools: [] })
    if (path === '/api/chat/events') {
      legacyStreams++
      return json({ error: 'legacy stream must not be opened' }, 500)
    }
    if (path === '/api/chat/send') {
      let body = ''
      for await (const chunk of request) body += chunk
      const input = JSON.parse(body) as { chatId: string; content: string; stream?: boolean }
      if (input.stream === true) return json({ error: 'stream_removed' }, 410)
      assert.ok(live.hub.stats.clients > 0, 'subscribe before admitting a command')
      sends++
      if (rejectNext) { rejectNext = false; return json({ error: 'Synthetic rejection' }, 503) }
      const requestId = `request-${sends}`
      const previousRequest = activeRequests.get(input.chatId)
      if (!steerNext) {
        activeRequests.set(input.chatId, requestId)
        histories.get(input.chatId)!.push({ role: 'user', content: input.content })
      } else {
        assert.ok(previousRequest)
        steerNext = false
        deferredGuidance.set(input.chatId, [{ role: 'user', content: input.content }])
      }
      live.publisher.invalidateSessions(`web:${input.chatId}`)
      if (interruptNext) {
        interruptNext = false
        assert.ok(previousRequest)
        live.publisher.chat(`web:${input.chatId}`, { event: 'turn_finished', done: true, status: 'cancelled', turnId: `turn-${previousRequest}` }, previousRequest)
        live.publisher.chat(`web:${input.chatId}`, { event: 'response', content: 'Following the new guidance', done: false }, requestId)
        await new Promise(resolve => setTimeout(resolve, 150))
      }
      if (finishBeforeAck) {
        finishBeforeAck = false
        finish(input.chatId, 'Completed before acknowledgement')
        await new Promise(resolve => setTimeout(resolve, 150))
      }
      if (admissionGate) {
        const gate = admissionGate
        admissionGate = undefined
        await gate
      }
      return json({ requestId, chatId: input.chatId })
    }
    if (path === '/v1/query/logs') return json({ entries: [...live.rows.logs].reverse(), total: live.rows.logs.length })
    if (path === '/v1/query/spans') return json({ entries: [...live.rows.spans].reverse(), total: live.rows.spans.length })
    const match = path.match(/^\/api\/sessions\/([^/]+)(?:\/(.*))?$/)
    if (match) {
      const sessionId = decodeURIComponent(match[1])
      if (!match[2] && request.method === 'DELETE') {
        deletions.push(sessionId)
        if (deletionGate) { const gate = deletionGate; deletionGate = undefined; await gate }
        if (rejectDeletion) { rejectDeletion = false; return json({ error: 'Synthetic deletion failure' }, 503) }
        const index = sessions.findIndex(session => session.sessionId === sessionId)
        assert.ok(index >= 0)
        sessions.splice(index, 1)
        live.publisher.invalidateSessions(sessionId)
        return json({ deleted: [sessionId] })
      }
      if (match[2] === 'cancel') {
        let body = ''
        for await (const chunk of request) body += chunk
        const { requestId } = JSON.parse(body)
        assert.equal(requestId, activeRequests.get(sessionId.replace(/^web:/, '')), 'Stop targets the active turn, never a steered input identity')
        cancellations.push(requestId)
        return json({ sessionId, status: 'requested' })
      }
      if (match[2] === 'background-tasks') {
        const tasks = background.get(sessionId) ?? []
        return json({ sessionId, total: tasks.length, tasks })
      }
      if (!match[2]) return json({ messages: sessionId.startsWith('cron:daily-report:')
        ? [{ role: 'assistant', content: 'Synthetic automation result' }] : [], previousPhysicalId: null })
      if (match[2] === 'context') return json({ systemPrompt: 'Synthetic automation context', tools: [] })
      if (match[2] === 'details') return json({
        sessionId, name: [...sessions, ...automationSessions].find(item => item.sessionId === sessionId)?.title,
        workdir: { kind: 'local', displayPath: directory },
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, usageScope: 'session',
        context: { usedTokens: null, windowTokens: null },
      })
      if (nodeOffline && (match[2] === 'files' || match[2] === 'git/status')) return json({
        error: 'workdir_unavailable', key: sessionId, nodeId: 'fixture-child', capabilityId: 'fixture-folder',
        reason: 'node-offline', action: 'connect_node',
      }, 503)
      if (match[2] === 'files') return json({ path: '', workdir: { kind: 'local', displayPath: directory },
        entries: ['one.md', 'two.md'].map(name => ({ name, type: 'file', ext: '.md', size: 12, mtime: null })) })
      if (match[2] === 'preview') return json({ binary: false, size: 12, content: `# ${url.searchParams.get('path')}` })
      if (match[2] === 'git/status') return json({ available: false, reason: 'not_repository', entries: [] })
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
async function waitFor(predicate: () => boolean | Promise<boolean>, label: string): Promise<void> {
  const end = Date.now() + 5000
  while (Date.now() < end) {
    if (await predicate()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  const alerts = await evaluate("({alerts:Array.from(document.querySelectorAll('[role=\"alert\"]')).map(element => element.textContent),menu:document.querySelector('.document-menu')?.outerHTML,focused:document.activeElement?.outerHTML.slice(0,300)})")
  throw new Error(`${phase}: ${label}; live=${JSON.stringify(live.hub.stats)}; connections=${JSON.stringify(live.connections)}; active=${JSON.stringify([...activeRequests])}; errors=${JSON.stringify([...errors, ...live.errors])}; alerts=${JSON.stringify(alerts)}`)
}
async function navigate(name: string, sessionId?: string): Promise<void> {
  const location = { name, ...(sessionId ? { params: { projectId: 'default', sessionId } } : {}) }
  await evaluate(`document.querySelector('#app').__vue_app__.config.globalProperties.$router.push(${JSON.stringify(location)})`)
}
const input = `.project-conversation:not([style*="display: none"]) textarea[aria-label="Message"]`
const pane = '.project-conversation:not([style*="display: none"]) .chat-workspace'
const hasMessage = (content: string) => evaluate<boolean>(`Array.from(document.querySelectorAll(${JSON.stringify(`${pane} .chat-content`)})).filter(element => element.textContent.trim() === ${JSON.stringify(content)}).length === 1`)
async function message(content: string) {
  await waitFor(() => evaluate<boolean>(`!!document.querySelector(${JSON.stringify(input)}) && !document.querySelector(${JSON.stringify(input)}).disabled`), 'composer is ready')
  await evaluate(`(() => {
    const input=document.querySelector(${JSON.stringify(input)});
    input.value=${JSON.stringify(content)}; input.dispatchEvent(new Event('input',{bubbles:true}));
    input.dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
  })()`)
}
function finish(chatId: string, content: string) {
  const requestId = activeRequests.get(chatId)!
  assert.ok(requestId)
  histories.get(chatId)!.push(...(deferredGuidance.get(chatId) ?? []), { role: 'assistant', content })
  deferredGuidance.delete(chatId)
  live.publisher.chat(`web:${chatId}`, { event: 'response', content, done: true }, requestId)
  activeRequests.delete(chatId)
  live.publisher.chat(`web:${chatId}`, { event: 'turn_finished', done: true, status: 'completed', turnId: `turn-${requestId}` }, requestId)
  live.publisher.invalidateSessions(`web:${chatId}`)
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
  window = new BrowserWindow({ width: 1400, height: 1000, show: false, webPreferences: {
    offscreen: true, backgroundThrottling: false, preload: join(directory, 'layout-preload.cjs'),
    additionalArguments: [`--layout-api-base=${origin}`],
  } })
  installDocumentTabShortcuts(window)
  window.webContents.on('console-message', details => { if (details.level === 'error') errors.push(details.message) })
  await window.loadURL(`${origin}/projects/default/chat`)
  await waitFor(() => evaluate<boolean>("!!document.querySelector('.folders-sidebar .session-select')"), 'sidebar ready')
  for (const [index, chatId] of chats.entries()) {
    phase = `visiting chat ${index}`
    await navigate('chat', `web:${chatId}`)
    await waitFor(() => hasMessage(`History for ${chatId}`), 'chat history ready')
    await waitFor(() => live.hub.stats.clients === 1, 'one shared connection')
    assert.equal(await evaluate<boolean>(`!!document.querySelector(${JSON.stringify(`${pane} .resend-btn`)})`), index === 2,
      'Resend is available only for a trailing human message, never completed replies followed by I/O or exec events')
    if (index === 0) await evaluate(`(() => {
      const input = document.querySelector(${JSON.stringify(input)});
      input.value = 'Keep my unsent draft'; input.dispatchEvent(new Event('input', {bubbles:true}));
      window.firstChatInput = input;
    })()`)
  }
  phase = 'Nodes after eight cached chats'
  await navigate('nodes')
  await waitFor(() => nodeRequests > 0, 'Nodes API must not queue behind inactive chat streams')
  await waitFor(() => evaluate<boolean>("document.querySelector('.node-admin-list')?.textContent.includes('Fixture Main') === true"), 'Nodes content rendered')
  await waitFor(() => live.hub.stats.clients === 0, 'deactivated idle workspace closes subscriptions')

  phase = 'Settings after eight cached chats'
  await navigate('settings')
  await waitFor(() => providerRequests > 0, 'provider inventory responds')
  await waitFor(() => evaluate<boolean>("!!document.querySelector('.provider-card')"), 'provider settings rendered')
  histories.get(chats[0])!.push({ role: 'assistant', content: 'Reply received while hidden' })
  phase = 'cached chat resumes'
  await navigate('chat', `web:${chats[0]}`)
  await waitFor(() => live.hub.stats.clients === 1, 'visible chat uses one shared connection')
  await waitFor(() => evaluate<boolean>("window.firstChatInput.closest('.project-conversation').textContent.includes('Reply received while hidden')"), 'missed history is refreshed')
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(input)}) === window.firstChatInput && window.firstChatInput.value === 'Keep my unsent draft'`), true, 'cached composer and draft survive navigation')
  assert.equal(sends, 0, 'navigation does not submit messages')

  phase = 'bulk file tab controls'
  const fileTab = (name: string) => `${pane} .document-tabs [role="tab"][aria-label="${name}"]`
  const fileCount = () => evaluate<number>(`document.querySelectorAll(${JSON.stringify(`${pane} .document-tabs [role="tab"]`)}).length`)
  async function openFile(name: string) {
    await evaluate(`document.querySelector(${JSON.stringify(`${pane} .tree-row[data-path="${name}"]`)}).click()`)
    await waitFor(() => evaluate<boolean>(`document.querySelector(${JSON.stringify(fileTab(name))})?.getAttribute('aria-selected') === 'true'`), 'file opens')
  }
  async function contextMenu(name: string) {
    await evaluate(`(() => {
      const tab = document.querySelector(${JSON.stringify(fileTab(name))});
      const rect = tab.getBoundingClientRect();
      tab.dispatchEvent(new MouseEvent('contextmenu', {bubbles:true, cancelable:true, button:2, clientX:rect.left + 8, clientY:rect.bottom}));
    })()`)
    await waitFor(() => evaluate<boolean>("document.querySelector('.document-menu [role=\"menuitem\"]') === document.activeElement"), 'context menu focuses first action')
  }
  await openFile('one.md')
  await openFile('two.md')
  await contextMenu('one.md')
  assert.equal(await evaluate<boolean>(`document.querySelector(${JSON.stringify(fileTab('two.md'))}).getAttribute('aria-selected') === 'true'`), true, 'right-click does not switch documents')
  await evaluate("Array.from(document.querySelectorAll('.document-menu button')).find(button => button.textContent === 'Close others').click()")
  await waitFor(async () => await fileCount() === 1, 'Close others removes only other files')
  assert.equal(await evaluate<boolean>(`document.querySelector(${JSON.stringify(fileTab('one.md'))}).getAttribute('aria-selected') === 'true'`), true, 'clicked document is retained and selected')
  await contextMenu('one.md')
  assert.equal(await evaluate<boolean>("Array.from(document.querySelectorAll('.document-menu button')).find(button => button.textContent === 'Close others').disabled"), true)
  await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))")
  assert.equal(await evaluate<boolean>(`document.activeElement === document.querySelector(${JSON.stringify(fileTab('one.md'))})`), true, 'Escape restores tab focus')
  await openFile('two.md')
  await navigate('chat', `web:${chats[1]}`)
  await waitFor(() => hasMessage(`History for ${chats[1]}`), 'other session ready')
  await openFile('one.md')
  await navigate('chat', `web:${chats[0]}`)
  await waitFor(async () => await fileCount() === 2, 'cached file tabs restored')
  await evaluate(`document.querySelector(${JSON.stringify(`${pane} .conversation-tab [role="tab"]`)}).click()`)
  await evaluate("document.dispatchEvent(new KeyboardEvent('keydown',{key:'W',ctrlKey:true,shiftKey:true,bubbles:true,cancelable:true}))")
  await waitFor(async () => await fileCount() === 0, 'DOM Ctrl+Shift+W closes all files from Conversation')
  await navigate('chat', `web:${chats[1]}`)
  await waitFor(async () => await fileCount() === 1, 'bulk close preserves other session tabs')
  await navigate('chat', `web:${chats[0]}`)
  await waitFor(async () => await fileCount() === 0, 'closed files do not return from cache')
  await openFile('one.md')
  await openFile('two.md')
  await contextMenu('one.md')
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: ['control', 'shift'] })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W', modifiers: ['control', 'shift'] })
  assert.equal(await fileCount(), 2, 'shortcut does not close files underneath a menu')
  await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))")
  await evaluate("(() => { const frame=document.createElement('iframe'); frame.id='shortcut-frame'; document.body.append(frame); frame.focus(); })()")
  window.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'W', modifiers: ['control', 'shift'] })
  window.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'W', modifiers: ['control', 'shift'] })
  await waitFor(async () => await fileCount() === 0, 'native shortcut reaches parent from iframe')
  assert.equal(window.isDestroyed(), false, 'Ctrl+Shift+W does not close Electron')
  await evaluate("document.querySelector('#shortcut-frame').remove()")
  await openFile('one.md')
  for (const width of [1400, 390]) {
    window.setSize(width, 1000)
    await new Promise(resolve => setTimeout(resolve, 150))
    await evaluate(`document.querySelector(${JSON.stringify(fileTab('one.md'))}).dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true,cancelable:true}))`)
    await waitFor(() => evaluate<boolean>("!!document.querySelector('.document-menu')"), 'keyboard opens menu')
    assert.equal(await evaluate<boolean>("(() => {const r=document.querySelector('.document-menu').getBoundingClientRect();return r.left>=0 && r.right<=innerWidth && r.top>=0 && r.bottom<=innerHeight})()"), true, `menu fits ${width}px viewport`)
    await evaluate("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))")
  }
  window.setSize(1400, 1000)
  await new Promise(resolve => setTimeout(resolve, 150))
  await contextMenu('one.md')
  await evaluate("Array.from(document.querySelectorAll('.document-menu button')).find(button => button.textContent.includes('Close all')).click()")
  await waitFor(async () => await fileCount() === 0, 'Close all menu action preserves only Conversation')
  assert.equal(await evaluate(`document.querySelector(${JSON.stringify(input)}).value`), 'Keep my unsent draft', 'bulk file operations preserve the draft')

  phase = 'composer background task inventory'
  const owner = `web:${chats[0]}`
  background.set(owner, [
    { id: 'process-one', sessionId: owner, kind: 'process', title: 'exec: pnpm dev <synthetic>', status: 'running', createdAt: new Date().toISOString() },
    { id: 'agent-two', sessionId: owner, kind: 'subagent', title: 'Inspect folder dependencies', status: 'running', createdAt: new Date().toISOString() },
  ])
  live.publisher.invalidateSessions(owner)
  const taskPanel = `${pane} .background-tasks`
  await waitFor(() => evaluate<boolean>(`document.querySelector(${JSON.stringify(taskPanel)})?.textContent.includes('2 running') === true`), 'running task count appears')
  await evaluate(`document.querySelector(${JSON.stringify(`${taskPanel} .background-toggle`)}).click()`)
  await waitFor(() => evaluate<boolean>(`document.querySelector(${JSON.stringify(`${taskPanel} .background-title`)})?.textContent === 'exec: pnpm dev <synthetic>'`), 'escaped task title is rendered')
  nodeOffline = true
  await evaluate(`document.querySelector(${JSON.stringify(`${pane} [aria-label="Refresh files"]`)}).click()`)
  await waitFor(() => evaluate<boolean>(`document.querySelectorAll(${JSON.stringify(`${pane} .file-tree-list .node-offline`)}).length === 1`), 'Files and Git share one offline status')
  assert.equal(await evaluate<boolean>(`!!document.querySelector(${JSON.stringify(`${pane} .file-tree-note.error`)})`), false, 'offline files do not show red Git/files errors')
  for (const width of [1400, 390]) {
    window.setSize(width, 1000)
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(await evaluate<boolean>(`(() => {
      const panel = document.querySelector(${JSON.stringify(taskPanel)});
      const box = document.querySelector(${JSON.stringify(`${pane} .composer-box`)});
      const a=panel.getBoundingClientRect(), b=box.getBoundingClientRect();
      return panel.closest('.chat-composer') !== null && a.bottom <= b.top + 1 && a.left >= 0 && a.right <= innerWidth + 1 && panel.scrollWidth <= panel.clientWidth + 1;
    })()`), true, `background panel stays above composer without overflow at ${width}px`)
    writeFileSync(join(directory, `background-tasks-${width === 1400 ? 'desktop' : 'mobile'}.png`), (await window.webContents.capturePage()).toPNG())
  }
  window.setSize(1400, 1000)
  nodeOffline = false
  await evaluate(`document.querySelector(${JSON.stringify(`${pane} .node-offline-check`)}).click()`)
  await waitFor(() => evaluate<boolean>(`!document.querySelector(${JSON.stringify(`${pane} .node-offline`)})`), 'file and Git retry recover after reconnection')
  await navigate('chat', `web:${chats[1]}`)
  await waitFor(() => hasMessage(`History for ${chats[1]}`), 'other chat ready')
  assert.equal(await evaluate<boolean>(`!!document.querySelector(${JSON.stringify(taskPanel)})`), false, 'other conversations do not inherit tasks')
  await navigate('chat', owner)
  await waitFor(() => evaluate<boolean>(`document.querySelector(${JSON.stringify(`${taskPanel} .background-toggle`)})?.getAttribute('aria-expanded') === 'true'`), 'disclosure survives cached navigation')
  background.set(owner, [])
  live.publisher.invalidateSessions(owner)
  await waitFor(() => evaluate<boolean>(`!document.querySelector(${JSON.stringify(taskPanel)})`), 'finished tasks leave the composer')
  await waitFor(() => live.hub.stats.clients === 1, 'background inventory adds no private connection')

  phase = 'rejected submission retains draft'
  rejectNext = true
  await message('Retain rejected draft')
  await waitFor(() => sends === 1 && activeRequests.size === 0, 'rejection received')
  await waitFor(() => evaluate<boolean>(`document.querySelector(${JSON.stringify(input)}).value === 'Retain rejected draft' && !document.querySelector(${JSON.stringify(input)}).disabled`), 'draft survives rejection')

  phase = 'completion before acknowledgement'
  finishBeforeAck = true
  await message('Fast request')
  await waitFor(() => evaluate<boolean>(`document.querySelector(${JSON.stringify(input)}).value === '' && !document.querySelector(${JSON.stringify(input)}).disabled`), 'early completion does not remain busy')
  await waitFor(() => hasMessage('Completed before acknowledgement'), 'fast completion appears once')

  phase = 'steering during an active turn'
  await message('Start steering run')
  await waitFor(() => activeRequests.has(chats[0]) && evaluate<boolean>(`document.querySelector(${JSON.stringify(input)}).value === ''`), 'initial request acknowledged')
  const originalRequest = activeRequests.get(chats[0])!
  const stopButton = `${pane} [aria-label="Stop current request"]`
  live.publisher.chat(owner, { event: 'response', content: 'Existing partial response', done: false }, originalRequest)
  await waitFor(() => hasMessage('Existing partial response'), 'partial reply renders')
  assert.equal(await evaluate<boolean>(`!document.querySelector(${JSON.stringify(input)}).disabled && !!document.querySelector(${JSON.stringify(`${pane} [aria-label="Send message"]`)}) && !!document.querySelector(${JSON.stringify(stopButton)})`), true, 'running composer exposes both Send and Stop')
  for (const width of [1400, 390]) {
    window.webContents.enableDeviceEmulation({
      screenPosition: 'desktop', screenSize: { width, height: 1000 }, viewPosition: { x: 0, y: 0 },
      viewSize: { width, height: 1000 }, deviceScaleFactor: 1, scale: 1,
    })
    await waitFor(() => evaluate<boolean>(`innerWidth === ${width}`), 'steering viewport ready')
    const controls = await evaluate<{ send: { left: number; right: number; top: number; height: number }; stop: { left: number; right: number; bottom: number; height: number }; width: number }>(`(() => {
      const send = document.querySelector(${JSON.stringify(`${pane} .composer-send`)}).getBoundingClientRect();
      const stop = document.querySelector(${JSON.stringify(stopButton)}).getBoundingClientRect();
      return { send: send.toJSON(), stop: stop.toJSON(), width: innerWidth };
    })()`)
    assert.ok(controls.stop.left >= 0 && controls.send.left >= 0 && controls.stop.right <= controls.width && controls.send.right <= controls.width
      && (controls.stop.right <= controls.send.left || controls.stop.bottom <= controls.send.top)
      && controls.stop.height >= 32 && controls.send.height >= 32, `Send and Stop at ${width}px: ${JSON.stringify(controls)}`)
  }
  window.webContents.disableDeviceEmulation()
  window.setSize(1400, 1000)
  rejectNext = true
  await message('Keep rejected guidance')
  await waitFor(() => evaluate<boolean>(`document.querySelector(${JSON.stringify(input)}).value === 'Keep rejected guidance' && !!document.querySelector(${JSON.stringify(`${pane} [role="alert"]`)})`), 'rejected guidance remains retryable in the composer')
  assert.equal(activeRequests.get(chats[0]), originalRequest)
  assert.equal(await hasMessage('Existing partial response'), true, 'failed follow-up does not erase the current output')
  waitingForCall = true
  live.publisher.invalidateSessions(owner)
  await waitFor(() => evaluate<boolean>(`!!document.querySelector(${JSON.stringify(`${pane} .chat-working.waiting-for-call`)})`), 'parent is waiting on a blocking call')
  steerNext = true
  const guidanceAdmission = Promise.withResolvers<void>()
  admissionGate = guidanceAdmission.promise
  await message('Use the smaller sample')
  await waitFor(() => admissionGate === undefined && hasMessage('Use the smaller sample'), 'pending guidance is visible')
  assert.equal(await evaluate<boolean>(`document.querySelector(${JSON.stringify(input)}).disabled`), true, 'only admission temporarily locks submission')
  const sendsDuringAdmission = sends
  await evaluate(`document.querySelector(${JSON.stringify(input)}).dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))`)
  await evaluate(`document.querySelector(${JSON.stringify(stopButton)}).click()`)
  await waitFor(() => cancellations.at(-1) === originalRequest, 'Stop retains the active identity while guidance admission is pending')
  guidanceAdmission.resolve()
  await waitFor(() => evaluate<boolean>(`document.querySelector(${JSON.stringify(input)}).value === '' && !document.querySelector(${JSON.stringify(input)}).disabled`), 'steered input is acknowledged without waiting for completion')
  assert.equal(sends, sendsDuringAdmission, 'duplicate Enter during admission does not submit twice')
  assert.equal(activeRequests.get(chats[0]), originalRequest, 'tool steering stays within the original turn')
  assert.equal(await evaluate<boolean>(`document.querySelector(${JSON.stringify(stopButton)}).disabled`), true, 'guidance acknowledgement does not lose the pending Stop')
  live.publisher.invalidateSessions(owner)
  await new Promise(resolve => setTimeout(resolve, 200))
  assert.equal(await hasMessage('Use the smaller sample'), true, 'admitted guidance stays visible before the tool boundary persists it')
  waitingForCall = false
  finish(chats[0], 'Finished steered result')
  await waitFor(() => evaluate<boolean>(`!document.querySelector(${JSON.stringify(stopButton)})`), 'a steered input does not leave a phantom active request')

  phase = 'steering replaces an active LLM request'
  await message('Start replacement run')
  await waitFor(() => activeRequests.has(chats[0]) && evaluate<boolean>(`document.querySelector(${JSON.stringify(input)}).value === ''`), 'replacement source acknowledged')
  const replacedRequest = activeRequests.get(chats[0])!
  interruptNext = true
  await message('Change the approach')
  await waitFor(() => activeRequests.get(chats[0]) !== replacedRequest && evaluate<boolean>(`document.querySelector(${JSON.stringify(input)}).value === ''`), 'new guidance admitted while the previous turn finishes')
  const replacementRequest = activeRequests.get(chats[0])!
  live.publisher.chat(owner, { event: 'turn_finished', done: true, status: 'cancelled', turnId: `turn-${replacedRequest}` }, replacedRequest)
  await waitFor(() => evaluate<boolean>(`!!document.querySelector(${JSON.stringify(stopButton)}) && !document.querySelector(${JSON.stringify(stopButton)}).disabled`), 'late completion cannot stop the replacement turn')
  await evaluate(`document.querySelector(${JSON.stringify(stopButton)}).click()`)
  await waitFor(() => cancellations.at(-1) === replacementRequest, 'Stop follows the confirmed replacement turn')
  finish(chats[0], 'Replacement result')
  await waitFor(() => evaluate<boolean>(`!document.querySelector(${JSON.stringify(stopButton)})`), 'replacement completion clears running state')

  phase = 'eight concurrent submissions'
  for (const [index, chatId] of chats.entries()) {
    await navigate('chat', `web:${chatId}`)
    await message(`Concurrent request ${index}`)
    await waitFor(() => activeRequests.has(chatId), 'request admitted')
    await waitFor(() => evaluate<boolean>(`document.querySelector(${JSON.stringify(input)}).value === ''`), 'short response acknowledged')
  }
  assert.equal(activeRequests.size, 8)
  const sendsBeforeReconnect = sends
  await waitFor(() => live.hub.stats.clients === 1, 'eight running requests share one stream')
  await navigate('nodes')
  await waitFor(() => nodeRequests > 1, 'Nodes responds while all requests run')
  assert.equal(activeRequests.size, 8, 'leaving chat never stops submitted work')
  await waitFor(() => live.hub.stats.clients === 1, 'hidden requests keep one completion feed')

  phase = 'replay after disconnection'
  live.disconnect()
  finish(chats[0], 'Recovered completion')
  await waitFor(() => live.hub.stats.clients === 1, 'shared feed reconnects')
  await navigate('chat', `web:${chats[0]}`)
  await waitFor(() => hasMessage('Recovered completion'), 'replayed completion reconciles without duplicates')
  await waitFor(() => evaluate<boolean>(`!document.querySelector(${JSON.stringify(input)}).disabled`), 'completed request no longer busy')
  for (const chat of chats.slice(1)) finish(chat, `Finished ${chat}`)
  await waitFor(() => evaluate<boolean>(`!document.querySelector(${JSON.stringify(input)}).disabled`), 'other completions do not retarget current request')

  phase = 'expired replay window'
  live.disconnect()
  for (let index = 0; index < 40; index++) live.publisher.invalidateSessions(`web:${chats[0]}`)
  histories.get(chats[0])!.push({ role: 'assistant', content: 'Saved beyond replay window' })
  await waitFor(() => live.resets.includes('expired'), 'journal expiry is explicit')
  await waitFor(() => hasMessage('Saved beyond replay window'), 'expired replay reloads saved history')
  live.other.chat(`web:${chats[0]}`, { event: 'response', content: 'OTHER PROJECT', done: true })
  assert.equal(await evaluate<boolean>(`document.querySelector(${JSON.stringify(pane)}).textContent.includes('OTHER PROJECT')`), false)

  phase = 'Main restart'
  histories.get(chats[0])!.push({ role: 'assistant', content: 'Saved across restart' })
  live.restart()
  await waitFor(() => live.resets.includes('epoch'), 'new Main generation resets old cursor')
  await waitFor(() => hasMessage('Saved across restart'), 'restart reconciles history')
  assert.equal(sends, sendsBeforeReconnect, 'replay, expiry and restart never resubmit commands')

  phase = 'generic fresh automation navigation'
  const automationButton = (id: string) => `.automation-entry[data-automation-id="${id}"]`
  const click = (selector: string) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`)
  await waitFor(() => evaluate<boolean>(`!!document.querySelector(${JSON.stringify(automationButton('daily-report'))})`), 'generic cron entry exists')
  assert.equal(await evaluate<number>("document.querySelectorAll('.automation-entry').length"), 3)
  assert.equal(await evaluate<number>("document.querySelectorAll('.folders-sidebar .session-select').length"), chats.length, '35 fresh runs do not occupy sidebar conversation rows')
  const cachedBefore = await evaluate<number>("document.querySelectorAll('.project-conversation').length")
  await click(automationButton('daily-report'))
  await waitFor(() => evaluate<boolean>("document.querySelectorAll('.automation-run').length === 30"), 'first run page is bounded')
  assert.equal(await evaluate<number>("document.querySelectorAll('.project-conversation').length"), cachedBefore, 'overview never initializes a draft')
  for (const width of [1400, 390]) {
    window.setSize(width, 1000)
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(await evaluate<boolean>("(() => { const el=document.querySelector('.automation-detail'), r=el.getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth+1 && el.scrollWidth<=el.clientWidth+1 })()"), true, `run overview stays bounded at ${width}px`)
    writeFileSync(join(directory, `automations-${width === 1400 ? 'desktop' : 'mobile'}.png`), (await window.webContents.capturePage()).toPNG())
  }
  window.setSize(1400, 1000)
  await click('.automation-sections button:last-child')
  await waitFor(() => evaluate<boolean>("document.querySelector('.automation-configuration')?.textContent.includes('Summarize recent folder changes.')"), 'configuration preserves the actual prompt')
  await click('.automation-sections button:first-child')
  await click('.run-pagination button:last-child')
  await waitFor(() => evaluate<boolean>("document.querySelectorAll('.automation-run').length === 5"), 'older runs paginate')
  await click('.automation-run[data-session-id="cron:daily-report:run-0"]')
  await waitFor(() => hasMessage('Synthetic automation result'), 'run opens its existing history')
  await waitFor(() => evaluate<boolean>("document.querySelector('select[aria-label=\"Run\"]')?.value === 'cron:daily-report:run-0'"), 'compact toolbar identifies the selected run')
  await click('.run-pagination button:first-child')
  await waitFor(() => evaluate<boolean>("document.querySelector('select[aria-label=\"Run\"] option')?.textContent === 'Current run'"), 'selected run remains represented outside the current page')
  live.publisher.invalidateSessions('cron:daily-report:run-34')
  await new Promise(resolve => setTimeout(resolve, 350))
  assert.equal(await evaluate<string>("document.querySelector('select[aria-label=\"Run\"]').value"), 'cron:daily-report:run-0', 'fresh invalidations never switch the inspected run')
  for (const width of [1400, 390]) {
    window.setSize(width, 1000)
    await new Promise(resolve => setTimeout(resolve, 150))
    assert.equal(await evaluate<boolean>("(() => { const el=document.querySelector('.automation-detail'), r=el.getBoundingClientRect(); return r.left>=0 && r.right<=innerWidth+1 && el.scrollWidth<=el.clientWidth+1 })()"), true, `run toolbar stays bounded at ${width}px`)
    writeFileSync(join(directory, `automation-run-${width === 1400 ? 'desktop' : 'mobile'}.png`), (await window.webContents.capturePage()).toPNG())
  }
  window.setSize(1400, 1000)
  await click(automationButton('encapsulation'))
  await waitFor(() => evaluate<boolean>("document.querySelector('.automation-detail')?.textContent.includes('No saved runs yet')"), 'encapsulation has the same first-class empty entry')
  await click(automationButton('archived-job'))
  await waitFor(() => evaluate<boolean>("document.querySelector('.automation-detail')?.textContent.includes('Dispatch disabled')"), 'inactive definitions remain inspectable')
  await navigate('chat', `web:${chats[0]}`)
  await waitFor(() => evaluate<boolean>("!document.querySelector('.automation-detail')"), 'ordinary append conversations have no automation toolbar')
  assert.equal(sends, sendsBeforeReconnect, 'browsing task histories never creates or dispatches a conversation')
  await waitFor(() => live.hub.stats.clients === 1, 'catalog, run history and conversations share one transport')

  phase = 'shared telemetry'
  await navigate('logs')
  await waitFor(() => evaluate<boolean>("document.querySelector('.tag.active')?.textContent === 'Live'"), 'log subscription ready')
  live.rows.logs.push({ id: 1, time: Date.now(), body: 'Shared live log', severity_number: 9, attributes: '[]', resource: '{}', scope: '{}' })
  await waitFor(() => evaluate<boolean>("document.body.textContent.includes('Shared live log')"), 'log arrives through shared feed')
  live.disconnect()
  await waitFor(() => live.hub.stats.clients === 0, 'last log tail stops')
  live.rows.logs.push({ id: 2, time: Date.now(), body: 'Log saved while disconnected', severity_number: 9, attributes: '[]', resource: '{}', scope: '{}' })
  await waitFor(() => evaluate<boolean>("document.body.textContent.includes('Log saved while disconnected')"), 'unobserved telemetry is recovered from its snapshot')
  await navigate('spans')
  await waitFor(() => evaluate<boolean>("document.querySelector('.tag.active')?.textContent === 'Live'"), 'span subscription ready')
  live.rows.spans.push({ id: 1, trace_id: 'fixture-trace', span_id: 'fixture-span', name: 'Shared live span', start_time: Date.now(), end_time: Date.now() + 1, attributes: '[]', events: '[]', resource: '{}', scope: '{}' })
  await waitFor(() => evaluate<boolean>("document.body.textContent.includes('Shared live span')"), 'span arrives through shared feed')
  await waitFor(() => live.hub.stats.clients === 1, 'telemetry shares the application connection')
  phase = 'DOM conversation deletion'
  await navigate('chat', `web:${chats[7]}`)
  const deleteTrigger = '[aria-label="Delete conversation Connection chat 7"]'
  const deleteDialog = 'dialog.session-delete-dialog'
  await waitFor(() => evaluate<boolean>(`!!document.querySelector(${JSON.stringify(deleteTrigger)})`), 'delete action is available')
  await evaluate(`window.confirm = () => { throw new Error('Native confirmation must not be used') }; void 0`)
  const openDelete = () => evaluate(`(() => {
    const button = document.querySelector(${JSON.stringify(deleteTrigger)});
    button.focus(); button.click();
  })()`)
  await openDelete()
  await waitFor(() => evaluate<boolean>(`!!document.querySelector(${JSON.stringify(deleteDialog)})?.matches(':modal')`), 'in-app confirmation is modal')
  assert.equal(deletions.length, 0, 'opening confirmation never deletes')
  assert.equal(await evaluate<boolean>(`document.activeElement === document.querySelector(${JSON.stringify(`${deleteDialog} button[type="button"]`)})`), true, 'Cancel receives default focus')
  assert.equal(await evaluate<boolean>(`document.querySelector(${JSON.stringify(deleteDialog)}).textContent.includes('Connection chat 7') && document.querySelector(${JSON.stringify(deleteDialog)}).textContent.includes('child sessions')`), true, 'confirmation identifies the conversation and cascade')
  for (const width of [1400, 390]) {
    window.webContents.enableDeviceEmulation({
      screenPosition: 'desktop', screenSize: { width, height: 844 }, viewPosition: { x: 0, y: 0 },
      viewSize: { width, height: 844 }, deviceScaleFactor: 1, scale: 1,
    })
    await waitFor(() => evaluate<boolean>(`innerWidth === ${width}`), 'confirmation viewport ready')
    assert.equal(await evaluate<boolean>(`(() => {
      const dialog = document.querySelector(${JSON.stringify(deleteDialog)}), bounds = dialog.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= innerWidth && bounds.top >= 0 && bounds.bottom <= innerHeight && dialog.scrollWidth <= dialog.clientWidth;
    })()`), true, `confirmation fits ${width}px without clipping`)
  }
  window.webContents.disableDeviceEmulation()
  await evaluate(`document.querySelector(${JSON.stringify(deleteDialog)}).dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true}))`)
  await waitFor(() => evaluate<boolean>(`!document.querySelector(${JSON.stringify(deleteDialog)})`), 'Escape cancels the confirmation')
  assert.equal(deletions.length, 0)
  assert.equal(await evaluate<boolean>(`document.activeElement === document.querySelector(${JSON.stringify(deleteTrigger)})`), true, 'Cancel restores trigger focus')
  await openDelete()
  rejectDeletion = true
  const deletionAdmission = Promise.withResolvers<void>()
  deletionGate = deletionAdmission.promise
  await evaluate(`document.querySelector(${JSON.stringify(`${deleteDialog} button[type="submit"]`)}).click()`)
  await waitFor(() => deletions.length === 1, 'one delete request admitted')
  await evaluate(`document.querySelector(${JSON.stringify(deleteDialog)}).dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true})); document.querySelector(${JSON.stringify(`${deleteDialog} form`)}).requestSubmit()`)
  assert.equal(await evaluate<boolean>(`document.querySelector(${JSON.stringify(deleteDialog)}).matches(':modal') && Array.from(document.querySelectorAll(${JSON.stringify(`${deleteDialog} button`)})).every(button => button.disabled)`), true, 'pending deletion stays visible and blocks repeated submission')
  deletionAdmission.resolve()
  await waitFor(() => evaluate<boolean>(`document.querySelector(${JSON.stringify(`${deleteDialog} [role="alert"]`)})?.textContent.includes('503') === true`), 'deletion failure stays in the dialog')
  assert.equal(deletions.length, 1)
  assert.ok(sessions.some(session => session.sessionId === `web:${chats[7]}`))
  await evaluate(`document.querySelector(${JSON.stringify(`${deleteDialog} button[type="submit"]`)}).click()`)
  await waitFor(() => evaluate<boolean>(`!document.querySelector(${JSON.stringify(deleteDialog)}) && !document.querySelector(${JSON.stringify(deleteTrigger)})`), 'successful retry closes confirmation and refreshes the sidebar')
  assert.deepEqual(deletions, [`web:${chats[7]}`, `web:${chats[7]}`])
  assert.equal(legacyStreams, 0)
  assert.deepEqual([...errors, ...live.errors], [])
  console.log('LAYOUT_RESULT ' + JSON.stringify({ ok: true, fixture: 'chat-connections', cachedChats: chats.length, concurrentRequests: 8, nodes: true, settings: true, replay: true, expiry: true, restart: true, noResubmission: true, telemetry: true, telemetryGap: true, backgroundTasks: true, offlineFiles: true, fileTabActions: true, freshAutomations: true, runPagination: true }))
}
main().catch(error => {
  console.log('LAYOUT_FAILURE ' + JSON.stringify({ phase, message: String(error).slice(0, 500), errors }))
  console.error(error)
  process.exitCode = 1
}).finally(() => {
  if (window && !window.isDestroyed()) window.destroy()
  live.close()
  server.closeAllConnections()
  server.close()
  app.exit(process.exitCode || 0)
})
