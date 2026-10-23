import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { createServer } from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { build } from 'esbuild'

const here = dirname(fileURLToPath(import.meta.url))
const repository = resolve(here, '..', '..')
const require = createRequire(import.meta.url)

test('real backend runs in an Electron utility process before any window and survives window close', { timeout: 60_000 }, async t => {
  const entry = join(repository, 'dist', 'src', 'index.js')
  await access(entry)
  const scratch = join(repository, '.tmp')
  await mkdir(scratch, { recursive: true })
  const root = await mkdtemp(join(scratch, 'utility-runtime-'))
  t.after(() => rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }))
  const dataDir = join(root, 'data')
  const home = join(dataDir, 'workspace')
  await mkdir(join(dataDir, 'config'), { recursive: true })
  await mkdir(home)
  const config = join(root, 'runtime-config.json')
  await writeFile(config, JSON.stringify({ version: 1, mode: 'main', dataDir, localNodeId: 'utility-fixture' }))
  await writeFile(join(dataDir, 'config', 'bot.config.json'), JSON.stringify({
    agent: { workspace: home, model: 'fixture@openai', sessionStorage: 'sqlite' },
    providers: { openai: { apiKey: 'synthetic-unused', baseUrl: 'http://127.0.0.1:1' } },
    channels: {}, mcp: {},
  }))
  const fixture = join(root, 'fixture.cjs')
  await build({
    entryPoints: [join(here, 'fixtures', 'utility-runtime-smoke.ts')],
    outfile: fixture, bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
  })
  const reservation = createServer().listen(0, '127.0.0.1')
  await once(reservation, 'listening')
  const address = reservation.address()
  assert.ok(address && typeof address !== 'string')
  await new Promise<void>((resolve, reject) => reservation.close(error => error ? reject(error) : resolve()))
  const env: NodeJS.ProcessEnv = {}
  for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP']) env[name] = root
  const child = spawn(require('electron') as string, [
    fixture, `--fixture-root=${root}`, `--fixture-entry=${entry}`,
    `--fixture-config=${config}`, `--fixture-port=${address.port}`,
  ], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = once(child, 'close')
  t.after(async () => { if (child.exitCode === null) child.kill(); await closed })
  let output = ''
  child.stdout.on('data', chunk => { output += String(chunk) })
  child.stderr.on('data', chunk => { output += String(chunk) })
  const timer = setTimeout(() => child.kill(), 45_000)
  let code: unknown
  try { [code] = await closed } finally { clearTimeout(timer) }
  assert.equal(code, 0, output.slice(-8000))
  assert.match(output, /UTILITY_RESULT \{"ok":true\}/)
})
