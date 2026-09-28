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
import UnoCSS from 'unocss/vite'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

test('rendered diagnosis: cold-load context layout, timing, metadata and lazy syntax highlighting', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron rendered smoke requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `trace-rendered-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const start = Date.parse('2026-09-17T00:00:00Z')
  let end = start + 6 * 60 * 60 * 1000
  let modelState = 'recorded'
  const toolCall = { id: 'call-1', type: 'function', function: { name: 'read', arguments: '{"path":"fixture.txt","nested":{"value":42}}' } }
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', plugins: [vue(),
      UnoCSS({ configFile: resolve(root, 'app', 'unocss.config.ts') }), {
      name: 'synthetic-trace',
      resolveId(id) {
        if (id === '/trace-fixture.ts') return '\0trace-fixture'
        if (id === '/tool-details-fixture.ts') return '\0tool-details-fixture'
        if (id === '/context-fixture.ts') return '\0context-fixture'
      },
      load(id) {
        if (id === '\0context-fixture') return `import 'uno.css';
          import { createApp, h } from 'vue';
          import '/src/styles.css';
          const { default: Diagnosis } = await import('/src/components/SessionDiagnosis.vue');
          const paragraph = 'Coordinate this synthetic project using its registered resources and independent conversations. ';
          createApp({ render: () => h(Diagnosis, { apiBase: location.origin, sessionId: 'context-fixture',
            physicalId: null, active: false, canReadTrace: false, working: false,
            systemPrompt: '# Project coordinator\\n\\n' + paragraph.repeat(16) + '\\n\\n\`\`\`text\\n' + 'long-token-'.repeat(80) + '\\n\`\`\`',
            compactionSummary: '# Earlier context\\n\\nRetained synthetic summary.',
            tools: [{ name: 'read', description: 'Read project resources', parameters: { properties: { path: { type: 'string' } } } }]
          }) }).mount('#app');`
        if (id === '\0tool-details-fixture') return `import { createApp, h, reactive } from 'vue';
          import ToolActivityGroup from '/src/components/ToolActivityGroup.vue';
          import '/src/styles.css';
          const batch = reactive({ end: 4, files: 0, incomplete: false, entries: [
            { index: 0, name: 'read', title: 'Read fixture', summary: '', icon: 'read', path:'fixture.json', failed: false,
              arguments: '{\\n  "path": "fixture.json",\\n  "count": 42\\n}',
              result: '{"ok":true,"html":"<img src=x onerror=alert(1)>"}' },
            { index: 1, name: 'message', title: 'Send fixture', summary: '', icon: 'tool', failed: false,
              arguments: '{"content":"hello"}', result: '' },
            { index: 2, name: 'write', title: 'Edit server.py', summary: '', icon: 'write', path:'src/server.py', failed: true,
              arguments: '{"path":"src/server.py"}', result: 'Error: permission denied' },
            { index: 3, name: 'write', title: 'Edit mystery.xyz', summary: '', icon: 'write', path:'src/mystery.xyz', failed: false,
              arguments: '{"path":"src/mystery.xyz"}' }
          ] });
          window.updateToolResult = source => { batch.entries[0].result = source; };
          createApp({ render: () => h(ToolActivityGroup, { batch }) }).mount('#app');`
        if (id !== '\0trace-fixture') return
        return `import { createApp, h } from 'vue';
          import Diagnosis from '/src/components/SessionDiagnosis.vue';
          import '/src/styles.css';
          createApp({ render: () => h(Diagnosis, { apiBase: location.origin, sessionId: 'fixture',
            physicalId: null, active: true, canReadTrace: true, working: false,
            systemPrompt: '', compactionSummary: '', tools: [] }) }).mount('#app');`
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const path = new URL(request.url!, 'http://127.0.0.1').pathname
          const json = (value: unknown) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)) }
          if (path === '/__context') {
            response.setHeader('Content-Type', 'text/html')
            response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div><script type="module" src="/context-fixture.ts"></script></body></html>')
            return
          }
          if (path === '/__tool-details') {
            response.setHeader('Content-Type', 'text/html')
            response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div><script type="module" src="/tool-details-fixture.ts"></script></body></html>')
            return
          }
          if (path === '/__trace') {
            response.setHeader('Content-Type', 'text/html')
            response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div><script type="module" src="/trace-fixture.ts"></script></body></html>')
            return
          }
          if (path === '/__trace/advance') { end += 60_000; json({ ok: true }); return }
          if (path.startsWith('/__trace/model-')) { modelState = path.slice('/__trace/model-'.length); json({ ok: true }); return }
          if (path === '/api/sessions/fixture/diagnosis') {
            json({
              schemaVersion: 1, kind: 'shadow-session-diagnosis',
              session: { sessionId: 'fixture', physicalId: 'segment' },
              history: { records: [{ id: 'segment:record:0', content: 'Synthetic exported evidence' }], hasMore: true },
              trace: { hasMore: false },
              privacy: { truncatedPaths: [], reviewRequiredBeforeSharing: true },
            })
            return
          }
          if (path === '/api/sessions/fixture') {
            json({ currentPhysicalId: 'segment', messages: [
              { role: 'user', content: 'Old input', timestamp: new Date(start).toISOString() },
              { role: 'assistant', content: 'Historical model return', timestamp: new Date(start + 2000).toISOString() },
              { role: 'user', content: 'Recent input with complete event content', timestamp: new Date(end - 60_000).toISOString() },
              { role: 'assistant', content: '', timestamp: new Date(end - 50_000).toISOString(), tool_calls: [toolCall] },
              { role: 'tool', tool_call_id: 'call-1', content: 'Synthetic tool result' },
              { role: 'assistant', content: 'Final model return', timestamp: new Date(end).toISOString() },
              { role: 'user', name: 'admin', content: [
                { type: 'text', text: '<sender id="web:orchestrator" name="admin" source="session" intent="handoff" />' },
                { type: 'text', text: 'Delegated inspection from coordinator.' },
              ] },
            ] })
            return
          }
          if (path === '/v1/query/session-spans') {
            json({ sessionId: 'fixture', physicalSessionId: 'segment', hasMore: false, entries: [
              { id: 1, traceId: 'fixture-trace', spanId: 'old', name: 'agent.chat', startTime: start + 1000, endTime: start + 2000, live: false, attributes: { 'llm.input_messages': '2' }, events: [] },
              { id: 2, traceId: 'fixture-trace', spanId: 'tool', name: 'agent.tool', startTime: end - 50_000, endTime: end - 40_000, live: false, attributes: { 'tool.call_id': 'call-1', 'tool.name': 'read', metadata: 'Synthetic metadata' }, events: [] },
              { id: modelState === 'live' ? null : 3, traceId: 'fixture-trace', spanId: 'model', name: 'agent.chat', startTime: end - 40_000,
                endTime: modelState === 'live' ? undefined : end, live: modelState === 'live', statusCode: modelState === 'failed' ? 2 : 0,
                attributes: { model: 'synthetic-model' }, events: modelState === 'recorded' ? [{
                  name: 'model.response', time: end, attributes: { message: JSON.stringify({
                    role: 'assistant', content: 'Final model return', reasoning_text: 'Synthetic model reasoning',
                    tool_calls: [toolCall], usage: { totalTokens: 42 },
                  }) },
                }] : [] },
            ] })
            return
          }
          next()
        })
      },
    }],
    server: { host: '127.0.0.1', port: 0, hmr: false },
    optimizeDeps: { include: ['vue'], entries: [] },
    cacheDir: resolve(directory, 'vite-cache'),
  })
  t.after(() => server.close())
  await server.listen()
  const address = server.httpServer!.address()
  assert.ok(address && typeof address !== 'string')
  const url = `http://127.0.0.1:${address.port}`
  assert.equal((await fetch(`${url}/__trace`)).ok, true)
  await build({
    entryPoints: [resolve(root, 'desktop', 'tests', 'fixtures', 'session-diagnosis-smoke.ts')],
    outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs',
    target: 'node24', external: ['electron'], logLevel: 'silent',
  })
  const env: NodeJS.ProcessEnv = { TRACE_SMOKE_URL: url }
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
  assert.match(output, /TRACE_RENDERED_SMOKE_OK/)
})
