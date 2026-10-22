import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

test('rendered desktop picker uses real protected IPC with synthetic sources and denies physical acquisition', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `display-picker-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error',
    plugins: [vue(), {
      name: 'display-picker-fixture',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== '/__display-picker') return next()
          response.setHeader('Content-Type', 'text/html')
          response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/src/io/display-picker-fixture.ts"></script></body></html>')
        })
      },
    }],
    server: { host: '127.0.0.1', port: 0, hmr: false },
    optimizeDeps: { entries: ['src/io/display-picker-fixture.ts'] },
    cacheDir: resolve(directory, 'vite-cache'),
  })
  t.after(() => server.close())
  await server.listen()
  const address = server.httpServer!.address()
  assert.ok(address && typeof address !== 'string')
  await Promise.all([
    ['app', 'src', 'io', 'display-picker-electron-fixture.ts'],
    ['desktop', 'tests', 'fixtures', 'media-permissions-preload.ts'],
  ].map((path, index) => build({
    entryPoints: [resolve(root, ...path)], outfile: resolve(directory, index ? 'preload.cjs' : 'main.cjs'),
    bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], logLevel: 'silent',
  })))
  const env: NodeJS.ProcessEnv = { PICKER_SMOKE_URL: `http://127.0.0.1:${address.port}/__display-picker` }
  if (process.env.PICKER_SCREENSHOT_DIR) env.PICKER_SCREENSHOT_DIR = process.env.PICKER_SCREENSHOT_DIR
  for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) if (process.env[name] !== undefined) env[name] = process.env[name]
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[name] = directory
  const child = spawn(desktopRequire('electron') as string, [resolve(directory, 'main.cjs')], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
  const timeout = setTimeout(() => child.kill(), 75_000)
  t.after(() => { clearTimeout(timeout); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, output)
  assert.match(output, /DISPLAY_PICKER_SMOKE_OK/)
  assert.doesNotMatch(output, /UnhandledPromiseRejection|Uncaught Exception/)
  console.log(output.match(/DISPLAY_PICKER_SMOKE_OK[^\r\n]*/)?.[0])
})
