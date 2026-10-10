import assert from 'node:assert/strict'
import { mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { app, BrowserWindow, utilityProcess } from 'electron'
import { createUtilityProcessSpawn } from '../../src/sidecar/utility-process.js'
import { NodeSidecarSupervisor } from '../../src/sidecar/supervisor.js'
import { createAuthenticatedShutdownRequest, createSidecarReadinessProbe } from '../../src/sidecar/local-control-client.js'
import { installBackgroundWindow } from '../../src/background-window.js'

function argument(name: string): string {
  const value = process.argv.find(arg => arg.startsWith(`--${name}=`))?.slice(name.length + 3)
  assert.ok(value, name)
  return value
}
const root = argument('fixture-root')
for (const name of ['userData', 'sessionData', 'logs', 'crashDumps'] as const) {
  const path = join(root, name)
  mkdirSync(path, { recursive: true })
  app.setPath(name, path)
}
app.setPath('home', root)
app.commandLine.appendSwitch('disable-background-networking')
app.commandLine.appendSwitch('disable-component-update')
app.on('window-all-closed', () => {})

async function main() {
  await app.whenReady()
  const port = Number(argument('fixture-port'))
  const token = 'synthetic-utility-fixture'
  const supervisor = new NodeSidecarSupervisor({
    spawn: createUtilityProcessSpawn((entry, args, options) => utilityProcess.fork(entry, args, options)),
    environment: {
      ...process.env,
      HOME: root, USERPROFILE: root, APPDATA: root, LOCALAPPDATA: root,
      GITHUB_COPILOT_TOKEN_DIR: join(root, 'empty-auth'),
    },
    readinessProbe: createSidecarReadinessProbe({ expectedRole: 'main' }),
    authenticatedShutdownRequest: createAuthenticatedShutdownRequest(),
  })
  try {
    const status = await supervisor.start({
      role: 'main', executablePath: process.execPath, entryPath: argument('fixture-entry'),
      configPath: argument('fixture-config'), launchToken: token, port,
    })
    assert.equal(status.phase, 'ready', JSON.stringify(status))
    assert.ok(app.getAppMetrics().some(metric => metric.name === 'Shadow Backend' && metric.pid !== process.pid))
    // Backend is already ready before the first renderer exists.
    const window = new BrowserWindow({ show: false, webPreferences: { sandbox: true } })
    const dispose = installBackgroundWindow(app, window)
    await window.loadURL('data:text/html,<title>Utility runtime fixture</title>')
    window.close()
    assert.equal(window.isDestroyed(), false)
    assert.equal(window.isVisible(), false)
    const response = await fetch(`http://127.0.0.1:${port}/local/v1/readiness`, {
      headers: { authorization: `Bearer ${token}` },
    })
    assert.equal(response.status, 200)
    const projects = await (await fetch(`http://127.0.0.1:${port}/api/projects`, {
      headers: { authorization: `Bearer ${token}` },
    })).json()
    assert.ok(projects.projects.length > 0)
    for (const project of projects.projects) {
      const result = await (await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/status`, {
        headers: { authorization: `Bearer ${token}` },
      })).json()
      assert.equal(result.state, 'ready')
    }
    dispose()
    window.destroy()
  } finally {
    await supervisor.stop()
  }
  assert.equal(supervisor.status.phase, 'stopped')
  await assert.rejects(fetch(`http://127.0.0.1:${port}/local/v1/readiness`))
  console.log('UTILITY_RESULT {"ok":true}')
  app.exit(0)
}
void main().catch(error => {
  console.error(error)
  app.exit(1)
})
