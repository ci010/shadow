import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer, optimizeDeps } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { z } from 'zod'
import { workDefinitionSchema, workRecordSchema } from '../../src/initiatives/work-contract.ts'
import { workNotesSchema, workNotePatchSchema } from '../../src/initiatives/work-notes.ts'
import { parseYieldRequest } from '../../src/sessions/yield-contract.ts'
import { pdfViewerAssets } from '../pdf-viewer-assets.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

test('rendered Project canvas anchors native questions, retains drafts, isolates HTML and preserves the workbench', {
  timeout: 120000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `work-ui-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const writes: { action: string; version: number; data: unknown }[] = [], answers: unknown[] = []
  let reportingSessionId = 'web:fixture', reportingWrites = 0, exhibitRequests = 0
  let empty = false, unavailable = false, deleteAttempts = 0, questionOpen = true
  const at = '2026-10-05T00:00:00Z'
  const rootKey = 'work:11111111-1111-4111-8111-111111111111'
  const graderKey = 'work:22222222-2222-4222-8222-222222222222'
  const exhibit = `<h2>Release evidence</h2><p>Token usage is measurable without a grader.</p>
    <table><thead><tr><th>Evidence</th><th>Availability</th></tr></thead><tbody>
    <tr><td>Token measurements</td><td>Ready</td></tr><tr><td>Scored evaluation</td><td>Optional</td></tr></tbody></table>
    <script>top.__exhibitEscaped=true;fetch('/__exhibit_network')</script>
    <img src="/__exhibit_network" onerror="top.__exhibitEscaped=true">
    <style>@import url('/__exhibit_network');body{background-image:url('/__exhibit_network')}</style>
    <form action="/__exhibit_network"><input name="secret"><button>Approve inside HTML</button></form>
    <a href="javascript:top.__exhibitEscaped=true">Untrusted navigation</a>
    <iframe src="/__exhibit_network"></iframe><meta http-equiv="refresh" content="0;url=/__exhibit_network">`
  const goal = workRecordSchema.parse({
    key: rootKey, subject: { kind: 'work', id: rootKey.slice(5) }, revision: 1, sequence: 1,
    definition: { objective: 'Understand release impact from available evidence', acceptance: ['A concise comparison'], boundaries: ['No publication'], evidence: [] },
    origin: 'human', changedBy: 'human', changedAt: at, change: 'goal', reason: 'User outcome', paused: false,
    workflow: { title: 'Release evidence', manager: 'web:orchestrator', assignee: 'web:orchestrator', assignmentRevision: 1, status: 'in_progress', dependencies: [] },
    notes: { kind: 'goal', summary: 'Token measurements are ready. The scoring approach needs a decision.', next: 'Confirm the evidence needed for the release report', html: exhibit },
  })
  let record = workRecordSchema.parse({
    key: 'topic:web:fixture', subject: { kind: 'topic', sessionId: 'web:fixture' }, revision: 1, sequence: 1,
    definition: { objective: 'Compare release candidates using the available measurements', acceptance: ['Report both candidates'], boundaries: ['No publication'], evidence: [] },
    origin: 'agent_interpretation', changedBy: 'web:fixture', changedAt: at, change: 'understanding', reason: 'Chosen approach', paused: false,
    workflow: { title: 'Evaluate release candidates', parentKey: rootKey, manager: 'web:orchestrator', assignee: 'web:fixture',
      assignmentRevision: 1, status: 'in_progress', dependencies: ['work:inputs'] },
    notes: { kind: 'approach', relation: { kind: 'supports', reason: 'Compare measurements to explain release impact' },
      basis: [{ key: rootKey, revision: 1 }], summary: 'Input fixtures are available', next: 'Compare token usage', plan: ['Read the usage report', 'Compare candidates'],
      artifacts: [{ label: 'Usage report', href: '/report.json' }],
      attention: { kind: 'assumption', summary: 'A grader is not required for token measurements', version: 1, by: 'web:fixture', at } },
  })
  const grader = workRecordSchema.parse({
    ...record, key: graderKey, subject: { kind: 'work', id: graderKey.slice(5) },
    definition: { objective: 'Prepare scoring only if the report requires it' },
    workflow: { ...record.workflow, title: 'Prepare a grader', parentKey: record.key, assignee: null, status: 'pending', dependencies: [] },
    notes: { kind: 'task', basis: [{ key: rootKey, revision: 1 }, { key: record.key, revision: 1 }],
      relation: { kind: 'assumption', reason: 'Scored evaluation was assumed to be necessary' } },
  })
  const question = parseYieldRequest({
    id: 'fixture-decision', sessionId: 'web:fixture', createdAt: at, deadline: null,
    question: 'Should the release report wait for scored evaluation?',
    options: ['Wait for a grader', 'Report token metrics only'], defaultOption: 'Report token metrics only',
    recipient: { kind: 'user', sessionId: 'web:fixture' }, origin: { physicalId: 'fixture-segment', toolCallId: 'ask-fixture' },
    workContext: { originKey: graderKey, decisionKey: rootKey, path: [goal, record, grader].map(item => ({
      key: item.key, revision: item.revision, assignmentRevision: item.workflow!.assignmentRevision,
      title: item.workflow!.title, objective: item.definition.objective, kind: item.notes!.kind, origin: item.origin,
      ...(item.key === graderKey ? { contextNeedsReview: true } : {}),
      ...(item.notes?.relation ? { relation: item.notes.relation } : {}),
    })) },
  }, 'web:fixture')
  const input = { kind: 'input', id: 'fixture-input', sessionId: 'web:untracked', question: 'Which report should be attached?',
    recipient: { kind: 'user', sessionId: 'web:untracked' }, origin: { physicalId: 'untracked-segment' }, createdAt: at, deadline: null }
  const detail = () => ({ records: [{ ...record, contextChanged: false,
    authority: { manager: record.workflow!.manager, executor: record.workflow!.assignee, active: true }, history: [] }], effects: [] })
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    optimizeDeps: { noDiscovery: true, exclude: ['emf-converter', '@napi-rs/canvas'],
      include: ['vue', 'vue-router', 'marked', 'dompurify', 'zod', 'katex', '@open-file-viewer/core', '@monaco-editor/loader'] },
    plugins: [pdfViewerAssets(), vue(), UnoCSS({ configFile: resolve(root, 'app', 'unocss.config.ts') }), {
      name: 'work-alignment-fixture',
      resolveId: id => id === '/work-fixture.ts' ? '\0work-fixture' : undefined,
      load: id => id !== '\0work-fixture' ? undefined : `
        import '/src/styles.css'; import 'uno.css';
        import { createApp, h, reactive } from 'vue';
        import { createRouter, createMemoryHistory } from 'vue-router';
        import ProjectWorkbench from '/src/components/ProjectDashboard.vue';
        import ProjectDeleteDialog from '/src/components/ProjectDeleteDialog.vue';
        import { createProjectLiveState } from '/src/project-live-state.ts';
        import { createInstallationContextProvider } from '/src/composables/useInstallationContext.ts';
        import { createLocalMainAdminContext } from '/src/installation-context.ts';
        const state = reactive({ visible:true, draft:'Keep my unsent draft', navigated:'', deleting:false, deleted:false });
        window.fixture = state;
        window.fixtureKeys = ${JSON.stringify({ root: rootKey, note: record.key, grader: graderKey })};
        window.showProjectDelete = () => { state.deleting = true; };
        const installation = reactive(createLocalMainAdminContext(location.origin));
        window.setAdmin = value => { installation.uiScopes = value ? createLocalMainAdminContext(location.origin).uiScopes : ['chat:read']; };
        let observer;
        const live = createProjectLiveState({ client: () => ({ subscribe: (_topic, value) => {
          observer = value; return { ready:async () => {}, close:() => {} };
        } }) });
        window.invalidateWork = () => observer?.event({ payload:{event:'invalidate'} });
        const router = createRouter({ history:createMemoryHistory(), routes:[
          { name:'chat', path:'/projects/:projectId/chat/:sessionId?', component:{render:() => null} },
          { name:'project-settings', path:'/projects/:projectId/settings/:section?', component:{render:() => null} },
          { name:'agents', path:'/projects/:projectId/agents', component:{render:() => null} },
          { name:'settings', path:'/settings/:section?', component:{render:() => null} },
        ] });
        window.navigateTab = tab => router.push(tab === 'settings'
          ? {name:'project-settings',params:{projectId:'p',section:'general'}}
          : {name:'chat',params:{projectId:'p',sessionId:'web:orchestrator'}});
        window.navigateWork = key => router.replace({query:{work:key}});
        await router.push({name:'chat',params:{projectId:'p',sessionId:'web:orchestrator'}}); await router.isReady();
        const app = createApp({ render:() => [h(ProjectWorkbench, {
          apiBase:location.origin + '/projects/p', projectId:'p', projectName:'Release evidence', visible:state.visible, style:'height:100vh',
          onNavigate:id => { state.navigated = id; }, onCompose:text => { state.draft += '\\n\\n' + text; },
          onProjectNavigation:tab => window.navigateTab(tab),
        }, { default:({active}) => h('section', {style:'display:flex;flex:1;flex-direction:column;padding:16px;min-width:0;'}, [
          h('p','Coordinator conversation'), h('p',{style:'flex:1;font-size:14px;'},'Compare the release evidence. A grader is one possible approach, not the original goal.'),
          h('textarea',{id:'fixture-composer',value:state.draft,disabled:!active,
            style:'box-sizing:border-box;width:100%;min-height:100px;background:var(--c-bg-input);color:var(--c-text);',
            onInput:event => {state.draft = event.target.value;}}),
        ]) }), state.deleting ? h(ProjectDeleteDialog, {
          apiBase:location.origin,project:{id:'p',name:'Release evidence',createdAt:${JSON.stringify(at)}},
          onClose:() => {state.deleting=false;},onDeleted:() => {state.deleted=true;state.deleting=false;},
        }) : null] });
        app.provide(Symbol.for('shadow.project-live-state'),live);
        app.use(router); app.use(createInstallationContextProvider(installation)); app.mount('#app');`,
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          const path = new URL(request.url!, 'http://127.0.0.1').pathname
          const json = (value: unknown) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)) }
          const body = async () => { let text = ''; for await (const chunk of request) text += chunk; return JSON.parse(text) }
          if (path === '/__work') {
            response.setHeader('Content-Type', 'text/html')
            response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/work-fixture.ts"></script></body></html>')
          } else if (path === '/__exhibit_network') {
            exhibitRequests++; response.end('Unexpected network access')
          } else if (path === '/__fixture') {
            const value = await body()
            if ('empty' in value) empty = !!value.empty
            if ('unavailable' in value) unavailable = !!value.unavailable
            if (value.advance) record = { ...record, sequence: record.sequence + 1,
              notes: { ...workNotesSchema.parse(record.notes), summary: 'Usage report is ready' } }
            json({})
          } else if (path === '/api/projects/p' && request.method === 'DELETE') {
            if (++deleteAttempts === 1) { response.statusCode = 409; json({ message: 'Stop active project work before deleting.' }) }
            else json({ deletedProjectId: 'p' })
          } else if (path === '/api/projects') {
            json({ projects: [{ id: 'p', name: 'Release evidence', createdAt: at }] })
          } else if (path.endsWith('/api/config')) {
            json({ agent: { model: 'fixture', workspace: 'C:\\synthetic-home', temperature: 0.7 }, learning: {} })
          } else if (path.endsWith('/api/sessions/graph')) {
            json({ sessions: [{ sessionId: 'web:fixture', title: 'Evaluation session' }], nodes: [] })
          } else if (path.endsWith('/api/sessions/stages')) {
            json({ stages: { 'web:fixture': questionOpen ? 'waiting' : 'idle', 'web:untracked': 'waiting' } })
          } else if (path.endsWith('/ask')) {
            const pending = path.includes('web%3Afixture') || path.includes('web:fixture') ? questionOpen ? question : null : input
            if (request.method === 'POST') {
              const value = await body()
              if (!pending || value.requestId !== pending.id) { response.statusCode = 409; json({ message: 'Question changed' }); return }
              answers.push(value); questionOpen = false
              json({ answer: { requestId: value.requestId, option: value.customText ?? value.option, custom: !!value.customText, answeredBy: 'user', answeredAt: at } })
            } else json({ request: pending })
          } else if (path.includes('/decisions/') && path.endsWith('/reviews')) {
            json({ reviews: [] })
          } else if (path === '/projects/p/api/work') {
            if (unavailable) { response.statusCode = 503; json({ error: 'unavailable' }); return }
            const summary = (key: string, title: string, status = 'pending', assignee: string | null = null) => ({
              key, title, status, assignee, revision: 1, sequence: 1, parentKey: null, dependencies: [],
              manager: 'web:orchestrator', blockedReason: status === 'blocked' ? 'Waiting for the release decision' : null,
              paused: false, adopted: false, proposals: 0, interpretationReview: false, changedAt: at,
            })
            const note = (item: typeof record) => ({ ...summary(item.key, item.workflow!.title, item.workflow!.status, item.workflow!.assignee),
              parentKey: item.workflow!.parentKey ?? null, dependencies: item.workflow!.dependencies, revision: item.revision, sequence: item.sequence,
              notes: item.notes, objective: item.definition.objective, origin: item.origin })
            json({
              items: empty ? [] : [note(goal), { ...summary('work:inputs', 'Prepare evaluation inputs', 'done', 'web:reviewer'), parentKey: rootKey },
                note(record), note(grader), { ...summary('work:followup', 'Document the comparison', 'blocked'),
                  observation: { sessionId: 'web:reviewer', observedAt: at, sources: [{ id: 'observed-input', physicalId: 'review-segment' }] } }],
              observer: { enabled: true, running: true, pending: 1, errors: [] },
              sessions: [
                { sessionId: 'web:fixture', title: 'Evaluation session', assignable: true, activity: questionOpen ? 'waiting' : 'idle', workKey: record.key },
                { sessionId: 'web:reviewer', title: 'Review session', assignable: true, activity: 'idle' },
                { sessionId: 'web:orchestrator', title: 'Coordinator', assignable: true, activity: 'idle' },
                { sessionId: 'web:untracked', title: 'Untracked conversation', assignable: true, activity: 'waiting' },
                { sessionId: 'virtual:untracked-child', title: 'Inspect inputs', assignable: false, activity: 'tool', parentSessionId: 'web:untracked' },
              ],
              requests: [...(questionOpen ? [{ id: question.id, sessionId: question.sessionId, question: question.question, kind: 'decision',
                recipient: 'user', context: question.workContext, workKeys: question.workContext!.path.map(node => node.key) }] : []),
                { id: input.id, sessionId: input.sessionId, question: input.question, kind: 'input', recipient: 'user', workKeys: [] }],
              effects: [],
            })
          } else if (path.endsWith('/decisions/owner')) {
            if (request.method === 'POST') { reportingSessionId = (await body()).reportingSessionId; reportingWrites++ }
            json({ reportingSessionId, candidates: [{ sessionId: 'web:fixture', label: 'Current session' }, { sessionId: 'web:reviewer', label: 'Review session' }] })
          } else if (path.startsWith('/projects/p/api/work/')) {
            if (request.method === 'POST') {
              const value = await body()
              writes.push(value)
              if (value.key !== record.key || value.version !== record.sequence) {
                response.statusCode = 409; json({ message: 'This note changed. Read its current version before updating it.' }); return
              }
              if (value.action === 'update') {
                const patch = z.object({ definition: workDefinitionSchema.optional(), notes: workNotePatchSchema.optional() }).strict().parse(value.data)
                record = { ...record, sequence: record.sequence + 1, revision: record.revision + Number(!!patch.definition),
                  definition: patch.definition ?? record.definition, origin: patch.definition ? 'human' : record.origin,
                  notes: workNotesSchema.parse({ ...record.notes, ...patch.notes }) }
              } else if (value.action === 'review') {
                const { conclusion } = z.object({ conclusion: z.string().min(1) }).parse(value.data)
                record = { ...record, sequence: record.sequence + 1, notes: workNotesSchema.parse({ ...record.notes,
                  attention: { ...record.notes!.attention, reviewed: { by: 'human', at, conclusion } } }) }
              } else throw new Error('Unexpected fixture mutation')
            }
            json(detail())
          } else next()
        })
      },
    }], server: { host: '127.0.0.1', port: 0 },
  })
  t.after(() => server.close())
  await optimizeDeps(server.config)
  await server.listen()
  const url = server.resolvedUrls?.local[0]; assert.ok(url)
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
  const timer = setTimeout(() => child.kill(), 100000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, `${output}\n${JSON.stringify(writes)}`)
  assert.match(output, /WORK_SMOKE_OK/)
  assert.deepEqual(writes.map(write => write.action), ['update', 'update', 'review'])
  assert.deepEqual(writes.map(write => write.version), [2, 3, 4])
  assert.equal(record.definition.objective, 'Corrected final outcome')
  assert.equal(record.notes?.attention?.reviewed?.conclusion, 'Token metrics can continue without a grader')
  assert.deepEqual(answers, [{ requestId: question.id, customText: 'Compare token usage; a grader is not required.' }])
  assert.equal(exhibitRequests, 0, 'An exhibit cannot fetch scripts, images, CSS, frames or form destinations')
  assert.equal(reportingWrites, 1)
  assert.equal(reportingSessionId, 'web:reviewer')
})
