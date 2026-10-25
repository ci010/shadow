import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync } from 'node:fs'
import { readFile, writeFile } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { app, BrowserWindow, session } from 'electron'
import { LiveFixture } from './live-fixture.ts'
import type { YieldDecisionRecord, YieldRequest, YieldReview } from '../../../src/sessions/yield-contract.ts'
import type { InputRequest } from '../../../src/sessions/input-request.ts'
import { decisionBrief } from '../../../src/testing/decision.ts'
import { WORK_APPROVE, WORK_REJECT } from '../../../src/initiatives/work-contract.ts'

function argument(name: string): string {
  const value = process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
  assert.ok(value, `Missing ${name}`)
  return resolve(value)
}
const assets = argument('layout-assets')
const directory = argument('layout-root')
for (const name of ['userData', 'sessionData', 'logs', 'crashDumps'] as const) {
  const path = join(directory, name)
  mkdirSync(path, { recursive: true })
  app.setPath(name, path)
}
app.setPath('home', directory)
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
app.commandLine.appendSwitch('disable-features', 'Translate,MediaRouter')
app.commandLine.appendSwitch('force-device-scale-factor', '1')
app.on('window-all-closed', () => {})

const root = 'web:chat-yield-fixture'
const reflector = 'reflector:yield-fixture'
const child = 'sub:yield-fixture'
const administrator = 'web:chat-admin'
const sessions = [root, reflector, child, administrator].map((sessionId, index) => ({
  sessionId, title: ['Yield root', 'Yield reflector', 'Yield child', 'Coordinator'][index], current: `physical-${index}`,
}))
const question = (sessionId: string, id: string, parent = false): YieldRequest => ({
  id, sessionId, question: 'Which approach should continue this task?',
  options: ['Make the smallest safe change', 'Refactor the implementation with focused tests', 'Leave the existing implementation unchanged'],
  defaultOption: 'Make the smallest safe change',
  recipient: { kind: parent ? 'parent' : 'user', sessionId: parent ? root : sessionId },
  createdAt: '2026-09-13T12:00:00.000Z', deadline: null as string | null,
})
const pending = new Map<string, ReturnType<typeof question>>()
let pendingInput: InputRequest | undefined
const inputAnswers: string[] = []
const decisionRecords = new Map<string, YieldDecisionRecord>()
const reviews: YieldReview[] = []
const owners = new Map<string, string>()
const followUps: { requestId: string; kind: string }[] = []
const recordsFor = (sessionId: string) => [...decisionRecords.values()].filter(record => record.request.sessionId === sessionId)
const live = new LiveFixture()
const failures: string[] = []
const answers: { requestId: string; option?: string; customText?: string }[] = []
const cancellations: { requestId: string }[] = []
let rejectNext = false
let sends = 0
let reads = 0

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
    if (path === '/api/web-auth/session') return json({ version: 1, required: false, authenticated: true })
    if (path === '/api/channels') return json({ channels: [] })
    if (path === '/api/agent-resources/credential-requests') return json({ request: null })
    if (path === '/api/agent-resources/publication-requests') return json({ request: null, requests: [] })
    if (path === '/api/agent-resources/probe-requests') return json({ requests: [] })
    if (path === '/api/projects') return json({ projects: [{ id: 'default', name: 'Default', createdAt: '2026-09-16T00:00:00Z' }] })
    if (path === '/api/automations') return json({ automations: [] })
    if (path === '/api/provider/setup') return json(status)
    if (path === '/api/provider/configured') return json({ providers: [{ ...status, selected: true }] })
    if (path === '/debug/models') return json({ models: ['gpt-5-mini@copilot'] })
    if (path === '/api/config') return json({ agent: { ...status, workspace: directory, temperature: 0.7 } })
    if (path === '/api/folders') return json({ folders: [] })
    if (path === '/api/work') return json({
      items: [], sessions: sessions.map(item => ({ sessionId: item.sessionId, title: item.title, assignable: true })),
      requests: [...pending.values()].filter(item => item.recipient.kind === 'user').map(item => ({
        id: item.id, sessionId: item.sessionId, kind: 'decision', question: item.question, workKeys: [],
      })), effects: [],
    })
    if (path === '/api/projects/default/status') return json({ state: 'ready' })
    if (path === '/api/sessions/graph') return json({
      sessions, nodes: sessions.map(item => ({ physicalId: item.current, logicalId: item.sessionId, parentPhysicalId: null, isCurrent: true })),
    })
    if (path === '/api/sessions/stages') return json({ stages: Object.fromEntries(sessions.map(item => [item.sessionId, pending.has(item.sessionId) || pendingInput?.sessionId === item.sessionId ? 'waiting' : 'idle'])) })
    if (path === '/api/chat/session') return json({ history: [{ role: 'user', content: 'Synthetic question test' }, ...live.history(`web:${url.searchParams.get('chatId')}`)],
      decisionRecords: recordsFor(`web:${url.searchParams.get('chatId')}`), tools: [], systemPrompt: '' })
    if (path === '/api/chat/send') { sends++; return json({ error: 'forbidden' }, 403) }
    const match = path.match(/^\/api\/sessions\/([^/]+)(?:\/(.*))?$/)
    if (match) {
      const id = match[1]!
      if (match[2] === 'decisions/owner') {
        if (request.method === 'POST') {
          let body = ''
          for await (const chunk of request) body += chunk
          owners.set(id, JSON.parse(body).reportingSessionId)
        }
        return json({ reportingSessionId: owners.get(id) ?? id,
          candidates: sessions.filter(item => item.sessionId !== child).map(item => ({ sessionId: item.sessionId, label: item.title })) })
      }
      if (match[2] === 'ask/follow-up' || match[2] === 'decisions/invalidate') {
        let body = ''
        for await (const chunk of request) body += chunk
        const input = JSON.parse(body)
        if (match[2] === 'decisions/invalidate') {
          const record = decisionRecords.get(input.reference.requestId)!
          assert.equal(record.request.sessionId, id)
          record.invalidated = { reference: input.reference, reason: input.reason, at: new Date().toISOString() }
          return json({ approved: false, affected: [{ sessionId: id, requestId: record.request.id }], notificationErrors: [] })
        }
        const current = pending.get(id)!
        assert.equal(input.requestId, current.id)
        assert.ok(input.kind === 'investigation' || input.kind === 'deferred')
        followUps.push(input)
        decisionRecords.set(current.id, { request: current, closed: { reason: input.kind, at: new Date().toISOString(), message: input.reason } })
        pending.delete(id)
        json({ continuation: { requestId: current.id, disposition: input.kind, approved: false,
          reason: input.reason, blocked: current.brief?.blocked, unaffected: current.brief?.unaffected } })
        live.finish(id)
        return
      }
      if (match[2] === 'decisions/reviews') return json({ reviews: reviews.filter(review => review.reference.requestId === url.searchParams.get('requestId')) })
      if (match[2] === 'ask/reviews') {
        let body = ''
        for await (const chunk of request) body += chunk
        const input = JSON.parse(body)
        const current = pending.get(id)!
        assert.equal(current.id, input.requestId)
        assert.ok(current.origin)
        const reference = { sessionId: id, physicalId: current.origin.physicalId, requestId: current.id }
        const review: YieldReview = { id: input.id, reference, kind: input.kind, question: input.question,
          sessionId: `decision-review:${input.id}`, createdAt: new Date().toISOString(), status: 'completed',
          response: 'The larger refactor is an agent suggestion, not a user requirement.' }
        if (input.kind === 'revise') {
          const revised: YieldRequest = { ...current, id: `${current.id}-v2`, decisionId: current.id, supersedes: reference,
            revisionReason: input.question, revisionSessionId: review.sessionId, question: 'Choose a bounded change without expanding scope.',
            options: [current.options[0], current.options[1]], timeoutPaused: true }
          review.replacement = { ...reference, requestId: revised.id }
          decisionRecords.set(current.id, { request: current, closed: { reason: 'superseded', at: revised.createdAt,
            message: input.question, replacement: review.replacement } })
          decisionRecords.set(revised.id, { request: revised })
          pending.set(id, revised)
        } else pending.set(id, { ...current, timeoutPaused: true })
        reviews.push(review)
        return json({ review }, 202)
      }
      if (match[2] === 'decisions') return json({ records: recordsFor(id) })
      if (match[2] === 'work') return json({ records: [], effects: [] })
      if (match[2] === 'background-tasks') return json({ sessionId: id, total: 0, tasks: [] })
      if (match[2] === 'ask') {
        if (request.method === 'GET') { reads++; return json({ request: pendingInput?.sessionId === id ? pendingInput : pending.get(id) ?? null }) }
        let body = ''
        for await (const chunk of request) body += chunk
        const input = JSON.parse(body)
        if (pendingInput?.sessionId === id && pendingInput.id === input.requestId) {
          assert.equal(request.method, 'POST')
          assert.deepEqual(Object.keys(input).sort(), ['requestId', 'text'])
          assert.equal(typeof input.text, 'string')
          inputAnswers.push(input.text)
          pendingInput = undefined
          json({ answer: { requestId: input.requestId, text: input.text, answeredBy: 'user', answeredAt: new Date().toISOString() } })
          live.finish(id)
          return
        }
        if (request.method === 'DELETE') {
          assert.deepEqual(Object.keys(input), ['requestId'])
          assert.equal(pending.get(id)?.id, input.requestId)
          assert.equal(pending.get(id)?.recipient.kind, 'user')
          cancellations.push(input)
          pending.delete(id)
          live.finish(id, 'cancelled')
          return json({ cancelled: true })
        }
        assert.equal(request.method, 'POST')
        answers.push(input)
        if (rejectNext) { rejectNext = false; return json({ error: 'unavailable', message: 'Synthetic answer rejection.' }, 503) }
        const current = pending.get(id)
        assert.ok(current && current.id === input.requestId)
        const custom = typeof input.customText === 'string'
        assert.deepEqual(Object.keys(input).sort(), [custom ? 'customText' : 'option', 'requestId'])
        assert.ok(custom ? input.customText.trim() && input.customText.length <= 4000 : current.options.includes(input.option))
        assert.equal(current.recipient.kind, 'user')
        pending.delete(id)
        const answer = { requestId: input.requestId, option: custom ? input.customText.trim() : input.option,
          ...(custom ? { custom: true as const } : {}), answeredBy: 'user' as const, answeredAt: new Date().toISOString() }
        if (current.origin) decisionRecords.set(current.id, { request: current, answer })
        json({ answer })
        live.chat(id, { event: 'response', content: 'Answer received.', done: true })
        live.finish(id)
        return
      }
      if (match[2] === 'details') return json({ sessionId: id, name: null, workdir: { kind: 'local', displayPath: directory }, usage: null, usageScope: 'session', context: { usedTokens: null, windowTokens: null } })
      if (match[2] === 'context') return json({ systemPrompt: '', tools: [] })
      if (match[2] === 'files') return json({ path: '', entries: [], workdir: { kind: 'local', displayPath: directory } })
      if (match[2] === 'git/status') return json({ available: false, entries: [], reason: 'not_repository' })
      if (!match[2]) return json({ messages: [{ role: 'assistant', content: 'Synthetic read-only history.' }],
        decisionRecords: recordsFor(id), previousPhysicalId: null, systemPrompt: '', tools: [] })
    }
    if (path.startsWith('/api/') || path.startsWith('/debug/')) {
      failures.push(`Unstubbed ${request.method} ${path}`)
      return json({ error: 'not_found' }, 404)
    }
    const assetIndex = path.indexOf('/assets/')
    const file = assetIndex >= 0 ? resolve(assets, `.${path.slice(assetIndex)}`) : join(assets, 'index.html')
    const within = relative(assets, file)
    assert.ok(!within.startsWith('..') && !isAbsolute(within))
    const mime: Record<string, string> = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.woff2': 'font/woff2' }
    response.writeHead(200, { 'Content-Type': mime[extname(file)] ?? 'application/octet-stream', 'Cache-Control': 'no-store' })
    response.end(await readFile(file))
  } catch (cause) {
    failures.push(String(cause))
    if (!response.headersSent) response.writeHead(500)
    response.end()
  }
})

