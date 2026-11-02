import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { test } from 'node:test'
import { Hono } from 'hono'
import WebSocket from 'ws'
import { folderFixture } from '../folders/test-fixtures.ts'
import { BrowserAuth } from './web-auth.ts'
import { createHtmlPreview } from './html-preview.ts'
import { GatewayClientAddressRegistry, registerGatewayRoutes, serveGateway } from './server.ts'

// Explicit opt-in; uses an existing Chromium-family binary with a disposable profile.
// Never connects to a user's browser, downloads a browser, or reads a real profile.
const executable = process.env.SHADOW_TEST_BROWSER
const font = process.env.SHADOW_TEST_FONT

test('real sandbox browser loads relative HTML assets without business API authority', {
  skip: !executable || !font ? 'Set SHADOW_TEST_BROWSER and SHADOW_TEST_FONT to existing Chromium and TTF files' : false,
  timeout: 40_000,
}, async t => {
  const { root, workspace } = await folderFixture(t)
  const page = join(workspace, 'page')
  await mkdir(join(page, 'assets'), { recursive: true })
  await writeFile(join(workspace, 'secret.txt'), 'outside secret')
  await copyFile(font!, join(page, 'assets', 'fixture.ttf'))
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=', 'base64')
  await writeFile(join(page, 'assets', 'image.png'), png)
  await writeFile(join(page, 'assets', 'background.png'), png)
  await writeFile(join(page, 'assets', 'style.css'), `@font-face { font-family: Fixture; src: url(fixture.ttf) } body { color: rgb(12, 34, 56); font-family: Fixture; background-image: url(background.png) }`)
  await writeFile(join(page, 'assets', 'classic.js'), 'window.classicLoaded = true')
  await writeFile(join(page, 'assets', 'dependency.js'), 'export const value = 42')
  await writeFile(join(page, 'assets', 'module.js'), "import {value} from './dependency.js'; window.moduleValue = value")
  await writeFile(join(page, 'index.html'), `<!doctype html><link rel="stylesheet" href="assets/style.css"><script src="assets/classic.js"></script><script type="module" src="assets/module.js"></script><body>font fixture<img id="image" src="assets/image.png"><script>
    addEventListener('load', async () => {
      await document.fonts.ready;
      let apiBlocked = false;
      try { await fetch('/api/private') } catch { apiBlocked = true }
      parent.postMessage({ type: 'preview-result', origin: globalThis.origin,
        classic: window.classicLoaded, module: window.moduleValue,
        color: getComputedStyle(document.body).color,
        image: document.querySelector('#image').naturalWidth,
        font: document.fonts.check('16px Fixture'), apiBlocked }, '*');
    });
  </script></body>`)
  const addresses = new GatewayClientAddressRegistry()
  const auth = new BrowserAuth({ clientAddresses: addresses, launchCredential: 'browser-fixture-only' })
  t.after(() => auth.close())
  let businessReads = 0
  const responses: Array<{ url: string; status: number; origin: string | null }> = []
  const app = new Hono()
  app.use('*', async (c, next) => {
    await next()
    responses.push({ url: c.req.url, status: c.res.status, origin: c.req.header('Origin') ?? null })
  })
  registerGatewayRoutes(app, [auth.plugin(), gateway => {
    gateway.get('/', c => c.html('<!doctype html><body>Preview browser test</body>'))
    gateway.post('/api/files/html-preview', c => createHtmlPreview(c, async () => workspace))
    gateway.get('/api/private', c => { businessReads++; return c.text('private') })
    gateway.get('/api/files/static/secret.txt', c => { businessReads++; return c.text('secret') })
  }], { browserAuth: auth, launchCredential: 'browser-fixture-only', clientAddresses: addresses }, {})
  const server = serveGateway(app, { host: '127.0.0.1', port: 0, clientAddresses: addresses })
  await server.ready
  t.after(() => server.shutdown())
  const origin = `http://127.0.0.1:${server.addr.port}`
  const profile = join(root, 'isolated-browser-profile')
  const browser = spawn(executable!, ['--headless=new', '--no-first-run', '--no-default-browser-check', '--disable-background-networking', '--remote-debugging-address=127.0.0.1', '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })
  let spawnError: Error | undefined
  browser.on('error', error => { spawnError = error })
  t.after(async () => {
    if (browser.exitCode === null && browser.signalCode === null) {
      const stopped = once(browser, 'exit')
      browser.kill('SIGTERM')
      await Promise.race([stopped, delay(2_000).then(() => { browser.kill('SIGKILL') })])
    }
  })
  let port = ''
  for (let i = 0; i < 150; i++) {
    if (spawnError) throw spawnError
    if (browser.exitCode !== null) throw new Error(`Browser exited: ${browser.exitCode}`)
    try { port = (await readFile(join(profile, 'DevToolsActivePort'), 'utf8')).split('\n')[0]!; break } catch { await delay(50) }
  }
  assert(port, 'isolated browser did not expose its loopback debugging endpoint')
  const target = await (await fetch(`http://127.0.0.1:${port}/json/new?about:blank`, { method: 'PUT' })).json() as { webSocketDebuggerUrl: string }
  const socket = new WebSocket(target.webSocketDebuggerUrl)
  await once(socket, 'open')
  t.after(() => socket.close())
  let sequence = 0
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>()
  socket.on('message', data => {
    const message = JSON.parse(String(data))
    if (message.id) {
      const callback = pending.get(message.id)
      pending.delete(message.id)
      if (message.error) callback?.reject(new Error(JSON.stringify(message.error)))
      else callback?.resolve(message.result)
    }

  })
  const command = (method: string, params: object = {}, sessionId?: string) => new Promise<any>((resolve, reject) => {
    const id = ++sequence
    pending.set(id, { resolve, reject })
    socket.send(JSON.stringify({ id, method, params, sessionId }))
  })
  const evaluate = async (expression: string) => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
    assert(!result.exceptionDetails, JSON.stringify(result.exceptionDetails))
    return result.result.value
  }
  await command('Page.enable')
  await command('Network.enable')
  await command('Page.navigate', { url: origin })
  for (let i = 0; i < 100; i++) {
    if (await evaluate(`location.origin === ${JSON.stringify(origin)} && document.readyState === 'complete'`)) break
    await delay(25)
  }
  const offer = await (await fetch(origin + '/local/v1/web-pairing', { method: 'POST', headers: { Authorization: 'Bearer browser-fixture-only' } })).json() as { code: string }
  await evaluate(`(async () => {
    const offer = ${JSON.stringify(offer)};
    const pairing = await fetch('/api/web-auth/pair', { method:'POST', headers:{'Content-Type':'application/json'}, body:JSON.stringify({code:offer.code}) });
    if (!pairing.ok) throw Error('pairing failed '+pairing.status);
    window.lease = await (await fetch('/api/files/html-preview?path=page/index.html', {method:'POST'})).json();
    window.frame = document.createElement('iframe');
    frame.setAttribute('sandbox','allow-scripts allow-forms allow-popups');
    frame.referrerPolicy = 'no-referrer';
    window.addEventListener('message', e => { if(e.source === frame.contentWindow && e.data.type === 'preview-result') window.previewResult = e.data });
    frame.src = lease.url; document.body.append(frame);
  })()`)
  let result: any
  for (let i = 0; i < 200; i++) {
    result = await evaluate('window.previewResult')
    if (result) break
    await delay(25)
  }
  assert.deepEqual(result, { type: 'preview-result', origin: 'null', classic: true, module: 42, color: 'rgb(12, 34, 56)', image: 1, font: true, apiBlocked: true })
  assert.equal(await evaluate('frame.contentDocument === null'), true)
  for (const asset of ['index.html', 'style.css', 'classic.js', 'module.js', 'dependency.js', 'image.png', 'background.png', 'fixture.ttf']) {
    assert(responses.some(response => response.url.endsWith('/' + asset) && response.status === 200), `Missing successful browser request for ${asset}`)
  }
  // A separate srcdoc sandbox has no lease CSP, so these requests reach global
  // authentication with the browser's real opaque Origin (not a synthetic header).
  await evaluate(`(() => {
    const probe = document.createElement('iframe');
    probe.setAttribute('sandbox','allow-scripts');
    addEventListener('message', e => { if (e.source === probe.contentWindow && e.data.type === 'auth-probe') window.authProbe = e.data });
    probe.srcdoc = '<script>Promise.all(["/api/private","/api/files/static/secret.txt"].map(path => fetch(path,{credentials:"include"}).then(r=>r.status,()=>"blocked"))).then(statuses => parent.postMessage({type:"auth-probe",origin:globalThis.origin,statuses},"*"))<\/script>';
    document.body.append(probe);
  })()`)
  let probe: any
  for (let i = 0; i < 100; i++) {
    probe = await evaluate('window.authProbe')
    if (probe) break
    await delay(25)
  }
  assert.equal(probe?.origin, 'null')
  for (const path of ['/api/private', '/api/files/static/secret.txt']) {
    assert(responses.some(response => new URL(response.url).pathname === path && response.origin === 'null' && response.status === 401), `Opaque browser request did not reach protected ${path}`)
  }
  const denied = await evaluate(`(async () => {
    const prefix = lease.url.slice(0,lease.url.lastIndexOf('/')+1);
    const statuses=[];
    for (const path of ['/api/private','/api/files/static/secret.txt',prefix+'secret.txt',prefix+'%2e%2e%2fsecret.txt']) statuses.push((await fetch(path,{credentials:'omit'})).status);
    await fetch(lease.revokeUrl,{method:'DELETE'});
    statuses.push((await fetch(lease.url,{credentials:'omit'})).status);
    return statuses;
  })()`)
  assert.deepEqual(denied, [401, 401, 404, 404, 404])
  assert.equal(businessReads, 0)
  t.diagnostic(JSON.stringify({ browser: await command('Browser.getVersion'), result, probe, denied, assets: responses.filter(response => response.url.includes('/api/html-preview/')).map(response => ({ path: new URL(response.url).pathname.replace(/html-preview\/[^/]+\//, 'html-preview/<lease>/'), status: response.status })) }))
})
