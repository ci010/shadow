const { app, BrowserWindow } = require('electron')
const { writeFile } = require('node:fs/promises')
const { join } = require('node:path')

const [dir, url] = process.argv.slice(2)
app.setPath('userData', join(dir, 'profile'))
app.setPath('sessionData', join(dir, 'session'))
app.whenReady().then(async () => {
  const window = new BrowserWindow({ show: false, webPreferences: {
    sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false,
  } })
  window.webContents.on('console-message', event => {
    if (event.level === 'error') console.error(event.message)
  })
  await window.loadURL(url)
  const bytes = await window.webContents.executeJavaScript(
    "(async () => (await import('/src/skills/three-playground-example-browser.ts')).buildExample())()"
  )
  await writeFile(join(dir, 'result.glb'), Buffer.from(bytes))
  app.exit(0)
}).catch(error => { console.error(error); app.exit(1) })
