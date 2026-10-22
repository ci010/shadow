import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { app, BrowserWindow, session } from 'electron'
import { FoldersFixture, type FixtureSession } from './folders-fixture.js'
import { LiveFixture } from './live-fixture.ts'
import { activeWorkspaceScript } from './active-workspace.ts'

function argument(name: string): string {
  const value = process.argv.find((value) => value.startsWith(`--${name}=`))?.slice(name.length + 3)
  assert.ok(value, `Missing fixture argument ${name}`)
  return resolve(value)
}
const assets = argument('layout-assets')
const directory = argument('layout-root')
const sessionId = `web:chat-layout-${'long-session-name-'.repeat(9)}`
const initialModel = 'claude-sonnet-4.6@copilot'
const alternateModel = 'gpt-5-mini@copilot'
let selectedModel = initialModel
let selectedProvider = 'copilot'
let providerReady = true
let providerReads = 0
const saves: unknown[] = []
const sessionConfigs = new Map<string, Record<string, unknown>>()
const sessionPatches: Array<{ sessionId: string; patch: Record<string, unknown> }> = []
let settingsGate: Promise<void> | undefined
let rejectSettings = false
let rejectedSettings = 0
const failures: string[] = []
const blockedRequests: string[] = []
const apiRequests = new Set<string>()
const ownedWindows = new Set<BrowserWindow>()
const cancelledLogins = new Set<string>()
let activeLogin: string | undefined
let providersEntries = 0
let onboardingGates = 0
let onboardingRecoveries = 0

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

const history = Array.from({ length: 72 }, (_, index) => ({
  role: index % 2 ? 'assistant' : 'user',
  content: index % 2
    ? `Synthetic response ${index}. ${'A long response wraps within the conversation. '.repeat(12)}\n\n\`\`\`text\n${'long-code-token'.repeat(70)}\n\`\`\``
    : `Synthetic message ${index}. ${'unbroken'.repeat(90)}`,
}))
const sessions: FixtureSession[] = Array.from({ length: 90 }, (_, index) => ({
  sessionId: index === 0 ? sessionId : `web:chat-fixture-${index}`,
  title: `Synthetic session ${index} ${'long-title-'.repeat(16)}`,
  description: `Synthetic description ${'long-description-'.repeat(12)}`,
  current: `physical-fixture-${index}`,
}))
const folders = new FoldersFixture(directory, sessions)
const live = new LiveFixture()
let implicitPaidRequests = 0
const prompt = '# Synthetic system prompt\n\n' + 'A fixture instruction, not a live agent. '.repeat(400)
const tools = Array.from({ length: 12 }, (_, index) => ({
  name: `synthetic_tool_${index}`,
  description: 'This tool is inert and cannot execute.',
  parameters: { type: 'object', properties: {} },
}))
const status = () => ({
  provider: selectedProvider, model: selectedModel,
  authMode: selectedProvider === 'copilot' ? 'copilot' : selectedProvider === 'openai' ? 'api-key' : 'none',
  ready: providerReady, hasApiKey: false,
  ...(!providerReady ? { reason: 'missing_credentials' } : {}),
})

const server = createServer(async (request, response) => {
  try {
    if (live.handle(request, response)) return
    const url = new URL(request.url!, 'http://127.0.0.1')
    const path = url.pathname.replace(/^\/projects\/default(?=\/)/, '')
    const json = (data: unknown) => {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(data))
    }
    if (path.startsWith('/api/') || path.startsWith('/debug/')) apiRequests.add(`${request.method} ${path}`)
    if (path === '/api/projects') return json({ projects: [{ id: 'default', name: 'Default', createdAt: '2026-09-16T00:00:00Z' }] })
    if (path === '/api/automations') return json({ automations: [] })
    const background = path.match(/^\/api\/sessions\/([^/]+)\/background-tasks$/)
    if (background) return json({ sessionId: decodeURIComponent(background[1]), total: 0, tasks: [] })
    if (path === '/v1/query/session-spans' && request.method === 'GET') return json({ entries: [], total: 0, hasMore: false })
    if (path === '/api/chat/send' || path.startsWith('/v1/')) {
      implicitPaidRequests += 1
      failures.push(`Folder action attempted a model request: ${request.method} ${path}`)
      response.writeHead(409).end()
      return
    }
    const configRoute = path.match(/^\/api\/sessions\/([^/]+)\/config$/)
    if (configRoute && request.method === 'PATCH') {
      const sessionId = decodeURIComponent(configRoute[1])
      assert.ok(sessions.some(session => session.sessionId === sessionId))
      let text = ''
      for await (const chunk of request) text += chunk
      const patch = JSON.parse(text)
      sessionPatches.push({ sessionId, patch })
      const gate = settingsGate
      settingsGate = undefined
      await gate
      if (rejectSettings) {
        rejectSettings = false
        rejectedSettings++
        response.writeHead(503, { 'Content-Type': 'application/json' }).end(JSON.stringify({ error: 'Synthetic session settings rejection' }))
        return
      }
      const config = { ...sessionConfigs.get(sessionId) }
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete config[key]
        else config[key] = value
      }
      sessionConfigs.set(sessionId, config)
      live.publisher.invalidateSessions(sessionId)
      return json({ key: sessionId, config })
    }
    if (await folders.handle(request, response, path)) return
    if (path === '/api/provider/configured') {
      json({ providers: providerReady ? [...new Set(['copilot', selectedProvider])].map(provider => ({
        provider, selected: provider === selectedProvider,
        authMode: provider === 'copilot' ? 'copilot' : provider === 'openai' ? 'api-key' : 'none',
        hasApiKey: false, model: provider === selectedProvider ? selectedModel : undefined,
      })) : [] })
      return
    }
    if (path === '/api/provider/setup') {
      if (request.method === 'POST') {
        let body = ''
        for await (const chunk of request) body += chunk
        const input = JSON.parse(body) as { model: string; provider: string }
        saves.push(input)
        selectedModel = input.model
        selectedProvider = input.provider
        providerReady = true
      } else providerReads += 1
      json(status())
    } else if (path === '/api/auth/login' && request.method === 'POST') {
      let body = ''
      for await (const chunk of request) body += chunk
      const input = JSON.parse(body) as { attemptId: string }
      activeLogin = input.attemptId
      json({
        loginId: activeLogin, state: 'pending', userCode: 'TEST-CODE',
        verificationUri: 'https://github.com/login/device',
        expiresAt: Date.now() + 600_000, intervalMs: 1000,
      })
    } else if (path.startsWith('/api/auth/login/')) {
      const loginId = decodeURIComponent(path.slice('/api/auth/login/'.length))
      if (request.method === 'DELETE') {
        cancelledLogins.add(loginId)
        if (activeLogin === loginId) activeLogin = undefined
        json({ loginId, state: 'cancelled' })
      } else json({
        loginId, state: cancelledLogins.has(loginId) ? 'cancelled' : 'pending',
        userCode: 'TEST-CODE', verificationUri: 'https://github.com/login/device',
        expiresAt: Date.now() + 600_000, intervalMs: 1000,
      })
    } else if (path === '/debug/models') json({ models: [initialModel, alternateModel] })
    else if (path === '/api/config') json({ agent: { provider: selectedProvider, model: selectedModel, workspace: directory, temperature: 0.7 } })
    else if (path === '/api/sessions/graph') {
      const graph = folders.graph()
      json({ ...graph, sessions: graph.sessions.map(session => ({ ...session, config: sessionConfigs.get(session.sessionId) })) })
    }
    else if (path === '/api/sessions/stages') json({ stages: { [sessionId]: 'idle' } })
    else if (path === '/api/chat/session') json({ history, systemPrompt: prompt, tools })
    else if (/^\/api\/sessions\/[^/]+$/.test(path)) json({ previousPhysicalId: null, messages: history })
    else if (/^\/api\/sessions\/[^/]+\/details$/.test(path)) json({
      sessionId: decodeURIComponent(path.split('/')[3]), name: null, workdir: { kind: 'local', displayPath: directory },
      usage: null, usageScope: 'session', context: { usedTokens: null, windowTokens: null },
    })
    else if (/^\/api\/sessions\/[^/]+\/files$/.test(path)) json({ path: '', workdir: { kind: 'local', displayPath: directory }, entries: [] })
    else if (/^\/api\/sessions\/[^/]+\/git\/status$/.test(path)) json({ available: false, reason: 'not_repository', entries: [] })
    else if (path === '/debug/agent-types') {
      json(Array.from({ length: 40 }, (_, index) => ({
        name: `fixture-agent-${index}`, description: 'Synthetic non-chat layout fixture '.repeat(5),
        source: 'builtin', canSpawn: false, ephemeral: false,
      })))
    } else if (path.startsWith('/debug/agent-types/') && path.endsWith('/context')) json({ systemPrompt: prompt, tools })
    else if (path.startsWith('/api/') || path.startsWith('/debug/')) {
      failures.push(`Unstubbed API: ${request.method} ${path}`)
      response.writeHead(404).end()
    } else {
      const file = path.startsWith('/assets/') ? resolve(assets, `.${path}`) : join(assets, 'index.html')
      const within = relative(assets, file)
      if (within.startsWith('..') || isAbsolute(within)) {
        response.writeHead(403).end()
        return
      }
      const contentTypes: Record<string, string> = {
        '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
        '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
      }
      response.writeHead(200, {
        'Content-Type': contentTypes[extname(file)] ?? 'application/octet-stream',
        'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self' data:; script-src 'self'; style-src 'self' 'unsafe-inline'; connect-src 'self'; font-src 'self' data:",
      })
      response.end(await readFile(file))
    }
  } catch {
    failures.push('Fixture HTTP handler failed')
    response.writeHead(500).end()
  }
})

