import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { createServer } from 'vite'
import { recordedFileChange } from '../../src/tools/file-change.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')
const sessionId = 'web:diff-fixture'
const path = 'src/release.ts'
const before = 'import { resolve } from "node:path";\n\nexport function release(): string {\n  return "old";\n}\n'
const after = `import { relative, resolve } from "node:path";\n\nexport function release(): string {\n  return "${'long-code-'.repeat(70)}";\n}\n`
const edit = recordedFileChange({ sessionId, toolCallId: 'edit', path, mode: 'edit', before, after })
const unavailable = recordedFileChange({ sessionId, toolCallId: 'unavailable', path, mode: 'write', after: 'const value = 42;\n', unavailable: 'Previous content was not readable.' })
const noop = recordedFileChange({ sessionId, toolCallId: 'noop', path, mode: 'edit', before: 'same', after: 'same' })

test('expanded official write tools render historical unified file diffs across themes and narrow viewports', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `tool-diff-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const requests: string[] = []
  let retryCount = 0
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app', 'unocss.config.ts') }), {
      name: 'synthetic-tool-diff',
      resolveId: id => id === '/tool-diff-fixture.ts' ? '\0tool-diff-fixture' : undefined,
      load(id) {
        if (id !== '\0tool-diff-fixture') return
        return `import 'uno.css'; import '/src/styles.css';
          import { createApp, computed, h, reactive } from 'vue';
          import ToolActivityGroup from '/src/components/ToolActivityGroup.vue';
          import { groupToolActivity } from '/src/tool-activity.ts';
          const state = reactive({ id:'edit', sessionId:${JSON.stringify(sessionId)}, extra:'' });
          window.__diffFixture = state;
          const listeners = new Map(['selectionchange','pointerup','pointercancel'].map(type => [type,new Set()]));
          const add = document.addEventListener.bind(document), remove = document.removeEventListener.bind(document);
          document.addEventListener = (type, listener, options) => { listeners.get(type)?.add(listener); add(type,listener,options); };
          document.removeEventListener = (type, listener, options) => { listeners.get(type)?.delete(listener); remove(type,listener,options); };
          window.__diffListenerCount = () => [...listeners.values()].reduce((total, set) => total + set.size, 0);
          const calls = () => [
            { event:'tool_call', content:'', toolCallId:state.id, toolCall:{name:'write',arguments:{path:${JSON.stringify(path)},match:'requested old',content:'requested new'}} },
            { event:'tool_result', toolCallId:state.id, content:state.id === 'failed' ? 'Error: write denied'
              : state.id === 'legacy' ? 'OK edit' : 'OK edit +2 -2 edit=${edit.id}' },
            ...(state.extra ? [
              { event:'tool_call', content:'', toolCallId:'repeat', toolCall:{name:'write',arguments:{path:${JSON.stringify(path)},content:'Repeated edit'}} },
              { event:'tool_result', toolCallId:'repeat', content:'OK edit +1 -0' },
              { event:'tool_call', content:'', toolCallId:'second', toolCall:{name:'write',arguments:{path:'src/second.ts',content:'Second file'}} },
              { event:'tool_result', toolCallId:'second', content:'OK write +1 -0' },
            ] : []),
            ...(state.extra === 'mixed' ? [
              { event:'tool_call', content:'', toolCallId:'check', toolCall:{name:'exec',arguments:{command:'check'}} },
              { event:'tool_result', toolCallId:'check', content:'Passed' },
            ] : []),
          ];
          createApp({ setup() {
            const batch = computed(() => groupToolActivity(calls()).get(0));
            return () => h('main', {style:'max-width:920px;margin:24px auto;padding:0 12px'}, [
              h(ToolActivityGroup, {batch:batch.value, apiBase:location.origin, sessionId:state.sessionId}),
            ]);
          } }).mount('#app');`
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          const url = new URL(request.url ?? '/', 'http://fixture')
          if (url.pathname.endsWith('/file-changes')) {
            const id = url.searchParams.get('toolCallId') ?? ''
            requests.push(id)
            response.setHeader('Content-Type', 'application/json')
            if (id === 'retry' && retryCount++ === 0) {
              response.statusCode = 503
              response.end(JSON.stringify({ error: 'synthetic_failure' }))
              return
            }
            const change = id === 'unavailable' ? unavailable : id === 'noop' ? noop
              : id === 'missing' ? undefined : { ...edit, toolCallId: id }
            const send = () => response.end(JSON.stringify({
              changes: change ? [change] : [], total: change ? 1 : 0, offset: 0,
            }))
            if (id === 'slow') setTimeout(send, 400)
            else send()
            return
          }
          if (url.pathname !== '/__tool_diff') return next()
          response.setHeader('Content-Type', 'text/html')
          response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app"></div><script type="module" src="/tool-diff-fixture.ts"></script></body></html>')
        })
      },
    }],
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  t.after(() => server.close())
  await build({
    entryPoints: [resolve(root, 'desktop', 'tests', 'fixtures', 'tool-file-diff-smoke.ts')],
    outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs',
    target: 'node24', external: ['electron'], logLevel: 'silent',
  })
  const env: NodeJS.ProcessEnv = { TOOL_DIFF_SMOKE_URL: server.resolvedUrls!.local[0] }
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'TOOL_DIFF_SCREENSHOTS']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = directory
  const child = spawn(desktopRequire('electron') as string, [resolve(directory, 'main.cjs')], {
    cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })
  const timer = setTimeout(() => child.kill(), 75_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, output)
  assert.match(output, /TOOL_DIFF_SMOKE_OK/)
  assert.ok(requests.includes('edit'))
  assert.equal(requests.filter(id => id === 'retry').length, 2)
  assert.equal(requests.filter(id => id === 'failed').length, 0)
})
