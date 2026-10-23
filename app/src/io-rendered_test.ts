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
import type { IoRun, IoRelayUpdate } from '../../src/io/contracts.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

test('rendered Electron I/O panel: explicit capture, asynchronous controls and two-phase finish', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron rendered smoke requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `io-rendered-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  let number = 0
  let ready = false
  let prepare: (() => void) | undefined
  let updates: IoRelayUpdate[] = []
  let lastUi: unknown
  let run: IoRun
  const newRun = () => {
    updates = []
    run = {
      version: 1, id: `run-${++number}`, projectId: 'default', sessionId: 'web:chat-smoke', revision: 'a'.repeat(64),
      definition: { version: 1, title: `Synthetic capture ${number}`, purpose: 'Rendered smoke using only a fake microphone.', endpoint: 'ws://127.0.0.1:1/synthetic', sources: [{ id: 'mic', kind: 'microphone', mode: 'recording' }], limits: { durationMs: 60_000, maxBytes: 4 * 1024 * 1024 }, ui: [] },
      status: 'awaiting_consent', createdAt: new Date().toISOString(), bytes: 0, artifacts: [],
    }
  }
  const effect = (method: IoRelayUpdate['effect']['method'], args: unknown[]) => {
    updates.push({ sequence: updates.length + 1, effect: { method, args } })
    if (method === 'ui.render') run.ui = args[0] as IoRun['ui']
    if (method === 'status') run.message = String(args[0])
  }
  const view = (text: string, revision = 0) => effect('ui.render', [[
    { id: 'notes', type: 'input', inputType: 'text', text: 'Notes', value: `Backend notes ${revision}` },
    { id: 'threshold', type: 'input', inputType: 'number', text: 'Threshold', value: 10 + revision, step: 0.1 },
    { id: 'recompute', type: 'button', text: 'Recompute' },
    { id: 'response', type: 'text', text },
  ]])
  newRun()
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', plugins: [vue(), {
      name: 'synthetic-io-api',
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const url = new URL(request.url!, 'http://127.0.0.1')
          const path = url.pathname.replace(/^\/projects\/default/, '')
          if (path === '/__io-rendered') {
            response.setHeader('Content-Type', 'text/html')
            response.end('<!doctype html><html><body><div id="app"></div><script type="module" src="/src/io/rendered-fixture.ts"></script></body></html>')
            return
          }
          if (!path.startsWith('/api/') && !path.startsWith('/__smoke/')) { next(); return }
          void (async () => {
            let raw = ''
            for await (const part of request) raw += part.toString()
            const body = raw ? JSON.parse(raw) : {}
            const json = (value: unknown) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)) }
            if (path === '/__smoke/state') return json({ status: run.status, lastUi })
            if (path === '/__smoke/ready') { ready = true; prepare?.(); return json({ ok: true }) }
            if (path === '/__smoke/new') { newRun(); return json({ ok: true }) }
            if (path === '/__smoke/view') { view('Initial backend view'); return json({ ok: true }) }
            if (path === '/__smoke/invalid-view') { effect('ui.render', [[{ id: 'threshold', type: 'input', sourceId: 'controls' }]]); return json({ ok: true }) }
            if (path === '/__smoke/stream-text') { view('Streaming result during text edit', 1); return json({ ok: true }) }
            if (path === '/__smoke/stream-number') { view('Streaming result during numeric edit', 2); return json({ ok: true }) }
            if (path === '/__smoke/done') { effect('preview', [{ mime: 'text/plain', text: 'Rendered final result' }]); run.status = 'completed'; return json({ ok: true }) }
            if (path.includes('/sessions/') && path.endsWith('/details')) return json({ sessionId: 'web:chat-smoke', name: 'Synthetic', workdir: { kind: 'local', displayPath: directory }, context: { usedTokens: null, windowTokens: null }, usage: null, usageScope: 'session' })
            if (path === '/api/io/clients') return json({ clientToken: 'synthetic-client' })
            if (path.endsWith('/heartbeat')) return json({ ok: true })
            if (path === '/api/io/runs') return json({ runs: [run] })
            if (path.endsWith('/prepare')) {
              run.backendStatus = 'connecting'
              if (!ready) await new Promise<void>(resolve => { prepare = resolve })
              run.backendStatus = 'ready'
              return json({ leaseToken: 'synthetic-lease', run })
            }
            if (path.endsWith('/start')) { assert.equal(ready, true); run.status = 'running'; run.startedAt = new Date().toISOString(); return json({ run }) }
            if (path.endsWith('/events')) {
              assert.equal(run.status, 'running')
              if (body.event.type === 'end') { run.status = 'stopping'; run.message = 'Still processing synthetic input' }
              if (body.event.type === 'ui') {
                lastUi = body.event
                setTimeout(() => view('Control acknowledged asynchronously', 3), 100)
              }
              return json({ accepted: true })
            }
            if (path.endsWith('/stop')) { run.status = body.status === 'completed' ? 'stopping' : body.status; run.error = body.error; return json({ run }) }
            if (path.endsWith('/updates')) return json({ updates: updates.filter(update => update.sequence > Number(url.searchParams.get('after') || 0)), cursor: updates.at(-1)?.sequence ?? 0 })
            if (path === `/api/io/runs/${run.id}`) return json(run)
            response.writeHead(404).end()
          })().catch(error => { response.writeHead(500).end(String(error)) })
        })
      },
    }],
    server: { host: '127.0.0.1', port: 0, hmr: false },
    optimizeDeps: { entries: ['src/io/rendered-fixture.ts'] },
    cacheDir: resolve(directory, 'vite-cache'),
  })
  t.after(() => server.close())
  await server.listen()
  const address = server.httpServer!.address()
  assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}`
  assert.equal((await fetch(`${url}/__io-rendered`)).ok, true)
  await build({ entryPoints: [resolve(root, 'app', 'src', 'io', 'rendered-electron-fixture.ts')], outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], logLevel: 'silent' })
  const env: NodeJS.ProcessEnv = { IO_SMOKE_URL: url }
  if (process.env.IO_SCREENSHOT_DIR) env.IO_SCREENSHOT_DIR = process.env.IO_SCREENSHOT_DIR
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
  assert.match(output, /IO_RENDERED_SMOKE_OK/)
  console.log(output.match(/IO_RENDERED_SMOKE_OK[^\r\n]*/)?.[0])
})
