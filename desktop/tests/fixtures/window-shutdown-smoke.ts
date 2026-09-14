import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { installDocumentTabShortcuts } from '../../src/document-tabs.js'
import { installWindowControls } from '../../src/window-controls.js'
import { installProjectDirectoryPicker } from '../../src/project-directories.js'
import { installChatContextPickers } from '../../src/chat-context.js'

const argument = process.argv.find(value => value.startsWith('--layout-root='))?.slice('--layout-root='.length)
assert.ok(argument)
const directory = resolve(argument)
for (const name of ['userData', 'sessionData', 'logs', 'crashDumps'] as const) {
  mkdirSync(join(directory, name), { recursive: true })
  app.setPath(name, join(directory, name))
}
app.setPath('home', directory)
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
app.on('window-all-closed', () => {})

function fail(error: unknown) {
  console.error(error)
  console.log(`LAYOUT_RESULT ${JSON.stringify({ ok: false, error: String(error) })}`)
  app.exit(1)
}
process.on('uncaughtException', fail)

async function main() {
  await app.whenReady()
  for (const action of ['close', 'destroy'] as const) {
    for (const loaded of [false, true]) {
      const window = new BrowserWindow({ show: false, webPreferences: {
        sandbox: true, contextIsolation: true, nodeIntegration: false,
      } })
      const contents = window.webContents
      const inputListeners = contents.listenerCount('before-input-event')
      const cleanup = [
        installWindowControls(ipcMain, window),
        installDocumentTabShortcuts(window),
        installProjectDirectoryPicker(ipcMain, window, async () => null),
        installChatContextPickers(ipcMain, window, { selectFiles: async () => [], selectFolders: async () => [] }),
      ]
      let closed = false
      window.once('closed', () => { closed = true })
      if (loaded) await window.loadURL('data:text/html,<title>Isolated shutdown fixture</title>')
      const closing = once(window, 'closed', { signal: AbortSignal.timeout(5000) })
      window[action]()
      await closing
      assert.equal(closed, true, `${action}: remaining closed listeners must run`)
      assert.equal(window.isDestroyed(), true)
      assert.equal(contents.listenerCount('before-input-event'), inputListeners, 'Shortcut listener was removed')
      for (const dispose of cleanup) assert.doesNotThrow(dispose)
      assert.ok(cleanup.every(dispose => !window.listeners('closed').includes(dispose)), 'All application cleanup listeners were removed')
    }
  }
  console.log('LAYOUT_RESULT {"ok":true,"shutdowns":4}')
  app.exit(0)
}
void main().catch(fail)