interface Box {
  left: number
  top: number
  right: number
  bottom: number
  width: number
  height: number
  clientWidth: number
  clientHeight: number
  scrollWidth: number
  scrollHeight: number
  overflowX: string
  overflowY: string
  paddingBottom: number
  display: string
}
interface Measurements {
  viewport: { width: number; height: number }
  title: string
  boxes: Record<string, Box | null>
  frames: number
  sessionCount: number
  messageCount: number
  model: string | null
  sendUncovered: boolean
  sendHitTarget: string | null
  desktop: boolean
  visibility: string
  glowTransform: string | null
  route: string
  activeTabs: string[]
  legacyProviderButton: boolean
}
const selectors = [
  'html', 'body', '.desktop-frame', '.desktop-title-bar', '.runtime-status-bar',
  '.desktop-content', '.app-main', '.route-content', '.chat-workspace',
  '.projects-sidebar', '.project-groups', '.chat-panel', '.conversation-heading-row',
  '.chat-messages', '.chat-composer', '.composer-input textarea',
  '.composer-toolbar', '.composer-controls', '[aria-label="Choose model"]', '.composer-send',
  '.session-diagnosis', '.diagnosis-toggle', '.window-controls', '.desktop-window-title',
  '.mouse-glow', '.mouse-glow-layer',
  '.folder-menu', '.folder-dialog',
]

