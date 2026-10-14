import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { writeFileSync } from 'node:fs'
import { mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { createServer, type RequestListener } from 'node:http'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createContext, runInContext, type Context } from 'node:vm'
import { compileBackend } from './backend-bundle.ts'
import {
  assertMacIconEncoding, assertOutsideRepository, backendCommand, backendResourceReport, bounded, createVerificationDirectory, descendants, fetchBounded, isolatedEnvironment,
  killPosixTree, nodeModeProbe, packagedEvalCommand, parsePosixProcesses, prepareRendererSmoke, relocatedPackageRoot, remainingBudget, rendererEnvironment, rendererSignatureCommands, reservePort, runCommand, sanitizeLog, serviceEnvironment, startProcess, terminateProcess,
  verifyRendererArtifacts, waitForOutput, waitReady, waitSuccessful,
  type ManagedProcess, type ProcessIdentity,
} from './packaged-verification.ts'
import { desktopTarget } from './desktop-target.ts'
import { localProxyConfiguration, proxyForUrl } from '../src/execution/network/proxy.ts'

const windows = desktopTarget('win32', 'x64')

test('macOS icon verification rejects the legacy PNG chunks that render as Finder noise', () => {
  const argb = (size: number) => {
    const channel = Buffer.alloc(Math.ceil(size * size / 128) * 2)
    for (let i = 0; i < channel.length; i += 2) {
      channel[i] = 253 // A run of 128 zero-valued pixels.
    }
    return Buffer.concat([Buffer.from('ARGB'), channel, channel, channel, channel])
  }
  const icns = (entries: Array<[string, Buffer]>) => {
    const chunks = entries.map(([type, payload]) => {
      const header = Buffer.alloc(8)
      header.write(type, 0, 'ascii')
      header.writeUInt32BE(8 + payload.length, 4)
      return Buffer.concat([header, payload])
    })
    const header = Buffer.alloc(8)
    header.write('icns')
    header.writeUInt32BE(8 + chunks.reduce((length, chunk) => length + chunk.length, 0), 4)
    return Buffer.concat([header, ...chunks])
  }
  const small: Array<[string, Buffer]> = [['ic04', argb(16)], ['ic05', argb(32)]]
  const valid = icns(small)
  assert.doesNotThrow(() => assertMacIconEncoding(valid))
  for (const type of ['icp4', 'icp5', 'icp6']) {
    assert.throws(() => assertMacIconEncoding(icns([...small, [type, Buffer.from('89504e470d0a1a0a', 'hex')]])),
      /Unsupported macOS icon encoding/)
  }
  assert.throws(() => assertMacIconEncoding(icns([small[0]])), /ic05 must use ARGB/)
  assert.throws(() => assertMacIconEncoding(icns([['ic04', Buffer.from('PNG data')], small[1]])), /ic04 must use ARGB/)
  assert.throws(() => assertMacIconEncoding(icns([...small, small[0]])), /Duplicate ICNS entry/)
  assert.throws(() => assertMacIconEncoding(Buffer.alloc(4)), /Invalid ICNS header/)
  assert.throws(() => assertMacIconEncoding(valid.subarray(0, -1)), /Invalid ICNS file length/)
  const truncatedHeader = Buffer.concat([valid, Buffer.alloc(4)])
  truncatedHeader.writeUInt32BE(truncatedHeader.length, 4)
  assert.throws(() => assertMacIconEncoding(truncatedHeader), /Truncated ICNS entry header/)
  const invalidEntry = Buffer.from(valid)
  invalidEntry.writeUInt32BE(0, 12)
  assert.throws(() => assertMacIconEncoding(invalidEntry), /Invalid ICNS entry length/)
  invalidEntry.writeUInt32BE(valid.length, 12)
  assert.throws(() => assertMacIconEncoding(invalidEntry), /Invalid ICNS entry length/)
})

test('verification data paths canonicalize OS temporary-directory aliases', async t => {
  const root = resolve('.test-data', `verification-paths-${randomUUID()}`)
  t.after(() => rm(root, { recursive: true, force: true }))
  const physical = join(root, 'physical')
  const alias = join(root, 'alias')
  await mkdir(physical, { recursive: true })
  await symlink(physical, alias, process.platform === 'win32' ? 'junction' : 'dir')
  const scratch = await createVerificationDirectory(alias)
  assert.equal(scratch, await realpath(scratch))
  assert.ok(scratch.startsWith(join(await realpath(physical), 'shadow-packaged-acceptance-')))
})

