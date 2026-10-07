import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { connect, type Socket } from 'node:net'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { fetch } from 'undici'
import { WebSocketServer } from 'ws'
import { LocalProxyDispatcher } from './proxy-client.ts'
import { localProxyConfiguration, proxyForUrl, windowsProxyConfiguration } from './proxy.ts'

test('Windows static routes preserve protocol choices, wildcard bypasses and local-host exclusions', () => {
  const proxy = windowsProxyConfiguration({
    enabled: true, server: 'http=proxy.example:8080;https=proxy.example:8081', automatic: false,
    bypass: '10.*;192.168.*;*.internal.example;<local>;specific.example:8443',
  })
  assert.equal(proxyForUrl(proxy, 'https://public.example/a'), 'http://proxy.example:8081/')
  assert.equal(proxyForUrl(proxy, 'http://public.example/a'), 'http://proxy.example:8080/')
  assert.equal(proxyForUrl(proxy, 'wss://public.example/socket'), 'http://proxy.example:8081/')
  assert.equal(proxyForUrl(proxy, 'ws://public.example/socket'), 'http://proxy.example:8080/')
  assert.equal(proxyForUrl(proxy, 'ws://localhost:1234/socket'), undefined)
  for (const url of ['http://localhost:1234', 'http://localhost.', 'https://127.0.0.2', 'http://[::1]', 'http://[::ffff:127.0.0.1]', 'http://10.8.7.6',
    'https://192.168.5.2', 'https://a.internal.example', 'http://printer', 'https://specific.example:8443']) {
    assert.equal(proxyForUrl(proxy, url), undefined, url)
  }
  assert.ok(proxyForUrl(proxy, 'https://specific.example'))
  const httpOnly = windowsProxyConfiguration({ enabled: true, server: 'http=proxy.example:80', bypass: '', automatic: false })
  assert.equal(proxyForUrl(httpOnly, 'https://public.example'), undefined)
  assert.equal(proxyForUrl(windowsProxyConfiguration({ enabled: false, server: '', bypass: '', automatic: false }), 'https://public.example'), undefined)
})

test('standard proxy environment takes precedence without consuming unrelated agent proxy variables', async () => {
  const config = await localProxyConfiguration(undefined, {
    platform: 'win32', env: { HTTP_PROXY: 'http://proxy.example:8080', NO_PROXY: '.internal.example,specific.example:8443' },
    readWindows: async () => { throw new Error('Environment has priority') },
  })
  assert.equal(config.source, 'environment')
  assert.equal(proxyForUrl(config, 'https://public.example'), 'http://proxy.example:8080/')
  assert.equal(proxyForUrl(config, 'https://internal.example'), undefined)
  assert.equal(proxyForUrl(config, 'https://a.internal.example'), undefined)
  assert.equal(proxyForUrl(config, 'https://specific.example:8443'), undefined)
  assert.ok(proxyForUrl(config, 'https://specific.example'))
  const windows = await localProxyConfiguration(undefined, {
    platform: 'win32', env: { GLOBAL_AGENT_HTTPS_PROXY: 'http://unrelated.invalid' },
    readWindows: async () => ({ enabled: true, server: 'proxy.example:8080', bypass: '', automatic: false }),
  })
  assert.equal(windows.source, 'windows-static')
  assert.deepEqual(await localProxyConfiguration(undefined, { platform: 'linux', env: {} }), { source: 'direct', bypass: [] })
})

test('credentials and unsupported proxy modes fail explicitly without echoing sensitive settings', async () => {
  for (const value of ['http://user:secret@proxy.example', 'socks5://proxy.example', 'http://proxy.example/private-token', 'proxy.example\ninjected']) {
    await assert.rejects(localProxyConfiguration(undefined, { env: { HTTPS_PROXY: value } }), error => {
      assert.ok(error instanceof Error)
      assert.doesNotMatch(error.message, /user:|secret|private-token|injected/)
      return true
    })
  }
  assert.throws(() => windowsProxyConfiguration({ enabled: true, server: 'proxy.example', bypass: '', automatic: true }), /PAC/)
  assert.throws(() => windowsProxyConfiguration({ enabled: true, server: 'socks=proxy.example', bypass: '', automatic: false }), /SOCKS/)
  const controller = new AbortController()
  controller.abort()
  await assert.rejects(localProxyConfiguration(controller.signal), { name: 'AbortError' })
})

