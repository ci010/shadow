import assert from 'node:assert/strict'
import test from 'node:test'
import {
  installRuntimeRequestAuthorization,
  normalizeLoopbackOrigin,
} from './runtime-authorization.js'

class FakeWebRequest {
  installCount = 0
  private listener:
    | ((
      details: {
        url: string
        requestHeaders: Record<string, string>
        webContentsId?: number
        frame?: { parent: unknown | null } | null
      },
      callback: (response: { requestHeaders: Record<string, string> }) => void,
    ) => void)
    | undefined

  onBeforeSendHeaders(
    _filter: { readonly urls: readonly string[] },
    listener: (
      details: {
        url: string
        requestHeaders: Record<string, string>
        webContentsId?: number
        frame?: { parent: unknown | null } | null
      },
      callback: (response: { requestHeaders: Record<string, string> }) => void,
    ) => void,
  ): void {
    this.installCount += 1
    this.listener = listener
  }

  request(
    url: string,
    requestHeaders: Record<string, string> = {},
    webContentsId?: number,
    frame: { parent: unknown | null } | null = { parent: null },
  ): Record<string, string> {
    let result: Record<string, string> | undefined
    this.listener?.({
      url,
      requestHeaders,
      frame,
      ...(webContentsId === undefined ? {} : { webContentsId }),
    }, (response) => {
      result = response.requestHeaders
    })
    return result!
  }
}

test('authorizes only the exact current loopback origin and installs one hook', () => {
  const webRequest = new FakeWebRequest()
  const update = installRuntimeRequestAuthorization({ webRequest }, () => true)
  update({ apiBase: 'http://127.0.0.1:43123', launchToken: 'launch-token' })

  assert.equal(webRequest.installCount, 1)
  assert.equal(
    webRequest.request('http://127.0.0.1:43123/api').Authorization,
    'Bearer launch-token',
  )
  for (
    const url of [
      'http://localhost:43123/api',
      'http://127.0.0.1:43124/api',
      'https://127.0.0.1:43123/api',
      'http://example.com:43123/api',
    ]
  ) {
    assert.equal(webRequest.request(url).Authorization, undefined)
  }
})

test('does not overwrite Authorization and clearing disables injection', () => {
  const webRequest = new FakeWebRequest()
  const update = installRuntimeRequestAuthorization({ webRequest }, () => true)
  update({ apiBase: 'http://127.0.0.1:43123', launchToken: 'launch-token' })
  assert.deepEqual(
    webRequest.request('http://127.0.0.1:43123/api', {
      authorization: 'Basic existing',
    }),
    {
      authorization: 'Basic existing',
    },
  )
  update(null)
  assert.equal(
    webRequest.request('http://127.0.0.1:43123/api').Authorization,
    undefined,
  )
})

test('injects credentials only for the trusted WebContents', () => {
  const webRequest = new FakeWebRequest()
  const update = installRuntimeRequestAuthorization(
    { webRequest },
    (details) => details.webContentsId === 42,
  )
  update({ apiBase: 'http://127.0.0.1:43123', launchToken: 'launch-token' })

  assert.equal(
    webRequest.request('http://127.0.0.1:43123/api', {}, 42).Authorization,
    'Bearer launch-token',
  )
  assert.equal(
    webRequest.request('http://127.0.0.1:43123/api', {}, 7).Authorization,
    undefined,
  )
  assert.equal(
    webRequest.request('http://127.0.0.1:43123/api').Authorization,
    undefined,
  )
})

test('rejects non-literal, credentialed, and non-origin API bases', () => {
  assert.equal(
    normalizeLoopbackOrigin('http://127.0.0.1:43123'),
    'http://127.0.0.1:43123',
  )
  for (
    const apiBase of [
      'http://localhost:43123',
      'http://example.com:43123',
      'https://127.0.0.1:43123',
      'http://user@127.0.0.1:43123',
      'http://127.0.0.1:43123/api',
    ]
  ) {
    assert.equal(normalizeLoopbackOrigin(apiBase), null)
  }
})

test('embedded apps in trusted WebContents never inherit the host launch credential', () => {
  const webRequest = new FakeWebRequest()
  const update = installRuntimeRequestAuthorization({ webRequest }, details => details.webContentsId === 42)
  update({ apiBase: 'http://127.0.0.1:43123', launchToken: 'synthetic-host-token' })
  for (const frame of [null, { parent: {} }]) {
    assert.equal(webRequest.request('http://127.0.0.1:43123/api', {}, 42, frame).Authorization, undefined)
  }
})

test('HMR uses the exact loopback HTTP authority, never leaking credentials to LAN or embedded sockets', () => {
  const webRequest = new FakeWebRequest()
  const update = installRuntimeRequestAuthorization({ webRequest }, details => details.webContentsId === 42)
  update({ apiBase: 'http://127.0.0.1:43123', launchToken: 'child-private' })
  assert.equal(webRequest.request('ws://127.0.0.1:43123/?token=hmr', {}, 42).Authorization, 'Bearer child-private')
  for (const url of ['ws://192.168.1.10:43123/', 'ws://127.0.0.1:43124/', 'wss://127.0.0.1:43123/']) {
    assert.equal(webRequest.request(url, {}, 42).Authorization, undefined)
  }
  assert.equal(webRequest.request('ws://127.0.0.1:43123/', {}, 42, { parent: {} }).Authorization, undefined)
})