async function evaluate<T>(window: BrowserWindow, script: string): Promise<T> {
  assert.ok(ownedWindows.has(window) && !window.isVisible(), 'Only hidden test-owned windows may be inspected')
  return window.webContents.executeJavaScript(activeWorkspaceScript(script)) as Promise<T>
}
async function waitFor(window: BrowserWindow, expression: string): Promise<void> {
  const deadline = Date.now() + 15_000
  while (!await evaluate<boolean>(window, expression)) {
    if (Date.now() > deadline) throw new Error(`Timed out: ${expression}`)
    await new Promise((done) => setTimeout(done, 50))
  }
  await evaluate(window, 'document.fonts.ready.then(() => true)')
  await new Promise((done) => setTimeout(done, 250))
}
async function measure(window: BrowserWindow): Promise<Measurements> {
  return evaluate(window, `(() => {
    const boxes = {};
    for (const selector of ${JSON.stringify(selectors)}) {
      const node = document.querySelector(selector);
      if (!node) { boxes[selector] = null; continue; }
      const rect = node.getBoundingClientRect(), style = getComputedStyle(node);
      boxes[selector] = {
        left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
        width: rect.width, height: rect.height,
        clientWidth: node.clientWidth, clientHeight: node.clientHeight,
        scrollWidth: node.scrollWidth, scrollHeight: node.scrollHeight,
        overflowX: style.overflowX, overflowY: style.overflowY, paddingBottom: parseFloat(style.paddingBottom), display: style.display
      };
    }
    const send = document.querySelector('.composer-send');
    const bounds = send?.getBoundingClientRect();
    const hit = bounds && document.elementFromPoint((bounds.left + bounds.right)/2, (bounds.top + bounds.bottom)/2);
    return {
      viewport: { width: innerWidth, height: innerHeight }, boxes,
      title: document.title, frames: document.querySelectorAll('.desktop-frame').length,
      sessionCount: document.querySelectorAll('.folder-session-row').length,
      messageCount: document.querySelectorAll('.chat-bubble').length,
      model: document.querySelector('[aria-label="Choose model"]')?.title ?? null,
      sendUncovered: Boolean(send && (hit === send || send.contains(hit))),
      sendHitTarget: hit ? hit.tagName.toLowerCase() + '.' + Array.from(hit.classList).join('.') : null,
      desktop: Boolean(window.shadowDesktop),
      route: location.hash ? location.hash.slice(1) : location.pathname + location.search,
      activeTabs: Array.from(document.querySelectorAll('.tab-nav [aria-current="page"]')).map(node => node.textContent.trim()),
      legacyProviderButton: Boolean(document.querySelector('.provider-settings-btn')),
      visibility: document.visibilityState,
      glowTransform: document.querySelector('.mouse-glow') ? getComputedStyle(document.querySelector('.mouse-glow')).transform : null
    };
  })()`)
}
function check(value: unknown, message: string): void {
  if (!value) failures.push(message)
}
function box(metrics: Measurements, selector: string): Box {
  const result = metrics.boxes[selector]
  assert.ok(result, `Missing ${selector}`)
  return result
}
function bounded(metrics: Measurements, selector: string, label: string): void {
  const bounds = box(metrics, selector)
  check(bounds.width > 0 && bounds.height > 0 && bounds.left >= -1 && bounds.top >= -1
    && bounds.right <= metrics.viewport.width + 1 && bounds.bottom <= metrics.viewport.height + 1,
  `${label}: ${selector} outside viewport: ${JSON.stringify(bounds)}`)
}
function documentChecks(metrics: Measurements, label: string): void {
  for (const selector of ['html', 'body']) {
    const element = box(metrics, selector)
    check(element.scrollWidth <= metrics.viewport.width + 1 && element.scrollHeight <= metrics.viewport.height + 1,
      `${label}: ${selector} document overflow ${element.scrollWidth}x${element.scrollHeight}`)
  }
  check(metrics.title === 'Shadow', `${label}: document.title must be Shadow`)
  check(metrics.frames === 1, `${label}: expected one DesktopFrame, received ${metrics.frames}`)
  bounded(metrics, '.desktop-title-bar', label)
  check(metrics.boxes['.runtime-status-bar'] === null, `${label}: runtime status must not occupy a second header row`)
  check(Math.abs(box(metrics, '.app-main').top - box(metrics, '.desktop-content').top) <= 1,
    `${label}: app content must begin directly below navigation`)
  if (metrics.desktop) bounded(metrics, '.window-controls', label)
  check(!metrics.legacyProviderButton, `${label}: legacy .provider-settings-btn must be removed`)
  check(metrics.activeTabs.length === 1, `${label}: exactly one top-level tab must have aria-current=page`)
}
function chatChecks(metrics: Measurements, label: string, mobile: boolean, expectedModel = initialModel): void {
  documentChecks(metrics, label)
  for (const selector of ['.chat-workspace', '.chat-panel', '.conversation-heading-row', '.chat-messages', '.chat-composer', '.composer-input textarea', '.composer-toolbar', '.composer-controls', '[aria-label="Choose model"]', '.composer-send']) bounded(metrics, selector, label)
  check(metrics.sendUncovered, `${label}: .composer-send is covered or outside hit-test viewport; hit=${metrics.sendHitTarget}`)
  check(metrics.sessionCount === sessions.length, `${label}: synthetic session list did not mount (${metrics.sessionCount}/${sessions.length})`)
  check(metrics.messageCount === 72, `${label}: synthetic history did not mount`)
  check(metrics.model?.includes(expectedModel), `${label}: conversation model not reflected in picker (${metrics.model})`)
  const messages = box(metrics, '.chat-messages')
  check(['auto', 'scroll'].includes(messages.overflowY) && messages.scrollHeight > messages.clientHeight,
    `${label}: .chat-messages must scroll internally`)
  const composer = box(metrics, '.chat-composer')
  const textarea = box(metrics, '.composer-input textarea')
  const toolbar = box(metrics, '.composer-toolbar')
  const model = box(metrics, '.composer-controls')
  const send = box(metrics, '.composer-send')
  check(messages.paddingBottom >= messages.bottom - composer.top, `${label}: scroll padding must keep the final message above the overlay composer`)
  check(textarea.bottom <= toolbar.top + 1, `${label}: textarea must occupy its own row above .composer-toolbar`)
  check(Math.abs(textarea.width - toolbar.width) <= 2, `${label}: textarea must fill the composer width`)
  check(model.right <= send.left + 1 && Math.abs(send.right - toolbar.right) <= 2, `${label}: model-left / Send-right toolbar alignment`)
  if (!mobile) {
    const sidebar = box(metrics, '.projects-sidebar')
    const list = box(metrics, '.project-groups')
    check(Math.abs(sidebar.left) <= 1, `${label}: .sessions-sidebar must touch the left edge`)
    check(Math.abs(sidebar.top - box(metrics, '.desktop-title-bar').bottom) <= 1, `${label}: .sessions-sidebar must start immediately below chrome`)
    check(['auto', 'scroll'].includes(list.overflowY) && list.scrollHeight > list.clientHeight,
      `${label}: .folders-scroll must scroll internally`)
    check(Math.abs(box(metrics, '.desktop-title-bar').height - 44) <= 1, `${label}: title bar should be 44px`)
  }
}
function report(label: string, metrics: Measurements): void {
  const bounds = Object.fromEntries(Object.entries(metrics.boxes).filter(([, value]) => value).map(([selector, value]) => [
    selector, {
      rect: [value!.left, value!.top, value!.right, value!.bottom],
      client: [value!.clientWidth, value!.clientHeight],
      scroll: [value!.scrollWidth, value!.scrollHeight],
      overflow: [value!.overflowX, value!.overflowY],
    },
  ]))
  console.log(`LAYOUT_METRICS ${JSON.stringify({ ...metrics, boxes: bounds, label })}`)
}

async function clickTab(window: BrowserWindow, text: string): Promise<void> {
  await evaluate(window, `Array.from(document.querySelectorAll('.tab-nav .tab')).find(node => node.textContent.trim() === ${JSON.stringify(text)}).click()`)
}

async function waitForTab(window: BrowserWindow, text: string): Promise<void> {
  await waitFor(window, `Array.from(document.querySelectorAll('.tab-nav [aria-current="page"]')).some(node => node.textContent.trim() === ${JSON.stringify(text)})`)
}

