// Test-only entry installed into a verified package copy. Never shipped as the production main.
const assert = require('node:assert/strict')
const { mkdirSync } = require('node:fs')
const { access } = require('node:fs/promises')
const { isAbsolute, join, relative, resolve, sep } = require('node:path')
const { fileURLToPath } = require('node:url')
const { app, BrowserWindow, ipcMain, session } = require('electron')

function argument(name) {
  const value = process.argv.find((item) => item.startsWith(`--${name}=`))?.slice(name.length + 3)
  assert.ok(value, `Missing acceptance argument ${name}`)
  return resolve(value)
}

const assets = argument('acceptance-assets')
const preload = argument('acceptance-preload')
const profile = argument('acceptance-profile')
const control = argument('acceptance-control')
const failures = []
let offlineFontStylesheets = 0
let window
let bootstrapReads = 0
let windowStateReads = 0
let finished = false
const initialState = Object.freeze({ version: 1, revision: 0, mode: null, step: 'choose-role' })

function safeRequestUrl(value) {
  try {
    const url = new URL(value)
    if (url.protocol === 'file:') return 'file://[path-redacted]'
    if (!['http:', 'https:', 'ws:', 'wss:'].includes(url.protocol)) return `${url.protocol}[redacted]`
    const path = url.pathname === '/css2' ? '/css2' : '/[path-redacted]'
    return `${url.origin}${path}${url.search ? '?[query-redacted]' : ''}${url.hash ? '#[fragment-redacted]' : ''}`.slice(0, 240)
  } catch { return '[invalid URL]' }
}

