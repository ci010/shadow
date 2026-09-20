import assert from 'node:assert/strict'
import test from 'node:test'
import { createRequire } from 'node:module'
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'
import { NodeSidecarSupervisor } from '../src/sidecar/supervisor.ts'
import { createAuthenticatedShutdownRequest, createSidecarReadinessProbe } from '../src/sidecar/local-control-client.ts'
import { StartupDiagnosticsLog, startupLogPath } from '../src/sidecar/startup-diagnostics.ts'
import { ProjectCatalog } from '../../src/projects/catalog.ts'

const repository = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..')
const require = createRequire(import.meta.url)

test('real Electron Node backend repeatedly becomes ready within the desktop budget with four Projects', { timeout: 90_000 }, async t => {
  const entryPath = join(repository, 'dist', 'src', 'index.js')
  await access(entryPath)
  const scratch = join(repository, '.tmp')
  await mkdir(scratch, { recursive: true })
  const directory = await mkdtemp(join(scratch, 'runtime-startup-'))
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))
  const dataDir = join(directory, 'data')
  const home = join(dataDir, 'workspace')
  await mkdir(join(dataDir, 'config'), { recursive: true })
  await mkdir(home)
  const configPath = join(directory, 'runtime-config.json')
  await writeFile(configPath, JSON.stringify({ version: 1, mode: 'main', dataDir, localNodeId: 'startup-fixture' }))
  await writeFile(join(dataDir, 'config', 'bot.config.json'), JSON.stringify({
    agent: { workspace: home, model: 'fixture@openai', sessionStorage: 'sqlite' },
    providers: { openai: { apiKey: 'synthetic-unused', baseUrl: 'http://127.0.0.1:1' } },
    channels: {}, mcp: {},
  }))
  const catalog = new ProjectCatalog(`${home}.projects`, [home])
  await catalog.init()
  for (let index = 0; index < 3; index++) await catalog.create(`Fixture ${index}`)
  const environment: NodeJS.ProcessEnv = {}
  for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT']) {
    if (process.env[name] !== undefined) environment[name] = process.env[name]
  }
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP']) environment[name] = directory
  environment.GITHUB_COPILOT_TOKEN_DIR = join(directory, 'empty-auth')
  environment.SEARXNG_URL = 'http://192.0.2.1:8888'
  const logPath = startupLogPath(join(directory, 'user-data'))
  const log = new StartupDiagnosticsLog(logPath)
  const durations: number[] = []
  for (let attempt = 0; attempt < 3; attempt++) {
    const reservation = createServer().listen(0, '127.0.0.1')
    await once(reservation, 'listening')
    const address = reservation.address()
    assert.ok(address && typeof address !== 'string')
    const port = address.port
    await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
    const logs: string[] = []
    const records: Array<Parameters<StartupDiagnosticsLog['write']>[0]> = []
    const supervisor = new NodeSidecarSupervisor({
      environment,
      readinessProbe: createSidecarReadinessProbe({ expectedRole: 'main' }),
      authenticatedShutdownRequest: createAuthenticatedShutdownRequest(),
      logSink: entry => logs.push(entry.message),
      diagnosticSink: entry => { records.push(entry); log.write(entry) },
    })
    const started = performance.now()
    const launchToken = randomUUID()
    try {
      const status = await supervisor.start({
        role: 'main', executablePath: require('electron') as string, entryPath, configPath,
        launchToken, port,
      })
      durations.push(Math.round(performance.now() - started))
      assert.equal(status.phase, 'ready', `Attempt ${attempt + 1}: ${JSON.stringify(status)}\n${logs.join('\n').slice(-4000)}`)
      assert.ok(durations.at(-1)! < 15_000, 'Must satisfy the unchanged production watchdog')
      const headers = { authorization: `Bearer ${launchToken}` }
      const projects = await (await fetch(`http://127.0.0.1:${port}/api/projects`, { headers })).json()
      assert.equal(projects.projects.length, 4)
      for (const project of projects.projects) {
        const status = await (await fetch(`http://127.0.0.1:${port}/api/projects/${project.id}/status`, { headers })).json()
        assert.equal(status.state, 'ready')
      }
    } finally { await supervisor.stop() }
    assert.doesNotMatch(logs.join('\n'), /SearXNG eager load|Selected .*provider/)
    assert.equal(supervisor.status.phase, 'stopped')
    const phases = records.filter(record => record.event === 'backend-phase')
    assert.ok(phases.some(record => record.backend?.component === 'host' && record.backend.phase === 'projects'
      && record.backend.status === 'completed'), 'Real backend phase records must reach the desktop diagnostic sink')
    assert.equal(new Set(phases.filter(record => record.backend?.component === 'project')
      .map(record => record.backend?.projectOrdinal)).size, 4)
    const persisted = await readFile(logPath, 'utf8')
    assert.match(persisted, /"event":"backend-phase"/)
    assert.doesNotMatch(persisted, /synthetic-unused|projectId|workspace|apiKey/)
    assert.ok(!persisted.includes(launchToken))
  }
  t.diagnostic(`Electron backend readiness, four Projects, milliseconds: ${durations.join(', ')}`)
})