async function runFolders(window: BrowserWindow, width: number, desktop: boolean): Promise<void> {
  const label = `folders-${width}`
  const folder = (path: string) => `Array.from(document.querySelectorAll('.folder-folder')).find(node => node.title === ${JSON.stringify(path)})`
  const group = (path: string) => `${folder(path)}?.closest('.folder-group')`
  const showSidebar = async () => {
    await evaluate(window, `(() => {
      if (!document.querySelector('.projects-sidebar').getBoundingClientRect().width) document.querySelector('.projects-toggle').click();
      document.querySelector('.project-groups').scrollTop = 0;
    })()`)
    await waitFor(window, `document.querySelector('.projects-sidebar')?.getBoundingClientRect().width > 0`)
  }
  const menu = async (action?: string) => {
    await showSidebar()
    await evaluate(window, `document.querySelector('[aria-label="New work in Default"]').click()`)
    await waitFor(window, `document.querySelectorAll('.folder-menu [role="menuitem"]').length === 3`)
    const items = await evaluate(window, `Array.from(document.querySelectorAll('.folder-menu [role="menuitem"]')).map(node => node.textContent.trim())`)
    check(JSON.stringify(items) === JSON.stringify(['Open folder', 'Clone repository', 'Start from scratch']), `${label}: folder menu must have exactly the three requested actions`)
    bounded(await measure(window), '.folder-menu', label)
    if (action) await evaluate(window, `Array.from(document.querySelectorAll('.folder-menu [role="menuitem"]')).find(node => node.textContent.trim() === ${JSON.stringify(action)}).click()`)
  }
  const field = async (name: string, value: string) => {
    await evaluate(window, `(() => {
      const input = Array.from(document.querySelectorAll('.folder-dialog .dialog-field')).find(node => node.firstElementChild.textContent.trim() === ${JSON.stringify(name)}).querySelector('input');
      input.value = ${JSON.stringify(value)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
  }
  const dialogButton = async (text: string) => {
    await evaluate(window, `Array.from(document.querySelectorAll('.folder-dialog button')).find(node => node.textContent.trim() === ${JSON.stringify(text)}).click()`)
  }
  const queuePicker = async (value: string | null) => {
    await evaluate(window, `window.layoutFixture.queueFolderDirectories([${JSON.stringify(value)}])`)
  }
  const state = async (text: string) => {
    await waitFor(window, `document.querySelector('.clone-status strong')?.textContent === ${JSON.stringify(text)}`)
    const metrics = await measure(window)
    bounded(metrics, '.folder-dialog', `${label}-${text}`)
    documentChecks(metrics, `${label}-${text}`)
  }
  const openClone = async (name: string) => {
    await menu('Clone repository')
    await waitFor(window, `Boolean(document.querySelector('.folder-dialog'))`)
    await evaluate(window, `Array.from(document.querySelectorAll('.folder-dialog button')).find(node => node.textContent.trim() === 'Clone another repository')?.click()`)
    await field('Repository URL', 'https://example.invalid/synthetic/layout.git')
    if (desktop) {
      await queuePicker(folders.root)
      await dialogButton('Browse…')
      await waitFor(window, `document.querySelector('.folder-dialog input[placeholder="Absolute folder path"]')?.value === ${JSON.stringify(folders.root)}`)
    } else await field('Parent folder', folders.root)
    await field('New folder name', name)
    bounded(await measure(window), '.folder-dialog', `${label}-clone-form`)
  }
  const submitClone = async () => {
    await evaluate(window, `document.querySelector('.folder-dialog form').requestSubmit()`)
    await state('Cloning repository…')
  }

  await clickTab(window, 'Chat')
  await waitFor(window, `document.querySelectorAll('.folder-folder').length === ${folders.folders.length}`)
  await showSidebar()
  await evaluate(window, `Array.from(document.querySelectorAll('.folder-toggle[aria-expanded="false"]')).forEach(node => node.click())`)
  await waitFor(window, `document.querySelectorAll('.folder-session-row').length === ${sessions.length}`)
  await evaluate(window, `Array.from(document.querySelectorAll('.legacy-chats .session-select')).find(node => node.title.includes(${JSON.stringify(sessionId)})).click()`)
  await waitFor(window, `document.querySelector('.chat-heading-copy')?.textContent.includes(${JSON.stringify(sessionId)})`)
  const previousRoute = await evaluate<string>(window, 'location.pathname')
  await menu()
  await evaluate(window, `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }))`)
  check(await evaluate(window, `document.activeElement.textContent.trim() === 'Start from scratch'`), `${label}: End must focus the final menu item`)
  await evaluate(window, `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', bubbles: true }))`)
  check(await evaluate(window, `document.activeElement.textContent.trim() === 'Clone repository'`), `${label}: ArrowUp must move menu focus`)
  await evaluate(window, `document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
  await waitFor(window, `!document.querySelector('.folder-menu')`)
  check(await evaluate(window, `document.activeElement.getAttribute('aria-label') === 'New work in Default'`), `${label}: Escape must close menu and return keyboard focus`)

  const empty = folders.folders.find((folder) => folder.id === folders.initialEmptyId)!
  const tree = folders.folders.find((folder) => folder.id === folders.treeId)!
  check(await evaluate(window, `Boolean(${group(empty.path)}?.querySelector('.folder-folder'))`), `${label}: an empty registered folder must remain visible`)
  check(await evaluate(window, `!${group(empty.path)}?.querySelector('.folder-conversations')`), `${label}: an empty folder must not create placeholder rows`)
  check(await evaluate(window, `!document.querySelector('.folders-sidebar').textContent.match(/No conversations yet|No unassociated conversations|Open a folder to keep|Fresh-context tasks appear here/)`), `${label}: sidebar must not repeat empty-state hints`)
  await evaluate(window, `${group(empty.path)}.querySelector('.folder-toggle').click()`)
  check(await evaluate(window, `!${group(empty.path)}?.querySelector('.folder-conversations')`), `${label}: collapse must hide empty folder contents`)
  await evaluate(window, `${group(empty.path)}.querySelector('.folder-toggle').click()`)
  await evaluate(window, `${group(tree.path)}.querySelector('.lineage-toggle').click()`)
  await waitFor(window, `${group(tree.path)}?.querySelectorAll('.folder-session-row').length === 1`)
  await evaluate(window, `${group(tree.path)}.querySelector('.lineage-toggle').click()`)
  await waitFor(window, `${group(tree.path)}?.querySelectorAll('.folder-session-row').length === 2`)
  check(await evaluate(window, `(() => {
    const rows = ${group(tree.path)}.querySelectorAll('.folder-session-row');
    return parseFloat(rows[1].style.paddingLeft) > parseFloat(rows[0].style.paddingLeft)
      && rows[1].querySelector('.session-select').title.includes('Parent: web:chat-fixture-88');
  })()`), `${label}: physical parent/child lineage must be retained inside folder grouping`)
  check(await evaluate(window, `document.querySelectorAll('.legacy-chats .folder-session-row').length === 88`), `${label}: legacy Chats must retain all unassociated sessions`)
  check(await evaluate(window, `(() => {
    const name = ${folder(tree.path)}.querySelector('.tree-label');
    return name.scrollWidth > name.clientWidth && getComputedStyle(name).textOverflow === 'ellipsis';
  })()`), `${label}: long folder names must ellipsize rather than expand the sidebar`)
  await scrollProof(window, '.project-groups')

  const openedPath = join(folders.root, `Opened folder ${width}`)
  const openFolder = async () => {
    if (desktop) await queuePicker(openedPath)
    await menu('Open folder')
    if (!desktop) {
      await waitFor(window, `Boolean(document.querySelector('.folder-dialog'))`)
      await field('Folder path', openedPath)
      await dialogButton('Open folder')
    }
    await waitFor(window, `${folder(openedPath)} !== undefined && !document.querySelector('.folder-dialog')`)
  }
  const createdBeforeOpen = folders.createdSessions.length
  await openFolder()
  await openFolder()
  check(await evaluate(window, `Array.from(document.querySelectorAll('.folder-folder')).filter(node => node.title === ${JSON.stringify(openedPath)}).length === 1`), `${label}: repeated folder registration must not duplicate the row`)
  check(folders.createdSessions.length === createdBeforeOpen, `${label}: opening a folder must not create a conversation`)
  check(await evaluate(window, 'location.pathname') === previousRoute, `${label}: opening a folder must preserve the current Chat`)
  if (desktop) {
    const registrations = folders.registrations.length
    await queuePicker(null)
    await menu('Open folder')
    await waitFor(window, `!document.querySelector('.folder-dialog') && !document.querySelector('.folder-menu')`)
    check(folders.registrations.length === registrations, `${label}: native picker cancellation must not register a folder`)
  }

  await menu('Start from scratch')
  await waitFor(window, `location.pathname !== ${JSON.stringify(previousRoute)} && Boolean(document.querySelector('.composer-input textarea'))`)
  check(folders.createdSessions.length === createdBeforeOpen, `${label}: Scratch must not create a folder-bound conversation`)
  await showSidebar()
  await evaluate(window, `${group(openedPath)}.querySelector('.folder-add').click()`)
  await waitFor(window, `document.querySelector('.folder-session-row.active .session-select')?.title.includes('web:chat-folder-fixture-')`)
  const created = folders.createdSessions.at(-1)!
  const opened = folders.folders.find((folder) => folder.path === openedPath)!
  check(created.folderId === opened.id, `${label}: folder + must bind the new conversation on the server`)
  check(await evaluate(window, `decodeURIComponent(location.pathname).endsWith(${JSON.stringify(created.sessionId)})`), `${label}: folder + must select the server-returned conversation`)
  check(sessions.find((session) => session.sessionId === created.sessionId)?.folderId === opened.id, `${label}: graph refresh must retain the server folder association`)

  folders.nextClone = 'succeeded'
  await openClone(`cloned-${width}`)
  const createdBeforeClone = folders.createdSessions.length
  await submitClone()
  await state('Repository cloned')
  const cloned = folders.operations.get(folders.cloneInputs.at(-1)!.operationId)!
  check(cloned.folder !== undefined, `${label}: successful clone must register its folder`)
  await dialogButton('Done')
  await waitFor(window, `!document.querySelector('.folder-dialog') && ${folder(cloned.destination)} !== undefined`)
  check(folders.createdSessions.length === createdBeforeClone, `${label}: clone success must not automatically create or send a conversation`)

  if (width === 900) {
    folders.nextClone = 'failed'
    await openClone('failed-900')
    await submitClone()
    await state('Clone failed')
    check(await evaluate(window, `document.querySelector('.clone-status')?.textContent.includes('partial checkout') && Boolean(document.querySelector('.folder-error[role="alert"]'))`), `${label}: clone failure must preserve safe recovery guidance`)
    folders.nextClone = 'succeeded'
    await field('New folder name', 'retry-900')
    await dialogButton('Retry clone')
    await state('Repository cloned')
    await dialogButton('Done')
    await waitFor(window, `!document.querySelector('.folder-dialog')`)

    folders.nextClone = 'running'
    await openClone('cancel-900')
    await submitClone()
    const cancelId = folders.cloneInputs.at(-1)!.operationId
    await dialogButton('Cancel clone')
    await state('Clone cancelled')
    check(folders.cancelled.has(cancelId), `${label}: Cancel clone must DELETE the active operation`)
    await dialogButton('Cancel')
    await waitFor(window, `!document.querySelector('.folder-dialog')`)

    for (const trigger of ['escape', 'deactivate'] as const) {
      await openClone(`failed-cancel-${trigger}-900`)
      folders.nextCancellation = 'failed'
      await submitClone()
      const failedCancelId = folders.cloneInputs.at(-1)!.operationId
      if (trigger === 'escape') {
        await evaluate(window, `document.querySelector('.folder-dialog').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
        await state('Clone failed')
        check(await evaluate(window, `Boolean(document.querySelector('.folder-dialog')) && document.querySelector('.clone-status')?.textContent.includes('partial checkout')`), `${label}: failed cancellation must retain modal recovery guidance`)
      }
      await clickTab(window, 'Settings')
      await waitForTab(window, 'Settings')
      check(folders.operations.get(failedCancelId)?.state === 'failed', `${label}: ${trigger} cancellation must preserve its terminal failure`)
      await clickTab(window, 'Chat')
      await waitForTab(window, 'Chat')
      await showSidebar()
      await waitFor(window, `Array.from(document.querySelectorAll('.sidebar-error button')).some(node => node.textContent.trim() === 'Review clone')`)
      await evaluate(window, `Array.from(document.querySelectorAll('.sidebar-error button')).find(node => node.textContent.trim() === 'Review clone').click()`)
      await state('Clone failed')
      check(await evaluate(window, `document.querySelector('.checkout-path')?.textContent === ${JSON.stringify(folders.operations.get(failedCancelId)!.destination)}`), `${label}: Review clone must recover the ${trigger} cancellation's checkout`)
      await dialogButton('Cancel')
      await waitFor(window, `!document.querySelector('.folder-dialog')`)
    }

    await openClone('hide-before-ack-900')
    folders.holdNextAcknowledgement = true
    await evaluate(window, `document.querySelector('.folder-dialog form').requestSubmit()`)
    await state('Starting clone…')
    const hiddenId = folders.cloneInputs.at(-1)!.operationId
    try {
      await evaluate(window, `document.querySelector('.folder-dialog').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`)
      await waitFor(window, `!document.querySelector('.folder-dialog')`)
      check(folders.cancelled.has(hiddenId), `${label}: hiding a starting clone must cancel before POST acknowledgement`)
    } finally { folders.acknowledgements.get(hiddenId)?.() }

    await openClone('deactivate-before-ack-900')
    folders.holdNextAcknowledgement = true
    await evaluate(window, `document.querySelector('.folder-dialog form').requestSubmit()`)
    await state('Starting clone…')
    const deactivatedId = folders.cloneInputs.at(-1)!.operationId
    try {
      await clickTab(window, 'Settings')
      await waitForTab(window, 'Settings')
      check(folders.cancelled.has(deactivatedId), `${label}: cached Chat deactivation must cancel an unacknowledged clone`)
      check(await evaluate(window, `!document.querySelector('.folder-dialog') && !document.querySelector('.folder-menu')`), `${label}: navigation must remove teleported folder surfaces`)
    } finally { folders.acknowledgements.get(deactivatedId)?.() }
    await clickTab(window, 'Chat')
    await waitForTab(window, 'Chat')
  }
  await showSidebar()
  await evaluate(window, `Array.from(document.querySelectorAll('.folder-toggle[aria-expanded="false"]')).forEach(node => node.click())`)
  await evaluate(window, `Array.from(document.querySelectorAll('.legacy-chats .session-select')).find(node => node.title.includes(${JSON.stringify(sessionId)})).click()`)
  await waitFor(window, `document.querySelector('.chat-heading-copy')?.textContent.includes(${JSON.stringify(sessionId)})`)
  const metrics = await measure(window)
  report(`${label}-complete`, metrics)
  chatChecks(metrics, `${label}-complete`, width < 700, selectedModel)
  check(implicitPaidRequests === 0, `${label}: folder operations must never issue an implicit model/Chat POST`)
  const nativePickerCalls = desktop ? await evaluate<number>(window, 'window.layoutFixture.folderPickerCalls()') : 0
  check(!desktop || nativePickerCalls >= 4, `${label}: native folder picker must be exercised for open, reopen, cancellation, and clone target`)
  console.log(`LAYOUT_FOLDERS ${JSON.stringify({ width, folders: folders.folders.length, graphSessions: sessions.length, treeChildren: 2, nativePickerCalls, implicitPaidRequests })}`)
}

