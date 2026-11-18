import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { BotProjection } from './bot-workflows.ts'
import type { ChannelSinkReceiver } from '../../src/channels/sink-contract.ts'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

test('Workflow connection inspector opens exact configured cards without effects', {
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
      return `import {createResourceApp as createApp} from '/src/stores/app.ts'; import {h} from 'vue'; import {createRouter,createMemoryHistory} from 'vue-router'; import Workspace from '/src/components/ProjectsWorkspace.vue'; import {setLocalePreference} from '/src/i18n.ts'; import '/src/styles.css'; import 'virtual:uno.css'; setLocalePreference('en');
        const router=createRouter({history:createMemoryHistory(),routes:[{path:'/projects/:projectId/board',name:'project-board',component:{render:()=>null}},{path:'/projects/:projectId/dashboard',name:'project-dashboard',component:{render:()=>null}},{path:'/projects/:projectId/chat/:sessionId?',name:'chat',component:{render:()=>null}},{path:'/projects/:projectId/workflows',name:'project-workflows',component:{render:()=>null}},{path:'/projects/:projectId/settings/:section?',name:'project-settings',component:{render:()=>null}},{path:'/projects/:projectId/agents',name:'agents',component:{render:()=>null}},{path:'/settings/:section?',name:'settings',component:{render:()=>null}}]});
        window.fixture={router,setLocalePreference};
        const app=createApp({render:()=>h(Workspace,{apiBase:location.origin,visible:true})});app.use(router);router.push(new URLSearchParams(location.search).get('fixtureRoute') || {name:'project-workflows',params:{projectId:'a'},query:{workflow:'schedule:a',run:'run:a'}});router.isReady().then(()=>app.mount('#app'));`
    },
    configureServer(server) { server.middlewares.use((req, res, next) => {
      const path = new URL(req.url!, 'http://127.0.0.1').pathname
      const json = (body: unknown) => {
        if (path.endsWith('/api/workflows')) {
          const fixture = body as { projectId: string; bots: BotProjection }
          const sink = fixture.bots.sinks![0]!
          sink.receivers[0].kind = 'group'
          const receiver = (id: string, conversationId: string, kind: ChannelSinkReceiver['kind'], name?: string): ChannelSinkReceiver => ({
            id, address: { projectId: fixture.projectId, botInstanceId: 'qq-shared', platform: 'qq', conversationId }, kind, name,
            path: `v:connections/qq-shared/receivers/${id}.json`,
            navigation: { kind: 'conversation', address: { projectId: fixture.projectId, botInstanceId: 'qq-shared', platform: 'qq', conversationId }, inboxSessionId: `channel-inbox:${fixture.projectId}:qq-shared:qq:${encodeURIComponent(conversationId)}` },
          })
          sink.receivers.push(receiver('named', 'group:named', 'group', 'Design team'), receiver('owner', 'dm:owner', 'direct', 'Owner private chat'), receiver('other', 'dm:other', 'direct'))
          fixture.bots.deployments.push({ id: 'personal', mode: 'personal', state: 'valid', agent: 'general' })
          fixture.bots.bindings.push({ id: 'personal-owner', deploymentId: 'personal', connectionId: 'qq-shared', platform: 'qq', kind: 'host-owner-ingress', enabled: true, subscribed: true, listener: true, sessionIds: ['web:owner-execution'], receiverIds: ['owner'] })
        }
        if (path.endsWith('/api/workflows') && req.headers.referer?.includes('passive=1')) { const fixture = body as { definitions: unknown[]; bots: { bindings: unknown[]; deployments: unknown[]; connections: {id: string}[] } }; fixture.definitions = []; fixture.bots.bindings = []; fixture.bots.deployments = []; fixture.bots.connections = fixture.bots.connections.filter(connection => connection.id === 'qq-shared') }
        const sync = path.endsWith('/api/workflows') && new URL(req.url!, 'http://fixture').searchParams.get('sync') === '1'
        res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(sync ? { version: 1, kind: 'full', cursor: 'fixture', snapshot: body } : body))
      }
      if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><body><div id="app"></div><script type="module" src="/fixture.ts"></script></body></html>'); return }
      if (!/^\/(?:projects\/[^/]+\/)?(?:api|debug)\//.test(path)) { next(); return }
      requests.push({ path, method: req.method! })
      const projectId = path.split('/')[2]
      if (path === '/api/projects') { json({ projects }); return }
      if (path.endsWith('/api/workflows')) {
        const definition = { id: `schedule:${projectId}`, name: `Workflow ${projectId}`, revision: 1, enabled: true, source: { kind: 'schedule', id: projectId }, nodes: [{ kind: 'schedule-action', action: 'session', job: { schedule: 'every 1h', session: 'fresh', task: `Reminder ${projectId}` } }] }
        json({ projectId, bots: { sinks: [{ kind: 'connection-sink', id: 'connection:qq-shared', projectId, connectionId: 'qq-shared', connectionPath: 'v:connections/qq-shared/overview.json', sinkPath: 'v:connections/qq-shared/sink.json', sink: { kind: 'common-receipt', reacts: false, navigation: { kind: 'connection-content', projectId, connectionId: 'qq-shared' } }, receivers: [{ id: 'group:ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ', address: { projectId, botInstanceId: 'qq-shared', platform: 'qq', conversationId: 'group:one' }, path: 'v:connections/qq-shared/receivers/group%3AABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ.json', navigation: { kind: 'conversation', address: { projectId, botInstanceId: 'qq-shared', platform: 'qq', conversationId: 'group:one' }, inboxSessionId: 'web:ordinary' }, evidence: { discovery: 'unknown', sessionMetadata: 'present', received: 'unknown', persisted: 'unknown', bound: 'unknown', executed: 'unknown' } }], bots: [], guidePath: 'v:bots/authoring' }], connections: [{ id: 'isolated-one', displayName: 'First isolated', platform: 'qq', purpose: 'service', enabled: false, health: 'disabled' }, { id: 'isolated-two', displayName: 'Second isolated', platform: 'qq', purpose: 'service', enabled: false, health: 'disabled' }, { id: 'qq-shared', displayName: 'Shared QQ', platform: 'qq', purpose: 'service', enabled: true, health: 'disconnected' }], deployments: [{ id: 'isolated-two', state: 'valid', mode: 'service' }, { id: 'sales', state: 'valid', mode: 'service', agent: 'BOT:sales' }, { id: 'support', state: 'valid', mode: 'service', agent: 'BOT:support' }], bindings: [{ id: 'one', deploymentId: 'sales', connectionId: 'qq-shared', platform: 'qq', topic: 'group:one', enabled: true, subscribed: true, listener: true, kind: 'message', sessionIds: [] }, { id: 'two', deploymentId: 'support', connectionId: 'qq-shared', platform: 'qq', topic: 'group:two', enabled: false, subscribed: true, listener: false, kind: 'message', sessionIds: ['web:ordinary'] }], warnings: [], routing: 'not-probed', processingSuccess: 'unknown' }, definitions: [definition], runs: [{ id: `run:${projectId}`, workflow: definition.id, definition, timestamp: '2026-11-12T10:00:00Z', status: 'completed', cursor: 1, attempts: 1, nextAt: 0, started: true, output: { sessionId: 'web:ordinary' } }] }); return
      }
      if (path.endsWith('/api/channels')) { json({ channels: (projectId === 'a' ? ['isolated-one', 'isolated-two', 'qq-shared'] : ['other']).map(id => ({ id, projectId, displayName: id, platform: 'qq', label: 'QQ', purpose: 'service', enabled: false, configured: true, state: 'disabled', config: { appId: 'fixture' }, secrets: { secret: true } })) }); return }
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
  }], server: { host: '127.0.0.1', port: 0, watch: null, hmr: false } })
  await server.listen(); t.after(() => server.close())
  const url = server.resolvedUrls?.local[0]; assert(url)
  const script = `const assert=require('node:assert/strict');const {app,BrowserWindow}=require('electron');const {setTimeout:delay}=require('node:timers/promises');app.setPath('userData',require('node:path').join(process.cwd(),'profile'));app.on('window-all-closed',()=>{});
    (async()=>{await app.whenReady();const win=new BrowserWindow({show:false,width:1280,height:850,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});win.webContents.on('console-message',d=>console.error('Renderer:',d.message));const run=async s=>{try{return await win.webContents.executeJavaScript(s)}catch(e){throw new Error(s+' '+e)}};const wait=async s=>{for(let i=0;i<240;i++){if(await run('Boolean('+s+')'))return;await delay(50)}throw new Error('Timeout '+s+' '+await run('document.body.innerText'))};
    const visible=s=>'[...document.querySelectorAll('+JSON.stringify(s)+')].find(e=>e.getBoundingClientRect().width&&e.getBoundingClientRect().height)';
    const route=()=>run('JSON.parse(JSON.stringify(window.fixture.router.currentRoute.value))');
    const open=async(project,query={})=>{await run('window.fixture.router.push('+JSON.stringify({name:'project-workflows',params:{projectId:project},query})+')');await wait(visible('.workflow-manager'));await wait(visible('.graph-group'))};
    const sidebar=async project=>open(project,{bot:'bot-binding:two'});
    await win.loadURL(${JSON.stringify(url)});
    // BOTs are inspection-only rows in the same canvas/tab, with binding-specific
    // Agent identity and only real existing Session links. No control POST exists.
    await wait('document.querySelector('+JSON.stringify('[data-workflow="connection:qq-shared"]')+')');
    await run('window.fixture.router.push({name:"project-workflows",params:{projectId:"a"},query:{bot:"bot-binding:two"}})');
    await wait('window.fixture.router.currentRoute.value.query.bot==="bot-binding:two"');
    await wait(visible('.workflow-inspector'));
    assert.equal(await run('('+visible('.workflow-inspector')+').textContent.includes("BOT:support")'),true);
    assert.equal(await run('!!document.querySelector('+JSON.stringify('[data-workflow="connection:qq-shared"] .group-toggle')+')'),false);
    await run('('+visible('.workflow-inspector a[aria-label="Configure BOT connection"]')+').click()');
    await wait('document.querySelector(".connection-id")?.textContent==="qq-shared"');
    assert.equal((await route()).params.projectId,'a');
    assert.equal((await route()).query.connectionId,'qq-shared');
    assert.equal(await run('document.querySelectorAll(".connection-card").length'),3);
    assert.equal(await run('document.querySelector(".connection-card[data-selected=true]").dataset.connectionId'),'qq-shared');
    await wait('document.activeElement?.classList.contains("selected-connection")');
    await sidebar('a');await wait(visible('.workflow-inspector'));

    await sidebar('a');await wait(visible('.workflow-inspector'));
    assert.equal((await route()).query.bot,'bot-binding:two');
    await open('a',{bot:'connection:qq-shared'});await wait(visible('.workflow-inspector a[aria-label="Configure BOT connection"]'));
    // Real inspector: anonymous receiver uses an honest label, IDs and payloads
    // are folded, exact history navigation remains separate from selection.
    assert.equal(await run('document.querySelector(".bot-technical").open'),false);
    assert.equal(await run('document.querySelector(".receiver-choice").textContent.includes("qq · Group · group:one")'),true);
    assert.equal(await run('document.querySelector(".receiver-directory").textContent.includes("ABCDEFGHIJKLMNOPQRSTUVWXYZ")'),false);
    assert.equal(await run('document.querySelector(".receiver-directory a").getAttribute("href").includes("web:ordinary")'),true);
    assert.equal(await run('Array.from(document.querySelectorAll(".graph-node[data-node-type=sink] strong")).some(e=>e.textContent==="Design team")'),true);
    assert.equal(await run('Array.from(document.querySelectorAll(".receiver-choice")).some(e=>e.textContent.includes("Design team"))'),true);
    assert.equal(await run('document.querySelectorAll(".graph-node[data-node-type=session]").length'),0);
    assert.equal(await run('Array.from(document.querySelectorAll(".graph-node[data-node-type=sink] strong")).some(e=>e.textContent.includes("group:two"))'),true);
    assert.equal(await run('Array.from(document.querySelectorAll(".execution-sessions a")).some(e=>e.getAttribute("href").includes("web:ordinary"))'),true);
    assert.equal(await run('document.querySelector(".execution-sessions").textContent.includes("separate from passive message history")'),true);
    assert.equal(await run('Array.from(document.querySelectorAll(".execution-sessions a")).some(e=>e.getAttribute("href").includes("web:owner-execution"))'),true);
    await run('document.querySelector(".receiver-choice").click()');
    await wait('document.querySelector(".receiver-choice").getAttribute("aria-pressed")==="true"');
    win.setSize(1800,950);await delay(200);
    await run('document.documentElement.classList.remove("dark")');
    for (const width of [320,380,480]) {
      const bounds=await run('(()=>{const e=document.querySelector(".workflow-inspector .sidebar-resizer"),r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+60),width:Number(e.getAttribute("aria-valuenow"))}})()');
      win.webContents.sendInputEvent({type:'mouseMove',x:bounds.x,y:bounds.y});win.webContents.sendInputEvent({type:'mouseDown',x:bounds.x,y:bounds.y,button:'left',clickCount:1});win.webContents.sendInputEvent({type:'mouseMove',x:bounds.x+bounds.width-width,y:bounds.y});win.webContents.sendInputEvent({type:'mouseUp',x:bounds.x+bounds.width-width,y:bounds.y,button:'left',clickCount:1});await delay(150);
      assert.equal(await run('document.querySelector(".workflow-inspector").scrollWidth<=document.querySelector(".workflow-inspector").clientWidth'),true);
      assert.equal(await run('Math.round(document.querySelector(".workflow-inspector").getBoundingClientRect().width)'),width);
      if(process.env.BOT_INSPECTOR_SCREENSHOTS) require('node:fs').writeFileSync(require('node:path').join(process.env.BOT_INSPECTOR_SCREENSHOTS,'bot-inspector-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
    }
    win.show();win.focus();await delay(100);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
    await run('document.documentElement.classList.add("dark");document.querySelector(".bot-heading button").focus()');
    assert.equal(await run('document.activeElement.getAttribute("aria-label")'), 'Close');
    assert.equal(await run('getComputedStyle(document.activeElement).outlineStyle'), 'solid');
    if(process.env.BOT_INSPECTOR_SCREENSHOTS) require('node:fs').writeFileSync(require('node:path').join(process.env.BOT_INSPECTOR_SCREENSHOTS,'bot-inspector-dark.png'),(await win.webContents.capturePage()).toPNG());
    // Native details remains keyboard operable; content scrolls within this pane.
    await run('document.querySelector(".bot-technical > summary").focus()');
    await delay(50);assert.equal(await run('document.activeElement===document.querySelector(".bot-technical > summary")'),true);
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'});
    await wait('document.querySelector(".bot-technical").open');
    await run('document.querySelector(".bot-technical").open=false;document.documentElement.classList.remove("dark")');
    await run('document.querySelector(".graph-canvas").dispatchEvent(new KeyboardEvent("keydown",{key:"@",code:"Digit2",shiftKey:true,bubbles:true}));document.querySelector(".workflow-inspector").scrollTop=0');await delay(300);
    if(process.env.BOT_INSPECTOR_SCREENSHOTS) require('node:fs').writeFileSync(require('node:path').join(process.env.BOT_INSPECTOR_SCREENSHOTS,'bot-topology.png'),(await win.webContents.capturePage()).toPNG());
    await run('document.querySelector(".execution-sessions").scrollIntoView({block:"center"})');await delay(100);
    if(process.env.BOT_INSPECTOR_SCREENSHOTS) require('node:fs').writeFileSync(require('node:path').join(process.env.BOT_INSPECTOR_SCREENSHOTS,'bot-execution-sessions.png'),(await win.webContents.capturePage()).toPNG());
    await run('Array.from(document.querySelectorAll(".execution-sessions a")).find(e=>e.getAttribute("href").includes("web:ordinary")).click()');
    await wait('window.fixture.router.currentRoute.value.name==="chat"');
    assert.equal((await route()).params.sessionId,'web:ordinary');
    await open('a',{bot:'connection:qq-shared'});await wait(visible('.workflow-inspector'));
    win.setSize(360,780);await delay(150);
    await run('document.querySelector(".workflow-inspector").scrollTop=0');
    assert.equal(await run('document.documentElement.scrollWidth<=window.innerWidth'),true);
    assert.equal(await run('document.querySelector(".workflow-inspector").scrollWidth<=document.querySelector(".workflow-inspector").clientWidth'),true);
    if(process.env.BOT_INSPECTOR_SCREENSHOTS) require('node:fs').writeFileSync(require('node:path').join(process.env.BOT_INSPECTOR_SCREENSHOTS,'bot-inspector-phone.png'),(await win.webContents.capturePage()).toPNG());
    win.setSize(1280,850);await delay(150);

    await run('('+visible('.workflow-inspector a[aria-label="Configure BOT connection"]')+').click()');
    await wait('document.querySelector(".connection-id")?.textContent==="qq-shared"');
    assert.equal((await route()).query.connectionId,'qq-shared');
    await sidebar('a');await wait(visible('.workflow-inspector'));
    await run('('+visible('.bot-heading button')+').click()');
    await wait('!window.fixture.router.currentRoute.value.query.bot');
    await run('window.fixture.workflowElement=('+visible('.workflow-manager')+')');
    // Ellipsis is direct, precise, Project-scoped navigation into the existing settings form.
    assert.equal(await run('!!document.querySelector('+JSON.stringify('[data-workflow="bot-deployment:isolated-two"] .group-connection')+')'),false);
    for (const id of ['isolated-one','isolated-two']) {
      await sidebar('a');
      assert.equal(await run('window.fixture.workflowElement===('+visible('.workflow-manager')+')'),true,'Settings navigation retains the Workflow instance');
      const selector='[data-workflow="connection:'+id+'"] .group-connection';
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
    // Original receipt-only use case: no BOT association does not invent a BOT.
    win.setSize(1280,850);await win.loadURL(${JSON.stringify(url)}+'?passive=1&fixtureRoute='+encodeURIComponent('/projects/a/workflows?bot=connection:qq-shared'));
    await wait('!!document.querySelector(".receiver-directory")');
    assert.equal(await run('document.querySelector(".bot-explanation").textContent'), 'Records messages without model reactions');
    assert.equal(await run('document.querySelector(".bot-technical").open'),false);
    assert.equal(await run('document.querySelectorAll(".bot-section[data-node]").length'),0);
    if(process.env.BOT_INSPECTOR_SCREENSHOTS) require('node:fs').writeFileSync(require('node:path').join(process.env.BOT_INSPECTOR_SCREENSHOTS,'bot-passive.png'),(await win.webContents.capturePage()).toPNG());
    await run('window.fixture.setLocalePreference("zh-CN")');await delay(100);
    assert.equal(await run('document.querySelector(".bot-explanation").textContent.includes("消息")'),true);
    assert.equal(await run('document.querySelector(".workflow-inspector").scrollWidth<=document.querySelector(".workflow-inspector").clientWidth'),true);
    if(process.env.BOT_INSPECTOR_SCREENSHOTS) require('node:fs').writeFileSync(require('node:path').join(process.env.BOT_INSPECTOR_SCREENSHOTS,'bot-passive-zh.png'),(await win.webContents.capturePage()).toPNG());
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
  for (const id of ['a']) assert(requests.some(request => request.path === `/projects/${id}/api/workflows`), `Workflow reads are scoped to ${id}`)
})