async function evaluate<T>(window: BrowserWindow, script: string): Promise<T> {
  assert.equal(window.isVisible(), false, 'Only inspect the isolated hidden fixture')
  return window.webContents.executeJavaScript(script) as Promise<T>
}
async function waitFor(window: BrowserWindow, expression: string) {
  const deadline = Date.now() + 15000
  while (!await evaluate(window, expression)) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${expression}`)
    await new Promise(resolve => setTimeout(resolve, 50))
  }
}
async function inspect(window: BrowserWindow, label: string, input = false) {
  await evaluate(window, 'document.fonts.ready')
  const result = await evaluate<{ bounded: boolean; radios: number; checked: number; defaults: number; covered: boolean; overflow: boolean; square: boolean; aligned: boolean; touchTargets: boolean }>(window, `(() => {
    const card = document.querySelector('.yield-question'), rect = card.getBoundingClientRect();
    const button = card.querySelector('button[type="submit"]'), bounds = button?.getBoundingClientRect();
    const hit = bounds && document.elementFromPoint(bounds.x + bounds.width/2, bounds.y + bounds.height/2);
    return { bounded: rect.left >= 0 && rect.top >= 0 && rect.right <= innerWidth && rect.bottom <= innerHeight,
      radios: card.querySelectorAll('input[type="radio"]').length, checked: card.querySelectorAll('input:checked').length,
      defaults: card.querySelectorAll('.yield-default').length, covered: !!button && !(hit === button || button.contains(hit)),
      square: [card, ...card.querySelectorAll('button, .yield-option, .yield-index, textarea')].every(el => getComputedStyle(el).borderRadius === '0px'),
      aligned: new Set([...card.querySelectorAll('.yield-index')].map(el => Math.round(el.getBoundingClientRect().left))).size === 1,
      touchTargets: innerWidth > 600 || [...card.querySelectorAll('.yield-option, .yield-actions button')].every(el => el.getBoundingClientRect().height >= 44),
      overflow: document.documentElement.scrollWidth > innerWidth || card.scrollWidth > card.clientWidth };
  })()`)
  assert.equal(result.bounded, true, `${label} card stays in viewport`)
  assert.equal(result.radios, input ? 0 : 3)
  assert.equal(result.checked, input ? 0 : 1)
  assert.equal(result.defaults, input ? 0 : 1)
  assert.equal(result.covered, false, `${label} Continue is independently reachable`)
  assert.equal(result.overflow, false)
  assert.equal(result.square, true, `${label} uses square corners throughout`)
  if (!input) assert.equal(result.aligned, true, `${label} presets and custom answer share one text column`)
  assert.equal(result.touchTargets, true, `${label} preserves mobile touch targets`)
  await writeFile(join(directory, `${label}.png`), (await window.webContents.capturePage()).toPNG())
  console.log(`LAYOUT_YIELD ${JSON.stringify({ label, ...result })}`)
}

async function runViewport(origin: string, width: number, height: number) {
  pending.clear()
  decisionRecords.clear()
  reviews.length = 0
  owners.clear()
  live.histories.clear()
  const isolated = session.fromPartition(`yield-${width}`, { cache: false })
  isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(`${origin}/`) }))
  isolated.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  const window = new BrowserWindow({
    show: false, frame: false, width, height, useContentSize: true,
    webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, offscreen: true },
  })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => { if (!url.startsWith(`${origin}/`)) event.preventDefault() })
  try {
    await window.loadURL(`${origin}/chat/${encodeURIComponent(root)}`)
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await waitFor(window, `!!document.querySelector('.composer-input textarea') && !!document.querySelector('.chat-bubble')`)
    const beforeReads = reads
    await new Promise(resolve => setTimeout(resolve, 1600))
    assert.equal(reads, beforeReads, 'Ordinary idle chats must not query a potentially unsupported yield endpoint')
    await evaluate(window, `(() => { const input = document.querySelector('.composer-input textarea'); input.value = 'Keep my unsent draft'; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
    assert.equal(await evaluate(window, `document.querySelector('[data-session-work="reporting"]')`), null, 'Reporting settings are no longer a permanent chat control')
    owners.set(root, reflector)
    const initial = { ...question(root, `root-${width}`), brief: decisionBrief, reportingSessionId: reflector,
      origin: { physicalId: 'physical-0', toolCallId: 'fixture-call' } }
    pending.set(root, initial)
    decisionRecords.set(initial.id, { request: initial })
    live.publisher.invalidateSessions(root)
    await waitFor(window, `!!document.querySelector('.yield-question input')`)
    await waitFor(window, `!!document.querySelector('.yield-decision.waiting-user')`)
    assert.equal(await evaluate(window, `document.querySelectorAll('.yield-decision').length`), 1, 'The pending endpoint supplies an anchor before the tool call loads')
    assert.match(await evaluate<string>(window, `document.querySelector('.yield-decision .decision-status').textContent`), /Needs your reply/)
    assert.match(await evaluate<string>(window, `document.querySelector('.yield-question .decision-brief').textContent`), /Original goal.*Unverified assumption.*Blocked until decided/s)
    live.chat(root, { event: 'tool_call', content: 'Waiting', toolCall: { name: 'ask', arguments: {} } })
    await waitFor(window, `!!document.querySelector('[aria-label="Stop current request"]') && document.querySelector('.composer-input textarea')?.disabled === false`)
    assert.match(await evaluate<string>(window, `document.querySelector('.chat-working').textContent`), /Waiting for a response/)
    await inspect(window, width > 600 ? 'yield-question-desktop' : 'yield-question-mobile')
    for (const theme of ['light', 'dark']) {
      await evaluate(window, `document.documentElement.classList.toggle('dark', ${theme === 'dark'})`)
      await inspect(window, `yield-${theme}-${width}`)
    }
    assert.equal(await evaluate(window, `document.querySelector('.yield-question').textContent.includes('No time limit')`), false, 'Indefinite waits do not repeat redundant status copy')
    assert.equal(await evaluate(window, `document.querySelector('.yield-question input:checked').value`), 'Make the smallest safe change')
    const beforeAnswers = answers.length
    if (width > 600) {
      await evaluate(window, `document.querySelector('.history-marker.waiting-user').dispatchEvent(new MouseEvent('mouseenter'))`)
      await waitFor(window, `document.querySelector('.history-preview.decision')?.textContent.includes('Needs your reply')`)
    }
    await new Promise(resolve => setTimeout(resolve, 1600))
    assert.equal(answers.length, beforeAnswers)
    if (width > 600) {
      assert.equal(await evaluate(window, `!!document.querySelector('.history-preview.decision')`), true, 'Polling the same immutable request must not dismiss the preview')
      await evaluate(window, `document.querySelector('.history-marker.waiting-user').dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}))`)
    }
    const discussion = '.yield-question .decision-discussion'
    await evaluate(window, `document.querySelector('${discussion}').open = true`)
    await waitFor(window, `!!document.querySelector('${discussion} textarea')`)
    await evaluate(window, `(() => { const input = document.querySelector('${discussion} textarea'); input.value = 'Where did the refactor requirement come from?'; input.dispatchEvent(new Event('input', {bubbles:true})); })()`)
    await evaluate(window, `document.querySelector('${discussion} .discussion-actions button').click()`)
    await waitFor(window, `document.querySelector('${discussion}').textContent.includes('not a user requirement')`)
    assert.equal(answers.length, beforeAnswers)
    assert.equal(pending.get(root)?.id, initial.id)
    assert.match(await evaluate<string>(window, `document.querySelector('.yield-question').textContent`), /Automatic default paused/)
    await evaluate(window, `(() => { const input = document.querySelector('${discussion} textarea'); input.value = 'Preserve the original scope and revise the question.'; input.dispatchEvent(new Event('input', {bubbles:true})); })()`)
    await evaluate(window, `document.querySelectorAll('${discussion} .discussion-actions button')[1].click()`)
    await waitFor(window, `document.querySelector('.yield-question').textContent.includes('Choose a bounded change')`)
    assert.equal(answers.length, beforeAnswers)
    assert.equal(sends, 0)
    assert.equal(await evaluate(window, `document.querySelector('.composer-input textarea').value`), 'Keep my unsent draft')
    assert.equal(await evaluate(window, `document.querySelectorAll('.yield-question input[type="radio"]').length`), 2)
    assert.equal(await evaluate(window, `document.documentElement.scrollWidth > innerWidth`), false)
    await evaluate(window, `document.querySelector('${discussion}').open = false`)
    await evaluate(window, `document.querySelectorAll('.yield-question input')[1].click()`)
    rejectNext = true
    await evaluate(window, `document.querySelector('.yield-continue').click()`)
    await waitFor(window, `document.querySelector('.yield-error')?.textContent.includes('Synthetic answer rejection')`)
    assert.equal(await evaluate(window, `document.querySelector('.yield-question input:checked').value`), 'Refactor the implementation with focused tests')
    assert.equal(await evaluate(window, `document.querySelector('.composer-input textarea').value`), 'Keep my unsent draft')
    await evaluate(window, `document.querySelector('.yield-continue').click()`)
    await waitFor(window, `!document.querySelector('.yield-question') && !document.querySelector('.composer-input textarea').disabled`)
    assert.equal(await evaluate(window, `!!document.querySelector('.yield-decision.waiting-user')`), false)
    await waitFor(window, `document.querySelector('.yield-decision.user')?.textContent.includes('Refactor the implementation')`)
    assert.match(await evaluate<string>(window, `document.querySelector('.yield-decision.user').textContent`), new RegExp(`root-${width}`), 'The original request identity survives response and history refresh')
    assert.equal(answers.at(-1)?.option, 'Refactor the implementation with focused tests')
    assert.equal(await evaluate(window, `document.querySelector('.composer-input textarea').value`), 'Keep my unsent draft')

    await evaluate(window, `document.querySelector('.yield-decision.user .decision-graph').open = true`)
    await waitFor(window, `!!document.querySelector('.graph-inspector .basis-graph')`)
    assert.match(await evaluate<string>(window, `document.querySelector('.graph-inspector .basis-graph').textContent`), /Original goal.*Unverified assumption.*Agent recommendation.*Blocked until decided/s)
    assert.equal(await evaluate(window, `document.documentElement.scrollWidth > innerWidth`), false)
    await evaluate(window, `document.querySelector('.yield-decision.user .decision-graph').open = false`)
    const historical = '.yield-decision.user .decision-discussion'
    await evaluate(window, `document.querySelector('${historical}').open = true`)
    await waitFor(window, `!!document.querySelector('${historical} textarea')`)
    await evaluate(window, `(() => { const input = document.querySelector('${historical} textarea'); input.value = 'The existing pipeline disproves the adapter premise.'; input.dispatchEvent(new Event('input', {bubbles:true})); })()`)
    await evaluate(window, `Array.from(document.querySelectorAll('${historical} button')).find(button => button.textContent.includes('Mark premise obsolete')).click()`)
    await waitFor(window, `!!document.querySelector('.yield-decision.invalidated .decision-answer')`)
    assert.match(await evaluate<string>(window, `document.querySelector('.yield-decision.invalidated .decision-answer').textContent`), /Refactor the implementation/)
    assert.equal(await evaluate(window, `document.querySelector('.yield-decision.invalidated').textContent.includes('No option was selected')`), false)

    for (const kind of ['investigation', 'deferred'] as const) {
      const next = { ...initial, id: `${kind}-${width}`, reconsiders: { sessionId: root, physicalId: 'physical-0', requestId: `${initial.id}-v2` } }
      pending.set(root, next)
      decisionRecords.set(next.id, { request: next })
      live.publisher.invalidateSessions(root)
      await waitFor(window, `!!document.querySelector('.yield-question')`)
      await evaluate(window, `document.querySelector('${discussion}').open = true`)
      await waitFor(window, `!!document.querySelector('${discussion} textarea')`)
      await evaluate(window, `(() => { const input = document.querySelector('${discussion} textarea'); input.value = 'Investigate the original pipeline; do not expand scope.'; input.dispatchEvent(new Event('input', {bubbles:true})); })()`)
      const beforeFollowUp = answers.length
      await evaluate(window, `document.querySelectorAll('${discussion} .discussion-actions button')[${kind === 'investigation' ? 2 : 3}].click()`)
      await waitFor(window, `!document.querySelector('.yield-question') && !!document.querySelector('.yield-decision.${kind}')`)
      assert.equal(followUps.at(-1)?.kind, kind)
      assert.equal(answers.length, beforeFollowUp)
      assert.equal(sends, 0)
      assert.equal(await evaluate(window, `document.querySelector('.composer-input textarea').value`), 'Keep my unsent draft')
    }

    for (const count of [2, 3]) {
      const current = question(root, `custom-${count}-${width}`)
      if (count === 2) { current.options = ['Yes', 'No']; current.defaultOption = 'No' }
      pending.set(root, current)
      live.publisher.invalidateSessions(root)
      await waitFor(window, `!!document.querySelector('.yield-custom-toggle')`)
      assert.equal(await evaluate(window, `document.querySelectorAll('.yield-custom-toggle').length`), 1)
      await evaluate(window, `document.querySelector('.yield-custom-toggle').click()`)
      await waitFor(window, `document.activeElement === document.querySelector('.yield-custom textarea')`)
      assert.equal(await evaluate(window, `document.querySelector('.yield-continue').disabled`), true)
      assert.equal(await evaluate(window, `document.querySelector('.yield-custom textarea').maxLength`), 4000)
      await evaluate(window, `(() => {
        const input = document.querySelector('.yield-custom textarea');
        input.value = 'My own approach\\nwith details';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      })()`)
      await new Promise(resolve => setTimeout(resolve, 1600))
      assert.equal(await evaluate(window, `document.querySelector('.yield-custom textarea').value`), 'My own approach\nwith details')
      const bounds = await evaluate(window, `(() => {
        const card = document.querySelector('.yield-question'), input = card.querySelector('textarea'), button = card.querySelector('.yield-continue');
        const rect = card.getBoundingClientRect(), r = button.getBoundingClientRect(), text = input.getBoundingClientRect();
        const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
        return { bounded: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
          overflow: card.scrollWidth > card.clientWidth || document.documentElement.scrollWidth > innerWidth,
          inputVisible: text.top >= rect.top && text.bottom <= rect.bottom,
          reachable: hit === button || button.contains(hit) };
      })()`)
      assert.deepEqual(bounds, { bounded: true, overflow: false, inputVisible: true, reachable: true }, `Custom entry stays usable with ${count} presets at ${width}px`)
      await writeFile(join(directory, `yield-custom-${count}-${width}.png`), (await window.webContents.capturePage()).toPNG())
      rejectNext = true
      await evaluate(window, `document.querySelector('.yield-continue').click()`)
      await waitFor(window, `document.querySelector('.yield-error')?.textContent.includes('Synthetic answer rejection')`)
      assert.equal(await evaluate(window, `document.querySelector('.yield-custom textarea').value`), 'My own approach\nwith details')
      assert.equal(await evaluate(window, `document.querySelector('.composer-input textarea').value`), 'Keep my unsent draft')
      assert.equal(await evaluate(window, `(() => {
        const button = document.querySelector('.yield-continue'), rect = button.getBoundingClientRect();
        const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
        return hit === button || button.contains(hit);
      })()`), true, 'A rejected response keeps the retry action reachable')
      await evaluate(window, `document.querySelector('.yield-continue').click()`)
      await waitFor(window, `!document.querySelector('.yield-question')`)
      assert.deepEqual(answers.at(-1), { requestId: current.id, customText: 'My own approach\nwith details' })
      assert.equal(await evaluate(window, `document.querySelector('.composer-input textarea').value`), 'Keep my unsent draft')
      console.log(`LAYOUT_YIELD_CUSTOM ${JSON.stringify({ width, count, bounds })}`)
    }

    const binaryOptions: [string, string] = ['Build both Apple Silicon arm64 and Intel x64 archives (recommended)', 'Build only the Apple Silicon arm64 archive']
    pending.set(root, { ...question(root, `binary-${width}`), question: 'Which macOS architectures should the first release support? Each architecture will have its own archive.', options: binaryOptions, defaultOption: binaryOptions[1]! })
    live.publisher.invalidateSessions(root)
    await waitFor(window, `document.querySelectorAll('label.yield-option').length === 2`)
    assert.equal(await evaluate(window, `document.querySelectorAll('.yield-question input[type="radio"]').length`), 2)
    const beforeBinary = answers.length
    assert.equal(await evaluate(window, `document.querySelectorAll('.yield-continue').length`), 1)
    const binaryBounds = await evaluate<boolean>(window, `Array.from(document.querySelectorAll('label.yield-option, .yield-continue')).every(button => {
      const r = button.getBoundingClientRect();
      const hit = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return r.left >= 0 && r.right <= innerWidth && r.height >= 32 && (hit === button || button.contains(hit));
    })`)
    assert.equal(binaryBounds, true, 'Both answer rows and Continue fit and remain reachable')
    await writeFile(join(directory, `yield-binary-${width}.png`), (await window.webContents.capturePage()).toPNG())
    assert.equal(answers.length, beforeBinary)
    await evaluate(window, `document.querySelector('label.yield-option').click()`)
    assert.equal(answers.length, beforeBinary, 'Clicking an answer selects it without submitting')
    assert.equal(await evaluate(window, `document.querySelector('.yield-question input:checked').value`), binaryOptions[0])
    await evaluate(window, `{
      const input = document.querySelector('.yield-question input');
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', {key:'b', bubbles:true, cancelable:true}));
    }`)
    assert.equal(await evaluate(window, `document.querySelector('.yield-question input:checked').value`), binaryOptions[1])
    await evaluate(window, `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'c', bubbles:true, cancelable:true}))`)
    await waitFor(window, `document.activeElement === document.querySelector('.yield-custom textarea')`)
    await evaluate(window, `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'a', bubbles:true, cancelable:true}))`)
    assert.equal(await evaluate(window, `document.querySelectorAll('.yield-question input:checked').length`), 0, 'Typing inside a custom answer must not select a preset')
    await evaluate(window, `{
      const input = document.querySelector('.yield-question input');
      input.focus();
      input.dispatchEvent(new KeyboardEvent('keydown', {key:'a', bubbles:true, cancelable:true}));
    }`)
    assert.equal(answers.length, beforeBinary, 'Letter shortcuts only select answers')
    const beforeEscape = cancellations.length
    await evaluate(window, `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape', bubbles:true, cancelable:true}))`)
    assert.equal(cancellations.length, beforeEscape, 'Escape must not silently cancel the task')
    await evaluate(window, `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Enter', bubbles:true, cancelable:true}))`)
    await waitFor(window, `!document.querySelector('.yield-question')`)
    assert.deepEqual(answers.at(-1), { requestId: `binary-${width}`, option: binaryOptions[0] })
    assert.equal(await evaluate(window, `document.querySelector('.composer-input textarea').value`), 'Keep my unsent draft')

    pending.set(root, { ...question(root, `work-${width}`), question: 'Apply this saved work proposal?',
      options: [WORK_APPROVE, WORK_REJECT], defaultOption: WORK_REJECT, brief: decisionBrief,
      origin: { physicalId: 'physical-0' },
      workProposal: { key: 'work:11111111-1111-4111-8111-111111111111', id: '22222222-2222-4222-8222-222222222222',
        baseRevision: 1, assignmentRevision: 2, change: 'pause', reason: 'Review acceptance first', paused: true,
        definition: { objective: 'Verify both directions', acceptance: ['Inbound and outbound verified'], boundaries: ['No publication'], evidence: [] } },
    })
    live.publisher.invalidateSessions(root)
    await waitFor(window, `document.querySelector('.work-proposal')`)
    const proposalText = await evaluate<string>(window, `document.querySelector('.work-proposal').textContent`)
    assert.match(proposalText, /Verify both directions/)
    assert.match(proposalText, /Inbound and outbound verified/)
    assert.match(proposalText, /No publication/)
    assert.match(proposalText, /New execution: paused/)
    assert.equal(await evaluate(window, `[...document.querySelectorAll('.yield-question button')].some(button => button.textContent.includes('Request revised question'))`), false)
    await evaluate(window, `document.querySelector('.yield-question input[type="radio"]').click()`)
    await evaluate(window, `document.querySelector('.yield-continue').click()`)
    await waitFor(window, `!document.querySelector('.yield-question')`)
    assert.deepEqual(answers.at(-1), { requestId: `work-${width}`, option: WORK_APPROVE })

    const expiring = question(root, `expired-${width}`)
    expiring.deadline = new Date(Date.now() - 1000).toISOString()
    pending.set(root, expiring)
    live.publisher.invalidateSessions(root)
    await waitFor(window, `document.querySelector('.yield-question')?.textContent.includes('Time limit reached')`)
    const expiredAnswers = answers.length
    await new Promise(resolve => setTimeout(resolve, 1600))
    assert.equal(answers.length, expiredAnswers, 'Client expiry must never resolve the question')
    live.chat(root, { event: 'tool_call', content: 'Waiting', toolCall: { name: 'ask', arguments: {} } })
    await waitFor(window, `!!document.querySelector('[aria-label="Stop current request"]') && document.querySelector('.composer-input textarea')?.disabled === false`)
    assert.equal(await evaluate(window, `!!document.querySelector('[aria-label="Stop waiting"]')`), false, 'Do not add an unrelated composer Stop control')
    await evaluate(window, `document.querySelector('.yield-cancel').click()`)
    await waitFor(window, `!document.querySelector('.yield-question') && !document.querySelector('.composer-input textarea').disabled`)
    assert.equal(cancellations.at(-1)?.requestId, expiring.id)
    assert.equal(answers.length, expiredAnswers, 'Cancel task must cancel without adopting the default')
    assert.equal(await evaluate(window, `document.querySelector('.composer-input textarea').value`), 'Keep my unsent draft')
    pending.set(root, question(root, `cancel-card-${width}`))
    live.publisher.invalidateSessions(root)
    await waitFor(window, `!!document.querySelector('.yield-cancel')`)
    await evaluate(window, `document.querySelector('.yield-cancel').click()`)
    await waitFor(window, `!document.querySelector('.yield-question')`)
    assert.equal(cancellations.at(-1)?.requestId, `cancel-card-${width}`)

    pendingInput = {
      kind: 'input', id: `input-${width}`, sessionId: root, question: 'Which workspace path should be used?',
      recipient: { kind: 'user', sessionId: root }, origin: { physicalId: 'physical-0', toolCallId: `ask-input-${width}` },
      createdAt: new Date().toISOString(), deadline: null,
    }
    live.publisher.invalidateSessions(root)
    await waitFor(window, `document.querySelector('.yield-heading')?.textContent.includes('Input')`)
    assert.equal(await evaluate(window, `document.querySelectorAll('.yield-question input[type="radio"]').length`), 0)
    assert.equal(await evaluate(window, `document.querySelector('.yield-continue').disabled`), true)
    await evaluate(window, `(() => {
      const input = document.querySelector('.yield-custom textarea'); input.focus();
      input.value = 'fixture-path'; input.dispatchEvent(new Event('input', {bubbles:true}));
    })()`)
    await inspect(window, `ask-input-${width}`, true)
    await evaluate(window, `document.querySelector('.yield-continue').click()`)
    await waitFor(window, `!document.querySelector('.yield-question')`)
    assert.equal(inputAnswers.at(-1), 'fixture-path')
    pending.set(reflector, question(reflector, `reflector-${width}`))
    await window.loadURL(`${origin}/chat/${encodeURIComponent(reflector)}`)
    await waitFor(window, `!!document.querySelector('.yield-continue')`)
    assert.equal(await evaluate(window, `!!document.querySelector('.composer-input textarea')`), false)
    await inspect(window, `yield-reflector-${width}`)

    pending.set(child, question(child, `child-${width}`, true))
    await window.loadURL(`${origin}/chat/${encodeURIComponent(child)}`)
    await waitFor(window, `document.querySelector('.yield-question')?.textContent.includes('Only that session can answer')`)
    await waitFor(window, `!!document.querySelector('.yield-decision.waiting-parent')`)
    assert.equal(await evaluate(window, `!!document.querySelector('.yield-decision.waiting-user')`), false)
    assert.equal(await evaluate(window, `document.querySelectorAll('.yield-question input:disabled').length`), 3)
    assert.equal(await evaluate(window, `document.querySelector('.yield-custom-toggle').matches(':disabled')`), true)
    assert.equal(await evaluate(window, `!!document.querySelector('.yield-continue')`), false)
    assert.equal(await evaluate(window, `!!document.querySelector('.yield-cancel')`), false)
    await inspect(window, `yield-parent-${width}`)
    assert.equal(sends, 0, 'Answers must not use the ordinary chat send route')
  } catch (cause) {
    console.log(`LAYOUT_YIELD_FAILURE ${await evaluate<string>(window, 'document.body.innerText.slice(0, 3000)')}`)
    await writeFile(join(directory, `yield-failure-${width}.png`), (await window.webContents.capturePage()).toPNG())
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
    console.log(`LAYOUT_RESULT ${JSON.stringify({ ok: true, answers: answers.length, cancellations: cancellations.length, sends, reads })}`)
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
