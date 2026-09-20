import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { app, BrowserWindow, session } from 'electron'
import { Hono } from 'hono'
import { uiPlugin } from '../../../src/gateway/ui.ts'

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
const failures: string[] = []
const project = { id: 'default', name: 'Button fixture', createdAt: '2026-09-16T00:00:00Z' }
let saves = 0
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url!, 'http://127.0.0.1')
    const json = (data: unknown, status = 200) => {
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' })
      response.end(JSON.stringify(data))
    }
    if (url.pathname === '/api/provider/setup') return json({ ready: true, provider: 'custom', model: 'fixture-model', authMode: 'none', hasApiKey: false })
    if (url.pathname === '/api/projects') return json({ projects: [project] })
    if (url.pathname === '/projects/default/api/config') return json({ agent: { model: 'fixture-model', workspace: directory, temperature: 0.7 } })
    if (url.pathname === '/api/projects/default' && request.method === 'PATCH') {
      let text = ''
      for await (const chunk of request) text += chunk
      assert.deepEqual(JSON.parse(text), { name: project.name })
      saves++
      return json({ project })
    }
    if (/^\/(?:api|projects\/default\/api|debug)\//.test(url.pathname)) {
      failures.push(`Unexpected ${request.method} ${url.pathname}`)
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
async function runViewport(origin: string, width: number, height: number) {
  const isolated = session.fromPartition(`buttons-${width}`, { cache: false })
  isolated.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !details.url.startsWith(`${origin}/`) }))
  const window = new BrowserWindow({ width, height, show: false, frame: false, useContentSize: true,
    webPreferences: { session: isolated, sandbox: true, contextIsolation: true, nodeIntegration: false, offscreen: true, backgroundThrottling: false } })
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('render-process-gone', (_event, details) => failures.push(`Renderer exited: ${details.reason}`))
  try {
    await window.loadURL(`${origin}/projects/default/settings/general`)
    window.webContents.debugger.attach('1.3')
    await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
    await waitFor(window, `document.querySelector('.settings-content form .btn')?.disabled === false`)
    await evaluate(window, `(() => {
      const examples = document.createElement('div');
      examples.id = 'button-examples';
      examples.style.cssText = 'display:flex;gap:8px;flex-wrap:wrap;margin-top:24px';
      examples.innerHTML = '<button class="btn">Secondary action</button><button class="btn ghost">Ghost action</button><button class="btn btn-sm">Compact</button><button class="btn" disabled>Disabled</button>';
      document.querySelector('.settings-content').append(examples);
    })()`)
    for (const theme of ['light', 'dark']) {
      await evaluate(window, `document.documentElement.classList.toggle('dark', ${theme === 'dark'})`)
      await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      await window.webContents.debugger.sendCommand('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 })
      await evaluate(window, `document.querySelector('.settings-content form .btn').focus()`)
      const result = await evaluate<{
        primary: string; secondary: string; ghost: string; font: string; appearance: string
        border: string; focus: string; disabled: string; disabledOpacity: string; height: number
        iconWidth: number; iconHeight: number; iconBackground: string; bounded: boolean
      }>(window, `(() => {
        const button = document.querySelector('.settings-content form .btn');
        const style = getComputedStyle(button), rect = button.getBoundingClientRect();
        const examples = document.querySelector('#button-examples');
        const disabled = getComputedStyle(examples.querySelector(':disabled'));
        const icon = document.querySelector('.theme-toggle'), iconRect = icon.getBoundingClientRect();
        return {
          primary: style.backgroundColor, secondary: getComputedStyle(examples.children[0]).backgroundColor,
          ghost: getComputedStyle(examples.children[1]).backgroundColor, font: style.fontSize,
          appearance: style.appearance, border: style.borderTopStyle, focus: style.outlineStyle,
          disabled: disabled.cursor, disabledOpacity: disabled.opacity, height: rect.height,
          iconWidth: iconRect.width, iconHeight: iconRect.height, iconBackground: getComputedStyle(icon).backgroundColor,
          bounded: document.documentElement.scrollWidth <= innerWidth &&
            [...examples.children, button].every(item => { const r = item.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth; })
        };
      })()`)
      assert.equal(result.primary, theme === 'dark' ? 'rgb(42, 42, 44)' : 'rgb(26, 26, 46)')
      assert.equal(result.secondary, theme === 'dark' ? 'rgb(22, 22, 23)' : 'rgb(255, 255, 255)')
      assert.equal(result.ghost, 'rgba(0, 0, 0, 0)')
      assert.equal(result.font, '13px')
      assert.equal(result.appearance, 'none')
      assert.equal(result.border, 'solid')
      assert.equal(result.focus, 'solid', 'Keyboard focus remains visible')
      assert.equal(result.disabled, 'not-allowed')
      assert.equal(result.disabledOpacity, '0.5')
      assert.ok(result.height >= (width < 700 ? 44 : 36))
      assert.equal(result.iconWidth, 28)
      assert.equal(result.iconHeight, 28)
      assert.equal(result.iconBackground, 'rgba(0, 0, 0, 0)')
      assert.equal(result.bounded, true)
      for (const selector of ['#button-examples > :first-child', '#button-examples > :disabled']) {
        const point = await evaluate<{ x: number; y: number }>(window, `(() => {
          const rect = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();
          return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
        })()`)
        await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', ...point })
        const background = await evaluate(window, `getComputedStyle(document.querySelector(${JSON.stringify(selector)})).backgroundColor`)
        assert.equal(background, selector.endsWith(':disabled') ? result.secondary
          : theme === 'dark' ? 'rgb(36, 36, 37)' : 'rgb(243, 244, 246)', 'Hover feedback excludes disabled controls')
      }
      await window.webContents.debugger.sendCommand('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 1, y: 1 })
      await writeFile(join(directory, `buttons-${theme}-${width}.png`), (await window.webContents.capturePage()).toPNG())
      console.log(`LAYOUT_BUTTONS ${JSON.stringify({ width, theme, ...result })}`)
    }
    const before = saves
    await evaluate(window, `document.querySelector('.settings-content form .btn').click()`)
    await waitFor(window, `document.querySelector('.settings-notice')?.textContent === 'Project name saved.'`)
    assert.equal(saves, before + 1, 'Global styling preserves native submit behavior')
    await evaluate(window, `(() => {
      const input = document.querySelector('.settings-field input');
      input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true }));
    })()`)
    await waitFor(window, `document.querySelector('.settings-content form .btn').disabled`)
    await evaluate(window, `document.querySelector('.settings-content form .btn').click()`)
    assert.equal(saves, before + 1, 'Disabled submit remains inert')
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
    console.log(`LAYOUT_RESULT ${JSON.stringify({ ok: true, fixture: 'button-styles', saves })}`)
  } catch (error) {
    console.error(error)
    console.log(`LAYOUT_RESULT ${JSON.stringify({ ok: false, error: String(error), failures })}`)
    process.exitCode = 1
  } finally {
    server.closeAllConnections()
    server.close()
    app.exit(Number(process.exitCode ?? 0))
  }
}
void main()
