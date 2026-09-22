import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

test('rendered work agreements preserve drafts on conflicts and separate goal, phase, checkpoint and transitions', {
  timeout: 90000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `work-ui-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const writes: { action: string; data?: { definition?: { objective: string }; strategy?: string } }[] = []
  let reportingSessionId = 'web:fixture'
  let reportingWrites = 0
  let record = {
    key: 'topic:web:fixture', subject: { kind: 'topic', sessionId: 'web:fixture' }, revision: 1,
    definition: { objective: 'Run both evaluations', acceptance: ['Both have complete results'], boundaries: ['No publication'], evidence: [] },
    origin: 'agent_interpretation', reason: 'Initial understanding', paused: false,
    authority: { manager: 'web:fixture', executor: 'web:fixture', active: true },
    adoption: { sessionId: 'web:fixture', revision: 1, understanding: 'Both evaluations', stop: ['Only smoke'], retain: ['Inputs'], next: ['Start with smoke'] },
    checkpoint: { revision: 1, completed: ['Inputs checked'], artifacts: ['report.json'], inFlight: [], unknown: [], retired: ['Only smoke'] },
    history: [{ kind: 'proposal', actor: 'web:peer', at: new Date().toISOString(),
      data: { definition: { objective: 'Two independent outcomes', acceptance: ['Both verified'], boundaries: ['No publication'] } } }],
  }
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    optimizeDeps: { entries: [] },
    plugins: [vue(), {
      name: 'work-alignment-fixture',
      resolveId: id => id === '/work-fixture.ts' ? '\0work-fixture' : undefined,
      load: id => id !== '\0work-fixture' ? undefined : `
        import '/src/styles.css';
        import { createApp, h, reactive } from 'vue';
        import SessionWorkControls from '/src/components/SessionWorkControls.vue';
        const state = reactive({ sessionId: 'web:fixture', canWrite: true, active: true });
        window.fixture = state;
        createApp({ render: () => h('div', { style: 'position:fixed;inset:auto 0 16px;' }, [
          h(SessionWorkControls, { ...state, apiBase: location.origin }),
          h('div', { id: 'fixture-composer', tabindex: 0,
            style: 'box-sizing:border-box;width:calc(100% - 40px);max-width:860px;height:96px;margin:8px auto 0;padding:12px;border:1px solid var(--c-border);background:var(--c-bg-input);color:var(--c-text-secondary);font-size:14px;' }, 'Message input'),
        ]) }).mount('#app');`,
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          const path = new URL(request.url!, 'http://127.0.0.1').pathname
          const json = (value: unknown) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)) }
          if (path === '/__work') {
            response.setHeader('Content-Type', 'text/html')
            response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/work-fixture.ts"></script></body></html>')
          } else if (path.startsWith('/api/sessions/') && path.endsWith('/decisions/owner')) {
            if (request.method === 'POST') {
              let body = ''
              for await (const chunk of request) body += chunk
              reportingSessionId = JSON.parse(body).reportingSessionId
              reportingWrites++
            }
            json({ reportingSessionId, candidates: [
              { sessionId: 'web:fixture', label: 'Current session' },
              { sessionId: 'web:reviewer', label: 'Review session' },
            ] })
          } else if (path.startsWith('/api/sessions/') && path.endsWith('/work')) {
            if (request.method === 'POST') {
              let body = ''
              for await (const chunk of request) body += chunk
              const input = JSON.parse(body)
              writes.push(input)
              if (input.action === 'update') {
                if (input.data.reason === 'Conflict') {
                  response.statusCode = 409
                  json({ message: 'Work revision changed; reload before applying.' }); return
                }
                record = { ...record, revision: record.revision + 1, definition: input.data.definition, origin: 'human', reason: input.data.reason }
              }
            }
            json({ records: [record], effects: [] })
          } else next()
        })
      },
    }], server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  t.after(() => server.close())
  const url = server.resolvedUrls?.local[0]
  assert.ok(url)
  await build({ entryPoints: [resolve(root, 'desktop', 'tests', 'fixtures', 'work-alignment-smoke.ts')],
    outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs',
    target: 'node24', external: ['electron'], logLevel: 'silent' })
  const env: NodeJS.ProcessEnv = { WORK_SMOKE_URL: url }
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XAUTHORITY', 'WORK_SCREENSHOTS']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = directory
  const child = spawn(desktopRequire('electron') as string, [resolve(directory, 'main.cjs')], {
    cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })
  const timer = setTimeout(() => child.kill(), 75000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, output)
  assert.match(output, /WORK_SMOKE_OK/)
  assert.deepEqual(writes.map(write => write.action), ['transition', 'update', 'update'])
  assert.equal(writes[0].data?.strategy, 'fresh')
  assert.equal(writes[2].data?.definition?.objective, 'Corrected final outcome')
  assert.equal(reportingWrites, 1)
  assert.equal(reportingSessionId, 'web:reviewer')
})
