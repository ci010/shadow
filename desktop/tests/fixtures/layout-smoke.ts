import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { extname, isAbsolute, join, relative, resolve } from 'node:path'
import { app, BrowserWindow, session } from 'electron'

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
let saveGate: Promise<void> | undefined
let rejectNextSave = false
let rejectedSaves = 0
const saves: unknown[] = []
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
const sessions = Array.from({ length: 90 }, (_, index) => ({
  sessionId: index === 0 ? sessionId : `web:chat-fixture-${index}`,
  title: `Synthetic session ${index} ${'long-title-'.repeat(16)}`,
  description: `Synthetic description ${'long-description-'.repeat(12)}`,
  current: `physical-fixture-${index}`,
}))
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
    const url = new URL(request.url!, 'http://127.0.0.1')
    const path = url.pathname
    const json = (data: unknown) => {
      response.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(data))
    }
    if (path.startsWith('/api/') || path.startsWith('/debug/')) apiRequests.add(`${request.method} ${path}`)
    if (path === '/api/provider/setup') {
      if (request.method === 'POST') {
        let body = ''
        for await (const chunk of request) body += chunk
        const input = JSON.parse(body) as { model: string; provider: string }
        saves.push(input)
        const gate = saveGate
        saveGate = undefined
        await gate
        if (rejectNextSave) {
          rejectNextSave = false
          rejectedSaves += 1
          response.writeHead(503, { 'Content-Type': 'application/json' })
          response.end(JSON.stringify({ error: 'Synthetic provider rejection' }))
          return
        }
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
    else if (path === '/api/config') json({ agent: { provider: selectedProvider, model: selectedModel } })
    else if (path === '/api/sessions/graph') json({ sessions, nodes: [] })
    else if (path === '/api/sessions/stages') json({ stages: { [sessionId]: 'idle' } })
    else if (path === '/api/chat/session') json({ history, systemPrompt: prompt, tools })
    else if (path === `/api/sessions/${encodeURIComponent(sessionId)}`) json({ previousPhysicalId: null, messages: history })
    else if (path === '/api/chat/events') {
      response.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' })
      response.write(': synthetic fixture connected\n\n')
    } else if (path === '/debug/agent-types') {
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
  '.sessions-sidebar', '.session-list', '.chat-panel', '.chat-header',
  '.chat-messages', '.chat-composer', '.composer-input textarea',
  '.composer-toolbar', '.composer-model', '.composer-model select', '.composer-send',
  '.right-pane', '.right-pane-toggle', '.window-controls', '.desktop-window-title',
  '.mouse-glow', '.mouse-glow-layer',
]

async function evaluate<T>(window: BrowserWindow, script: string): Promise<T> {
  assert.ok(ownedWindows.has(window) && !window.isVisible(), 'Only hidden test-owned windows may be inspected')
  return window.webContents.executeJavaScript(script) as Promise<T>
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
        overflowX: style.overflowX, overflowY: style.overflowY, display: style.display
      };
    }
    const send = document.querySelector('.composer-send');
    const bounds = send?.getBoundingClientRect();
    const hit = bounds && document.elementFromPoint((bounds.left + bounds.right)/2, (bounds.top + bounds.bottom)/2);
    return {
      viewport: { width: innerWidth, height: innerHeight }, boxes,
      title: document.title, frames: document.querySelectorAll('.desktop-frame').length,
      sessionCount: document.querySelectorAll('.chat-session-row').length,
      messageCount: document.querySelectorAll('.chat-bubble').length,
      model: document.querySelector('.composer-model select')?.value ?? null,
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
  bounded(metrics, '.runtime-status-bar', label)
  if (metrics.desktop) bounded(metrics, '.window-controls', label)
  check(!metrics.legacyProviderButton, `${label}: legacy .provider-settings-btn must be removed`)
  check(metrics.activeTabs.length === 1, `${label}: exactly one top-level tab must have aria-current=page`)
}
function chatChecks(metrics: Measurements, label: string, mobile: boolean, toolsOpen: boolean, expectedModel = initialModel): void {
  documentChecks(metrics, label)
  for (const selector of ['.chat-workspace', '.chat-panel', '.chat-header', '.chat-messages', '.chat-composer', '.composer-input textarea', '.composer-toolbar', '.composer-model', '.composer-model select', '.composer-send']) bounded(metrics, selector, label)
  if (!mobile || !toolsOpen) check(metrics.sendUncovered, `${label}: .composer-send is covered or outside hit-test viewport; hit=${metrics.sendHitTarget}`)
  check(metrics.sessionCount === 90, `${label}: synthetic session list did not mount`)
  check(metrics.messageCount === 72, `${label}: synthetic history did not mount`)
  check(metrics.model === expectedModel, `${label}: global model not injected into composer`)
  const messages = box(metrics, '.chat-messages')
  check(['auto', 'scroll'].includes(messages.overflowY) && messages.scrollHeight > messages.clientHeight,
    `${label}: .chat-messages must scroll internally`)
  const composer = box(metrics, '.chat-composer')
  const textarea = box(metrics, '.composer-input textarea')
  const toolbar = box(metrics, '.composer-toolbar')
  const model = box(metrics, '.composer-model')
  const send = box(metrics, '.composer-send')
  check(messages.bottom <= composer.top + 1, `${label}: .chat-messages overlaps .chat-composer`)
  check(textarea.bottom <= toolbar.top + 1, `${label}: textarea must occupy its own row above .composer-toolbar`)
  check(Math.abs(textarea.width - toolbar.width) <= 2, `${label}: textarea must fill the composer width`)
  check(model.right <= send.left + 1 && Math.abs(send.right - toolbar.right) <= 2, `${label}: model-left / Send-right toolbar alignment`)
  if (!mobile) {
    const sidebar = box(metrics, '.sessions-sidebar')
    const list = box(metrics, '.session-list')
    check(Math.abs(sidebar.left) <= 1, `${label}: .sessions-sidebar must touch the left edge`)
    check(Math.abs(sidebar.top - box(metrics, '.runtime-status-bar').bottom) <= 1, `${label}: .sessions-sidebar must start immediately below chrome`)
    check(['auto', 'scroll'].includes(list.overflowY) && list.scrollHeight > list.clientHeight,
      `${label}: .session-list must scroll internally`)
    check(Math.abs(box(metrics, '.desktop-title-bar').height - 44) <= 1, `${label}: title bar should be 44px`)
    check(Math.abs(box(metrics, '.runtime-status-bar').height - 30) <= 1, `${label}: status bar should be 30px`)
  }
  if (toolsOpen) {
    bounded(metrics, '.right-pane', label)
    bounded(metrics, '.right-pane-toggle', label)
    if (!mobile) check(box(metrics, '.chat-panel').right <= box(metrics, '.right-pane').left + 1, `${label}: tools pane overlaps chat panel`)
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

async function scrollProof(window: BrowserWindow, selector: string): Promise<void> {
  const result = await evaluate<{ top: number; documentY: number }>(window, `(() => {
    const node = document.querySelector(${JSON.stringify(selector)});
    node.scrollTop = 0; node.scrollTop = 100;
    return { top: node.scrollTop, documentY: window.scrollY };
  })()`)
  check(result.top > 0 && result.documentY === 0, `${selector}: internal scrolling must move content without scrolling document`)
}

async function runViewport(origin: string, width: number, height: number, desktop: boolean): Promise<void> {
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
    await waitFor(window, `document.querySelectorAll('.chat-session-row').length === 90`)
    await evaluate(window, `document.querySelector('.chat-session-row').click()`)
    await waitFor(window, `document.querySelectorAll('.chat-bubble').length === 72 && document.querySelector('.composer-model select')?.disabled === false`)
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
    chatChecks(metrics, `${label}-chat`, mobile, false)
    await scrollProof(window, '.chat-messages')
    if (!mobile) await scrollProof(window, '.session-list')

    await evaluate(window, `(() => {
      const textarea = document.querySelector('.composer-input textarea');
      textarea.value = Array.from({ length: 30 }, (_, i) => 'Synthetic draft line ' + i).join('\\n');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await waitFor(window, `document.querySelector('.composer-send')?.disabled === false`)
    metrics = await measure(window)
    report(`${label}-long-draft`, metrics)
    chatChecks(metrics, `${label}-long-draft`, mobile, false)
    const textarea = box(metrics, '.composer-input textarea')
    check(textarea.scrollHeight > textarea.clientHeight && ['auto', 'scroll'].includes(textarea.overflowY), `${label}: long textarea must scroll internally`)

    await evaluate(window, `(() => {
      const textarea = document.querySelector('.composer-input textarea');
      textarea.value = ''; textarea.dispatchEvent(new Event('input', { bubbles: true }));
      document.querySelector('.right-pane-toggle').click();
    })()`)
    await waitFor(window, `document.querySelector('.right-pane-toggle')?.getAttribute('aria-expanded') === 'true'`)
    metrics = await measure(window)
    report(`${label}-tools-open`, metrics)
    chatChecks(metrics, `${label}-tools-open`, mobile, true)
    await evaluate(window, `document.querySelector('.right-pane-toggle').click()`)
    await waitFor(window, `document.querySelector('.right-pane-toggle')?.getAttribute('aria-expanded') === 'false'`)
    metrics = await measure(window)
    report(`${label}-tools-closed`, metrics)
    chatChecks(metrics, `${label}-tools-closed`, mobile, false)

    const modelSelector = '.chat-composer select[aria-label="Model for new turns"]'
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
    const readsBeforeSave = providerReads
    let finishSave!: () => void
    saveGate = new Promise<void>((done) => { finishSave = done })
    await evaluate(window, `(() => {
      const select = document.querySelector(${JSON.stringify(modelSelector)});
      select.value = ${JSON.stringify(alternateModel)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`)
    try {
      await waitFor(window, `document.querySelector(${JSON.stringify(modelSelector)})?.disabled === true`)
      check(await evaluate(window, `document.querySelector(${JSON.stringify(modelSelector)})?.title === ${JSON.stringify(initialModel)}`), `${label}: model must not commit before server acceptance`)
      check(await draftRetained(), `${label}: draft or textarea identity lost during pending model save`)
    } finally {
      finishSave()
    }
    await waitFor(window, `document.querySelector(${JSON.stringify(modelSelector)})?.value === ${JSON.stringify(alternateModel)} && !document.querySelector(${JSON.stringify(modelSelector)})?.disabled`)
    check(saves.length === saveCount + 1, `${label}: model selector must use global provider setup API`)
    const saved = saves.at(-1) as { provider?: string; model?: string } | undefined
    check(saved?.provider === 'copilot' && saved.model === alternateModel && Object.keys(saved).length === 2, `${label}: incorrect global model save payload`)
    check(providerReads > readsBeforeSave, `${label}: global model save must refresh provider status`)
    check(await draftRetained(), `${label}: draft or textarea identity lost after global model save/refresh`)

    await clickTab(window, 'Providers')
    await waitForTab(window, 'Providers')
    await waitFor(window, `Boolean(document.querySelector('.provider-setup')) && !document.querySelector('.chat-workspace')`)
    check(await evaluate(window, `location.pathname === '/providers'`), `${label}: Providers tab must navigate to /providers`)
    check(await evaluate(window, `!window.layoutDraftInput.isConnected && window.layoutDraftInput.value === ${JSON.stringify(draft)}`), `${label}: KeepAlive must detach, not discard, Chat's textarea`)
    metrics = await measure(window)
    report(`${label}-providers`, metrics)
    documentChecks(metrics, `${label}-providers`)
    check(['auto', 'scroll'].includes(box(metrics, '.route-content').overflowY), `${label}: Providers must use normal route scrolling`)

    await evaluate(window, `(() => {
      const select = document.querySelector('select[aria-label="Model for new turns"]');
      select.value = ${JSON.stringify(initialModel)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`)
    await waitFor(window, `document.querySelector('select[aria-label="Model for new turns"]')?.value === ${JSON.stringify(initialModel)} && !document.querySelector('select[aria-label="Model for new turns"]')?.disabled`)
    check(await evaluate(window, `location.pathname === '/providers' && Boolean(document.querySelector('.provider-setup'))`), `${label}: global model changes must not leave Providers`)
    await clickTab(window, 'Chat')
    await waitForTab(window, 'Chat')
    await waitFor(window, `Boolean(document.querySelector('.composer-input textarea'))`)
    check(await draftRetained(), `${label}: Chat tab return lost draft or textarea identity`)
    check(await evaluate(window, 'location.pathname + location.search + location.hash') === chatUrl, `${label}: Chat tab must return to the remembered session URL`)

    await clickTab(window, 'Providers')
    await waitFor(window, `Boolean(document.querySelector('.provider-setup'))`)
    await evaluate(window, `Array.from(document.querySelectorAll('.provider-setup button')).find(node => node.textContent.trim() === 'Sign in with GitHub Copilot').click()`)
    await waitFor(window, `Boolean(document.querySelector('.device-panel'))`)
    const pendingLogin = activeLogin
    check(Boolean(pendingLogin), `${label}: synthetic Copilot login must be pending before navigation`)
    await clickTab(window, 'Chat')
    await waitForTab(window, 'Chat')
    check(Boolean(pendingLogin && cancelledLogins.has(pendingLogin)), `${label}: leaving Providers must cancel the pending login`)
    check(await draftRetained(), `${label}: leaving pending Copilot login lost Chat draft`)

    await clickTab(window, 'Providers')
    await waitFor(window, `Boolean(document.querySelector('.provider-setup'))`)
    check(await evaluate(window, `!document.querySelector('.device-panel')`), `${label}: Providers must remount without stale pending login`)
    await evaluate(window, `Array.from(document.querySelectorAll('.provider-setup button')).find(node => node.textContent.trim() === 'Back to workspace').click()`)
    await waitForTab(window, 'Chat')
    await waitFor(window, `!document.querySelector('.provider-setup') && Boolean(document.querySelector('.composer-input textarea'))`)
    check(await draftRetained(), `${label}: closing provider settings lost the chat draft`)
    check(await evaluate(window, 'location.pathname + location.search + location.hash') === chatUrl, `${label}: Back to workspace must restore the remembered session URL`)
    metrics = await measure(window)
    report(`${label}-draft-retained`, metrics)
    chatChecks(metrics, `${label}-draft-retained`, mobile, false, initialModel)

    rejectNextSave = true
    await evaluate(window, `(() => {
      const select = document.querySelector(${JSON.stringify(modelSelector)});
      select.value = ${JSON.stringify(alternateModel)};
      select.dispatchEvent(new Event('change', { bubbles: true }));
    })()`)
    await waitFor(window, `Boolean(document.querySelector('.provider-error[role="alert"]')) && !document.querySelector(${JSON.stringify(modelSelector)})?.disabled`)
    check(await evaluate(window, `document.querySelector(${JSON.stringify(modelSelector)})?.value === ${JSON.stringify(initialModel)}`), `${label}: rejected model save must retain the previously accepted model`)
    check(selectedModel === initialModel, `${label}: rejected save changed synthetic backend model`)
    check(await draftRetained(), `${label}: rejected model save lost the chat draft`)
    console.log(`LAYOUT_INTERACTIONS ${JSON.stringify({ label, draftRetained: await draftRetained(), providerRefreshed: providerReads > readsBeforeSave, rejectedModelRetained: selectedModel === initialModel, loginCancelled: Boolean(pendingLogin && cancelledLogins.has(pendingLogin)) })}`)

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

    await clickTab(window, 'Providers')
    await waitFor(window, `Boolean(document.querySelector('.provider-setup'))`)
    await evaluate(window, `Array.from(document.querySelectorAll('.provider-setup .method-tabs button')).find(node => node.textContent.includes('API key')).click()`)
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
    check(await evaluate(window, `document.querySelector(${JSON.stringify(modelSelector)})?.value === ${JSON.stringify(initialModel)}`), `${label}: restored Chat must receive the provider's current model`)

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
    await waitForTab(window, 'Providers')
    await waitFor(window, `Boolean(document.querySelector('.provider-setup'))`)
    check(await evaluate(window, `location.pathname === '/providers' && !document.querySelector('.chat-workspace')`), `${label}: direct /providers entry must render the route, not Chat`)
    providersEntries += 1
    metrics = await measure(window)
    report(`${label}-direct-providers`, metrics)
    documentChecks(metrics, `${label}-direct-providers`)

    providerReady = false
    selectedProvider = 'openai'
    await window.loadURL(`${origin}/agents`)
    await waitFor(window, `document.querySelector('#provider-setup-title')?.textContent.trim() === 'Connect a model provider'`)
    check(await evaluate(window, `!document.querySelector('.chat-workspace') && !document.querySelector('.agent-item')`), `${label}: missing-key startup must show onboarding, not a failed route`)
    onboardingGates += 1
    metrics = await measure(window)
    report(`${label}-onboarding-gate`, metrics)
    documentChecks(metrics, `${label}-onboarding-gate`)
    providerReady = true
    selectedProvider = 'copilot'
    await evaluate(window, `Array.from(document.querySelectorAll('.provider-setup button')).find(node => node.textContent.trim() === 'Recheck configuration').click()`)
    await waitFor(window, `document.querySelectorAll('.agent-item').length === 40 && !document.querySelector('.provider-setup')`)
    check(await evaluate(window, `location.pathname.startsWith('/agents')`), `${label}: recovered startup gate must release the requested route`)
    onboardingRecoveries += 1
    metrics = await measure(window)
    report(`${label}-onboarding-recovered`, metrics)
    documentChecks(metrics, `${label}-onboarding-recovered`)
  } finally {
    ownedWindows.delete(window)
    window.destroy()
    await isolated.clearStorageData()
  }
}

async function main(): Promise<void> {
  const deadline = setTimeout(() => {
    console.log('LAYOUT_FAILURE fixture exceeded 85 seconds')
    for (const window of ownedWindows) window.destroy()
    app.exit(1)
  }, 85_000)

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
  console.log(`LAYOUT_RESULT ${JSON.stringify({ ok: failures.length === 0, failures: failures.length, viewports: 3, apiRoutes: apiRequests.size, successfulSetupWrites: saves.length - rejectedSaves, rejectedModelSaves: rejectedSaves, cancelledLogins: cancelledLogins.size, providersEntries, onboardingGates, onboardingRecoveries, externalRequests: blockedRequests.length })}`)
  app.exit(failures.length === 0 ? 0 : 1)
}

void main().catch((error: unknown) => {
  console.log(`LAYOUT_FAILURE fixture initialization: ${error instanceof Error ? error.message : String(error)}`)
  app.exit(1)
})
