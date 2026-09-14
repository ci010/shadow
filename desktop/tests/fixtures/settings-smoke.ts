import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { app, BrowserWindow, session } from 'electron'
import { Hono } from 'hono'
import { uiPlugin } from '../../../src/gateway/ui.ts'
import type { ChannelSetupStatus } from '../../../src/channels/setup-contract.ts'

function argument(name: string) {
  const value = process.argv.find(value => value.startsWith(`--${name}=`))?.slice(name.length + 3)
  assert.ok(value)
  return resolve(value)
}
const directory = argument('layout-root')
for (const name of ['userData', 'sessionData', 'logs', 'crashDumps'] as const) {
  mkdirSync(join(directory, name), { recursive: true })
  app.setPath(name, join(directory, name))
}
app.setPath('home', directory)
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
app.on('window-all-closed', () => {})
const ui = new Hono()
uiPlugin(argument('layout-assets'))(ui)
let channels: ChannelSetupStatus[] = []
let readyProvider = true
let failList = false
let failSave = false
let malformedList = false
const patches: Array<{ id: string; config: Record<string, unknown> }> = []
const failures: string[] = []
let channelReads = 0
let holdSave = false
let finishSave: (() => void) | undefined
const cancelledLogins = new Set<string>()
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url!, 'http://127.0.0.1')
    const path = url.pathname
    const json = (data: unknown, status = 200) => { response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' }); response.end(JSON.stringify(data)) }
    if (path === '/api/provider/setup') return json({ ready: readyProvider, provider: 'custom', model: 'fixture-model', authMode: 'none', hasApiKey: false })
    if (path === '/api/provider/configured') return json({ providers: [{ provider: 'custom', model: 'fixture-model', selected: true, authMode: 'none', hasApiKey: false }] })
    if (path === '/debug/models') return json({ models: ['fixture-model'] })
    if (path === '/api/auth/login' && request.method === 'POST') {
      let text = ''
      for await (const chunk of request) text += chunk
      return json({ loginId: JSON.parse(text).attemptId, state: 'pending', userCode: 'TEST-1234',
        verificationUri: 'https://github.com/login/device', expiresAt: Date.now() + 60_000, intervalMs: 60_000 })
    }
    if (path.startsWith('/api/auth/login/') && request.method === 'DELETE') {
      cancelledLogins.add(path.slice('/api/auth/login/'.length))
      return json({})
    }
    if (path === '/api/channels') {
      channelReads++
      return failList ? json({ error: 'Synthetic offline' }, 503) : json({ channels: malformedList ? [{ id: 'qq' }] : channels })
    }
    const match = path.match(/^\/api\/channels\/(qq|feishu|discord)$/)
    if (match && request.method === 'PATCH') {
      let text = ''
      for await (const chunk of request) text += chunk
      const body = JSON.parse(text)
      patches.push({ id: match[1], config: body.config })
      if (holdSave) { holdSave = false; await new Promise<void>(resolve => { finishSave = resolve }) }
      if (failSave) return json({ error: 'Synthetic refusal' }, 400)
      const channel = channels.find(item => item.id === match[1])!
      for (const [key, value] of Object.entries(body.config)) {
        if (['secret', 'token', 'appSecret', 'encryptKey', 'verificationToken'].includes(key)) channel.secrets[key] = !!value
        else if (key === 'enabled') channel.enabled = value === true
        else channel.config[key] = value as string | number | boolean | string[]
      }
      channel.configured = true
      channel.state = channel.enabled ? 'connecting' : 'disabled'
      delete channel.message
      return json({ channel })
    }
    if (/^\/(?:api|debug|local|nodes|v1)\//.test(path)) {
      failures.push(`Unexpected ${request.method} ${path}`)
      return json({ error: 'Unstubbed endpoint' }, 404)
    }
    const resource = await ui.request(url.toString())
    const type = resource.headers.get('Content-Type') || 'application/octet-stream'
    response.writeHead(resource.status, { 'Content-Type': type })
    const bytes = Buffer.from(await resource.arrayBuffer())
    response.end(type.includes('text/html') ? bytes.toString().replace(/<link\b[^>]*href=["']https:\/\/fonts\.(?:googleapis|gstatic)\.com[^>]*>/g, '') : bytes)
  } catch (error) {
    failures.push(String(error))
    if (!response.headersSent) response.writeHead(500)
    response.end()
  }
})
const evaluate = <T = unknown>(window: BrowserWindow, source: string): Promise<T> => window.webContents.executeJavaScript(source)
async function waitFor(window: BrowserWindow, source: string) {
  const deadline = Date.now() + 10_000
  while (!await evaluate(window, source)) {
    if (Date.now() >= deadline) throw new Error(`Timed out ${source}; failures=${JSON.stringify(failures)}`)
    await new Promise(resolve => setTimeout(resolve, 30))
  }
}
async function click(window: BrowserWindow, selector: string) {
  await waitFor(window, `!!document.querySelector(${JSON.stringify(selector)}) && !document.querySelector(${JSON.stringify(selector)}).disabled`)
  await evaluate(window, `document.querySelector(${JSON.stringify(selector)}).click()`)
}
async function field(window: BrowserWindow, selector: string, value: string) {
  await evaluate(window, `(() => { const input = document.querySelector(${JSON.stringify(selector)}); input.value = ${JSON.stringify(value)}; input.dispatchEvent(new Event('input', { bubbles: true })); })()`)
}
async function screenshot(window: BrowserWindow, viewport: string) {
  await evaluate(window, 'document.fonts.ready')
  assert.equal(await evaluate(window, 'document.documentElement.scrollWidth <= innerWidth'), true)
  assert.equal(await evaluate(window, `Array.from(document.querySelectorAll('.channel-editor input, .channel-editor select')).filter(input => input.getClientRects().length).every(input => { const rect = input.getBoundingClientRect(); return rect.left >= 0 && rect.right <= innerWidth; })`), true)
  await writeFile(join(directory, `settings-channels-${viewport}.png`), (await window.webContents.capturePage()).toPNG())
}
async function runViewport(origin: string, width: number, height: number) {
  channels = [
    { id: 'qq', label: 'QQ', enabled: false, configured: false, state: 'unconfigured', config: { sandbox: false, markdown: true }, secrets: { secret: false, token: false } },
    { id: 'feishu', label: 'Feishu', enabled: true, configured: true, state: 'connected', config: { appId: 'fixture-feishu' }, secrets: { appSecret: true } },
    { id: 'discord', label: 'Discord', enabled: true, configured: true, state: 'error', message: 'Connection failed. Check credentials and retry.', config: { triggerMode: 'mention' }, secrets: { token: true } },
  ]
  readyProvider = true
  failList = false
  failSave = false
  malformedList = false
  const isolated = session.fromPartition(`settings-${width}`, { cache: false })
  isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(`${origin}/`) }))
  const window = new BrowserWindow({ width, height, show: false, frame: false, useContentSize: true,
    webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  const viewport = width > 700 ? 'desktop' : 'mobile'
  const qq = '[data-channel="qq"]'
  const channelsLink = '.settings-navigation a[href$="/channels"]'
  const providersLink = '.settings-navigation a[href$="/providers"]'
  try {
    await window.loadURL(`${origin}/providers`)
    await waitFor(window, `location.pathname === '/settings/providers' && !!document.querySelector('.provider-card')`)
    assert.equal(await evaluate(window, `Array.from(document.querySelectorAll('.tab-nav .tab')).some(item => item.textContent.trim() === 'Providers')`), false)
    assert.equal(await evaluate(window, `Array.from(document.querySelectorAll('.tab-nav .tab')).some(item => item.textContent.trim() === 'Settings')`), true)
    const cancellations = cancelledLogins.size
    await click(window, '.provider-setup .method-tabs button:first-child')
    await click(window, '.provider-setup .actions .primary')
    await waitFor(window, `!!document.querySelector('.device-panel')`)
    await click(window, channelsLink)
    await waitFor(window, `document.querySelectorAll('.channel-row').length === 3`)
    await waitFor(window, `!document.querySelector('.device-panel')`)
    assert.equal(cancelledLogins.size, cancellations + 1, 'Switching to Channels cancels pending provider login')
    assert.equal(await evaluate(window, `document.querySelector('[data-channel="feishu"] .channel-state').textContent.trim()`), 'Connected')
    assert.equal(await evaluate(window, `document.querySelector('[data-channel="discord"] .channel-state').textContent.trim()`), 'Needs attention')
    await click(window, `${qq} .channel-actions button`)
    await field(window, `${qq} input[name="appId"]`, 'synthetic-qq-id')
    await field(window, `${qq} input[name="secret"]`, 'synthetic-qq-secret')
    await click(window, providersLink)
    const hiddenReads = channelReads
    await new Promise(resolve => setTimeout(resolve, 5200))
    assert.equal(channelReads, hiddenReads, 'Hidden channels do not keep polling')
    await click(window, channelsLink)
    assert.equal(await evaluate(window, `document.querySelector('${qq} input[name="secret"]').value`), 'synthetic-qq-secret', 'Switching settings sections preserves unsaved input')
    await screenshot(window, viewport)
    holdSave = true
    finishSave = undefined
    await click(window, `${qq} .channel-primary`)
    await waitFor(window, `document.querySelector('${qq} fieldset').disabled`)
    const deadline = Date.now() + 5000
    while (!finishSave && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 20))
    assert.ok(finishSave)
    finishSave()
    await waitFor(window, `document.querySelector('${qq} .channel-state').textContent.trim() === 'Connecting'`)
    assert.equal(await evaluate(window, `document.querySelector('${qq} input[name="secret"]').value`), '')
    assert.match(await evaluate<string>(window, `document.querySelector('${qq} input[name="secret"]').placeholder`), /Saved/)
    channels[0].state = 'connected'
    await click(window, '.channels-heading button')
    await waitFor(window, `document.querySelector('${qq} .channel-state').textContent.trim() === 'Connected'`)
    await click(window, `${qq} .channel-actions button:last-child`)
    await waitFor(window, `document.querySelector('${qq} .channel-state').textContent.trim() === 'Disconnected'`)
    assert.deepEqual(patches.at(-1), { id: 'qq', config: { enabled: false } })
    await click(window, '[data-channel="feishu"] .channel-actions button')
    failSave = true
    await click(window, '[data-channel="feishu"] .channel-primary')
    await waitFor(window, `document.querySelector('[data-channel="feishu"] [role="alert"]')?.textContent.includes('Check the channel')`)
    assert.equal(Object.hasOwn(patches.at(-1)!.config, 'appSecret'), false, 'Saved credential is retained when the input is blank')
    failSave = false
    malformedList = true
    await click(window, '.channels-heading button')
    await waitFor(window, `document.querySelector('.channels-view [role="alert"]')?.textContent.includes('invalid channel')`)
    assert.equal(await evaluate(window, `document.querySelectorAll('.channel-row').length`), 3, 'Malformed refresh preserves last known rows with an explicit error')
    malformedList = false
    failList = true
    await window.reload()
    await waitFor(window, `document.querySelector('.channels-view [role="alert"]')?.textContent.includes('unavailable')`)
    failList = false
    await click(window, '.channels-view [role="alert"] button')
    await waitFor(window, `document.querySelectorAll('.channel-row').length === 3`)
    readyProvider = false
    await window.reload()
    await waitFor(window, `document.querySelectorAll('.channel-row').length === 3`)
    assert.equal(await evaluate(window, `location.pathname`), '/settings/channels', 'Channel setup remains available before a model provider is ready')
  } finally { window.destroy() }
}
async function main() {
  try {
    await app.whenReady()
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const origin = `http://127.0.0.1:${address.port}`
    await runViewport(origin, 1440, 1000)
    await runViewport(origin, 390, 844)
    assert.deepEqual(failures, [])
    console.log(`LAYOUT_RESULT ${JSON.stringify({ ok: true, channelReads, patches: patches.length })}`)
  } catch (error) {
    console.error(error)
    console.log(`LAYOUT_RESULT ${JSON.stringify({ ok: false, error: String(error), failures })}`)
    process.exitCode = 1
  } finally {
    finishSave?.()
    server.closeAllConnections()
    server.close()
    app.exit(Number(process.exitCode ?? 0))
  }
}
void main()
