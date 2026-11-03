import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { app, BrowserWindow, ipcMain, nativeImage, type Task } from 'electron'
import { DesktopMicroApps } from '../../src/micro-apps.ts'
import { createMicroAppWindow } from '../../src/micro-app-window.ts'
import { installMicroAppIpc } from '../../src/micro-app-ipc.ts'
import { parseMicroAppArguments, type MicroAppIdentity } from '../../src/micro-app-contract.ts'
import { installRuntimeRequestAuthorization } from '../../src/runtime-authorization.ts'

const output = process.env.MICROAPPS_NATIVE_OUTPUT!
const profile = join(output, 'profile')
app.setPath('userData', profile)
if (process.platform === 'win32') app.setAppUserModelId(`com.shadow.test.microapp.${createHash('sha256').update(profile).digest('hex').slice(0, 12)}`)
app.on('window-all-closed', () => {})
let launchFromTask: ((identity: MicroAppIdentity) => Promise<void>) | undefined
let taskLaunches = 0
const primary = app.requestSingleInstanceLock()
if (!primary) app.quit()
else {
  app.on('second-instance', (_event, args) => {
    const identity = parseMicroAppArguments(args)
    if (identity && launchFromTask) {
      void launchFromTask(identity).then(() => { taskLaunches++ }).catch(error => { console.error(error); app.exit(1) })
    }
  })
  void main().then(() => app.exit(0), error => { console.error(error); app.exit(1) })
}

