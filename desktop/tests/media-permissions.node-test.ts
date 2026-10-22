import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const source = dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

test('real Electron gates fake media devices for packaged file and loopback renderer', { timeout: 90_000 }, async (t) => {
  const directory = resolve(source, '..', '..', '.test-artifacts', `media-permissions-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  await Promise.all(['media-permissions-smoke', 'media-permissions-preload'].map((name) => build({
    entryPoints: [join(source, 'fixtures', `${name}.ts`)],
    outfile: join(directory, `${name}.cjs`),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
    logLevel: 'silent',
  })))
  const env: NodeJS.ProcessEnv = {}
  for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) {
    env[name] = directory
  }
  const child = spawn(require('electron') as string, [join(directory, 'media-permissions-smoke.cjs')], {
    cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (data: string) => { stdout += data })
  child.stderr.setEncoding('utf8').on('data', (data: string) => { stderr += data })
  const timeout = setTimeout(() => child.kill(), 75_000)
  t.after(() => { clearTimeout(timeout); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, `${stdout}\n${stderr}`)
  assert.match(stdout, /MEDIA_PERMISSIONS_OK file/)
  assert.match(stdout, /MEDIA_PERMISSIONS_OK url/)
  assert.doesNotMatch(stderr, /UnhandledPromiseRejection|Uncaught Exception/)
})