test('backend command uses only relocated executable/resources and explicit service mode', () => {
  const root = resolve('relocated app')
  const bootstrap = resolve('isolated config', 'bootstrap.json')
  const command = backendCommand(root, bootstrap, windows)
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

test('packaged smoke uses direct networking without consulting host proxy or PAC settings', async () => {
  const env = serviceEnvironment('isolated', resolve('isolated', 'credential'), 4567)
  const configuration = await localProxyConfiguration(undefined, {
    env, platform: 'win32',
    readWindows: async () => { throw new Error('Packaged smoke must not read the host proxy settings') },
  })
  assert.equal(configuration.source, 'environment')
  assert.equal(configuration.http, undefined)
  assert.equal(configuration.https, undefined)
  assert.equal(proxyForUrl(configuration, 'http://127.0.0.1:4567'), undefined)
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

test('readiness accepts ready, fails auth and malformed bodies, and has a deadline', async t => {
  await httpFixture((_request, response) => response.end('{"status":"ready"}'), async (origin) => {
    await waitReady(origin, {}, runningStub(), 1_000)
  })
  await httpFixture((_request, response) => { response.statusCode = 401; response.end() }, async (origin) => {
    await assert.rejects(waitReady(origin, {}, runningStub(), 1_000), /authentication rejected/)
  })
  await httpFixture((_request, response) => response.end('not json'), async (origin) => {
    await assert.rejects(waitReady(origin, {}, runningStub(), 1_000), SyntaxError)
  })
  const unavailable = t.mock.method(globalThis, 'fetch', async () => new Response(null, { status: 503 }))
  try {
    await assert.rejects(waitReady('http://127.0.0.1', {}, runningStub(), 30), /readiness timed out.*HTTP 503[\s\S]*diagnostics/)
  } finally { unavailable.mock.restore() }
  await httpFixture(() => {}, async origin => {
    await assert.rejects(waitReady(origin, {}, runningStub(), 30), /readiness timed out[\s\S]*diagnostics/)
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
  assert.deepEqual(descendants([child, grandchild], root), [])
  assert.deepEqual(descendants([{ ...root, created: '2026-09-16T00:00:05' }, child, grandchild], root), [])
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
    await verifyRendererArtifacts(root, windows)
    await writeFile(join(assets, 'index.js'), '')
    await assert.rejects(verifyRendererArtifacts(root, windows), /Empty renderer asset/)
    await rm(join(assets, 'index.js'))
    await assert.rejects(verifyRendererArtifacts(root, windows), /ENOENT/)
    await writeFile(join(resources, 'app-dist', 'index.html'), '<script src="./assets/../../escape.js"></script>')
    await assert.rejects(verifyRendererArtifacts(root, windows), /escapes package/)
    await writeFile(join(resources, 'app-dist', 'index.html'), '<p>No renderer entry</p>')
    await assert.rejects(verifyRendererArtifacts(root, windows), /lacks a bundled JavaScript entry/)
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
    const command = await prepareRendererSmoke(join(root, 'application'), root, 'fixture source', windows)
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

for (const target of [windows, desktopTarget('darwin', 'arm64'), desktopTarget('darwin', 'x64'), desktopTarget('linux', 'x64')]) {
  test(`${target.platform}/${target.arch} relocated executable, backend and renderer use platform resource layout`, async () => {
    const scratch = join(process.cwd(), '.test-data', `platform-fixture-${randomUUID()}`)
    const root = relocatedPackageRoot(scratch, target)
    const resources = join(root, target.resourcesRelativePath)
    await mkdir(join(resources, 'app-dist', 'assets'), { recursive: true })
    try {
      if (target.platform === 'darwin') assert.ok(root.endsWith('Shadow.app'))
      const backend = backendCommand(root, join(scratch, 'bootstrap.json'), target)
      assert.equal(backend.executable, join(root, target.executableRelativePath))
      assert.equal(backend.args[0], join(resources, 'backend', 'dist', 'src', 'index.js'))
      const script = join(scratch, 'eval-fixture.ts')
      const evaluation = packagedEvalCommand(root, script, target)
      assert.equal(evaluation.executable, backend.executable)
      assert.deepEqual(evaluation.args.slice(-2), [
        pathToFileURL(join(resources, 'backend', 'dist', 'src', 'script-runtime', 'runtime.js')).href, script,
      ])
      assert.ok(!evaluation.args.includes('--eval-runner'))
      await writeFile(join(resources, 'app-dist', 'index.html'), '<script src="./assets/index.js"></script>')
      await writeFile(join(resources, 'app-dist', 'assets', 'index.js'), 'renderer')
      await verifyRendererArtifacts(root, target)
      await writeFile(join(resources, 'app.asar'), 'unchanged production archive')
      const renderer = await prepareRendererSmoke(root, scratch, 'fixture', target)
      assert.equal(renderer.executable, backend.executable)
      assert.ok(renderer.args.includes(`--acceptance-preload=${join(resources, 'acceptance-production.asar', 'dist', 'preload.cjs')}`))
      assert.equal(await readFile(join(resources, 'acceptance-production.asar'), 'utf8'), 'unchanged production archive')
    } finally {
      await rm(scratch, { recursive: true, force: true })
    }
  })
}

test('packaged eval invokes the compiled runtime/worker API on Node and Electron and transforms TypeScript to 42', async () => {
  const scratch = join(process.cwd(), '.test-data', `packaged-eval-${randomUUID()}`)
  const target = desktopTarget()
  const root = relocatedPackageRoot(scratch, target)
  const backend = join(root, target.resourcesRelativePath, 'backend')
  await mkdir(backend, { recursive: true })
  try {
    await compileBackend(process.cwd(), join(backend, 'dist'), ['script-runtime/runtime', 'script-runtime/worker'])
    await writeFile(join(backend, 'package.json'), '{"type":"module"}')
    await writeFile(join(scratch, 'value.ts'), 'export enum Value { Answer = 42 }\n')
    const script = join(scratch, 'eval-fixture.ts')
    await writeFile(script, `
      import { Value } from './value.ts'
      class Result { constructor(public value: number) {} }
      export default () => new Result(Value.Answer).value
    `)
    const command = packagedEvalCommand(root, script, target)
    const desktopRequire = createRequire(new URL('../desktop/package.json', import.meta.url))
    const executables = [process.execPath, desktopRequire('electron') as string]
    for (const executable of executables) {
      const output = await runCommand(executable, command.args, {
        cwd: scratch, env: isolatedEnvironment(scratch, '', 0),
      }, 15_000, 'packaged script runtime eval')
      const report = output.split(/\r?\n/).find(line => line.startsWith('SHADOW_PACKAGED_EVAL_RESULT='))
      assert.ok(report, output)
      assert.deepEqual(JSON.parse(report.slice('SHADOW_PACKAGED_EVAL_RESULT='.length)), { result: 42 })
    }
    await rm(join(backend, 'dist', 'src', 'script-runtime', 'worker.js'))
    await assert.rejects(runCommand(process.execPath, command.args, {
      cwd: scratch, env: isolatedEnvironment(scratch, '', 0),
    }, 15_000, 'missing packaged worker'), /failed/)
  } finally {
    await rm(scratch, { recursive: true, force: true })
  }
})

test('macOS synthetic entry re-signs only the disposable bundle while preserving entitlements and runtime flags', () => {
  const scratch = resolve('isolated')
  for (const arch of ['arm64', 'x64']) {
    const target = desktopTarget('darwin', arch)
    const root = relocatedPackageRoot(scratch, target)
    const commands = rendererSignatureCommands(root, scratch, target)
    assert.deepEqual(commands, [
      {
        executable: '/usr/bin/codesign',
        args: ['--force', '--sign', '-', '--timestamp=none',
          '--preserve-metadata=identifier,entitlements,requirements,flags,runtime', root],
      },
      { executable: '/usr/bin/codesign', args: ['--verify', '--deep', '--strict', root] },
    ])
    assert.throws(() => rendererSignatureCommands(resolve('desktop', 'release', 'Shadow.app'), scratch, target), /Only the disposable renderer bundle/)
  }
  for (const target of [windows, desktopTarget('linux', 'x64')]) {
    assert.deepEqual(rendererSignatureCommands(relocatedPackageRoot(scratch, target), scratch, target), [])
  }
})

test('Linux renderer preserves Xvfb display authorization but isolates HOME, XDG and temp paths', () => {
  const original = { DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY }
  process.env.DISPLAY = ':99'
  process.env.XAUTHORITY = '/runner/display-authority'
  try {
    const scratch = resolve('isolated')
    const env = rendererEnvironment(scratch, desktopTarget('linux', 'x64'))
    assert.equal(env.DISPLAY, ':99')
    assert.equal(env.XAUTHORITY, '/runner/display-authority')
    assert.equal(env.HOME, scratch)
    assert.equal(env.TMPDIR, scratch)
    assert.equal(env.XDG_CONFIG_HOME, join(scratch, 'profile', 'config'))
    assert.equal(env.XDG_CACHE_HOME, join(scratch, 'profile', 'cache'))
    assert.equal(env.XDG_DATA_HOME, join(scratch, 'profile', 'data'))
    assert.equal(env.ELECTRON_RUN_AS_NODE, undefined)
    assert.equal(env.ELECTRON_DISABLE_SANDBOX, undefined)
    assert.equal(rendererEnvironment(scratch, windows).DISPLAY, undefined)
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }
})

test('POSIX census parses macOS and Linux metrics without exporting command lines', () => {
  const parsed = parsePosixProcesses(`
  123 1 Wed Sep 16 02:03:04 2026 10240 00:00:01 /Applications/Shadow.app/Contents/MacOS/Shadow --secret=private
  124 123 Wed Sep 16 02:03:05 2026 2048 0:00.25 /Applications/Shadow.app/Contents/Frameworks/Shadow Helper --type=renderer
  125 124 Wed Sep 16 02:03:06 2026 4096 1-02:03:04 /opt/shadow --type=gpu-process
  126 123 Wed Sep 16 02:03:07 2026 0 00:00:00 [defunct]
`)
  assert.equal(parsed[0]!.created, '2026-09-16T02:03:04.000Z')
  assert.equal(parsed[0]!.workingSetBytes, 10240 * 1024)
  assert.equal(parsed[0]!.cpuSeconds, 1)
  assert.equal(parsed[1]!.cpuSeconds, 0.25)
  assert.equal(parsed[2]!.cpuSeconds, 93784)
  assert.deepEqual(parsed.map(row => row.gui), [false, true, true, false])
  assert.ok(!JSON.stringify(parsed).includes('private'))
  assert.deepEqual(descendants(parsed, parsed[0]!), [parsed[1], parsed[3], parsed[2]])
  assert.match(backendResourceReport(parsed[0]!, 'darwin').label, /POSIX resident set/)
  assert.throws(() => parsePosixProcesses('invalid private command'), /Invalid POSIX process census row/)
  assert.throws(() => parsePosixProcesses('123 1 Wed Sep 16 02:03:04 2026 10 invalid private'), /Invalid POSIX process identity/)
  assert.deepEqual(parsePosixProcesses(''), [])
})

test('POSIX cleanup signals exact descendants before root and refuses PID reuse', async () => {
  const root = { pid: 90123, parentPid: 1, created: '2026-09-16T00:00:02', gui: false }
  const child = { ...root, pid: 90124, parentPid: root.pid, created: '2026-09-16T00:00:03' }
  const unrelated = { ...root, pid: 90125 }
  let processes = [root, child, unrelated]
  const signalled: Array<[number, string]> = []
  await killPosixTree(root, Date.now() + 3_000, {
    snapshot: async () => processes,
    signal: (pid, signal) => { signalled.push([pid, signal]); processes = processes.filter(value => value.pid !== pid) },
  })
  assert.deepEqual(signalled, [[child.pid, 'SIGTERM'], [root.pid, 'SIGTERM']])
  assert.deepEqual(processes, [unrelated])

  signalled.length = 0
  let snapshots = 0
  await killPosixTree(root, Date.now() + 3_000, {
    snapshot: async () => ++snapshots === 1 ? [root] : [{ ...root, created: '2026-09-16T00:00:04' }],
    signal: (pid, signal) => { signalled.push([pid, signal]) },
  })
  assert.deepEqual(signalled, [])
  await assert.rejects(killPosixTree({ ...root, pid: 1 }), /Unsafe owned process PID/)
  await assert.rejects(killPosixTree({ ...root, pid: process.pid }), /Unsafe owned process PID/)
})

test('POSIX cleanup escalates only matching identities and is bounded', async () => {
  const root = { pid: 90123, parentPid: 1, created: '2026-09-16T00:00:02', gui: false }
  let alive = true
  const signalled: string[] = []
  await killPosixTree(root, Date.now() + 3_000, {
    snapshot: async () => alive ? [root] : [],
    signal: (_pid, signal) => { signalled.push(signal); if (signal === 'SIGKILL') alive = false },
  })
  assert.deepEqual(signalled, ['SIGTERM', 'SIGKILL'])
  await assert.rejects(killPosixTree(root, Date.now() - 1, {
    snapshot: async () => [root], signal: () => { throw new Error('must not signal') },
  }), /cleanup deadline/)
  await assert.rejects(killPosixTree(root, Date.now() + 1_500, {
    snapshot: async () => [root], signal: () => {},
  }), /survived cleanup|cleanup deadline/)
})

test('POSIX cleanup waits for asynchronous termination after SIGKILL', async () => {
  const root = { pid: 90123, parentPid: 1, created: '2026-09-16T00:00:02', gui: false }
  let killed = false
  let settlingSnapshots = 0
  const signalled: string[] = []
  await killPosixTree(root, Date.now() + 3_000, {
    snapshot: async () => killed && ++settlingSnapshots >= 4 ? [] : [root],
    signal: (_pid, signal) => { signalled.push(signal); if (signal === 'SIGKILL') killed = true },
  })
  assert.deepEqual(signalled, ['SIGTERM', 'SIGKILL'])
  assert.equal(settlingSnapshots, 4)
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
