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
import UnoCSS from 'unocss/vite'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

test('rendered Project workbench shows assignment, graph, guarded details and a retained coordinator draft', {
  timeout: 90000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `work-ui-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const writes: { action: string; data?: { definition?: { objective: string }; strategy?: string } }[] = []
  let reportingSessionId = 'web:fixture'
  let reportingWrites = 0
  let empty = false, unavailable = false, deleteAttempts = 0
  let record = {
    key: 'topic:web:fixture', subject: { kind: 'topic', sessionId: 'web:fixture' }, revision: 1,
    definition: { objective: 'Run both evaluations', acceptance: ['Both have complete results'], boundaries: ['No publication'], evidence: [] },
    origin: 'agent_interpretation', reason: 'Initial understanding', paused: false,
    authority: { manager: 'web:fixture', executor: 'web:fixture', active: true },
    sequence: 1,
    workflow: { title: 'Run both evaluations', parentKey: 'work:root', manager: 'web:fixture', assignee: 'web:fixture',
      assignmentRevision: 1, status: 'in_progress', dependencies: ['work:inputs'] },
    adoption: { sessionId: 'web:fixture', revision: 1, understanding: 'Both evaluations', stop: ['Only smoke'], retain: ['Inputs'], next: ['Start with smoke'] },
    checkpoint: { revision: 1, completed: ['Inputs checked'], artifacts: ['report.json'], inFlight: [], unknown: [], retired: ['Only smoke'] },
    proposals: [{ id: '11111111-1111-4111-8111-111111111111', baseRevision: 1, assignmentRevision: 1, status: 'pending',
      change: 'pause', reason: 'Review before executing', paused: true,
      definition: { objective: 'Run both evaluations', acceptance: ['Both have complete results'], boundaries: ['No publication'], evidence: [] } }],
    history: [{ kind: 'proposal', actor: 'web:peer', at: new Date().toISOString(),
      data: { definition: { objective: 'Two independent outcomes', acceptance: ['Both verified'], boundaries: ['No publication'] } } }],
  }
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    optimizeDeps: { entries: [] },
    plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app', 'unocss.config.ts') }), {
      name: 'work-alignment-fixture',
      resolveId: id => id === '/work-fixture.ts' ? '\0work-fixture' : undefined,
      load: id => id !== '\0work-fixture' ? undefined : `
        import '/src/styles.css';
        import 'uno.css';
        import { createApp, h, reactive } from 'vue';
        import { createRouter, createMemoryHistory } from 'vue-router';
        import ProjectWorkbench from '/src/components/ProjectDashboard.vue';
        import ProjectDeleteDialog from '/src/components/ProjectDeleteDialog.vue';
        import { createProjectLiveState } from '/src/project-live-state.ts';
        import { createInstallationContextProvider } from '/src/composables/useInstallationContext.ts';
        import { createLocalMainAdminContext } from '/src/installation-context.ts';
        const state = reactive({ visible: true, draft: 'Keep my unsent draft', navigated: '', deleting: false, deleted: false });
        window.fixture = state;
        window.showProjectDelete = () => { state.deleting = true; };
        const installation = reactive(createLocalMainAdminContext(location.origin));
        window.setAdmin = value => { installation.uiScopes = value ? createLocalMainAdminContext(location.origin).uiScopes : ['chat:read']; };
        let observer;
        const live = createProjectLiveState({ client: () => ({ subscribe: (_topic, value) => {
          observer = value; return { ready: async () => {}, close: () => {} };
        } }) });
        window.invalidateWork = () => observer?.event({ payload: { event: 'invalidate' } });
        const router = createRouter({ history: createMemoryHistory(), routes: [
          { name: 'chat', path: '/projects/:projectId/chat/:sessionId?', component: { render: () => null } },
          { name: 'project-settings', path: '/projects/:projectId/settings/:section?', component: { render: () => null } },
          { name: 'agents', path: '/projects/:projectId/agents', component: { render: () => null } },
          { name: 'settings', path: '/settings/:section?', component: { render: () => null } },
        ] });
        window.navigateTab = tab => router.push(tab === 'settings'
          ? { name:'project-settings', params:{projectId:'p',section:'general'} }
          : { name:'chat', params:{projectId:'p',sessionId:'web:orchestrator'} });
        window.navigateWork = key => router.replace({ query: { work: key } });
        await router.push({ name:'chat', params:{projectId:'p',sessionId:'web:orchestrator'} }); await router.isReady();
        const app = createApp({ render: () => [h(ProjectWorkbench, {
          apiBase: location.origin + '/projects/p', projectId: 'p', projectName: 'Evaluation project', visible: state.visible,
          style: 'height:100vh',
          onNavigate: id => { state.navigated = id; }, onCompose: text => { state.draft += '\\n\\n' + text; },
          onProjectNavigation: tab => window.navigateTab(tab),
        }, { default: ({ active }) => h('section', { style: 'display:flex;flex:1;flex-direction:column;padding:16px;min-width:0;' }, [
          h('p', 'Coordinator conversation'), h('p', { style: 'flex:1;font-size:14px;' }, 'The evaluations are assigned. The second stage depends on prepared inputs.'),
          h('textarea', { id: 'fixture-composer', value: state.draft, disabled: !active,
            style: 'box-sizing:border-box;width:100%;min-height:100px;background:var(--c-bg-input);color:var(--c-text);',
            onInput: event => { state.draft = event.target.value; } }),
        ]) }), state.deleting ? h(ProjectDeleteDialog, {
          apiBase: location.origin, project: { id:'p', name:'Evaluation project', createdAt:'2026-10-05T00:00:00Z' },
          onClose: () => { state.deleting = false; },
          onDeleted: () => { state.deleted = true; state.deleting = false; },
        }) : null] });
        app.provide(Symbol.for('shadow.project-live-state'), live);
        app.use(router); app.use(createInstallationContextProvider(installation)); app.mount('#app');`,
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          const path = new URL(request.url!, 'http://127.0.0.1').pathname
          const json = (value: unknown) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)) }
          if (path === '/__work') {
            response.setHeader('Content-Type', 'text/html')
            response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/work-fixture.ts"></script></body></html>')
          } else if (path === '/__fixture') {
            let body = ''
            for await (const chunk of request) body += chunk
            const value = JSON.parse(body); empty = !!value.empty; unavailable = !!value.unavailable
            json({})
          } else if (path === '/api/projects/p' && request.method === 'DELETE') {
            if (++deleteAttempts === 1) {
              response.statusCode = 409
              json({ message: 'Stop active project work before deleting.' })
            } else json({ deletedProjectId: 'p' })
          } else if (path === '/api/projects') {
            json({ projects: [{ id: 'p', name: 'Evaluation project', createdAt: '2026-10-05T00:00:00Z' }] })
          } else if (path.endsWith('/api/config')) {
            json({ agent: { model: 'fixture', workspace: 'C:\\synthetic-home', temperature: 0.7 }, learning: {} })
          } else if (path.endsWith('/api/sessions/graph')) {
            json({ sessions: [{ sessionId: 'web:fixture', title: 'Evaluation session' }], nodes: [] })
          } else if (path.endsWith('/api/sessions/stages')) {
            json({ stages: { 'web:fixture': 'idle' } })
          } else if (path === '/projects/p/api/work') {
            if (unavailable) { response.statusCode = 503; json({ error: 'unavailable' }); return }
            const summary = (key: string, title: string, status = 'pending', assignee: string | null = null) => ({
              key, title, status, assignee, revision: 1, sequence: 1, parentKey: null, dependencies: [],
              manager: 'web:fixture', blockedReason: status === 'blocked' ? 'Waiting for the evaluation comparison' : null,
              paused: false, adopted: false, proposals: 0, interpretationReview: false, changedAt: new Date().toISOString(),
            })
            json({
              items: empty ? [] : [
                summary('work:root', 'Evaluation rollout'),
                { ...summary('work:inputs', 'Prepare evaluation inputs', 'done', 'web:reviewer'), parentKey: 'work:root' },
                { ...summary(record.key, record.workflow.title, 'in_progress', 'web:fixture'),
                  parentKey: 'work:root', dependencies: ['work:inputs'], revision: record.revision, proposals: record.revision === 1 ? 1 : 0 },
                summary('work:followup', 'Document the comparison', 'blocked'),
              ],
              sessions: [
                { sessionId: 'web:fixture', title: 'Evaluation session', assignable: true },
                { sessionId: 'web:reviewer', title: 'Review session', assignable: true },
                { sessionId: 'web:orchestrator', title: 'Coordinator', assignable: true },
              ], requests: [], effects: [],
            })
          } else if (path.endsWith('/decisions/owner')) {
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
          } else if (path.startsWith('/projects/p/api/work/')) {
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
  assert.equal(code, 0, `${output}\n${JSON.stringify(writes)}`)
  assert.match(output, /WORK_SMOKE_OK/)
  assert.deepEqual(writes.map(write => write.action), ['transition', 'update', 'update'])
  assert.equal(writes[0].data?.strategy, 'fresh')
  assert.equal(writes[2].data?.definition?.objective, 'Corrected final outcome')
  assert.equal(reportingWrites, 1, 'Reporting remains an explicit advanced action')
  assert.equal(reportingSessionId, 'web:reviewer')
})
