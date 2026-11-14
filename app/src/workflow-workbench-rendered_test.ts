import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

test('Workflow uses real workbench tabs with drafts, conversation context, project isolation and run deep links', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `workflow-workbench-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const requests: { path: string; method: string }[] = []
  const projects = ['a', 'b'].map(id => ({ id, name: `Project ${id.toUpperCase()}`, createdAt: '2026-01-01' }))
  const server = await createServer({ configFile: false, envDir: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'cache'), optimizeDeps: { noDiscovery: true, include: ['vue', 'vue-router', '@vue-flow/core'] }, plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app/unocss.config.ts') }), {
    name: 'workflow-workbench-fixture',
    resolveId: id => id === '/fixture.ts' ? '\0workflow-workbench-fixture' : undefined,
    load(id) {
      if (id !== '\0workflow-workbench-fixture') return
      return `import {createApp,h} from 'vue'; import {createRouter,createMemoryHistory} from 'vue-router'; import Workspace from '/src/components/ProjectsWorkspace.vue'; import {setLocalePreference} from '/src/i18n.ts'; import '/src/styles.css'; import 'virtual:uno.css'; setLocalePreference('en');
        const router=createRouter({history:createMemoryHistory(),routes:[{path:'/projects/:projectId/dashboard',name:'project-dashboard',component:{render:()=>null}},{path:'/projects/:projectId/chat/:sessionId?',name:'chat',component:{render:()=>null}},{path:'/projects/:projectId/workflows',name:'project-workflows',component:{render:()=>null}},{path:'/projects/:projectId/settings/:section?',name:'project-settings',component:{render:()=>null}},{path:'/projects/:projectId/agents',name:'agents',component:{render:()=>null}},{path:'/settings/:section?',name:'settings',component:{render:()=>null}}]});
        window.fixture={router};
        const app=createApp({render:()=>h(Workspace,{apiBase:location.origin,visible:true})});app.use(router);router.push(new URLSearchParams(location.search).get('fixtureRoute') || {name:'project-workflows',params:{projectId:'a'},query:{workflow:'schedule:a',run:'run:a'}});router.isReady().then(()=>app.mount('#app'));`
    },
    configureServer(server) { server.middlewares.use((req, res, next) => {
      const path = new URL(req.url!, 'http://127.0.0.1').pathname
      const json = (body: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)) }
      if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><body><div id="app"></div><script type="module" src="/fixture.ts"></script></body></html>'); return }
      if (!/^\/(?:projects\/[^/]+\/)?(?:api|debug)\//.test(path)) { next(); return }
      requests.push({ path, method: req.method! })
      const projectId = path.split('/')[2]
      if (path === '/api/projects') { json({ projects }); return }
      if (path.endsWith('/api/workflows')) {
        const definition = { id: `schedule:${projectId}`, name: `Workflow ${projectId}`, revision: 1, enabled: true, source: { kind: 'schedule', id: projectId }, nodes: [{ kind: 'schedule-action', action: 'session', job: { schedule: 'every 1h', session: 'fresh', task: `Reminder ${projectId}` } }] }
        json({ projectId, bots: { connections: [{ id: 'isolated-one', displayName: 'First isolated', platform: 'qq', purpose: 'service', enabled: false, health: 'disabled' }, { id: 'isolated-two', displayName: 'Second isolated', platform: 'qq', purpose: 'service', enabled: false, health: 'disabled' }, { id: 'qq-shared', displayName: 'Shared QQ', platform: 'qq', purpose: 'service', enabled: true, health: 'disconnected' }], deployments: [{ id: 'isolated-two', state: 'valid', mode: 'service' }, { id: 'sales', state: 'valid', mode: 'service', agent: 'BOT:sales' }, { id: 'support', state: 'valid', mode: 'service', agent: 'BOT:support' }], bindings: [{ id: 'one', deploymentId: 'sales', connectionId: 'qq-shared', platform: 'qq', topic: 'group:one', enabled: true, subscribed: true, listener: true, kind: 'message', sessionIds: [] }, { id: 'two', deploymentId: 'support', connectionId: 'qq-shared', platform: 'qq', topic: 'group:two', enabled: false, subscribed: true, listener: false, kind: 'message', sessionIds: ['web:ordinary'] }], warnings: [], routing: 'not-probed', processingSuccess: 'unknown' }, definitions: [definition], runs: [{ id: `run:${projectId}`, workflow: definition.id, definition, timestamp: '2026-11-12T10:00:00Z', status: 'completed', cursor: 1, attempts: 1, nextAt: 0, started: true, output: { sessionId: 'web:ordinary' } }] }); return
      }
      if (path.endsWith('/api/channels')) { json({ channels: (projectId === 'a' ? ['isolated-one', 'isolated-two'] : ['other']).map(id => ({ id, projectId, displayName: id, platform: 'qq', label: 'QQ', purpose: 'service', enabled: false, configured: true, state: 'disabled', config: { appId: 'fixture' }, secrets: { secret: true } })) }); return }
      if (path.endsWith('/api/automations')) { json({ automations: [{ id: 'system:session-cleanup', name: 'Session cleanup', source: 'system', session: 'fresh', enabled: true, schedule: 'every 1h', workflow: { id: `schedule:${projectId}`, pending: 0, blocked: 0 } }] }); return }
      if (path.endsWith('/runs')) { json({ runs: [{ id: 'cleanup-run', sessionId: 'web:ordinary', startedAt: '2026-11-12T10:00:00Z', status: 'completed' }], total: 1, offset: 0 }); return }
      if (/\/status$/.test(path)) { json({ state: 'ready' }); return }
      if (path.endsWith('/api/work')) { json({ items: [], sessions: [], requests: [], effects: [] }); return }
      if (path.endsWith('/api/config')) { json({ agent: { model: 'fixture', workspace: '/synthetic/home', temperature: 0.5 } }); return }
      if (path.endsWith('/api/models')) { json({ models: ['fixture'], providers: [] }); return }
      if (path.endsWith('/api/service-groups')) { json({ revision: 'r1', agents: [], groups: [] }); return }
      if (path.endsWith('/api/knowledge')) { json({ entries: [], links: [] }); return }
      if (path.endsWith('/api/folders')) { json({ folders: [] }); return }
      if (/\/api\/sessions\/web%3Aordinary$/.test(path)) { json({ messages: [{ role: 'user', content: 'Ordinary conversation retained' }] }); return }
      json({ projects, sessions: [], nodes: [], activity: {}, jobs: [], requests: [], messages: [], tools: [], providers: [] })
    }) },
  }], server: { host: '127.0.0.1', port: 0 } })
  await server.listen(); t.after(() => server.close())
  const url = server.resolvedUrls?.local[0]; assert(url)
  const script = `const assert=require('node:assert/strict');const {app,BrowserWindow}=require('electron');const {setTimeout:delay}=require('node:timers/promises');app.setPath('userData',require('node:path').join(process.cwd(),'profile'));app.on('window-all-closed',()=>{});
    (async()=>{await app.whenReady();const win=new BrowserWindow({show:false,width:1280,height:850,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});win.webContents.on('console-message',d=>console.error('Renderer:',d.message));const run=async s=>{try{return await win.webContents.executeJavaScript(s)}catch(e){throw new Error(s+' '+e)}};const wait=async s=>{for(let i=0;i<240;i++){if(await run('Boolean('+s+')'))return;await delay(50)}throw new Error('Timeout '+s+' '+await run('document.body.innerText'))};
    const visible=s=>'[...document.querySelectorAll('+JSON.stringify(s)+')].find(e=>e.getBoundingClientRect().width&&e.getBoundingClientRect().height)';
    const route=()=>run('JSON.parse(JSON.stringify(window.fixture.router.currentRoute.value))');
    const primary=async()=>{const s=visible('.conversation-tab button');await wait(s);await run(s+'.click()')};
    const tab=label=>'[...document.querySelectorAll(".document-tab button[role=tab]")].find(e=>e.textContent.trim()==='+JSON.stringify(label)+' && e.getBoundingClientRect().width)';
    const clickTab=async label=>{await wait(tab(label));await run(tab(label)+'.click()')};
    const open=async(project,query={})=>{await run('window.fixture.router.push('+JSON.stringify({name:'project-workflows',params:{projectId:project},query})+')');await wait(visible('.workflow-manager'));await wait(visible('.graph-group'))};
    const sidebar=async project=>{const s='document.querySelector('+JSON.stringify('[data-project-id="'+project+'"] .automation-entry')+')';await wait(s);await run(s+'.click()');await wait('window.fixture.router.currentRoute.value.name==="project-workflows" && window.fixture.router.currentRoute.value.params.projectId==='+JSON.stringify(project));await wait(visible('.workflow-manager'));await wait(visible('.graph-group'))};
    await win.loadURL(${JSON.stringify(url)});
    // Cold deep link: no session exists, yet the genuine document strip and graph work.
    await wait(visible('.workflow-inspector'));await wait(visible('.graph-group'));
    assert.equal(await run('('+visible('.vue-flow')+').getBoundingClientRect().height>350'),true,'Graph occupies the real workbench pane');
    if(process.env.WORKFLOW_WORKBENCH_SCREENSHOT) require('node:fs').writeFileSync(process.env.WORKFLOW_WORKBENCH_SCREENSHOT,(await win.webContents.capturePage()).toPNG());
    assert.equal((await route()).query.run,'run:a');assert.equal((await route()).params.sessionId,undefined);
    assert.equal(await run('!!'+tab('Workflows')),true);assert.equal(await run('!!'+visible('.conversation-tab')),true);
    assert.equal(await run('document.querySelector(".workflow-manager").closest(".file-workbench")!==null'),true);
    assert.equal(await run('!!'+visible('.reference-composer')),false);
    await primary();await wait('window.fixture.router.currentRoute.value.name==="chat"');
    await wait(visible('.reference-composer'));
    await run('('+visible('.reference-composer')+').textContent="Unsent draft stays here";('+visible('.reference-composer')+').dispatchEvent(new Event("input",{bubbles:true}))');
    await clickTab('Workflows');await wait(visible('.workflow-inspector'));
    assert.equal((await route()).query.workflow,'schedule:a');assert.equal((await route()).query.run,'run:a');
    await sidebar('a');assert.equal((await route()).query.run,'run:a');
    assert.equal(await run('[...document.querySelectorAll(".document-tab button[role=tab]")].filter(e=>e.textContent.trim()==="Workflows"&&e.getBoundingClientRect().width).length'),1);
    await primary();await wait(visible('.reference-composer'));assert.equal(await run('('+visible('.reference-composer')+').textContent'),'Unsent draft stays here');
    // Knowledge and Workflow are peers in the same real strip, not independent views.
    await run('document.querySelector('+JSON.stringify('[aria-label="Project A knowledge"]')+').click()');await wait(visible('.knowledge-document'));
    await clickTab('Workflows');await wait(visible('.workflow-manager'));
    assert.equal(await run('('+tab('Workflows')+').closest(".document-tablist")===('+tab('Knowledge')+').closest(".document-tablist")'),true);
    await clickTab('Knowledge');await wait('window.fixture.router.currentRoute.value.query.panel==="knowledge"');
    await sidebar('a');await wait(visible('.workflow-inspector'));assert.equal((await route()).query.run,'run:a');
    // Project B has a different graph/inspection and cannot change A's draft or run.
    await open('b',{workflow:'schedule:b',run:'run:b'});await wait(visible('.workflow-inspector'));
    assert.equal(await run('('+visible('.workflow-inspector')+').textContent.includes("Workflow b")'),true);
    await sidebar('a');await wait(visible('.workflow-inspector'));assert.equal((await route()).query.workflow,'schedule:a');assert.equal((await route()).query.run,'run:a');
    await primary();await wait(visible('.reference-composer'));assert.equal(await run('('+visible('.reference-composer')+').textContent'),'Unsent draft stays here');
    // Existing ordinary session remains the Conversation tab and history is not replaced.
    await run('window.fixture.router.push({name:"chat",params:{projectId:"a",sessionId:"web:ordinary"}})');
    await wait('document.body.innerText.includes("Ordinary conversation retained")');
    await sidebar('a');await wait(visible('.workflow-manager'));await primary();
    await wait('window.fixture.router.currentRoute.value.name==="chat"');assert.equal((await route()).params.sessionId,'web:ordinary');
    // A Project returns to its last active workbench, not its most recently created resource.
    await run('window.fixture.router.push({name:"chat",params:{projectId:"a",sessionId:"web:second"}})');
    await run('window.fixture.router.push({name:"chat",params:{projectId:"a",sessionId:"web:ordinary"}})');
    await sidebar('b');await sidebar('a');await primary();
    await wait('window.fixture.router.currentRoute.value.name==="chat"');assert.equal((await route()).params.sessionId,'web:ordinary');
    await sidebar('a');await clickTab('Diagnosis');await wait(visible('.diagnosis-document'));
    assert.equal((await route()).name,'chat');assert.equal((await route()).query.panel,'diagnosis');
    await sidebar('a');await wait(visible('.graph-group'));
    await run('window.fixture.workflowElement=('+visible('.workflow-manager')+')');
    // Reproduce Workflow -> Session cleanup Automation -> open latest conversation (not a direct chat URL).
    await wait('('+visible('.group-conversation')+').getAttribute("aria-disabled")==="false"');await run('('+visible('.group-conversation')+').click()');
    await wait('window.fixture.router.currentRoute.value.params.sessionId==="web:ordinary" && window.fixture.router.currentRoute.value.query.automation==="system:session-cleanup"');
    assert.equal(await run('!!document.querySelector(".workflow-projection-link")'),false,'Automation conversation has no redundant workflow banner');
    assert.equal(await run('document.body.innerText.includes("This conversation is a model execution, not the workflow run.")'),false);
    assert.equal(await run('document.body.innerText.includes("View workflow execution")'),false);
    assert.equal(await run('!!'+tab('Workflows')),true,'Automation navigation retains the actual open document');
    await clickTab('Workflows');await wait(visible('.workflow-inspector'));
    assert.equal((await route()).query.run,'run:a');
    assert.equal(await run('window.fixture.workflowElement===('+visible('.workflow-manager')+')'),true,'Document instance survives latest-run navigation');
    await primary();await wait('window.fixture.router.currentRoute.value.name==="chat"');
    assert.equal(await run('!!'+tab('Workflows')),true);
    await sidebar('a');await run('('+visible('.document-tab.selected .document-close')+').click()');
    await wait('window.fixture.router.currentRoute.value.name==="chat"');assert.equal((await route()).params.sessionId,'web:ordinary');
    assert.equal(await run('!!'+tab('Workflows')),false);
    await run('window.fixture.router.push({name:"chat",params:{projectId:"a",sessionId:"web:second"}})');
    await wait('window.fixture.router.currentRoute.value.params.sessionId==="web:second"');await delay(100);assert.equal(await run('!!'+tab('Workflows')),false,'Switching sessions must not reopen an explicitly closed project document');
    await run('window.fixture.router.push({name:"chat",params:{projectId:"a",sessionId:"web:ordinary"}})');
    await sidebar('a');assert.equal(await run('!!'+tab('Workflows')),true);
    // Project document shortcuts belong to the primary shell even if a child pane had focus.
    await run('window.fixture.router.push({name:"chat",params:{projectId:"a",sessionId:"web:ordinary"},query:{child:"web:child"}})');
    await wait(visible('.child-conversation'));await run('('+visible('.child-conversation')+').dispatchEvent(new FocusEvent("focusin",{bubbles:true}))');
    await sidebar('a');await run('document.dispatchEvent(new KeyboardEvent("keydown",{key:"w",ctrlKey:true,bubbles:true}))');
    await wait('window.fixture.router.currentRoute.value.name==="chat"');assert.equal((await route()).query.child,'web:child');
    await sidebar('a');
    assert.deepEqual(await run('Array.from(('+visible('.workflow-manager')+').querySelectorAll(".graph-column-heading")).map(el=>el.textContent)'),['Cron','Automation','BOT']);
    assert.equal(await run('Array.from(document.querySelectorAll(".graph-group[data-workflow^=bot-]")).every(el=>el.dataset.column==="bot")'),true);
    // BOTs are inspection-only rows in the same canvas/tab, with binding-specific
    // Agent identity and only real existing Session links. No control POST exists.
    await wait('document.querySelector('+JSON.stringify('[data-workflow="bot-binding:two"]')+')');
    await run('('+visible('[data-workflow="bot-binding:two"] .group-heading')+').click()');
    await wait('window.fixture.router.currentRoute.value.query.bot==="bot-binding:two"');
    await wait(visible('.workflow-inspector'));
    assert.equal(await run('('+visible('.workflow-inspector')+').textContent.includes("BOT:support")'),true);
    assert.equal(await run('!!document.querySelector('+JSON.stringify('[data-workflow="bot-binding:two"] .group-toggle')+')'),false);
    await primary();await sidebar('a');await wait(visible('.workflow-inspector'));
    assert.equal((await route()).query.bot,'bot-binding:two');
    await run('('+visible('.inspector-toolbar button')+').click()');
    await wait('!window.fixture.router.currentRoute.value.query.bot');
    await run('window.fixture.workflowElement=('+visible('.workflow-manager')+')');
    // Ellipsis is direct, precise, Project-scoped navigation into the existing settings form.
    assert.equal(await run('!!document.querySelector('+JSON.stringify('[data-workflow="bot-deployment:isolated-two"] .group-connection')+')'),false);
    for (const id of ['isolated-one','isolated-two']) {
      await sidebar('a');
      assert.equal(await run('window.fixture.workflowElement===('+visible('.workflow-manager')+')'),true,'Settings navigation retains the Workflow instance');
      const selector='[data-workflow="bot-connection:'+id+'"] .group-connection';
      await wait('document.querySelector('+JSON.stringify(selector)+')');
      assert.equal(await run('document.querySelector('+JSON.stringify(selector)+').getAttribute("aria-label")'),'Configure BOT connection');
      await run('('+visible(selector)+').click()');
      await wait('window.fixture.router.currentRoute.value.name==="project-settings"');
      assert.equal((await route()).params.section,'connections');assert.equal((await route()).params.projectId,'a');assert.equal((await route()).query.connectionId,id);
      await wait('document.querySelector(".connection-id")?.textContent==='+JSON.stringify(id));
    }
    // A cold URL load and real renderer reload recover the precise connection.
    await win.loadURL(${JSON.stringify(url)}+'?fixtureRoute='+encodeURIComponent('/projects/a/settings/connections?connectionId=isolated-two'));
    await wait('document.querySelector(".connection-id")?.textContent==="isolated-two"');
    win.reload();await delay(200);
    await wait('document.querySelector(".connection-id")?.textContent==="isolated-two"');
    await run('window.fixture.router.push({name:"project-settings",params:{projectId:"a",section:"connections"},query:{connectionId:"missing"}})');
    await wait('document.body.innerText.includes("The requested connection is unavailable")');
    assert.equal(await run('!!document.querySelector(".selected-connection")'),false);
    await run('window.fixture.router.push({name:"project-settings",params:{projectId:"b",section:"connections"},query:{connectionId:"isolated-two"}})');
    await wait('document.body.innerText.includes("The requested connection is unavailable")');
    assert.equal(await run('!!document.querySelector(".selected-connection")'),false);
    await sidebar('a');
    // Narrow panes retain the tab shell and bounded graph rather than replacing the UI.
    win.setSize(650,844);await delay(200);await wait(visible('.workflow-manager'));assert.equal(await run('document.documentElement.scrollWidth<=window.innerWidth'),true);
    await win.close();console.log('WORKFLOW_WORKBENCH_OK');app.quit();})().catch(error=>{console.error(error);app.exit(1)});`
  const entry = resolve(directory, 'main.cjs')
  await build({ stdin: { contents: script, resolveDir: directory, sourcefile: 'fixture-run.cjs' }, outfile: entry, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
  const child = spawn(desktopRequire('electron') as string, [entry], { cwd: directory, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
  const timer = setTimeout(() => child.kill(), 80_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close'); assert.equal(code, 0, output); assert.match(output, /WORKFLOW_WORKBENCH_OK/)
  assert.deepEqual(requests.filter(request => request.method !== 'GET'), [], 'Opening tabs/deep links never prepares, sends or runs a session')
  for (const id of ['a', 'b']) assert(requests.some(request => request.path === `/projects/${id}/api/workflows`), `Workflow reads are scoped to ${id}`)
})
