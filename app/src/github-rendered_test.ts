import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer, type ViteDevServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createGitHubFixture } from '../../src/testing/github.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')
test('GitHub workbench imports, confirms exact writes, reconciles uncertainty and explicitly subscribes without losing drafts', {
  timeout: 90000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `github-ui-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  const f = await createGitHubFixture(directory)
  let server: ViteDevServer | undefined
  let stopChild = () => {}
  t.after(async () => {
    stopChild()
    try { await server?.close() }
    finally {
      try { await f.close() }
      finally { await rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }) }
    }
  })
  f.remote.issue.title = 'Review an externally reported correction with a verylongunbrokentopicnamethatmustwrapratherthanoverflowtheprojectsidebar'
  let reads = 0
  server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'), optimizeDeps: { entries: [] },
    plugins: [vue(), {
      name: 'github-ui-fixture',
      resolveId: id => id === '/github-fixture.ts' ? '\0github-fixture' : undefined,
      load: id => id !== '\0github-fixture' ? undefined : `
        import '/src/styles.css';
        import { createApp, h, reactive } from 'vue';
        import { createRouter, createMemoryHistory } from 'vue-router';
        import ProjectWorkbench from '/src/components/ProjectWorkbench.vue';
        import { createProjectLiveState } from '/src/project-live-state.ts';
        import { createInstallationContextProvider } from '/src/composables/useInstallationContext.ts';
        import { createLocalMainAdminContext } from '/src/installation-context.ts';
        const state = reactive({ visible: true, draft: 'Retained coordinator draft' });
        const installation = reactive(createLocalMainAdminContext(location.origin));
        window.setAdmin = value => { installation.uiScopes = value ? createLocalMainAdminContext(location.origin).uiScopes : ['chat:read']; };
        let observer;
        const live = createProjectLiveState({ client: () => ({ subscribe: (_topic, value) => {
          observer = value; return { ready: async () => {}, close: () => {} };
        } }) });
        window.invalidateWork = () => observer?.event({ payload: { event: 'invalidate' } });
        const router = createRouter({ history: createMemoryHistory(), routes: [{ name: 'chat', path: '/', component: { render: () => null } }] });
        await router.push('/'); await router.isReady();
        const app = createApp({ render: () => h(ProjectWorkbench, {
          apiBase: location.origin + '/projects/p', projectId: 'p', projectName: 'Delivery project', visible: state.visible,
          style: 'height:100vh', onCompose: text => { state.draft += '\\n\\n' + text; },
        }, { default: () => h('textarea', { value: state.draft }) }) });
        app.provide(Symbol.for('shadow.project-live-state'), live);
        app.use(router); app.use(createInstallationContextProvider(installation)); app.mount('#app');`,
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          try {
            const path = new URL(request.url!, 'http://127.0.0.1').pathname
            const json = (value: unknown) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)) }
            if (path === '/__github') {
              response.setHeader('Content-Type', 'text/html')
              response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/github-fixture.ts"></script></body></html>')
            } else if (path === '/__stats') {
              json({ writes: f.requests.filter(request => request.method !== 'GET').length, reads, deliveries: f.delivered.length })
            } else if (path === '/__fixture') {
              let body = ''
              for await (const chunk of request) body += chunk
              const command = JSON.parse(body).command
              if (command === 'source') f.remote.issue.body += '\nAdditional external detail.'
              else if (command === 'uncertain') f.remote.failAfterWrite = true
              else if (command === 'offline') f.remote.failReads = true
              else if (command === 'online') { f.remote.failReads = false; f.remote.failAfterWrite = false }
              else throw new Error('Unknown fixture command')
              json({})
            } else if (path.startsWith('/projects/p/api/github')) {
              if (path === '/projects/p/api/github' && request.method === 'GET') reads++
              let body = ''
              for await (const chunk of request) body += chunk
              const result = await f.app.request(path.slice('/projects/p'.length), {
                method: request.method, headers: { 'Content-Type': 'application/json', 'x-fixture-owner': 'yes' },
                ...(body ? { body } : {}),
              })
              response.statusCode = result.status
              result.headers.forEach((value, key) => response.setHeader(key, value))
              response.end(await result.text())
            } else if (path.endsWith('/api/sessions/graph')) json({ sessions: [], nodes: [] })
            else if (path.endsWith('/api/sessions/stages')) json({ stages: {} })
            else if (path === '/projects/p/api/work') {
              const references = f.service.references()
              json({ items: f.works.workRecords().map(work => ({
                key: work.key, title: work.workflow!.title, status: work.workflow!.status, assignee: work.workflow!.assignee,
                manager: work.workflow!.manager, parentKey: work.workflow!.parentKey ?? null, dependencies: work.workflow!.dependencies,
                revision: work.revision, sequence: work.sequence, paused: work.paused, adopted: false, proposals: 0,
                interpretationReview: false, blockedReason: null, changedAt: work.changedAt, github: references[work.key],
              })), sessions: [...f.states.keys()].map(sessionId => ({ sessionId, title: sessionId, assignable: true })), requests: [], effects: [] })
            } else next()
          } catch (error) { next(error) }
        })
      },
    }], server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const url = server.resolvedUrls?.local[0]
  assert.ok(url)
  await build({ entryPoints: [resolve(root, 'desktop', 'tests', 'fixtures', 'github-smoke.ts')],
    outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs',
    target: 'node24', external: ['electron'], logLevel: 'silent' })
  const env: NodeJS.ProcessEnv = { GITHUB_SMOKE_URL: url }
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XAUTHORITY', 'GITHUB_SCREENSHOTS']) {
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
  stopChild = () => { clearTimeout(timer); if (child.exitCode === null) child.kill() }
  const [code] = await once(child, 'close')
  assert.equal(code, 0, output)
  assert.match(output, /GITHUB_SMOKE_OK/)
  assert.equal(f.remote.comments.length, 2)
  assert.deepEqual(f.service.state().operations.map(operation => operation.status), ['succeeded', 'reconciled'])
  assert.equal(f.delivered.length, 1)
  assert.equal(f.delivered[0].delivery?.urgency, 'queue')
  assert.equal(f.works.workRecords().length, 2)
  assert.equal(f.works.workRecords().find(work => work.key !== f.work.key)?.workflow?.assignee, null)
})
