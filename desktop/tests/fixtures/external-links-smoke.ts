import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { join, resolve } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow } from 'electron'
import { installNavigationPolicy } from '../../src/navigation.js'
import { resolveRendererTarget } from '../../src/renderer-target.js'

const root = process.argv.find(value => value.startsWith('--layout-root='))?.slice('--layout-root='.length)
assert.ok(root)
const directory = resolve(root)
for (const name of ['userData', 'sessionData', 'logs', 'crashDumps'] as const) {
  mkdirSync(join(directory, name), { recursive: true })
  app.setPath(name, join(directory, name))
}
app.setPath('home', directory)
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
app.on('window-all-closed', () => {})

async function main() {
  await app.whenReady()
  const html = `<a id="blank" href="https://example.com/docs?q=shadow#section" target="_blank" rel="noopener noreferrer"><strong>Documentation</strong></a>
    <a id="same" href="http://example.com/same">Same-window link</a>
    <a id="failure" href="https://example.com/fail" target="_blank">Failure</a>
    <a id="internal" href="#/chat/synthetic">Internal route</a>
    <a id="blocked" href="file:///C:/not-a-real-file.txt" target="_blank">Blocked file</a>`
  writeFileSync(join(directory, 'index.html'), html)
  const server = createServer((_request, response) => {
    response.setHeader('Content-Type', 'text/html')
    response.end(html)
  }).listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try {
    for (const developmentUrl of [undefined, `http://127.0.0.1:${address.port}`]) {
      const target = resolveRendererTarget({ rendererDistPath: directory, developmentUrl })
      const window = new BrowserWindow({ show: false, webPreferences: {
        sandbox: true, contextIsolation: true, nodeIntegration: false,
      } })
      const opened: string[] = []
      const errors: unknown[] = []
      const failure = new Error('Synthetic browser launch failure')
      installNavigationPolicy(window.webContents, target, async url => {
        opened.push(url)
        if (url.endsWith('/fail')) throw failure
      }, error => { errors.push(error) })
      const waitFor = async (check: () => boolean) => {
        const deadline = Date.now() + 5000
        while (!check()) {
          assert.ok(Date.now() < deadline, 'Navigation handling timed out')
          await delay(20)
        }
      }
      const click = (selector: string) => window.webContents.executeJavaScript(
        `document.querySelector(${JSON.stringify(selector)}).click()`, true,
      )
      try {
        if (target.kind === 'file') await window.loadFile(target.filePath)
        else await window.loadURL(target.url)
        const original = window.webContents.getURL()
        await click('#blank strong')
        await waitFor(() => opened.length === 1)
        assert.equal(opened[0], 'https://example.com/docs?q=shadow#section')
        await click('#same')
        await waitFor(() => opened.length === 2)
        assert.equal(opened[1], 'http://example.com/same')
        assert.equal(window.webContents.getURL(), original, 'External links cannot replace the renderer')
        await click('#failure')
        await waitFor(() => errors.length === 1)
        assert.equal(errors[0], failure, 'Browser failures must be reported, not swallowed')
        await click('#blocked')
        await delay(100)
        assert.equal(opened.length, 3, 'File URLs are never passed to the OS')
        assert.equal(BrowserWindow.getAllWindows().length, 1, 'No popup BrowserWindow is created')
        await click('#internal')
        await waitFor(() => window.webContents.getURL().endsWith('#/chat/synthetic'))
        assert.equal(opened.length, 3, 'Internal routes stay inside the application')
      } finally {
        window.destroy()
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
  console.log('LAYOUT_RESULT {"ok":true,"externalLinks":"file-and-dev"}')
  app.exit(0)
}

main().catch(error => {
  console.error(error)
  app.exit(1)
})
