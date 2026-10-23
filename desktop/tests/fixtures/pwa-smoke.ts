import assert from 'node:assert/strict'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'

app.setPath('userData', join(process.cwd(), 'profile'))
app.commandLine.appendSwitch('disable-background-networking')
app.on('window-all-closed', () => {})
const watchdog = setTimeout(() => { console.error('PWA smoke watchdog expired'); app.exit(1) }, 85_000)

async function main() {
  await app.whenReady()
  const origin = new URL(process.env.PWA_SMOKE_URL!).origin
  const window = new BrowserWindow({
    show: false,
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, backgroundThrottling: false },
  })
  const external: string[] = []
  const crashes: string[] = []
  window.webContents.on('render-process-gone', (_event, details) => crashes.push(details.reason))
  window.webContents.session.webRequest.onBeforeRequest((details, callback) => {
    const forbidden = /^https?:/.test(details.url) && new URL(details.url).origin !== origin
    if (forbidden) external.push(details.url)
    callback({ cancel: forbidden })
  })
  const execute = (code: string) => window.webContents.executeJavaScript(code)
  const wait = async (code: string) => {
    const deadline = Date.now() + 12_000
    while (Date.now() < deadline) {
      if (await execute(code)) return
      await delay(50)
    }
    throw new Error(`Timed out: ${code}\n${await execute('JSON.stringify(window.__pwa)')}`)
  }
  const cdp = window.webContents.debugger
  await window.loadURL(`${origin}/`)
  cdp.attach('1.3')
  const command = async (method: string, params?: Record<string, unknown>, sessionId?: string) => {
    let timeout: ReturnType<typeof setTimeout> | undefined
    try {
      return await Promise.race([
        cdp.sendCommand(method, params, sessionId),
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => reject(new Error(`CDP timed out: ${method}`)), 10_000)
        }),
      ])
    } finally {
      clearTimeout(timeout)
    }
  }
  const documents: { url: string; status: number; fromServiceWorker?: boolean }[] = []
  cdp.on('message', (_event, method, params) => {
    if (method === 'Network.responseReceived' && params.type === 'Document') documents.push(params.response)
  })
  await command('Network.enable')
  await command('Page.enable')
  await command('Network.setCacheDisabled', { cacheDisabled: true })
  let workerSession: string
  const offline = async (value: boolean) => {
    // Chromium scopes CDP network emulation to each target: the worker's fetch
    // must go offline too, not just requests initiated by the document.
    for (const sessionId of [undefined, workerSession]) {
      await command('Network.emulateNetworkConditions', {
        offline: value, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
      }, sessionId)
    }
  }
  const controlled = () => wait(`window.__pwa?.registered && !!navigator.serviceWorker.controller`)
  try {
    await controlled()
    assert.equal(await execute('window.__pwa.error'), null)
    assert.equal(await execute('navigator.serviceWorker.controller.scriptURL'), `${origin}/sw.js`)
    const registration = await execute(`navigator.serviceWorker.getRegistration().then(r => ({
      scope: r.scope, updateViaCache: r.updateViaCache, state: r.active.state
    }))`)
    assert.deepEqual(registration, { scope: `${origin}/`, updateViaCache: 'none', state: 'activated' })
    await window.loadURL(`${origin}/`)
    await controlled()
    assert.equal((await execute('navigator.serviceWorker.getRegistrations().then(r => r.length)')), 1)
    const targets = await command('Target.getTargets')
    const worker = targets.targetInfos.find((target: { type: string; url: string }) =>
      target.type === 'service_worker' && target.url === `${origin}/sw.js`)
    assert.ok(worker, 'The production worker must be running in a genuine Chromium worker target')
    workerSession = (await command('Target.attachToTarget', { targetId: worker.targetId, flatten: true })).sessionId
    await command('Network.enable', {}, workerSession)
    await command('Network.setCacheDisabled', { cacheDisabled: true }, workerSession)

    const manifest = await command('Page.getAppManifest')
    assert.equal(manifest.url, `${origin}/manifest.webmanifest`)
    assert.deepEqual(manifest.errors, [], 'Chromium must parse the actual manifest without errors')
    const parsed = JSON.parse(manifest.data)
    assert.equal(parsed.id, '/')
    assert.equal(parsed.start_url, '/')
    assert.equal(parsed.scope, '/')
    assert.equal(parsed.display, 'standalone')
    assert.equal(parsed.name, 'Shadow')
    let installability: unknown
    try {
      installability = await command('Page.getInstallabilityErrors')
    } catch (error) {
      if (!/wasn't found|not found|not supported|Method not found/i.test(String(error))) throw error
      installability = { unsupported: String(error) }
    }
    console.log(`PWA_CHROMIUM_DIAGNOSTICS ${JSON.stringify({ installability, manifestErrors: manifest.errors })}`)
    if (installability && typeof installability === 'object' && 'installabilityErrors' in installability) {
      assert.deepEqual(installability.installabilityErrors, [], 'Chromium installability errors')
    }
    const images = [...parsed.icons.map((icon: { src: string; sizes: string }) => ({ src: icon.src, size: Number(icon.sizes.split('x')[0]) })),
      { src: await execute(`document.querySelector('link[rel="apple-touch-icon"]').getAttribute('href')`), size: 180 }]
    assert.deepEqual(images.map(icon => icon.size), [192, 512, 180])
    for (const image of images) {
      const dimensions = await execute(`(async () => {
        const response = await fetch(${JSON.stringify(image.src)});
        if (!response.ok) throw new Error('Icon fetch: ' + response.status);
        const blob = await response.blob(), bitmap = await createImageBitmap(blob);
        return { bytes: blob.size, type: blob.type, width: bitmap.width, height: bitmap.height };
      })()`)
      assert.ok(dimensions.bytes > 0)
      assert.equal(dimensions.type, 'image/png')
      assert.equal(dimensions.width, image.size)
      assert.equal(dimensions.height, image.size)
    }
    const apiPaths = ['/api/pwa-private', '/projects/synthetic/api/pwa-private']
    for (const path of apiPaths) {
      const result = await execute(`fetch(${JSON.stringify(path)}).then(r => r.json())`)
      assert.equal(result.secret, 'synthetic-private-not-for-offline')
    }
    assert.deepEqual(await execute('caches.keys()'), [])
    await offline(true)
    for (const path of [...apiPaths, '/pwa/icon-192.png']) {
      assert.equal(await execute(`fetch(${JSON.stringify(path)}).then(() => 'unexpected response', () => 'network failure')`),
        'network failure', `Offline ${path} must not be served from a worker cache`)
    }
    for (const path of ['/', '/projects/synthetic/chat/test-session']) {
      const url = `${origin}${path}`
      await window.loadURL(url)
      const text = await execute('document.body.innerText')
      assert.match(text, /Shadow is unavailable/)
      assert.match(text, /Conversations are not available offline/)
      assert.doesNotMatch(text, /Synthetic online|synthetic-private/)
      const response = documents.findLast(document => document.url === url)
      assert.ok(response, 'CDP must observe the offline document response')
      assert.equal(response.status, 503)
      assert.equal(response.fromServiceWorker, true)
      assert.deepEqual(await execute('caches.keys()'), [])
    }
    for (const path of apiPaths) {
      await assert.rejects(window.loadURL(`${origin}${path}`), /ERR_INTERNET_DISCONNECTED|ERR_FAILED/)
    }
    await offline(false)
    await window.loadURL(`${origin}/projects/synthetic/chat/test-session`)
    await controlled()
    assert.equal(await execute('document.querySelector("#fixture").textContent'), 'Synthetic online PWA fixture')
    for (const path of apiPaths) {
      const result = await execute(`fetch(${JSON.stringify(path)}).then(r => r.json())`)
      assert.ok(result.revision > 2, 'Recovery must fetch fresh private responses')
    }
    assert.deepEqual(await execute('caches.keys()'), [])
    assert.deepEqual(external, [], 'The fixture must not attempt external network requests')
    assert.deepEqual(crashes, [])
    console.log('PWA_SMOKE_OK registration/control/reload, Chromium manifest/icons, offline 503, API network-only, online recovery')
  } finally {
    window.destroy()
  }
}

main().then(() => { clearTimeout(watchdog); app.exit(0) }).catch(error => {
  console.error(error)
  clearTimeout(watchdog)
  app.exit(1)
})
