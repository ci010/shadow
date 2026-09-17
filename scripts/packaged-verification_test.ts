import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer, type RequestListener } from 'node:http'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { createContext, runInContext, type Context } from 'node:vm'
import {
  assertOutsideRepository, backendCommand, backendResourceReport, bounded, descendants, fetchBounded, isolatedEnvironment,
  nodeModeProbe, prepareRendererSmoke, remainingBudget, rendererEnvironment, reservePort, runCommand, sanitizeLog, serviceEnvironment, startProcess, terminateProcess,
  verifyRendererArtifacts, waitForOutput, waitReady, waitSuccessful,
  type ManagedProcess, type ProcessIdentity,
} from './packaged-verification.ts'

test('backend command uses only relocated executable/resources and explicit service mode', () => {
  const root = resolve('relocated app')
  const bootstrap = resolve('isolated config', 'bootstrap.json')
  const command = backendCommand(root, bootstrap)
  assert.equal(command.executable, join(root, 'Shadow.exe'))
  assert.deepEqual(command.args, [
    join(root, 'resources', 'backend', 'dist', 'src', 'index.js'),
    'server', 'start', '--config', bootstrap, '--service',
  ])
  assert.ok(!command.args.includes('--local-executor'))
})

test('service smoke uses an isolated credential file rather than inline or command-line credentials', () => {
  const credentialFile = resolve('isolated', 'service-credential')
  const env = serviceEnvironment('isolated', credentialFile, 4567)
  assert.equal(env.WINDOWS_USE_LAUNCH_TOKEN_FILE, credentialFile)
  assert.equal(env.WINDOWS_USE_LAUNCH_TOKEN, undefined)
  assert.equal(env.GATEWAY_LAUNCH_CREDENTIAL, undefined)
  assert.equal(env.ELECTRON_RUN_AS_NODE, '1')
  assert.equal(env.GATEWAY_PORT, '4567')
  assert.throws(() => serviceEnvironment('isolated', 'relative', 4567), /must be absolute/)
})

test('isolated environment does not inherit Node injection, credentials or user config', () => {
  const original = process.env.NODE_OPTIONS
  process.env.NODE_OPTIONS = '--import evil.js'
  try {
    const env = isolatedEnvironment('isolated', 'test-secret', 4567)
    assert.equal(env.NODE_OPTIONS, undefined)
    assert.equal(env.NODE_PATH, undefined)
    assert.equal(env.ELECTRON_RUN_AS_NODE, '1')
    assert.equal(env.WINDOWS_USE_LAUNCH_TOKEN, 'test-secret')
    assert.equal(env.GATEWAY_HOST, '127.0.0.1')
    assert.equal(env.GATEWAY_PORT, '4567')
    assert.equal(env.HOME, 'isolated')
    assert.equal(env.USERPROFILE, 'isolated')
    assert.equal(env.APPDATA, join('isolated', 'profile', 'roaming'))
  } finally {
    if (original === undefined) delete process.env.NODE_OPTIONS
    else process.env.NODE_OPTIONS = original
  }
})

test('relocation guard rejects repository and descendants, permits sibling with shared prefix', () => {
  const repository = resolve('source')
  assert.throws(() => assertOutsideRepository(repository, repository), /outside/)
  assert.throws(() => assertOutsideRepository(join(repository, 'package'), repository), /outside/)
  assert.doesNotThrow(() => assertOutsideRepository(resolve('source-relocated'), repository))
})

test('diagnostics are bounded and strip tokens and terminal controls', () => {
  const log = sanitizeLog('\x1b[31mBearer credential\nsecret-value\x00', ['secret-value'])
  assert.equal(log, 'Bearer [REDACTED]\n[REDACTED]')
  assert.equal(sanitizeLog('x'.repeat(30_000)).length, 12_000)
  assert.ok(!sanitizeLog('prefix secret-value suffix', ['secret-value'], 15).includes('secret-value'))
})

