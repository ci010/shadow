import assert from 'node:assert/strict'
import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { once } from 'node:events'
import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

if (process.platform !== 'win32') throw new Error('The current desktop package target is Windows.')
const packaged = resolve('desktop/release/win-unpacked')
// Relocation prevents imports from silently falling back to repository dependencies.
const scratch = await mkdtemp(join(tmpdir(), 'shadow-package-'))
const backend = join(scratch, 'backend')
let child: ChildProcess | undefined
let output = ''
try {
  await cp(join(packaged, 'resources/backend'), backend, { recursive: true, dereference: true })
  const reserve = createServer()
  reserve.listen(0, '127.0.0.1')
  await once(reserve, 'listening')
  const address = reserve.address()
  assert.ok(address && typeof address !== 'string')
  const port = address.port
  await new Promise<void>((done) => reserve.close(() => done()))
  const dataDir = join(scratch, 'data')
  const bootstrap = join(scratch, 'bootstrap.json')
  await mkdir(join(dataDir, 'config'), { recursive: true })
  await writeFile(bootstrap, JSON.stringify({
    version: 1, mode: 'main', dataDir, localNodeId: 'packaging-smoke',
  }))
  await writeFile(join(dataDir, 'config', 'bot.config.json'), JSON.stringify({
    agent: { workspace: join(dataDir, 'workspace'), model: 'gpt-4.1', sessionStorage: 'sqlite' },
    channels: {}, mcp: {},
  }))
  const token = 'packaging-smoke-credential'
  const env = {
    PATH: process.env.PATH,
    SystemRoot: process.env.SystemRoot,
    TEMP: scratch,
    TMP: scratch,
    USERPROFILE: scratch,
    APPDATA: scratch,
    LOCALAPPDATA: scratch,
    ELECTRON_RUN_AS_NODE: '1',
    WINDOWS_USE_LAUNCH_TOKEN: token,
    GATEWAY_PORT: String(port),
    GATEWAY_HOST: '127.0.0.1',
    SEARXNG_URL: 'http://127.0.0.1:1',
  }
  const executable = join(packaged, 'Shadow.exe')
  child = spawn(executable, [
    join(backend, 'dist/src/index.js'),
    'server', 'start', '--config', bootstrap, '--local-executor',
  ], { cwd: scratch, env, stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout!.on('data', (chunk) => { output += chunk })
  child.stderr!.on('data', (chunk) => { output += chunk })
  await once(child, 'spawn')
  const exited = once(child, 'exit')
  const origin = `http://127.0.0.1:${port}`
  const headers = { Authorization: `Bearer ${token}` }
  let ready = false
  for (let attempt = 0; attempt < 300; attempt++) {
    if (child.exitCode !== null) throw new Error(`Packaged backend exited:\n${output}`)
    try {
      const response = await fetch(`${origin}/local/v1/readiness`, { headers, signal: AbortSignal.timeout(500) })
      if (response.ok) {
        assert.equal((await response.json()).status, 'ready')
        ready = true
        break
      }
    } catch (error) {
      if (!(error instanceof TypeError || error instanceof DOMException)) throw error
    }
    await new Promise((done) => setTimeout(done, 100))
  }
  assert.ok(ready, output)
  assert.equal((await fetch(`${origin}/local/v1/readiness`)).status, 401)
  const logs = await fetch(`${origin}/v1/query/logs`, { headers })
  assert.equal(logs.status, 200)
  assert.ok(JSON.stringify(await logs.json()).includes('All services started'))

  const script = join(scratch, 'eval-fixture.ts')
  await writeFile(join(scratch, 'value.ts'), 'export enum Value { Answer = 42 }\n')
  await writeFile(script, `
    import { Value } from './value.ts'
    class Result { constructor(public value: number) {} }
    export default () => new Result(Value.Answer).value
  `)
  const payload = Buffer.from(JSON.stringify({ module: script, cwd: scratch, args: [] })).toString('base64')
  const evaluated = spawnSync(executable, [
    join(backend, 'dist/src/script-runtime/child.js'), '--eval-runner', payload,
  ], { cwd: scratch, env, encoding: 'utf8', timeout: 15_000 })
  assert.equal(evaluated.status, 0, evaluated.stderr + evaluated.stdout)
  assert.ok(evaluated.stdout.includes('"result":42'), evaluated.stdout)

  assert.equal((await fetch(`${origin}/local/v1/shutdown`, { method: 'POST', headers })).status, 202)
  const timeout = setTimeout(() => child?.kill('SIGKILL'), 15_000)
  try {
    const [code] = await exited
    assert.equal(code, 0, output)
  } finally {
    clearTimeout(timeout)
  }
  console.log('Relocated Electron backend: startup, auth, telemetry, native TypeScript, shutdown OK')
} finally {
  if (child?.pid !== undefined && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit')
    child.kill('SIGKILL')
    await exited
  }
  await rm(scratch, { recursive: true, force: true })
}