function diagnostic(value) {
  return String(value).replace(/(?:https?|file|wss?):\/\/[^\s"'<>]+/g, safeRequestUrl)
    .replace(/\bBearer\s+[^\s"',}]+/gi, 'Bearer [REDACTED]')
    .replace(/[\x00-\x08\x0b-\x1f\x7f]/g, '').slice(0, 1_000)
}

function recordFailure(value) {
  if (failures.length < 12) failures.push(diagnostic(value))
}

function isKnownFontStylesheet(details) {
  if (details.resourceType !== 'stylesheet') return false
  try {
    const url = new URL(details.url)
    const families = url.searchParams.getAll('family').sort()
    return url.protocol === 'https:' && url.hostname === 'fonts.googleapis.com' && !url.port &&
      !url.username && !url.password && !url.hash && url.pathname === '/css2' &&
      [...url.searchParams.keys()].sort().join(',') === 'display,family,family' &&
      url.searchParams.get('display') === 'swap' &&
      families.join('|') === 'IBM Plex Mono:wght@400;600|Inter:wght@400;500;600;700'
  } catch { return false }
}

for (const name of ['userData', 'sessionData', 'logs', 'crashDumps']) {
  const path = join(profile, name)
  mkdirSync(path, { recursive: true })
  app.setPath(name, path)
}
app.setPath('home', profile)
app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
app.commandLine.appendSwitch('disable-features', 'Translate,MediaRouter')
// Covers preconnect/DNS, which does not necessarily emit a webRequest event.
app.commandLine.appendSwitch('host-resolver-rules', 'MAP * ~NOTFOUND')
app.on('window-all-closed', () => {})

function finish(code) {
  if (finished) return
  finished = true
  clearTimeout(watchdog)
  if (window && !window.isDestroyed()) window.destroy()
  app.exit(code)
}

function fail(error) {
  console.error(`Packaged renderer fixture FAILED: ${diagnostic(error)}`)
  finish(1)
}

const watchdog = setTimeout(() => fail(new Error('Renderer fixture exceeded 60s deadline')), 60_000)
process.on('uncaughtException', fail)
process.on('unhandledRejection', fail)

async function waitForControl(suffix) {
  const deadline = Date.now() + 12_000
  while (Date.now() < deadline) {
    try { await access(`${control}.${suffix}`); return } catch (error) {
      if (error.code !== 'ENOENT') throw error
    }
    await new Promise((done) => setTimeout(done, 50))
  }
  throw new Error(`Renderer fixture control ${suffix} timed out`)
}

app.whenReady().then(async () => {
  session.defaultSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
  session.defaultSession.setPermissionCheckHandler(() => false)
  session.defaultSession.webRequest.onBeforeRequest({ urls: ['<all_urls>'] }, (details, callback) => {
    if (isKnownFontStylesheet(details)) {
      offlineFontStylesheets++
      return callback({ redirectURL: `data:text/css,${encodeURIComponent('/* Acceptance-only offline font fallback. No remote font data loaded. */')}` })
    }
    if (details.url.startsWith('data:') || details.url === 'about:blank') return callback({ cancel: false })
    let allowed = false
    try {
      const path = fileURLToPath(details.url)
      const inside = relative(assets, path)
      allowed = inside !== '..' && !inside.startsWith(`..${sep}`) && !isAbsolute(inside)
    } catch {}
    if (!allowed) recordFailure(`Renderer blocked request: ${safeRequestUrl(details.url)} (${details.resourceType ?? 'unknown'})`)
    callback({ cancel: !allowed })
  })
  ipcMain.handle('shadow:bootstrap:load', () => { bootstrapReads++; return initialState })
  ipcMain.handle('shadow:window:get-state', () => { windowStateReads++; return { maximized: false } })

  console.log('SHADOW_RENDERER_WAITING')
  await waitForControl('start')
  window = new BrowserWindow({
    show: false,
    width: 1024,
    height: 768,
    webPreferences: {
      preload,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      offscreen: true,
      backgroundThrottling: false,
    },
  })
  window.on('show', () => fail(new Error('Acceptance window must remain hidden')))
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('preload-error', (_event, _path, error) => recordFailure(`Preload error: ${error.message}`))
  window.webContents.on('render-process-gone', (_event, details) => recordFailure(`Renderer exited: ${details.reason}`))
  window.webContents.on('console-message', (details) => {
    if (details.level === 'error') recordFailure(`Renderer console error: ${details.message}`)
  })
  await window.loadFile(join(assets, 'index.html'))
  const deadline = Date.now() + 10_000
  let mounted = false
  while (Date.now() < deadline) {
    assert.equal(failures.length, 0, failures.join('\n'))
    mounted = await window.webContents.executeJavaScript(
      `!!document.querySelector('#app[data-v-app] .setup-panel [role="radiogroup"]')`,
    )
    if (mounted) break
    await new Promise((done) => setTimeout(done, 50))
  }
  assert.ok(mounted, 'Copied renderer did not mount the first-run role chooser')
  const bridge = await window.webContents.executeJavaScript(`(async () => {
    const api = window.shadowDesktop;
    await Promise.all([...document.images].map(image => image.decode().catch(() => {})));
    return {
      wizard: await api.bootstrap.load(),
      windowState: await api.windowControls.getState(),
      nodeRequire: typeof window.require,
      nodeProcess: typeof window.process,
      mediaApi: typeof api.mediaCapture,
      foldersApi: typeof api.folders.selectDirectory,
      mainChoices: document.querySelectorAll('[role="radiogroup"] [role="radio"]').length,
      styleSheets: document.styleSheets.length,
      imageLoaded: [...document.images].some(image => image.complete && image.naturalWidth > 0),
    };
  })()`)
  assert.deepEqual(bridge.wizard, initialState)
  assert.deepEqual(bridge.windowState, { maximized: false })
  assert.equal(bridge.nodeRequire, 'undefined')
  assert.equal(bridge.nodeProcess, 'undefined')
  assert.equal(bridge.mediaApi, 'object')
  assert.equal(bridge.foldersApi, 'function')
  assert.equal(bridge.mainChoices, 2)
  assert.ok(bridge.styleSheets > 0, 'Copied renderer stylesheet did not load')
  assert.ok(bridge.imageLoaded, 'Copied renderer image asset did not load')
  assert.ok(bootstrapReads >= 2 && windowStateReads >= 2, 'Renderer startup and explicit preload IPC round trips did not both run')
  assert.equal(failures.length, 0, failures.join('\n'))
  assert.equal(window.isVisible(), false)
  console.log('SHADOW_RENDERER_RESULT=' + JSON.stringify({
    rendererMounted: true,
    preloadIpc: true,
    isolatedWorld: true,
    visible: false,
    bootstrapReads,
    windowStateReads,
    offlineFontStylesheets,
    offlineFontPolicy: 'Only the exact declared Google Fonts stylesheet is replaced with inert local CSS; system font fallback is tested, remote fonts are NOT validated.',
    label: 'Synthetic hidden Electron entry with copied production renderer/preload; NOT unmodified production main or complete app acceptance',
  }))
  await waitForControl('stop')
  finish(0)
}).catch(fail)