test('bounded operations complete, reject and time out', async () => {
  assert.equal(await bounded(Promise.resolve(42), 100, 'resolved'), 42)
  await assert.rejects(bounded(Promise.reject(new Error('original')), 100, 'rejected'), /original/)
  await assert.rejects(bounded(new Promise(() => {}), 20, 'hung'), /hung timed out/)
  assert.throws(() => remainingBudget(Date.now() - 1, 100), /cleanup deadline/)
  assert.equal(remainingBudget(Date.now() + 1_000, 100), 100)
})

test('process capture handles success, nonzero exit, spawn failure and secret chunk boundaries', async () => {
  const output = await runCommand(process.execPath, ['-e', 'process.stdout.write("ok")'], {}, 3_000, 'success')
  assert.equal(output, 'ok')
  await assert.rejects(runCommand(process.execPath, [
    '-e', 'process.stdout.write("secret-"); setTimeout(() => { process.stderr.write("value"); process.exitCode = 3 }, 10)',
  ], {}, 3_000, 'failure', ['secret-value']), (error: Error) => {
    assert.match(error.message, /code 3/)
    assert.ok(!error.message.includes('secret-value'))
    assert.match(error.message, /REDACTED/)
    return true
  })
  await assert.rejects(runCommand(join(process.cwd(), 'nonexistent-packaged-test.exe'), [], {}, 3_000, 'spawn'), /spawn failed/)
})

test('process timeout terminates owned headless child and does not hang', async () => {
  const process = startProcess(globalThis.process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {})
  try {
    await assert.rejects(waitSuccessful(process, 50, 'hanging child'), /timed out/)
  } finally {
    await terminateProcess(process.child)
  }
  const result = await bounded(process.completion, 3_000, 'close')
  assert.ok(result.code !== 0 || result.signal !== null)
})

test('fixture output gates fail on premature exit or timeout and accept split markers', async () => {
  const child = startProcess(process.execPath, ['-e', 'process.stdout.write("FIXTURE_"); setTimeout(() => console.log("READY"), 10)'], {})
  await waitForOutput(child, 'FIXTURE_READY', 3_000)
  await waitSuccessful(child, 3_000, 'fixture gate')
  const exited = runningStub()
  exited.result = () => ({ code: 1, signal: null })
  await assert.rejects(waitForOutput(exited, 'MISSING', 100), /exited before MISSING/)
  await assert.rejects(waitForOutput(runningStub(), 'MISSING', 20), /MISSING timed out/)
})

async function httpFixture(listener: RequestListener, run: (origin: string) => Promise<void>): Promise<void> {
  const server = createServer(listener)
  await new Promise<void>((done, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', done)
  })
  const address = server.address()
  assert.ok(address && typeof address !== 'string')
  try {
    await run(`http://127.0.0.1:${address.port}`)
  } finally {
    server.closeAllConnections()
    await new Promise<void>((done) => server.close(() => done()))
  }
}

test('HTTP bounds include stalled headers and stalled body', async () => {
  await httpFixture(() => {}, async (origin) => {
    await assert.rejects(fetchBounded(origin, {}, 30))
  })
  await httpFixture((_request, response) => {
    response.writeHead(200, { 'Content-Type': 'application/json' })
    response.write('{"never":')
  }, async (origin) => {
    await assert.rejects(fetchBounded(origin, {}, 30))
  })
})

test('HTTP enforces body size and rejects redirects', async () => {
  await httpFixture((_request, response) => response.end('x'.repeat(2_000_001)), async (origin) => {
    await assert.rejects(fetchBounded(origin), /exceeds 2MB/)
  })
  await httpFixture((_request, response) => {
    response.writeHead(302, { Location: 'http://127.0.0.1:1/' })
    response.end()
  }, async (origin) => {
    await assert.rejects(fetchBounded(origin))
  })
})

function runningStub(): ManagedProcess {
  return {
    child: { exitCode: null, signalCode: null } as ManagedProcess['child'],
    completion: new Promise(() => {}),
    result: () => undefined,
    logs: () => 'captured backend diagnostics',
  }
}

