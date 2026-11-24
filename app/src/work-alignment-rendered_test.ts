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
import { z } from 'zod'
import { workRecordSchema } from '../../src/initiatives/work-contract.ts'
import { projectWorkLiveOverviewSchema } from '../../src/projects/work-overview.ts'
import { parseYieldRequest } from '../../src/sessions/yield-contract.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

test('rendered Project canvas anchors native questions, retains drafts, renders Markdown and preserves the workbench', {
  timeout: 120000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `work-ui-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const writes: { action: string; version: number; data: unknown }[] = [], answers: unknown[] = []
  let reportingSessionId = 'web:fixture', reportingWrites = 0
  let empty = false, unavailable = false, deleteAttempts = 0, questionOpen = true
  let organizationAttempts = 0
  let organized = false
  const requestsSeen: string[] = []
  const at = '2026-10-05T00:00:00Z'
  const rootKey = 'work:11111111-1111-4111-8111-111111111111'
  const graderKey = 'work:22222222-2222-4222-8222-222222222222'
  const goal = workRecordSchema.parse({
    key: rootKey, revision: 2, sequence: 2,
    definition: 'Understand release impact from available evidence\n\n- A concise comparison\n- No publication',
    origin: 'human', changedBy: 'human', changedAt: at,
    title: 'Release evidence', manager: 'web:chat-admin', assignee: 'web:chat-admin', assignmentRevision: 1, status: 'in_progress', dependencies: [],
    kind: 'goal', summary: 'Token measurements are ready. The scoring approach needs a decision.',
  })
  let record = workRecordSchema.parse({
    key: 'work:1d7572b8-f94a-50e1-bb3d-a1679fb67b80', revision: 1, sequence: 1,
    definition: 'Compare release candidates using the available measurements\n\n- Report both candidates\n- No publication',
    origin: 'agent_interpretation', changedBy: 'web:fixture', changedAt: at,
    title: 'Evaluate release candidates', parentKey: rootKey, manager: 'web:chat-admin', assignee: 'web:fixture', assignmentRevision: 1, status: 'in_progress', dependencies: ['work:c8545301-0122-5347-9beb-053d8e158a93'],
    kind: 'approach', basis: [{ key: rootKey, revision: 1 }], summary: 'Input fixtures are available', artifacts: [{ label: 'Usage report', href: '/report.json' }],
  })
  const grader = workRecordSchema.parse({
    ...record, key: graderKey,
    definition: 'Prepare scoring only if the report requires it. Scored evaluation was assumed to be necessary.',
    title: 'Prepare a grader', parentKey: record.key, assignee: null, status: 'pending', dependencies: [],
    kind: 'task', basis: [{ key: rootKey, revision: 1 }, { key: record.key, revision: 1 }],
  })
  const question = parseYieldRequest({
    id: 'fixture-decision', sessionId: 'web:fixture', createdAt: at, deadline: null,
    question: 'Should the release report wait for scored evaluation?',
    options: ['Wait for a grader', 'Report token metrics only'], defaultOption: 'Report token metrics only',
    recipient: { kind: 'user', sessionId: 'web:fixture' }, origin: { physicalId: 'fixture-segment', toolCallId: 'ask-fixture' },
    workContext: { originKey: graderKey, decisionKey: rootKey, path: [goal, record, grader].map(item => ({
      key: item.key, revision: item.revision, assignmentRevision: item.assignmentRevision,
      title: item.title, definition: item.definition, kind: item.kind, origin: item.origin,
      ...(item.key === graderKey ? { contextNeedsReview: true } : {}),
    })) },
  }, 'web:fixture')
  const input = { kind: 'input', id: 'fixture-input', sessionId: 'web:untracked', question: 'Which report should be attached?',
    recipient: { kind: 'user', sessionId: 'web:untracked' }, origin: { physicalId: 'untracked-segment' }, createdAt: at, deadline: null }
  const contextChanged = (item: typeof record) => item.basis.some(ref => ref.key === rootKey && ref.revision !== goal.revision)
  const detail = () => ({ records: [{ ...record, contextChanged: contextChanged(record),
    authority: { manager: record.manager, executor: record.assignee, active: true }, history: [] }], effects: [] })
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    optimizeDeps: { noDiscovery: true, include: ['vue', 'vue-router', 'vue-i18n', 'pinia', 'dompurify', 'zod'] },
    plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app', 'unocss.config.ts') }), {
      name: 'work-alignment-fixture',
      resolveId: id => id === '/work-fixture.ts' ? '\0work-fixture' : undefined,
      load: id => id !== '\0work-fixture' ? undefined : `
        import '/src/styles.css'; import 'uno.css';
        import {createResourceApp as createApp} from '/src/stores/app.ts'; import {useProjectResourceStore} from '/src/stores/project.ts'; import {h, reactive } from 'vue';
        import { createRouter, createMemoryHistory } from 'vue-router';
        import ProjectWorkbench from '/src/components/ProjectWorkbench.vue';
        import ProjectContextCanvas from '/src/components/ProjectContextCanvas.vue';
        import WorkAlignment from '/src/components/WorkAlignment.vue';
        import ProjectDeleteDialog from '/src/components/ProjectDeleteDialog.vue';
        import { createProjectLiveState } from '/src/project-live-state.ts';
        import { createInstallationContextProvider } from '/src/composables/useInstallationContext.ts';
        import { createLocalMainAdminContext } from '/src/installation-context.ts';
        Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true });
        const state = reactive({ visible:true, canWrite:true, mode:'canvas', data:null, error:'', revision:0,
          draft:'Keep my unsent draft', navigated:'', deleting:false, deleted:false });
        async function loadOverview() {
          try {
            window.fixtureStage = 'requesting ' + new URL('/projects/p/api/work', location.href).href;
            const response = await fetch('/projects/p/api/work');
            window.fixtureStage = 'Work overview HTTP ' + response.status;
            if (!response.ok) throw new Error('Could not refresh work');
            state.data = await response.json(); state.error = ''; state.revision++;
          } catch(error) { state.error = error.message; }
        }
        window.fixture = state;
        window.organizationCalls = 0;
        const originalFetch = window.fetch;
        window.fetch = (...args) => { if (String(args[0]).endsWith('/api/work/organize')) window.organizationCalls++; return originalFetch(...args); };
        window.fixtureKeys = ${JSON.stringify({ root: rootKey, note: record.key, grader: graderKey })};
        window.showProjectDelete = () => { state.deleting = true; };
        const installation = reactive(createLocalMainAdminContext(location.origin));
        window.setAdmin = value => { state.canWrite = value; installation.uiScopes = value ? createLocalMainAdminContext(location.origin).uiScopes : ['chat:read']; };
        const observers = new Set();
        const pool = { observeHost: (_base, observe) => { observe({ phase: 'live' }); return () => {}; }, client: () => ({ subscribe: (_topic, value) => {
          observers.add(value); return { ready:async () => {}, close:() => observers.delete(value) };
        } }) };
        const live = createProjectLiveState(pool);
        window.invalidateWork = async () => { await loadOverview(); for (const observer of observers) observer.event({ payload:{event:'invalidate'} }); };
        const router = createRouter({ history:createMemoryHistory(), routes:[
          { name:'chat', path:'/projects/:projectId/chat/:sessionId?', component:{render:() => null} },
          { name:'project-board', path:'/projects/:projectId/board', component:{render:() => null} },
          { name:'project-settings', path:'/projects/:projectId/settings/:section?', component:{render:() => null} },
          { name:'agents', path:'/projects/:projectId/agents', component:{render:() => null} },
          { name:'settings', path:'/settings/:section?', component:{render:() => null} },
        ] });
        window.navigateTab = tab => router.push(tab === 'settings'
          ? {name:'project-settings',params:{projectId:'p',section:'general'}}
          : {name:'chat',params:{projectId:'p',sessionId:'web:chat-admin'}});
        window.navigateWork = key => router.replace({name:'project-board',params:{projectId:'p'},query:{work:key}});
        await router.push({name:'chat',params:{projectId:'p',sessionId:'web:chat-admin'}}); await router.isReady();
        router.afterEach(to => { window.fixtureRoute = to.fullPath; });
        window.fixtureRoute = router.currentRoute.value.fullPath;
        const app = createApp({ render:() => [
          state.error ? h('p', {class:'fixture-refresh-error',role:'alert'},state.error) : null,
          h('div', {style:state.mode === 'canvas' ? '' : 'display:none'}, [state.data ? h(ProjectContextCanvas, {
            data:state.data, matches:state.data.items, apiBase:location.origin + '/projects/p', selected:'',
            canWrite:state.canWrite, active:state.visible && state.mode === 'canvas',
            onSelect:async key => { await window.navigateWork(key); state.mode='workbench'; }, onUpdated:loadOverview,
            onDiscuss:key=>{state.draft+='\\nDiscuss the premise of '+key;},
          }) : null]),
          state.mode === 'workbench' ? h(ProjectWorkbench, {
            apiBase:location.origin + '/projects/p', projectId:'p', visible:state.visible, style:'height:800px',
            onNavigate:id => { state.navigated = id; },
            onCompose:text => { state.draft += '\\n\\n' + text; },
          }) : null,
          !state.canWrite ? h(WorkAlignment, {apiBase:location.origin+'/projects/p',sessionId:'web:fixture',project:true,workKey:window.fixtureKeys.note,embedded:true,expanded:true,
            canWrite:false,revision:state.revision}) : null,
          h('textarea',{id:'fixture-composer',value:state.draft,style:'width:100%;min-height:100px',onInput:event=>{state.draft=event.target.value;}}),
          state.deleting ? h(ProjectDeleteDialog, {
          apiBase:location.origin,project:{id:'p',name:'Release evidence',createdAt:${JSON.stringify(at)}},
          onClose:() => {state.deleting=false;},onDeleted:() => {state.deleted=true;state.deleting=false;},
        }) : null] });
        useProjectResourceStore(app.config.globalProperties.$pinia).owner=live;
        app.onUnmount(()=>live.dispose());
        app.provide(Symbol.for('shadow.live-client-pool'), pool);
        app.use(router); app.use(createInstallationContextProvider(installation)); app.mount('#app');
        void loadOverview();`,
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          void (async () => {
          const path = new URL(request.url!, 'http://127.0.0.1').pathname
          if (path.includes('/api/')) requestsSeen.push(path)
          const json = (value: unknown) => { response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify(value)) }
          const body = async () => { let text = ''; for await (const chunk of request) text += chunk; return JSON.parse(text) }
          if (path === '/__work') {
            response.setHeader('Content-Type', 'text/html')
            response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/work-fixture.ts"></script></body></html>')
          } else if (path === '/__fixture') {
            const value = await body()
            if ('empty' in value) empty = !!value.empty
            if ('unavailable' in value) unavailable = !!value.unavailable
            if (value.advance) record = { ...record, sequence: record.sequence + 1,
              summary: 'Usage report is ready' }
            json({})
          } else if (path === '/api/projects/p' && request.method === 'DELETE') {
            if (++deleteAttempts === 1) { response.statusCode = 409; json({ message: 'Stop active project work before deleting.' }) }
            else json({ deletedProjectId: 'p' })
          } else if (path === '/api/projects') {
            json({ projects: [{ id: 'p', name: 'Release evidence', createdAt: at }] })
          } else if (path.endsWith('/api/config')) {
            json({ agent: { model: 'fixture', workspace: 'C:\\synthetic-home', temperature: 0.7 }, learning: {} })
          } else if (path.endsWith('/api/sessions/summary')) {
            json({ sessions: [{ sessionId: 'web:fixture', title: 'Evaluation session' }], nodes: [] })
          } else if (path.endsWith('/api/sessions/stages')) {
            json({ activity: { 'web:fixture': { stage: questionOpen ? 'waiting' : 'idle' }, 'web:untracked': { stage: 'waiting' } } })
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
          } else if (path === '/projects/p/api/folders') {
            // Real local FolderRecord wire shape has no kind discriminator.
            json({ folders: [{ id: 'fixture-folder', name: 'Fixture source', path: '/fixture', createdAt: at }] })
          } else if (path === '/projects/p/api/actions') {
            json({ actions: [{ id: 'fixture-action', name: 'Build fixture', command: 'echo fixture', folderId: 'fixture-folder', pinned: true }] })
          } else if (path === '/projects/p/api/actions/runs') {
            json({ runs: [] })
          } else if (path === '/projects/p/api/work-history') {
            json({ records: [
              { request: { ...question, id: 'history-human' }, answer: { requestId: 'history-human', option: question.options[1], answeredBy: 'user', answeredAt: at } },
              { request: { ...question, id: 'history-parent', recipient: { kind: 'parent', sessionId: 'parent' } }, answer: { requestId: 'history-parent', option: question.options[0], answeredBy: 'parent', answeredAt: at } },
              { request: { ...question, id: 'history-timeout' }, answer: { requestId: 'history-timeout', option: question.defaultOption, answeredBy: 'timeout', answeredAt: at } },
              { request: { ...question, id: 'history-pending' } },
            ], errors: [], truncated: false })
          } else if (path === '/projects/p/api/work/completions') {
            json({ items: [] })
          } else if (path === '/projects/p/api/work/organize') {
            await body(); organizationAttempts++
            if (organizationAttempts === 1) { response.statusCode = 502; json({ error: 'model_json_invalid', message: 'private provider text must not be displayed' }) }
            else { organized = true; json({}) }
          } else if (path === '/projects/p/api/work') {
            if (unavailable) { response.statusCode = 503; json({ error: 'unavailable' }); return }
            const summary = (key: string, title: string, status = 'pending', assignee: string | null = null) => ({
              key, title, status, assignee, revision: 1, sequence: 1, parentKey: null, dependencies: [],
              manager: 'web:chat-admin', blockedReason: status === 'blocked' ? 'Waiting for the release decision' : null,
              changedAt: at, kind: 'task', summary: '', artifacts: [], basis: [],
            })
            const note = (item: typeof record) => ({ ...summary(item.key, item.title, item.status, item.assignee),
              parentKey: item.parentKey ?? null, dependencies: item.dependencies, revision: item.revision, sequence: item.sequence,
              kind: item.kind, summary: item.summary, artifacts: item.artifacts, basis: item.basis, contextChanged: contextChanged(item), contextAssessment: item.contextAssessment, definition: item.definition, origin: item.origin })
            json(projectWorkLiveOverviewSchema.parse({
              focus: organized ? { inferredAt: at, origin: 'model_interpretation', inputCount: 1, omittedCount: 0,
                sources: [{ key: rootKey, sequence: goal.sequence }], result: { groups: [{ category: 'Understand release effects',
                  purpose: 'Use the available evidence to explain release effects', motivation: 'The user may want confidence before release', topicKeys: [rootKey] }] } } : undefined,
              items: empty ? [] : [note(goal), { ...summary('work:c8545301-0122-5347-9beb-053d8e158a93', 'Prepare evaluation inputs', 'done', 'web:reviewer'), parentKey: rootKey },
                note(record), note(grader), { ...summary('work:a1deaa76-f989-5fd4-9215-f4f71aa4ba7a', 'Document the comparison', 'blocked'), dependencies: [rootKey],
                  observation: { sessionId: 'web:reviewer', observedAt: at, sources: [{ id: 'observed-input', physicalId: 'review-segment' }] } }],
              observer: { enabled: true, running: false, pending: 1, errors: [] },
              sessions: [
                { sessionId: 'web:fixture', title: 'Evaluation session', assignable: true, activity: questionOpen ? 'waiting' : 'idle', workKey: record.key },
                { sessionId: 'web:reviewer', title: 'Review session', assignable: true, activity: 'idle' },
                { sessionId: 'web:chat-admin', title: 'Admin', assignable: true, activity: 'idle' },
                { sessionId: 'web:untracked', title: 'Untracked conversation', assignable: true, activity: 'waiting' },
                { sessionId: 'virtual:untracked-child', title: 'Inspect inputs', assignable: false, activity: 'tool', parentSessionId: 'web:untracked' },
              ],
              requests: [...(questionOpen ? [{ id: question.id, sessionId: question.sessionId, question: question.question, kind: 'decision',
                recipient: 'user', context: question.workContext, workKeys: question.workContext!.path.map(node => node.key) }] : []),
                { id: input.id, sessionId: input.sessionId, question: input.question, kind: 'input', recipient: 'user', workKeys: [] }],
              effects: [],
            }))
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
              if (value.action === 'review') {
                const { conclusion } = z.object({ conclusion: z.string().min(1) }).parse(value.data)
                assert(contextChanged(record), 'Fixture reviews only stale ancestry')
                record = { ...record, sequence: record.sequence + 1, basis: [{ key: rootKey, revision: goal.revision }], contextAssessment: conclusion }
              } else throw new Error('Unexpected fixture mutation')
            }
            json(detail())
          } else next()
          })().catch(next)
        })
      },
    }], server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  })
  t.after(() => server.close())
  await server.listen()
  const url = server.resolvedUrls?.local[0]; assert.ok(url)
  const overview = await fetch(new URL('/projects/p/api/work', url), { signal: AbortSignal.timeout(5000) })
  assert.equal(overview.status, 200, await overview.clone().text())
  assert.equal(projectWorkLiveOverviewSchema.parse(await overview.json()).requests[0]?.context?.decisionKey, rootKey)
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
  assert.equal(code, 0, `${output}\nRequests: ${JSON.stringify(requestsSeen)}\nWrites: ${JSON.stringify(writes)}`)
  assert.match(output, /WORK_SMOKE_OK/)
  assert.deepEqual(writes.map(write => write.action), ['review', 'review'], 'Only assessment writes are allowed; note modifications go through Chat tools')
  assert.deepEqual(writes.map(write => write.version), [2, 3], 'Stale assessment fails before an explicit current-version retry')
  assert.equal(record.definition, 'Compare release candidates using the available measurements\n\n- Report both candidates\n- No publication')
  assert.equal(record.origin, 'agent_interpretation', 'Discuss does not silently rewrite the goal or its provenance')
  assert.equal(record.contextAssessment, 'Token metrics can continue without a grader')
  assert.deepEqual(answers, [{ requestId: question.id, customText: 'Compare token usage; a grader is not required.' }])
  assert.equal(reportingWrites, 0, 'Work details never edits reporting responsibility')
  assert.equal(reportingSessionId, 'web:fixture')
})
