import assert from 'node:assert/strict'
import { writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import { app, BrowserWindow, ipcMain } from 'electron'
import { installMediaPermissions } from '../../src/media-permissions.js'
import { resolveRendererTarget } from '../../src/renderer-target.js'
import { secureWebPreferences } from '../../src/window-controls.js'

app.commandLine.appendSwitch('use-fake-device-for-media-stream')
const root = process.cwd()
app.setPath('userData', join(root, 'profile'))
app.on('window-all-closed', () => {})

async function main(): Promise<void> {
  const html = '<!doctype html><html><title>Media permission fixture</title><body>Trusted host fixture</body></html>'
  await writeFile(join(root, 'index.html'), html)
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html', 'access-control-allow-origin': '*' })
    response.end(html)
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    for (const kind of ['file', 'url'] as const) {
      const target = resolveRendererTarget({
        rendererDistPath: root,
        ...(kind === 'url' ? { developmentUrl: `http://127.0.0.1:${address.port}/` } : {}),
      })
      const window = new BrowserWindow({
        show: false,
        webPreferences: secureWebPreferences(join(root, 'media-permissions-preload.cjs')),
      })
      const clipboardDecisions: Array<{ permission: string; allowed: boolean }> = []
      const permissions = window.webContents.session
      const setPermissionRequestHandler = permissions.setPermissionRequestHandler.bind(permissions)
      permissions.setPermissionRequestHandler = handler => {
        setPermissionRequestHandler(handler && ((sender, permission, callback, details) => {
          handler(sender, permission, allowed => {
            if (permission.startsWith('clipboard')) {
              clipboardDecisions.push({ permission, allowed })
              // Exercise Chromium's permission request without touching the OS clipboard.
              callback(false)
            } else callback(allowed)
          }, details)
        }))
      }
      let selections = 0
      installMediaPermissions(ipcMain, window, target, {
        chooseDisplaySource: async () => { selections++; return undefined },
      })
      try {
        if (target.kind === 'file') await window.loadFile(target.filePath)
        else await window.loadURL(target.url)
        const execute = (code: string, gesture = false) => window.webContents.executeJavaScript(code, gesture)
        window.webContents.debugger.attach('1.3')
        await window.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true })
        const checkClipboard = async (allowed = true) => {
          clipboardDecisions.length = 0
          await execute(`navigator.clipboard.writeText('Synthetic copy probe').catch(error => error.name)`, true)
          assert.deepEqual(clipboardDecisions, [{ permission: 'clipboard-sanitized-write', allowed }], `${kind}: only the trusted Main document may copy, without arming media`)
          clipboardDecisions.length = 0
          await execute(`navigator.clipboard.readText().then(() => 'allowed', error => error.name)`, true)
          assert.ok(clipboardDecisions.length > 0, `${kind}: clipboard read reaches the permission gate`)
          assert.ok(clipboardDecisions.every(decision => !decision.allowed), `${kind}: Copy does not grant clipboard read`)
        }
        assert.equal(await execute(`mediaCapture.arm({runId:'run-1',capabilities:['microphone','screen'],durationMs:10000}).then(()=>'armed',()=> 'denied')`), 'denied', `${kind}: require activation`)
        await checkClipboard()
        assert.equal(await execute(`fetch('http://127.0.0.1:${address.port}/').then(r => r.ok)`), true, `${kind}: local backend remains reachable`)
        const denied = `navigator.mediaDevices.getUserMedia({audio:true}).then(s => {s.getTracks().forEach(t => t.stop()); return 'allowed'}, e => e.name)`
        assert.equal(await execute(denied), 'NotAllowedError', `${kind}: no automatic microphone grant`)
        await execute(`history.replaceState({}, '', ${JSON.stringify(kind === 'url' ? '/projects/fixture/conversations/one?view=chat' : '#/projects/fixture/conversations/one')})`)
        await checkClipboard()
        assert.match(await execute(`(async () => {
          await mediaCapture.arm({runId:'run-1',capabilities:['microphone','screen'],durationMs:10000});
          return navigator.mediaDevices.getDisplayMedia({video:true,audio:false})
            .then(s => {s.getTracks().forEach(t => t.stop());return 'allowed'}, e => e.name);
        })()`, true), /^(NotAllowedError|AbortError)$/, `${kind}: Start activation survives only the grant IPC before picker cancellation`)
        assert.equal(selections, 1, `${kind}: screen went through trusted chooser without a second gesture`)
        assert.equal(await execute(denied), 'allowed', `${kind}: user-armed microphone capture`)
        await execute(`history.pushState({}, '', ${JSON.stringify(kind === 'url' ? '/projects/fixture/conversations/two?view=chat#capture' : '#/projects/fixture/conversations/two')})`)
        assert.equal(await execute(denied), 'allowed', `${kind}: same-document conversation navigation retains the explicit grant`)
        assert.deepEqual(await execute(`new Promise(resolve => {
          const frame = document.createElement('iframe');
          frame.src = location.href;
          frame.onload = async () => {
            const preload = typeof frame.contentWindow.mediaCapture;
            const result = await frame.contentWindow.navigator.mediaDevices.getUserMedia({audio:true})
              .then(s => {s.getTracks().forEach(t => t.stop()); return 'allowed'}, e => e.name);
            frame.remove();
            resolve({preload, result});
          };
          document.body.append(frame);
        })`), { preload: 'undefined', result: 'NotAllowedError' }, `${kind}: subframes cannot inherit a grant or preload`)
        assert.equal(await execute(`navigator.mediaDevices.getUserMedia({video:true}).then(s => {s.getTracks().forEach(t => t.stop());return 'allowed'}, e => e.name)`), 'NotAllowedError', `${kind}: camera not granted`)
        await execute(`mediaCapture.revoke({runId:'run-1'})`)
        assert.equal(await execute(denied), 'NotAllowedError', `${kind}: revocation prevents reacquisition`)
        const cameraWithAudio = `navigator.mediaDevices.getUserMedia({video:true,audio:true}).then(s => {s.getTracks().forEach(t => t.stop());return 'allowed'}, e => e.name)`
        await execute(`mediaCapture.arm({runId:'camera-only',capabilities:['camera'],durationMs:10000})`, true)
        assert.equal(await execute(cameraWithAudio), 'NotAllowedError', `${kind}: camera does not imply microphone permission`)
        await execute(`mediaCapture.revoke({runId:'camera-only'})`)
        await execute(`mediaCapture.arm({runId:'camera-microphone',capabilities:['camera','microphone'],durationMs:10000})`, true)
        assert.equal(await execute(cameraWithAudio), 'allowed', `${kind}: camera audio requires both explicit capabilities`)
        await execute(`mediaCapture.revoke({runId:'camera-microphone'})`)
        await execute(`mediaCapture.arm({runId:'run-2',capabilities:['microphone'],durationMs:10000})`, true)
        const loaded = new Promise<void>((resolve) => window.webContents.once('did-finish-load', resolve))
        window.reload()
        await loaded
        assert.equal(await execute(denied), 'NotAllowedError', `${kind}: reload clears grants`)
        await execute(`mediaCapture.arm({runId:'run-3',capabilities:['microphone'],durationMs:20})`, true)
        await new Promise((resolve) => setTimeout(resolve, 30))
        assert.equal(await execute(denied), 'NotAllowedError', `${kind}: deadline prevents reacquisition`)
        if (target.kind === 'url') {
          await window.loadURL(`${target.origin}/untrusted-document`)
          await checkClipboard(false)
          const arm = `mediaCapture.arm({runId:'untrusted',capabilities:['microphone'],durationMs:10000}).then(()=>'armed',()=> 'denied')`
          assert.equal(await execute(arm, true), 'denied', 'same origin alone cannot arm media capture')
          await execute(`history.replaceState({}, '', '/')`)
          await checkClipboard(false)
          assert.equal(await execute(arm, true), 'denied', 'an untrusted document cannot gain trust by changing its URL')
          await window.loadURL(target.url)
          await checkClipboard()
          assert.equal(await execute(arm, true), 'armed', 'loading the verified entry restores document trust')
          assert.equal(await execute(denied), 'allowed', 'the new trusted entry can capture after a fresh Start')
        }
        console.log(`MEDIA_PERMISSIONS_OK ${kind}`)
      } finally {
        window.destroy()
        permissions.setPermissionRequestHandler = setPermissionRequestHandler
      }
    }
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()))
  }
}

void app.whenReady().then(main).then(() => app.exit(0), (error) => {
  console.error(error)
  app.exit(1)
})