test('readiness accepts ready, fails auth and malformed bodies, and has a deadline', async () => {
  await httpFixture((_request, response) => response.end('{"status":"ready"}'), async (origin) => {
    await waitReady(origin, {}, runningStub(), 1_000)
  })
  await httpFixture((_request, response) => { response.statusCode = 401; response.end() }, async (origin) => {
    await assert.rejects(waitReady(origin, {}, runningStub(), 1_000), /authentication rejected/)
  })
  await httpFixture((_request, response) => response.end('not json'), async (origin) => {
    await assert.rejects(waitReady(origin, {}, runningStub(), 1_000), SyntaxError)
  })
  await httpFixture((_request, response) => { response.statusCode = 503; response.end() }, async (origin) => {
    await assert.rejects(waitReady(origin, {}, runningStub(), 30), /readiness timed out.*HTTP 503[\s\S]*diagnostics/)
  })
  const exited = runningStub()
  exited.result = () => ({ code: 3, signal: null })
  await assert.rejects(waitReady('http://127.0.0.1:1', {}, exited), /exited before readiness.*code 3/)
})

test('descendant census follows nested lineage but rejects reused parent PIDs and cycles', () => {
  const root: ProcessIdentity = { pid: 1, parentPid: 0, created: '2026-09-16T00:00:02', gui: false }
  const child = { pid: 2, parentPid: 1, created: '2026-09-16T00:00:03', gui: false }
  const grandchild = { pid: 3, parentPid: 2, created: '2026-09-16T00:00:04', gui: true }
  const old = { pid: 4, parentPid: 1, created: '2026-09-16T00:00:01', gui: false }
  assert.deepEqual(descendants([root, child, grandchild, old, { ...root, parentPid: 3 }], root), [child, grandchild])
})

test('Node-mode probe rejects ordinary Node and labels memory only as runtime baseline', async () => {
  await assert.rejects(runCommand(process.execPath, ['-e', nodeModeProbe], {}, 3_000, 'probe'), /code 1/)
  assert.match(nodeModeProbe, /not backend RSS or a memory budget/)
})

test('backend metrics are actual PID samples, not runtime baseline or invented budgets', () => {
  const identity = { pid: 123, parentPid: 1, created: '2026-09-16T00:00:02', gui: false }
  const report = backendResourceReport({ ...identity, workingSetBytes: 105_422_848, cpuSeconds: 0.125 })
  assert.equal(report.workingSetBytes, 105_422_848)
  assert.equal(report.cumulativeCpuSeconds, 0.125)
  assert.match(report.label, /Actual backend PID sample/)
  assert.match(report.label, /not CPU utilization or a memory budget/)
  assert.throws(() => backendResourceReport(identity), /working set unavailable/)
  assert.throws(() => backendResourceReport({ ...identity, workingSetBytes: 1, cpuSeconds: -1 }), /CPU time unavailable/)
})

test('port reservation releases a loopback port', async () => {
  const port = await reservePort()
  assert.ok(port > 0 && port < 65_536)
})

