import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { runInNewContext } from 'node:vm'
import test from 'node:test'
import { registerBrowserPwa } from './pwa.ts'

test('install metadata uses standalone root launch and the shared Electron logo', async () => {
  const manifest = JSON.parse(await readFile(new URL('../public/manifest.webmanifest', import.meta.url), 'utf8'))
  assert.equal(manifest.name, 'Shadow')
  assert.equal(manifest.id, '/')
  assert.equal(manifest.scope, '/')
  assert.equal(manifest.start_url, '/')
  assert.equal(manifest.display, 'standalone')
  for (const size of [192, 512]) {
    const icon = manifest.icons.find((icon: { sizes: string }) => icon.sizes === `${size}x${size}`)
    assert.equal(icon?.src, `/pwa/icon-${size}.png`)
    assert.equal(icon.type, 'image/png')
    assert.equal(icon.purpose, 'any', 'Do not mark the unpadded desktop logo as maskable')
    const png = await readFile(new URL(`../public${icon.src}`, import.meta.url))
    assert.equal(png.subarray(0, 8).toString('hex'), '89504e470d0a1a0a')
    assert.equal(png.readUInt32BE(16), size)
    assert.equal(png.readUInt32BE(20), size)
  }
  assert.deepEqual(
    await readFile(new URL('../public/pwa/icon-512.png', import.meta.url)),
    await readFile(new URL('./assets/shadow-logo.png', import.meta.url)),
  )
  const apple = await readFile(new URL('../public/pwa/apple-touch-icon.png', import.meta.url))
  assert.equal(apple.readUInt32BE(16), 180)
  assert.equal(apple.readUInt32BE(20), 180)
  const html = await readFile(new URL('../index.html', import.meta.url), 'utf8')
  assert.match(html, /rel="manifest" href="\/manifest.webmanifest"/)
  assert.match(html, /rel="apple-touch-icon" sizes="180x180" href="\/pwa\/apple-touch-icon.png"/)
  assert.match(html, /name="apple-mobile-web-app-capable" content="yes"/)
})

test('worker registration is production/secure-browser only and failures propagate', async () => {
  const calls: { url: string | URL; options?: RegistrationOptions }[] = []
  const failure = new Error('Synthetic registration failure')
  const serviceWorker: Pick<ServiceWorkerContainer, 'register'> = {
    register: async (url, options) => { calls.push({ url, options }); throw failure },
  }
  const browser = { production: true, desktop: false, secureContext: true, protocol: 'https:', serviceWorker }
  for (const override of [
    { production: false }, { desktop: true }, { secureContext: false },
    { protocol: 'file:' }, { serviceWorker: undefined },
  ]) assert.equal(await registerBrowserPwa({ ...browser, ...override }), undefined)
  assert.equal(calls.length, 0)
  await assert.rejects(registerBrowserPwa(browser), error => error === failure)
  await assert.rejects(registerBrowserPwa({ ...browser, protocol: 'http:' }), error => error === failure)
  assert.deepEqual(calls, Array.from({ length: 2 }, () => ({
    url: '/sw.js', options: { scope: '/', updateViaCache: 'none' },
  })))
})

test('service worker never caches data or intercepts APIs, and preserves online errors', async () => {
  const listeners = new Map<string, (event: unknown) => void>()
  let onlineResponse = new Response('online')
  let offline = false
  let networkCalls = 0
  let activated = false
  let installed = false
  runInNewContext(await readFile(new URL('../public/sw.js', import.meta.url), 'utf8'), {
    URL, Response,
    self: {
      location: { origin: 'https://shadow.test' },
      addEventListener: (name: string, listener: (event: unknown) => void) => listeners.set(name, listener),
      skipWaiting: async () => { installed = true },
      clients: { claim: async () => { activated = true } },
    },
    fetch: async () => {
      networkCalls++
      if (offline) throw new TypeError('Synthetic disconnected network')
      return onlineResponse
    },
    caches: new Proxy({}, { get() { throw new Error('Worker must not use CacheStorage') } }),
  })
  for (const name of ['install', 'activate']) {
    let operation: Promise<unknown> | undefined
    listeners.get(name)!({ waitUntil: (promise: Promise<unknown>) => { operation = promise } })
    await operation
  }
  assert(installed && activated)
  function navigate(path: string, mode = 'navigate', method = 'GET') {
    let response: Promise<Response> | undefined
    listeners.get('fetch')!({
      request: { url: new URL(path, 'https://shadow.test').href, mode, method },
      respondWith: (promise: Promise<Response>) => { response = promise },
    })
    return response
  }
  for (const path of [
    '/api/sessions', '/api/web-auth/session', '/projects/default/api/sessions',
    '/projects/default/v1/query', '/local/v1/shutdown', '/nodes/v1/status',
    '/assets/app.js', 'https://external.test/',
  ]) assert.equal(navigate(path), undefined, path)
  assert.equal(navigate('/', 'cors'), undefined)
  assert.equal(navigate('/', 'navigate', 'POST'), undefined)
  assert.equal(networkCalls, 0)
  for (const status of [200, 401, 403, 503]) {
    onlineResponse = new Response(`Network ${status}`, { status })
    assert.equal(await navigate('/'), onlineResponse, `Preserve HTTP ${status}`)
  }
  offline = true
  for (const path of ['/', '/projects/default/chat/web%3Aone', '/settings/models', '/nodes']) {
    const response = await navigate(path)
    assert.equal(response?.status, 503)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    const html = await response.text()
    assert.match(html, /Conversations are not available offline/)
    assert(!html.includes('web%3Aone'))
  }
  offline = false
  onlineResponse = new Response('Recovered')
  assert.equal(await (await navigate('/'))?.text(), 'Recovered')
})
