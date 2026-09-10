import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const sourceDirectory = dirname(fileURLToPath(import.meta.url))
const repository = resolve(sourceDirectory, '..', '..')
const require = createRequire(import.meta.url)

test('built Vue layout stays bounded in isolated hidden Electron viewports', {
  timeout: 120_000,
}, async (t) => {
  const assets = join(repository, 'app', 'dist')
  await assert.doesNotReject(access(join(assets, 'index.html')), 'Build the renderer with pnpm build:app before the layout test')
  const scratch = join(repository, '.tmp')
  await mkdir(scratch, { recursive: true })
  const directory = await mkdtemp(join(scratch, 'layout-smoke-'))
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))

  await Promise.all(['layout-smoke', 'layout-preload'].map((name) => build({
    entryPoints: [join(sourceDirectory, 'fixtures', `${name}.ts`)],
    outfile: join(directory, `${name}.cjs`),
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'node24',
    external: ['electron'],
    logLevel: 'silent',
  })))

  // Do not inherit provider credentials, NODE_OPTIONS, or ELECTRON_RUN_AS_NODE.
  const env: NodeJS.ProcessEnv = {}
  for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) {
    env[name] = directory
  }
  const child = spawn(require('electron') as string, [
    '--enable-logging=stderr',
    `--user-data-dir=${join(directory, 'userData')}`,
    join(directory, 'layout-smoke.cjs'),
    `--layout-assets=${assets}`,
    `--layout-root=${directory}`,
  ], {
    cwd: directory,
    env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  let stderr = ''
  child.stdout.setEncoding('utf8').on('data', (data: string) => { stdout += data })
  child.stderr.setEncoding('utf8').on('data', (data: string) => { stderr += data })
  const closed = once(child, 'close')
  const timeout = setTimeout(() => child.kill(), 95_000)
  t.after(() => clearTimeout(timeout))
  const [code] = await closed
  const lines = stdout.split(/\r?\n/).filter((line) => line.startsWith('LAYOUT_'))
  for (const line of lines) t.diagnostic(line)
  assert.equal(code, 0, `Hidden Electron fixture failed:\n${lines.join('\n')}\n${stderr.slice(-6_000)}`)
  assert.ok(lines.some((line) => line.startsWith('LAYOUT_RESULT ') && JSON.parse(line.slice(14)).ok === true), 'Fixture must report completed geometry assertions')
})