test('real CONNECT transport and native Node preload use the configured proxy while loopback stays direct', async () => {
  const upstream = createServer((_request, response) => response.end('synthetic resource'))
  const gateway = new WebSocketServer({ server: upstream })
  gateway.on('connection', socket => socket.send('synthetic gateway'))
  const proxy = createServer()
  const sockets = new Set<Socket>()
  const requests: string[] = []
  for (const server of [upstream, proxy]) server.on('connection', socket => {
    sockets.add(socket)
    socket.on('close', () => sockets.delete(socket))
  })
  upstream.listen(0, '127.0.0.1')
  await once(upstream, 'listening')
  const target = upstream.address()
  assert.ok(target && typeof target !== 'string')
  proxy.on('connect', (request, socket, head) => {
    requests.push(request.url ?? '')
    const remote = connect(target.port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) remote.write(head)
      socket.pipe(remote).pipe(socket)
    })
    remote.on('error', () => socket.destroy())
    socket.on('error', () => remote.destroy())
    socket.on('close', () => remote.destroy())
  })
  proxy.listen(0, '127.0.0.1')
  await once(proxy, 'listening')
  const address = proxy.address()
  assert.ok(address && typeof address !== 'string')
  const configuration = windowsProxyConfiguration({
    enabled: true, server: `127.0.0.1:${address.port}`, bypass: '<local>;10.*', automatic: false,
  })
  const dispatcher = new LocalProxyDispatcher(configuration)
  try {
    assert.equal(await (await fetch('http://resource.example.invalid/file', { dispatcher })).text(), 'synthetic resource')
    assert.deepEqual(requests, ['resource.example.invalid:80'])
    assert.equal(await (await fetch(`http://127.0.0.1:${target.port}/`, { dispatcher })).text(), 'synthetic resource')
    assert.equal(requests.length, 1)
    const child = await promisify(execFile)(process.execPath, [
      '--import', new URL('./proxy-preload.ts', import.meta.url).href, '--input-type=module', '--eval',
      "console.log(await (await fetch('http://resource.example.invalid/from-child')).text());console.log(Object.hasOwn(process.env,'SHADOW_APP_NETWORK_PROXY'))",
    ], { timeout: 10_000, windowsHide: true, env: { ...process.env, SHADOW_APP_NETWORK_PROXY: JSON.stringify(configuration) } })
    assert.equal(child.stdout.trim(), 'synthetic resource\nfalse')
    assert.equal(requests.length, 2)
    const env = { ...process.env }
    for (const key of Object.keys(env)) if (/^(https?_proxy|no_proxy|SHADOW_APP_NETWORK_PROXY)$/i.test(key)) delete env[key]
    env.HTTP_PROXY = `http://127.0.0.1:${address.port}`
    const backend = await promisify(execFile)(process.execPath, [
      '--import', 'tsx', '--input-type=module', '--eval', `
        import assert from 'node:assert/strict';
        import { WebSocket, getGlobalDispatcher } from 'undici';
        import { initializeBackendNetwork } from ${JSON.stringify(new URL('./backend.ts', import.meta.url).href)};
        await Promise.all([initializeBackendNetwork(), initializeBackendNetwork()]);
        const dispatcher = getGlobalDispatcher();
        await initializeBackendNetwork();
        assert.equal(getGlobalDispatcher(), dispatcher);
        console.log(await (await fetch('http://resource.example.invalid/backend')).text());
        console.log(await (await fetch('http://127.0.0.1:${target.port}/local')).text());
        await new Promise((resolve, reject) => {
          const ws = new WebSocket('ws://gateway.example.invalid/gateway', { dispatcher });
          ws.onmessage = event => { console.log(event.data); ws.close(); };
          ws.onerror = () => reject(new Error('Gateway connection failed'));
          ws.onclose = resolve;
        });
        await dispatcher.close();
      `,
    ], { timeout: 15_000, windowsHide: true, env })
    assert.match(backend.stdout, /Backend proxy source: environment/)
    assert.match(backend.stdout, /synthetic resource\nsynthetic resource\nsynthetic gateway/)
    assert.equal(requests.length, 4, 'Backend fetch and WebSocket use CONNECT, while loopback bypasses the proxy')
    assert.deepEqual(requests.slice(-2), ['resource.example.invalid:80', 'gateway.example.invalid:80'])
  } finally {
    await dispatcher.close()
    for (const client of gateway.clients) client.terminate()
    await new Promise<void>(resolve => gateway.close(() => resolve()))
    for (const socket of sockets) socket.destroy()
    await Promise.all([upstream, proxy].map(server => new Promise<void>(resolve => server.close(() => resolve()))))
  }
})
