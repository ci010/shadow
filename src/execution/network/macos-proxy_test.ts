import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseMacOSProxyOutput } from './macos-proxy.ts'
import { localProxyConfiguration, macOSProxyConfiguration, proxyConfigurationSchema, proxyForUrl, resolveProxyForUrl, setLocalProxyEnabled } from './proxy.ts'
import { LocalProxyDispatcher } from './proxy-client.ts'
import { fetch } from 'undici'

const output = `<dictionary> {
  HTTPEnable : 1
  HTTPProxy : proxy.invalid
  HTTPPort : 8080
  HTTPSEnable : 1
  HTTPSProxy : secure.invalid
  HTTPSPort : 8081
  ExcludeSimpleHostnames : 1
  ExceptionsList : <array> {
    0 : *.internal.invalid
    1 : 10.0.0.0/8
    2 : 2001:db8::/32
  }
  __SCOPED__ : <dictionary> {
    en0 : <dictionary> {
      HTTPEnable : 1
      HTTPProxy : ignored.invalid
    }
  }
}`

test('macOS effective scutil policy parses protocol routes, bypass and scoped dictionaries', async () => {
  const settings = parseMacOSProxyOutput(output)
  const config = await localProxyConfiguration(undefined, { platform: 'darwin', env: {}, readMacOS: async () => settings })
  assert.equal(config.source, 'macos-static')
  assert.deepEqual(proxyConfigurationSchema.parse(config), config)
  assert.equal(proxyForUrl(config, 'http://public.invalid'), 'http://proxy.invalid:8080/')
  assert.equal(proxyForUrl(config, 'wss://public.invalid'), 'http://secure.invalid:8081/')
  for (const url of ['http://printer', 'http://a.internal.invalid', 'http://10.2.3.4', 'http://[2001:db8::1]', 'http://127.0.0.2', 'http://localhost']) {
    assert.equal(proxyForUrl(config, url), undefined, url)
  }
  assert.equal(proxyForUrl(macOSProxyConfiguration({ ...settings, https: undefined }), 'https://public.invalid'), undefined)
  assert.equal(macOSProxyConfiguration(parseMacOSProxyOutput('<dictionary> {\n}')).source, 'direct')
})

test('macOS discovery respects environment priority, disable/detect and abort', async () => {
  let reads = 0
  const options = { platform: 'darwin' as const, env: {}, readMacOS: async () => { reads++; return parseMacOSProxyOutput(output) } }
  assert.equal((await localProxyConfiguration(undefined, { ...options, env: { HTTPS_PROXY: 'http://environment.invalid' } })).source, 'environment')
  assert.equal(reads, 0)
  setLocalProxyEnabled(false)
  try {
    assert.equal((await localProxyConfiguration(undefined, options)).source, 'direct')
    assert.equal(reads, 0)
    assert.equal((await localProxyConfiguration(undefined, { ...options, detectOnly: true })).source, 'macos-static')
  } finally { setLocalProxyEnabled(true) }
  const controller = new AbortController()
  await assert.rejects(localProxyConfiguration(controller.signal, { ...options, readMacOS: async () => {
    controller.abort(); return parseMacOSProxyOutput(output)
  } }), { name: 'AbortError' })
})

test('macOS malformed settings and SOCKS fail without disclosure', () => {
  for (const text of ['secret output', output.replace('HTTPEnable : 1', 'HTTPEnable : yes'), output.replace('8080', '99999'), output.replace('proxy.invalid', 'user:secret@proxy.invalid'), output.replace('HTTPPort : 8080', 'HTTPPort : 0'), output.replace('HTTPPort : 8080', 'HTTPPort : 8080\nHTTPPort : 80')]) {
    assert.throws(() => parseMacOSProxyOutput(text), error => {
      assert.ok(error instanceof Error)
      assert.doesNotMatch(error.message, /secret|user:|99999/)
      return true
    })
  }
  assert.throws(() => macOSProxyConfiguration(parseMacOSProxyOutput('<dictionary> {\nSOCKSEnable : 1\n}')), /SOCKS/)
})

test('macOS PAC and WPAD never silently use static or direct routes; loopback remains direct', async () => {
  for (const key of ['ProxyAutoConfigEnable', 'ProxyAutoDiscoveryEnable']) {
    const config = macOSProxyConfiguration(parseMacOSProxyOutput(output.replace('HTTPEnable : 1', `HTTPEnable : 1\n${key} : 1`)))
    assert.equal(proxyConfigurationSchema.parse(config).source, 'macos-auto')
    assert.equal(await resolveProxyForUrl(config, 'http://localhost:9000'), undefined)
    await assert.rejects(resolveProxyForUrl(config, 'https://public.invalid'), /macOS PAC.*HTTP_PROXY/)
    const dispatcher = new LocalProxyDispatcher(config)
    try { await assert.rejects(fetch('https://never-contact.invalid', { dispatcher }), error => {
      assert.ok(error instanceof Error && error.cause instanceof Error)
      assert.match(error.cause.message, /no direct fallback/)
      return true
    }) } finally { await dispatcher.destroy() }
  }
})