async function scrollProof(window: BrowserWindow, selector: string): Promise<void> {
  const result = await evaluate<{ top: number; documentY: number }>(window, `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    node.scrollTop = 0; node.scrollTop = 100;
    return { top: node.scrollTop, documentY: window.scrollY };
  })()`)
  check(result.top > 0 && result.documentY === 0, `${selector}: internal scrolling must move content without scrolling document`)
}

async function runViewport(origin: string, width: number, height: number, desktop: boolean): Promise<void> {
  folders.reset()
  sessionConfigs.clear()
  selectedModel = initialModel
  selectedProvider = 'copilot'
  providerReady = true
  const isolated = session.fromPartition(`layout-${width}-${height}-${desktop}`, { cache: false })
  isolated.webRequest.onBeforeRequest((details, callback) => {
    const allowed = details.url.startsWith(`${origin}/`)
    if (!allowed) blockedRequests.push(new URL(details.url).origin)
    callback({ cancel: !allowed })
  })
  isolated.setPermissionRequestHandler((_webContents, _permission, callback) => callback(false))
  const window = new BrowserWindow({
    show: false, frame: false, width, height, useContentSize: true,
    webPreferences: {
      session: isolated, contextIsolation: true, sandbox: true, nodeIntegration: false,
      // Keep animation frames painting without ever showing a native window.
      backgroundThrottling: false, offscreen: true,
      ...(desktop ? {
        preload: join(directory, 'layout-preload.cjs'),
        additionalArguments: [`--layout-api-base=${origin}`],
      } : {}),
    },
  })
  ownedWindows.add(window)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith(`${origin}/`)) event.preventDefault()
  })
  window.webContents.on('render-process-gone', (_event, details) => failures.push(`Renderer exited: ${details.reason}`))
  try {
    await window.loadURL(origin)
    window.webContents.enableDeviceEmulation({
      screenPosition: 'desktop',
      screenSize: { width, height },
      viewPosition: { x: 0, y: 0 },
      viewSize: { width, height },
      deviceScaleFactor: 1,
      scale: 1,
    })
    await waitFor(window, `document.querySelectorAll('.folder-folder').length === 2 && document.querySelectorAll('.legacy-chats .folder-session-row').length === 88`)
    await evaluate(window, `Array.from(document.querySelectorAll('.folder-toggle[aria-expanded="false"]')).forEach(node => node.click()); document.querySelector('.legacy-chats .session-select').click()`)
    await waitFor(window, `document.querySelectorAll('.chat-bubble').length === 72 && document.querySelector('[aria-label="Choose model"]')?.disabled === false`)
    await evaluate(window, `(() => {
      const point = { clientX: innerWidth - 1, clientY: innerHeight - 1, bubbles: true };
      window.dispatchEvent(new PointerEvent('pointermove', point));
      window.dispatchEvent(new MouseEvent('mousemove', point));
    })()`)
    await waitFor(window, `(() => {
      const glow = document.querySelector('.mouse-glow')?.getBoundingClientRect();
      return glow && Math.abs((glow.left + glow.right) / 2 - (innerWidth - 1)) < 1
        && Math.abs((glow.top + glow.bottom) / 2 - (innerHeight - 1)) < 1;
    })()`).catch(async (error: unknown) => {
      report(`${width}x${height}-pointer-timeout`, await measure(window))
      throw error
    })
    const mobile = width < 600
    const label = `${desktop ? 'desktop' : 'web'}-${width}x${height}`
    let metrics = await measure(window)
    check(metrics.viewport.width === width && metrics.viewport.height === height, `${label}: CSS viewport did not match requested size`)
    check(metrics.desktop === desktop, `${label}: wrong bootstrap path`)
    const glow = box(metrics, '.mouse-glow')
    check(glow.right > width && glow.bottom > height, `${label}: pointer edge must exercise decorative overflow rather than a stationary glow`)
    report(`${label}-chat-pointer-edge`, metrics)
    chatChecks(metrics, `${label}-chat`, mobile)
    await scrollProof(window, '.chat-messages')
    if (!mobile) await scrollProof(window, '.project-groups')

    await evaluate(window, `(() => {
      const textarea = document.querySelector('.composer-input textarea');
      textarea.value = Array.from({ length: 30 }, (_, i) => 'Synthetic draft line ' + i).join('\\n');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await waitFor(window, `document.querySelector('.composer-send')?.disabled === false`)
    metrics = await measure(window)
    report(`${label}-long-draft`, metrics)
    chatChecks(metrics, `${label}-long-draft`, mobile)
    const textarea = box(metrics, '.composer-input textarea')
    check(textarea.scrollHeight > textarea.clientHeight && ['auto', 'scroll'].includes(textarea.overflowY), `${label}: long textarea must scroll internally`)

    await evaluate(window, `(() => {
      const textarea = document.querySelector('.composer-input textarea');
      textarea.value = ''; textarea.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.diagnosis-toggle').click();
    })()`)
    await waitFor(window, `document.querySelector('.diagnosis-toggle')?.getAttribute('aria-pressed') === 'true'`)
    await evaluate(window, `Array.from(document.querySelectorAll('.diagnosis-views button')).find(button => button.textContent.startsWith('Tools')).click()`)
    metrics = await measure(window)
    report(`${label}-tools-open`, metrics)
    documentChecks(metrics, `${label}-tools-open`)
    bounded(metrics, '.session-diagnosis', `${label}-tools-open`)
    check(box(metrics, '.composer-send').width === 0, `${label}: diagnosis must hide the conversation composer`)
    await evaluate(window, `document.querySelector('.diagnosis-toggle').click()`)
    await waitFor(window, `document.querySelector('.diagnosis-toggle')?.getAttribute('aria-pressed') === 'false'`)
    metrics = await measure(window)
    report(`${label}-tools-closed`, metrics)
    chatChecks(metrics, `${label}-tools-closed`, mobile)

    const modelSelector = '.chat-composer [aria-label="Choose model"]'
    const draft = 'Synthetic unsent draft\nMust survive model saves and provider settings.'
    await evaluate(window, `(() => {
      const input = document.querySelector('.composer-input textarea');
      window.layoutDraftInput = input;
      input.dataset.layoutRetained = 'true';
      input.value = ${JSON.stringify(draft)};
      input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    const draftRetained = () => evaluate<boolean>(window, `(() => {
      const input = document.querySelector('.composer-input textarea');
      return input === window.layoutDraftInput && input?.dataset.layoutRetained === 'true' && input.value === ${JSON.stringify(draft)};
    })()`)
    const chatUrl = await evaluate<string>(window, 'location.pathname + location.search + location.hash')
    const saveCount = saves.length
    const chooseModel = async (model: string) => {
      await evaluate(window, `document.querySelector(${JSON.stringify(modelSelector)}).click()`)
      await evaluate(window, `document.querySelector('.model-menu-model').click()`)
      await waitFor(window, `!!document.querySelector('.model-search')`)
      await evaluate(window, `document.querySelector(${JSON.stringify(`.model-option[title="${model}"]`)}).click()`)
      await waitFor(window, `!document.querySelector('.composer-popover') && document.querySelector(${JSON.stringify(modelSelector)}).title.includes(${JSON.stringify(model)})`)
    }
    const chooseEffort = async (label: string) => {
      await evaluate(window, `document.querySelector(${JSON.stringify(modelSelector)}).click()`)
      await evaluate(window, `document.querySelector('.model-menu-effort').click()`)
      await waitFor(window, `!!document.querySelector('.effort-option')`)
      await evaluate(window, `Array.from(document.querySelectorAll('.effort-option')).find(button => button.querySelector('.setting-option-copy > span').textContent.trim() === ${JSON.stringify(label)}).click()`)
    }
    const patchesBeforeModel = sessionPatches.length
    await chooseModel(alternateModel)
    check(saves.length === saveCount && selectedModel === initialModel, `${label}: conversation model overrides must not change App provider defaults`)
    check(sessionPatches.length === patchesBeforeModel, `${label}: next-turn model selection must remain local until admission`)
    check(await draftRetained(), `${label}: model selection lost draft or textarea identity`)

    let finishSave!: () => void
    settingsGate = new Promise<void>(done => { finishSave = done })
    await chooseEffort('High')
    try {
      await waitFor(window, `document.querySelector(${JSON.stringify(modelSelector)})?.getAttribute('aria-busy') === 'true'`)
      check(await draftRetained(), `${label}: pending session settings lost the unsent draft`)
    } finally { finishSave() }
    await waitFor(window, `document.querySelector(${JSON.stringify(modelSelector)})?.getAttribute('aria-busy') !== 'true' && document.querySelector('.model-effort').textContent.includes('High')`)
    assert.deepEqual(sessionPatches.at(-1), { sessionId, patch: { thinking: { type: 'enabled' }, reasoningEffort: 'high' } })
    assert.deepEqual(sessionConfigs.get(sessionId), { thinking: { type: 'enabled' }, reasoningEffort: 'high' })
    rejectSettings = true
    await chooseEffort('Low')
    await waitFor(window, `!!document.querySelector('.composer-error') && document.querySelector(${JSON.stringify(modelSelector)})?.getAttribute('aria-busy') !== 'true'`)
    check(await evaluate(window, `document.querySelector('.model-effort').textContent.includes('High')`), `${label}: rejected session settings must retain accepted effort`)
    check(sessionConfigs.get(sessionId)?.reasoningEffort === 'high', `${label}: rejection changed persisted session settings`)
    check(await draftRetained(), `${label}: rejected session settings lost the draft`)
    await chooseEffort('Default')
    await waitFor(window, `!document.querySelector('.composer-error') && document.querySelector(${JSON.stringify(modelSelector)})?.getAttribute('aria-busy') !== 'true'`)

    await clickTab(window, 'Settings')
    await waitForTab(window, 'Settings')
    await waitFor(window, `Boolean(document.querySelector('.provider-setup')) && !document.querySelector('.chat-workspace')`)
    check(await evaluate(window, `location.pathname === '/settings'`), `${label}: Settings tab must navigate to /settings`)
    check(await evaluate(window, `!window.layoutDraftInput.isConnected && window.layoutDraftInput.value === ${JSON.stringify(draft)}`), `${label}: KeepAlive must detach, not discard, Chat's textarea`)
    metrics = await measure(window)
    report(`${label}-providers`, metrics)
    documentChecks(metrics, `${label}-providers`)
    check(['auto', 'scroll'].includes(box(metrics, '.route-content').overflowY), `${label}: Providers must use normal route scrolling`)

    check(await evaluate(window, `!Array.from(document.querySelectorAll('[aria-label="Choose model"]')).some(node => node.getClientRects().length)`), `${label}: App provider settings must not expose a global conversation model picker`)
    await clickTab(window, 'Chat')
    await waitForTab(window, 'Chat')
    await waitFor(window, `Boolean(document.querySelector('.composer-input textarea'))`)
    check(await draftRetained(), `${label}: Chat tab return lost draft or textarea identity`)
    check(await evaluate(window, `document.querySelector(${JSON.stringify(modelSelector)}).title.includes(${JSON.stringify(alternateModel)})`), `${label}: cached conversation must retain its own next-turn model`)
    check(await evaluate(window, 'location.pathname + location.search + location.hash') === chatUrl, `${label}: Chat tab must return to the remembered session URL`)

    await clickTab(window, 'Settings')
    await waitFor(window, `Boolean(document.querySelector('.provider-setup'))`)
    await evaluate(window, `document.querySelector('[data-provider="copilot"] button').click()`)
    await waitFor(window, `document.querySelector('.setup-title')?.textContent.includes('GitHub Copilot settings')`)
    await evaluate(window, `Array.from(document.querySelectorAll('.provider-setup button')).find(node => node.textContent.trim() === 'Sign in with GitHub Copilot').click()`)
    await waitFor(window, `Boolean(document.querySelector('.device-panel'))`)
    const pendingLogin = activeLogin
    check(Boolean(pendingLogin), `${label}: synthetic Copilot login must be pending before navigation`)
    await clickTab(window, 'Chat')
    await waitForTab(window, 'Chat')
    check(Boolean(pendingLogin && cancelledLogins.has(pendingLogin)), `${label}: leaving Providers must cancel the pending login`)
    check(await draftRetained(), `${label}: leaving pending Copilot login lost Chat draft`)

    await clickTab(window, 'Settings')
    await waitFor(window, `Boolean(document.querySelector('.provider-setup'))`)
    check(await evaluate(window, `!document.querySelector('.device-panel')`), `${label}: Providers must remount without stale pending login`)
    await evaluate(window, `Array.from(document.querySelectorAll('.provider-setup button')).find(node => node.textContent.trim() === 'Back to workspace').click()`)
    await waitForTab(window, 'Chat')
    await waitFor(window, `!document.querySelector('.provider-setup') && Boolean(document.querySelector('.composer-input textarea'))`)
    check(await draftRetained(), `${label}: closing provider settings lost the chat draft`)
    check(await evaluate(window, 'location.pathname + location.search + location.hash') === chatUrl, `${label}: Back to workspace must restore the remembered session URL`)
    metrics = await measure(window)
    report(`${label}-draft-retained`, metrics)
    chatChecks(metrics, `${label}-draft-retained`, mobile, alternateModel)
    console.log(`LAYOUT_INTERACTIONS ${JSON.stringify({ label, draftRetained: await draftRetained(), conversationModel: alternateModel, sessionSettings: true, globalModelUnchanged: selectedModel === initialModel, loginCancelled: Boolean(pendingLogin && cancelledLogins.has(pendingLogin)) })}`)

    if (desktop) {
      await evaluate(window, `document.querySelector('[aria-label="Maximize window"]').click()`)
      await waitFor(window, `Boolean(document.querySelector('[aria-label="Restore window"]'))`)
      await evaluate(window, `window.layoutFixture.publishWindowState(false)`)
      await waitFor(window, `Boolean(document.querySelector('[aria-label="Maximize window"]'))`)
      await evaluate(window, `document.querySelector('[aria-label="Minimize window"]').click(); document.querySelector('[aria-label="Close window"]').click()`)
      const calls = await evaluate(window, 'window.layoutFixture.windowCalls()')
      check(JSON.stringify(calls) === JSON.stringify(['toggleMaximize', 'minimize', 'close']), `${label}: window-control mock interactions did not arrive`)
      check(!window.isVisible() && !window.isMinimized(), `${label}: mock controls must not affect native window`)
    } else check(metrics.boxes['.window-controls'] === null, `${label}: browser must not render native window controls`)

    await clickTab(window, 'Settings')
    await waitFor(window, `Boolean(document.querySelector('.provider-setup'))`)
    await waitFor(window, `Boolean(document.querySelector('.provider-setup form'))`)
    await evaluate(window, `(() => {
      const provider = document.querySelector('.provider-setup form select');
      provider.value = 'custom';
      provider.dispatchEvent(new Event('change', { bubbles: true }));
    })()`)
    await waitFor(window, `Boolean(document.querySelector('.provider-setup input[placeholder="local"]'))`)
    const readsBeforeProviderSave = providerReads
    await evaluate(window, `(() => {
      const form = document.querySelector('.provider-setup form');
      const values = [
        [form.querySelector('input[placeholder="local"]'), 'layout-provider'],
        [form.querySelector('input[placeholder="Model ID from your provider"]'), ${JSON.stringify(initialModel)}],
        [form.querySelector('input[type="url"]'), ${JSON.stringify(`${origin}/synthetic/v1`)}]
      ];
      for (const [input, value] of values) {
        input.value = value;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }
    })()`)
    await evaluate(window, `document.querySelector('.provider-setup form').requestSubmit()`)
    await waitForTab(window, 'Chat')
    await waitFor(window, `Boolean(document.querySelector('.composer-input textarea')) && !document.querySelector(${JSON.stringify(modelSelector)})?.disabled`)
    check(providerReads > readsBeforeProviderSave, `${label}: successful ProviderSetup save must refresh App's provider source`)
    check(selectedProvider === 'layout-provider', `${label}: keyless synthetic provider form was not saved`)
    check(await draftRetained(), `${label}: successful provider save lost cached Chat draft`)
    check(await evaluate(window, 'location.pathname + location.search + location.hash') === chatUrl, `${label}: successful provider save must restore remembered Chat URL`)
    check(await evaluate(window, `document.querySelector(${JSON.stringify(modelSelector)})?.title.includes(${JSON.stringify(alternateModel)})`), `${label}: provider configuration must not overwrite the cached conversation's model`)

    await evaluate(window, `Array.from(document.querySelectorAll('.tab')).find(node => node.textContent.trim() === 'Agents').click()`)
    await waitFor(window, `document.querySelectorAll('.agent-item').length === 40`)
    metrics = await measure(window)
    report(`${label}-agents`, metrics)
    documentChecks(metrics, `${label}-agents`)
    const route = box(metrics, '.route-content')
    check(['auto', 'scroll'].includes(route.overflowY) && route.scrollHeight > route.clientHeight, `${label}: non-chat .route-content must scroll`)
    await scrollProof(window, '.route-content')

    selectedProvider = 'copilot'
    selectedModel = initialModel
    await window.loadURL(`${origin}/providers`)
    await waitForTab(window, 'Settings')
    await waitFor(window, `Boolean(document.querySelector('.provider-setup'))`)
    check(await evaluate(window, `location.pathname === '/settings/providers' && !document.querySelector('.chat-workspace')`), `${label}: legacy /providers entry must render Settings, not Chat`)
    providersEntries += 1
    metrics = await measure(window)
    report(`${label}-direct-providers`, metrics)
    documentChecks(metrics, `${label}-direct-providers`)

    providerReady = false
    selectedProvider = 'openai'
    await window.loadURL(`${origin}/agents`)
    await waitFor(window, `document.querySelector('.setup-title')?.textContent.trim() === 'Connect a model provider'`)
    check(await evaluate(window, `!document.querySelector('.chat-workspace') && !document.querySelector('.agent-item')`), `${label}: missing-key startup must show onboarding, not a failed route`)
    onboardingGates += 1
    metrics = await measure(window)
    report(`${label}-onboarding-gate`, metrics)
    documentChecks(metrics, `${label}-onboarding-gate`)
    providerReady = true
    selectedProvider = 'copilot'
    await evaluate(window, `Array.from(document.querySelectorAll('.provider-setup button')).find(node => node.textContent.trim() === 'Recheck configuration').click()`)
    await waitFor(window, `document.querySelectorAll('.agent-item').length === 40 && !document.querySelector('.provider-setup')`)
    check(await evaluate(window, `location.pathname.startsWith('/projects/default/agents')`), `${label}: recovered startup gate must release the requested route`)
    onboardingRecoveries += 1
    metrics = await measure(window)
    report(`${label}-onboarding-recovered`, metrics)
    documentChecks(metrics, `${label}-onboarding-recovered`)
    await runFolders(window, width, desktop)
  } finally {
    ownedWindows.delete(window)
    window.destroy()
    await isolated.clearStorageData()
  }
}

async function main(): Promise<void> {
  const deadline = setTimeout(() => {
    console.log('LAYOUT_FAILURE fixture exceeded 115 seconds')
    for (const window of ownedWindows) window.destroy()
    live.close()
    app.exit(1)
  }, 115_000)

  try {
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    await app.whenReady()
    for (const [width, height, desktop] of [[1280, 800, true], [900, 600, true], [360, 740, false]] as const) {
      try { await runViewport(origin, width, height, desktop) }
      catch (error) { failures.push(`${width}x${height}: ${error instanceof Error ? error.message : String(error)}`) }
    }
    check(blockedRequests.length === 0, `App attempted non-fixture requests: ${[...new Set(blockedRequests)].join(', ')}`)
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error))
  } finally {
    clearTimeout(deadline)
    for (const window of ownedWindows) window.destroy()
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  }
  for (const failure of failures) console.log(`LAYOUT_FAILURE ${failure}`)
  console.log(`LAYOUT_RESULT ${JSON.stringify({ ok: failures.length === 0, failures: failures.length, viewports: 3, apiRoutes: apiRequests.size, successfulSetupWrites: saves.length, sessionSettingsWrites: sessionPatches.length - rejectedSettings, rejectedSessionSettings: rejectedSettings, cancelledLogins: cancelledLogins.size, providersEntries, onboardingGates, onboardingRecoveries, folderRegistrations: folders.registrations.length, folderSessions: folders.createdSessions.length, cloneStarts: folders.cloneInputs.length, cloneCancels: folders.cancelled.size, failedCancellations: folders.failedCancellations, implicitPaidRequests, externalRequests: blockedRequests.length })}`)
  app.exit(failures.length === 0 ? 0 : 1)
}

void main().catch((error: unknown) => {
  console.log(`LAYOUT_FAILURE fixture initialization: ${error instanceof Error ? error.message : String(error)}`)
  app.exit(1)
})