test('renderer references check rejects missing, empty and escaping assets without running GUI', async () => {
  const root = join(process.cwd(), '.test-data', `packaged-verification-${randomUUID()}`)
  const resources = join(root, 'resources')
  const assets = join(resources, 'app-dist', 'assets')
  await mkdir(assets, { recursive: true })
  try {
    await writeFile(join(resources, 'app-dist', 'index.html'), '<script type="module" src="./assets/index.js"></script>')
    await writeFile(join(assets, 'index.js'), 'console.log("renderer")')
    await verifyRendererArtifacts(root)
    await writeFile(join(assets, 'index.js'), '')
    await assert.rejects(verifyRendererArtifacts(root), /Empty renderer asset/)
    await rm(join(assets, 'index.js'))
    await assert.rejects(verifyRendererArtifacts(root), /ENOENT/)
    await writeFile(join(resources, 'app-dist', 'index.html'), '<script src="./assets/../../escape.js"></script>')
    await assert.rejects(verifyRendererArtifacts(root), /escapes package/)
    await writeFile(join(resources, 'app-dist', 'index.html'), '<p>No renderer entry</p>')
    await assert.rejects(verifyRendererArtifacts(root), /lacks a bundled JavaScript entry/)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('renderer fixture replaces only disposable entry and preserves original production archive', async () => {
  const root = join(process.cwd(), '.test-data', `renderer-fixture-${randomUUID()}`)
  const resources = join(root, 'application', 'resources')
  await mkdir(resources, { recursive: true })
  try {
    const original = Buffer.from('synthetic production archive')
    await writeFile(join(resources, 'app.asar'), original)
    const command = await prepareRendererSmoke(join(root, 'application'), root, 'fixture source')
    assert.equal(command.executable, join(root, 'application', 'Shadow.exe'))
    assert.ok(command.args.includes(`--acceptance-preload=${join(resources, 'acceptance-production.asar', 'dist', 'preload.cjs')}`))
    assert.ok(command.args.includes(`--acceptance-assets=${join(resources, 'app-dist')}`))
    assert.deepEqual(await readFile(join(resources, 'acceptance-production.asar')), original)
    assert.equal(await readFile(join(resources, 'app', 'fixture.cjs'), 'utf8'), 'fixture source')
    const entry = JSON.parse(await readFile(join(resources, 'app', 'package.json'), 'utf8'))
    assert.equal(entry.main, 'fixture.cjs')
    assert.notEqual(entry.main, 'dist/main.js')
    await assert.rejects(readFile(join(resources, 'app.asar')), /ENOENT/)
    const env = rendererEnvironment(root)
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined)
    assert.equal(env.WINDOWS_USE_LAUNCH_TOKEN, undefined)
    assert.equal(env.GATEWAY_PORT, undefined)
    assert.equal(env.USERPROFILE, root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('renderer harness mock verifies isolation, narrow offline fonts, safe diagnostics and failure exits', async () => {
  const fixture = await readFile(join(process.cwd(), 'scripts', 'fixtures', 'packaged-renderer-smoke.cjs'), 'utf8')
  const builtinRequire = createRequire(import.meta.url)
  for (const failure of ['none', 'preload', 'console', 'network']) {
    const root = join(process.cwd(), '.test-data', `renderer-harness-${randomUUID()}`)
    const messages: string[] = []
    const handlers = new Map<string, () => unknown>()
    let context: Context
    let finish!: (code: number) => void
    const exited = new Promise<number>((done) => { finish = done })
    const paths = new Map<string, string>()
    const switches = new Map<string, string | undefined>()
    let options: Record<string, any> | undefined
    type Decision = { cancel?: boolean; redirectURL?: string }
    let requestFilter: ((details: { url: string; resourceType?: string }, callback: (value: Decision) => void) => void) | undefined
    const electron = {
      app: {
        setPath: (name: string, path: string) => paths.set(name, path),
        disableHardwareAcceleration: () => {},
        commandLine: { appendSwitch: (name: string, value?: string) => switches.set(name, value) },
        on: () => {},
        whenReady: () => Promise.resolve(),
        exit: (code: number) => finish(code),
      },
      session: {
        defaultSession: {
          setPermissionRequestHandler: () => {},
          setPermissionCheckHandler: () => {},
          webRequest: { onBeforeRequest: (_filter: unknown, callback: typeof requestFilter) => { requestFilter = callback } },
        },
      },
      ipcMain: { handle: (channel: string, handler: () => unknown) => handlers.set(channel, handler) },
      BrowserWindow: class extends EventEmitter {
        destroyed = false
        webContents = Object.assign(new EventEmitter(), {
          setWindowOpenHandler: () => {},
          executeJavaScript: async (source: string) => {
            if (source.startsWith('!!document.querySelector')) return true
            handlers.get('shadow:bootstrap:load')!()
            handlers.get('shadow:window:get-state')!()
            return runInContext(`({
              wizard: initialState, windowState: { maximized: false }, nodeRequire: 'undefined',
              nodeProcess: 'undefined', mediaApi: 'object', foldersApi: 'function',
              mainChoices: 2, styleSheets: 1, imageLoaded: true
            })`, context)
          },
        })
        constructor(value: Record<string, any>) { super(); options = value }
        async loadFile(path: string) {
          assert.equal(path, join(root, 'assets', 'index.html'))
          handlers.get('shadow:bootstrap:load')!()
          handlers.get('shadow:window:get-state')!()
          if (failure === 'preload') this.webContents.emit('preload-error', {}, 'preload.cjs', new Error('synthetic preload failure'))
          if (failure === 'console') this.webContents.emit('console-message', { level: 'error', message: 'synthetic console failure' }, 3)
          if (failure === 'network') requestFilter!({
            url: 'https://user:password@example.invalid/private-token?token=query-secret#fragment-secret',
            resourceType: 'xhr',
          }, (decision) => assert.equal(decision.cancel, true))
        }
        isVisible() { return false }
        isDestroyed() { return this.destroyed }
        destroy() { this.destroyed = true }
      },
    }
    await mkdir(root, { recursive: true })
    try {
      context = createContext({
        URL,
        require: (name: string) => name === 'electron' ? electron : builtinRequire(name),
        process: {
          argv: [
            `--acceptance-assets=${join(root, 'assets')}`, `--acceptance-preload=${join(root, 'preload.cjs')}`,
            `--acceptance-profile=${join(root, 'profile')}`, `--acceptance-control=${join(root, 'control')}`,
          ],
          on: () => {},
        },
        console: {
          log: (message: string) => {
            messages.push(message)
            if (message === 'SHADOW_RENDERER_WAITING') writeFileSync(join(root, 'control.start'), '')
            if (message.startsWith('SHADOW_RENDERER_RESULT=')) writeFileSync(join(root, 'control.stop'), '')
          },
          error: (message: string) => messages.push(message),
        },
        setTimeout,
        clearTimeout,
      })
      runInContext(fixture, context, { filename: 'packaged-renderer-smoke.cjs' })
      assert.equal(await bounded(exited, 3_000, 'synthetic renderer harness'), failure === 'none' ? 0 : 1)
      assert.equal(options!.show, false)
      assert.equal(options!.webPreferences.offscreen, true)
      assert.equal(options!.webPreferences.contextIsolation, true)
      assert.equal(options!.webPreferences.nodeIntegration, false)
      assert.equal(options!.webPreferences.sandbox, true)
      assert.equal(paths.get('userData'), join(root, 'profile', 'userData'))
      assert.equal(switches.get('host-resolver-rules'), 'MAP * ~NOTFOUND')
      const knownFont = 'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=IBM+Plex+Mono:wght@400;600&display=swap'
      requestFilter!({ url: knownFont, resourceType: 'stylesheet' }, (result) => {
        assert.ok(result.redirectURL?.startsWith('data:text/css,'))
        assert.equal(result.cancel, undefined)
      })
      for (const url of [
        'https://example.invalid/', 'http://127.0.0.1:43123/api/projects',
        'https://fonts.gstatic.com/font.woff2', `${knownFont}&token=query-secret`,
        knownFont.replace('https:', 'http:'), knownFont.replace('Inter:', 'Other:'),
      ]) requestFilter!({ url, resourceType: 'stylesheet' }, (result) => assert.equal(result.cancel, true))
      requestFilter!({ url: knownFont, resourceType: 'script' }, (result) => assert.equal(result.cancel, true))
      const safeUrl = runInContext(`safeRequestUrl('https://user:password@example.invalid/private-token?token=query-secret#fragment-secret')`, context)
      assert.equal(safeUrl, 'https://example.invalid/[path-redacted]?[query-redacted]#[fragment-redacted]')
      assert.ok(runInContext(`diagnostic('x'.repeat(5000))`, context).length <= 1_000)
      const diagnostics = messages.join('\n')
      for (const secret of ['password', 'private-token', 'query-secret', 'fragment-secret']) assert.ok(!diagnostics.includes(secret))
      if (failure === 'network') assert.match(diagnostics, /Renderer blocked request: https:\/\/example.invalid/)
      else if (failure !== 'none') assert.ok(messages.some((value) => value.includes(`synthetic ${failure} failure`)))
      else assert.ok(messages.some((value) => value.includes('SHADOW_RENDERER_RESULT=') && value.includes('NOT unmodified production main')))
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
})
