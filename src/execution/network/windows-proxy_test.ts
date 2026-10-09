import assert from 'node:assert/strict'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { test } from 'node:test'
import { resolveWindowsProxy } from './windows-proxy.ts'
import { resolveProxyForUrl, type ProxyConfiguration } from './proxy.ts'

test('native WinHTTP evaluates a local PAC without changing system settings', { skip: process.platform !== 'win32', timeout: 60_000 }, async t => {
  const server = createServer((request, response) => {
    response.setHeader('Content-Type', 'application/x-ns-proxy-autoconfig')
    if (request.url === '/missing.pac') { response.writeHead(404); response.end(); return }
    if (request.url === '/broken.pac') { response.end('function invalid('); return }
    response.end(`function FindProxyForURL(url, host) {
      if (shExpMatch(url, "*/direct")) return "DIRECT";
      return "PROXY 127.0.0.1:18080";
    }`)
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const pac = `http://127.0.0.1:${address.port}/test.pac`
  const resolve = (url: URL, signal?: AbortSignal) => resolveWindowsProxy(url, signal, pac)
  const configuration: ProxyConfiguration = { source: 'windows-auto', bypass: [] }
  assert.equal(await resolveProxyForUrl(configuration, 'http://fixture.invalid/proxy', undefined, resolve), 'http://127.0.0.1:18080/')
  assert.equal(await resolveProxyForUrl(configuration, 'http://fixture.invalid/direct', undefined, resolve), undefined)
  await assert.rejects(resolveWindowsProxy(new URL('http://fixture.invalid/private-query?secret=fixture'), undefined,
    `http://127.0.0.1:${address.port}/broken.pac`), error => {
    assert.ok(error instanceof Error)
    assert.match(error.message, /WinHTTP/)
    assert.doesNotMatch(error.message, /fixture\.invalid|secret|broken\.pac/)
    return true
  })
  await assert.rejects(resolveWindowsProxy(new URL('http://fixture.invalid'), undefined,
    `http://127.0.0.1:${address.port}/missing.pac`), /could not download.*PAC script/)
})

test('native PAC resolution aborts a stalled download', { skip: process.platform !== 'win32', timeout: 30_000 }, async t => {
  const requested = Promise.withResolvers<void>()
  const server = createServer(() => requested.resolve())
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => { server.closeAllConnections(); server.close() })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  const abort = new AbortController()
  const pending = resolveWindowsProxy(new URL('http://fixture.invalid'), abort.signal,
    `http://127.0.0.1:${address.port}/stalled.pac`)
  const rejection = assert.rejects(pending, { name: 'AbortError' })
  await requested.promise
  abort.abort()
  await rejection
})