async function main() {
  await app.whenReady()
  const cold = parseMicroAppArguments(process.argv)
  const window = new BrowserWindow({ show: false, width: 1200, height: 850, webPreferences: {
    preload: join(output, 'preload.cjs'), contextIsolation: true, sandbox: true, nodeIntegration: false,
  } })
  const execute = (code: string) => window.webContents.executeJavaScript(code)
  const authorization = { apiBase: new URL(process.env.MICROAPPS_NATIVE_URL!).origin, launchToken: process.env.MICROAPPS_NATIVE_CHILD_ID ? 'fixture-child-secret' : 'synthetic-owner' }
  const update = installRuntimeRequestAuthorization(window.webContents.session, details => details.webContentsId === window.webContents.id)
  update(authorization)
  let appWindow: BrowserWindow | undefined
  let tasks: Task[] = [], actualTasks = false
  const errors: string[] = []
  const manager = new DesktopMicroApps({
    userDataPath: profile, executablePath: process.execPath, appPath: process.argv[1]!, packaged: false,
    defaultIconPath: join(output, 'fallback.ico'),
    createWindow: input => createMicroAppWindow(options => { appWindow = new BrowserWindow(options); return appWindow }, input),
    decodeIcon: bytes => {
      const image = nativeImage.createFromBuffer(bytes); assert.equal(image.isEmpty(), false)
      return { png: image.toPNG(), ...image.getSize() }
    },
    setUserTasks: value => {
      tasks = value
      const ok = app.setUserTasks(value)
      actualTasks ||= ok && value.length > 0
      return ok
    },
    onError: message => errors.push(message),
  })
  const disposeIpc = installMicroAppIpc(ipcMain, () => window, manager)
  manager.setAuthorization(authorization)
  launchFromTask = identity => manager.open(identity)
  const wait = async (predicate: () => Promise<unknown> | unknown, label: string) => {
    const end = Date.now() + 12_000
    while (Date.now() < end) { if (await predicate()) return; await delay(40) }
    const state = appWindow && !appWindow.isDestroyed() ? { id: appWindow.id, visible: appWindow.isVisible(), minimized: appWindow.isMinimized() } : null
    throw new Error(label + '\n' + JSON.stringify({ window: state, errors }) + '\n' + await execute('document.body.innerText'))
  }
  const button = (text: string) => `[...document.querySelectorAll('button')].find(b=>b.getClientRects().length&&b.textContent.trim()===${JSON.stringify(text)})`
  const click = async (text: string) => {
    await wait(() => execute(`!!${button(text)}&&!${button(text)}.disabled`), text)
    await execute(`${button(text)}.click()`)
  }
  let succeeded = false
  try {
    if (process.env.MICROAPPS_NATIVE_CHILD_ID) {
      const identity = { projectId: 'default', appId: process.env.MICROAPPS_NATIVE_CHILD_ID }
      const base = `${authorization.apiBase}/projects/default/api/microapps/${identity.appId}`
      const post = (action: string, body: unknown) => fetch(`${base}/${action}`, { method: 'POST', headers: { Authorization: `Bearer ${authorization.launchToken}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) })
      await window.loadURL('data:text/html,<a id="message-app-link">Open published app</a><output></output>')
      await execute(`document.querySelector('a').onclick=()=>window.shadowDesktop.microApps.open(${JSON.stringify(identity)}).then(()=>document.querySelector('output').textContent='opened',()=>document.querySelector('output').textContent='review');void 0`)
      const messageOpen = () => execute(`document.querySelector('output').textContent='';document.querySelector('a').click()`)
      await messageOpen()
      await wait(() => execute(`document.querySelector('output').textContent==='review'`), 'Child pending approval stays in review')
      assert.equal(appWindow, undefined)
      const status = await (await fetch(base + '/status', { headers: { Authorization: `Bearer ${authorization.launchToken}` } })).json() as { revision: string }
      assert.equal((await post('approve', { revision: status.revision, confirm: true })).status, 200)
      await messageOpen()
      await wait(() => execute(`document.querySelector('output').textContent==='opened'`), 'Child message IPC open')
      const native = appWindow!
      const origin = new URL(native.webContents.getURL()).origin
      assert.notEqual(origin, authorization.apiBase)
      // Main and Child share loopback in this fixture: explicitly reject accidentally loading Main's own origin.
      const mainLaunch = await fetch(`${process.env.MICROAPPS_NATIVE_MAIN_URL}/projects/default/api/microapps/${identity.appId}/open`, {
        method: 'POST', headers: { Authorization: 'Bearer fixture-main-secret', 'Content-Type': 'application/json' }, body: JSON.stringify({ revision: status.revision }),
      })
      assert.equal(mainLaunch.status, 200)
      assert.notEqual(origin, new URL((await mainLaunch.json() as { url: string }).url).origin, 'Native document must use Child relay, not Main loopback')
      assert.equal(native.getParentWindow(), null)
      assert.notEqual(native.webContents.session, window.webContents.session)
      assert.equal(await native.webContents.executeJavaScript('typeof window.shadowDesktop'), 'undefined')
      await wait(() => native.webContents.executeJavaScript(`document.querySelector('output').textContent==='state:0'`), 'Real document and SDK connect/state read through Child')
      assert.equal(new URL(native.webContents.getURL()).hash, '')
      await native.webContents.executeJavaScript(`document.querySelector('#save').click()`)
      await wait(() => native.webContents.executeJavaScript(`document.querySelector('output').textContent==='saved:1'`), 'SDK save through Child')
      await messageOpen()
      await wait(() => execute(`document.querySelector('output').textContent==='opened'`), 'Repeated IPC open')
      await wait(() => native.isFocused(), 'Child native focus reuse')
      assert.equal(appWindow!.id, native.id)
      native.close()
      await wait(async () => (await (await fetch(base + '/status', { headers: { Authorization: `Bearer ${authorization.launchToken}` } })).json()).status === 'stopped', 'Remote Main runtime stopped on close')
      await messageOpen()
      await wait(() => execute(`document.querySelector('output').textContent==='opened'`), 'Child reopens')
      const reopened = appWindow!, newOrigin = new URL(reopened.webContents.getURL()).origin
      assert.notEqual(newOrigin, origin)
      await wait(() => reopened.webContents.executeJavaScript(`document.querySelector('output').textContent==='state:1'`), 'State persisted on Main across runs')
      assert.equal((await post('revoke', {})).status, 200)
      await assert.rejects(fetch(newOrigin), /fetch failed/)
      await manager.refresh()
      await wait(() => reopened.isDestroyed(), 'Revocation closes Child native window')
      await messageOpen()
      await wait(() => execute(`document.querySelector('output').textContent==='review'`), 'Revoked version cannot reopen')
      assert.deepEqual(errors, [])
      console.log('NATIVE_CHILD_APPS_OK')
      succeeded = true
      return
    }
    if (cold) {
      await manager.open(cold)
      assert.ok(appWindow && !appWindow.isDestroyed())
      assert.equal(appWindow.isVisible(), true)
      assert.equal(appWindow.getTitle(), 'Branded native app')
      assert.equal(await appWindow.webContents.executeJavaScript('typeof window.shadowDesktop'), 'undefined')
      console.log('NATIVE_COLD_OK')
      succeeded = true
      return
    }
    await window.loadURL(new URL('__native', process.env.MICROAPPS_NATIVE_URL).href)
    await wait(() => execute('!!document.querySelector("#message-app-link")'), 'Published message link')
    await execute('document.querySelector("#message-app-link").click()')
    await wait(() => execute('!!document.querySelector(".app-confirm input")'), 'Owner review')
    assert.equal(appWindow, undefined, 'Pending approval must not launch code')
    assert.equal(await execute('!!document.querySelector(".app-detail")'), true)
    await execute('document.querySelector(".app-confirm input").click()')
    await click('Approve this version')
    await click('Open window')
    await wait(() => !!appWindow && !appWindow.isDestroyed() && appWindow.isVisible(), 'Independent window')
    const native = appWindow!
    assert.equal(await execute('document.querySelector("iframe")'), null)
    assert.equal(native.getParentWindow(), null)
    assert.equal(native.getTitle(), 'Branded native app')
    const preferences = native.webContents.getLastWebPreferences()
    assert.equal(preferences.preload, undefined)
    assert.equal(preferences.nodeIntegration, false); assert.equal(preferences.sandbox, true)
    assert.notEqual(native.webContents.session, window.webContents.session)
    assert.equal(await native.webContents.executeJavaScript('typeof require'), 'undefined')
    assert.equal(await native.webContents.executeJavaScript('typeof window.shadowDesktop'), 'undefined')
    await native.webContents.executeJavaScript('document.querySelector("#run").click()')
    await wait(() => native.webContents.executeJavaScript('document.querySelector("output").textContent==="Result 1"'), 'Scoped model request')
    assert.equal(new URL(native.webContents.getURL()).hash, '')
    const reloaded = once(native.webContents, 'did-finish-load')
    native.webContents.reload()
    await reloaded
    await native.webContents.executeJavaScript('document.title="Changed page title"')
    await delay(80)
    assert.equal(native.getTitle(), 'Branded native app')
    await native.webContents.executeJavaScript('document.querySelector("#run").click()')
    await wait(() => native.webContents.executeJavaScript('document.querySelector("output").textContent==="Result 2"'), 'Reloaded app access')
    await execute('document.querySelector("#message-app-link").click()')
    await wait(() => execute('!!document.querySelector(".app-heading") && document.querySelector(".app-heading").textContent.includes("Running")'), 'Approved message link launch')
    await wait(() => appWindow!.isFocused(), 'Repeated message link focuses native window')
    assert.equal(appWindow!.id, native.id)
    await manager.refresh()
    assert.deepEqual(errors, [])
    if (process.platform === 'win32') {
      assert.equal(tasks.length, 1)
      assert.equal(actualTasks, true)
      assert.equal(nativeImage.createFromPath(tasks[0]!.iconPath!).isEmpty(), false)
      assert.ok(!JSON.stringify(tasks).includes('synthetic-owner'))
      const child = spawn(process.execPath, [tasks[0]!.arguments!], {
        cwd: dirname(process.execPath), env: process.env, windowsVerbatimArguments: true, stdio: 'ignore',
      })
      const [code] = await once(child, 'close'); assert.equal(code, 0)
      await wait(() => taskLaunches === 1, 'Windows task focused the existing instance')
      assert.equal(appWindow!.id, native.id)
    }
    native.close()
    await wait(() => !manager.hasOpenWindows, 'Native window closed')
    await click('Refresh')
    await wait(() => execute('document.querySelector(".app-heading").textContent.includes("Stopped")'), 'Closing stopped the backend')
    await click('Open window')
    await wait(() => appWindow!.id !== native.id && appWindow!.isVisible(), 'Fresh runtime after close')
    await click('Review details')
    await click('Revoke access and stop')
    await wait(() => !manager.hasOpenWindows, 'Revoked app window closes')
    await manager.refresh()
    if (process.platform === 'win32') assert.equal(tasks.length, 0)
    await execute('document.querySelector(".app-confirm input").click()')
    await click('Approve this version')
    await manager.refresh()
    for (const theme of ['light', 'dark']) for (const width of [1200, 390]) {
      await execute(`document.documentElement.classList.toggle("dark", ${theme === 'dark'})`)
      window.setContentSize(width, 850)
      await delay(100)
      assert.equal(await execute('document.documentElement.scrollWidth<=document.documentElement.clientWidth'), true)
      assert.equal(await execute('document.querySelector(".app-heading-identity img").naturalWidth>0'), true)
      if (process.env.MICROAPPS_SCREENSHOTS) await writeFile(join(process.env.MICROAPPS_SCREENSHOTS, `native-apps-${theme}-${width}.png`), (await window.webContents.capturePage()).toPNG())
    }
    await writeFile(join(output, 'native-proof.json'), JSON.stringify({
      independentWindow: true, noIframe: true, customIcon: true, realWindowsTasks: actualTasks,
      warmTaskLaunches: taskLaunches, credentialFreeTasks: !JSON.stringify(tasks).includes('synthetic-owner'),
    }))
    const cancelled = new AbortController()
    let loadingWindow: BrowserWindow | undefined, closed = 0
    const loading = createMicroAppWindow(options => {
      loadingWindow = new BrowserWindow(options)
      loadingWindow.webContents.once('did-start-loading', () => { setTimeout(() => cancelled.abort(), 100) })
      return loadingWindow
    }, { name: 'Cancelled app', iconPath: tasks[0]?.iconPath ?? '', partition: 'cancelled-test',
      url: new URL('__hang#shadow_ticket=private-test-ticket', process.env.MICROAPPS_NATIVE_URL).href,
      signal: cancelled.signal, onClosed: () => { closed++ } })
    await assert.rejects(loading, { message: 'Micro App window could not load. Reopen it from Shadow Apps.' })
    assert.equal(loadingWindow?.isDestroyed(), true)
    assert.equal(closed, 1)
    assert.deepEqual(errors, [])
    console.log('NATIVE_APPS_OK')
    succeeded = true
  } finally {
    disposeIpc(); launchFromTask = undefined
    await manager.shutdown()
    update(null)
    if (process.platform === 'win32' && (cold || !succeeded)) app.setUserTasks([])
    window.destroy()
  }
}
