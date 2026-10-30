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

test('project settings and Knowledge click through history and observed groups without executing sessions', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `observation-navigation-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const projects = ['a', 'b'].map(id => ({ id, name: `Project ${id.toUpperCase()}`, createdAt: '2026-01-01' }))
  const requests: { path: string; method: string }[] = []
  const server = await createServer({ configFile: false, envDir: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'cache'), optimizeDeps: { entries: [] }, plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app/unocss.config.ts') }), {
    name: 'observation-navigation-fixture',
    resolveId: id => id === '/fixture.ts' ? '\0navigation-fixture' : undefined,
    load(id) {
      if (id !== '\0navigation-fixture') return
      return `import {createApp,h} from 'vue'; import {createRouter,createMemoryHistory} from 'vue-router'; import Workspace from '/src/components/ProjectsWorkspace.vue'; import {observedGroupId} from '/src/service-groups.ts'; import {setLocalePreference} from '/src/i18n.ts'; import '/src/styles.css'; import 'virtual:uno.css'; setLocalePreference('en');
        const router=createRouter({history:createMemoryHistory(),routes:[{path:'/projects/:projectId/dashboard',name:'project-dashboard',component:{render:()=>null}},{path:'/projects/:projectId/chat/:sessionId?',name:'chat',component:{render:()=>null}},{path:'/projects/:projectId/settings/:section?',name:'project-settings',component:{render:()=>null}},{path:'/projects/:projectId/agents',name:'agents',component:{render:()=>null}},{path:'/settings/:section?',name:'settings',component:{render:()=>null}}]});
        window.fixture={router,observedId:observedGroupId({botInstanceId:'bot',conversationId:'group:received'})};
        const app=createApp({render:()=>h(Workspace,{apiBase:location.origin,visible:true})});app.use(router);router.push({name:'chat',params:{projectId:'a',sessionId:'bot:history'}});router.isReady().then(()=>app.mount('#app'));`
    },
    configureServer(server) { server.middlewares.use((req, res, next) => {
      const url = new URL(req.url!, 'http://127.0.0.1')
      const path = url.pathname
      const json = (body: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)) }
      if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><body><div id="app"></div><script type="module" src="/fixture.ts"></script></body></html>'); return }
      if (!path.includes('/api/') && !path.includes('/debug/')) { next(); return }
      requests.push({ path, method: req.method! })
      if (path === '/api/projects') { json({ projects }); return }
      if (/\/status$/.test(path)) { json({ state: 'ready' }); return }
      if (path.endsWith('/api/work')) { json({ items: [], sessions: [], requests: [], effects: [] }); return }
      if (path.endsWith('/api/project/usage')) { const metrics = { calls: 0, tokens: 0, unknownTokenCalls: 0, costs: [], unknownCostCalls: 0, durationMs: 0, unknownDurationCalls: 0 }; json({ projectId: path.split('/')[2], asOf: '2026-10-01T12:00:00Z', timeZone: 'UTC', total: metrics, today: metrics, past7Days: metrics, month: metrics, daily: [], scanLimitReached: false, untrackedSessions: 0, undatedCalls: 0 }); return }
      if (path.endsWith('/api/config')) { json({ agent: { model: 'fixture', workspace: '/synthetic/home', temperature: 0.5 } }); return }
      if (path.endsWith('/api/models')) { json({ models: ['fixture'], providers: [] }); return }
      if (path.endsWith('/api/service-groups')) { json({ revision: 'r1', agents: [], groups: [{ botInstanceId: 'bot', platform: 'qq', conversationId: 'group:received', botName: 'Bot', enabled: false, pending: false, lastSeen: 1, messages: [{ id: 'm', sender: 'fixture', text: 'Received-only fixture', receivedAt: 1, state: 'not_enabled' }] }] }); return }
      if (path.endsWith('/api/knowledge')) { json({ entries: [], links: [] }); return }
      if (path.endsWith('/api/folders')) { json({ folders: [] }); return }
      if (/\/api\/sessions\/bot%3Ahistory$/.test(path)) { json({ messages: [{ role: 'user', content: 'Existing history fixture' }] }); return }
      json({ projects, sessions: [], nodes: [], stages: {}, jobs: [], requests: [], messages: [], tools: [], providers: [] })
    }) },
  }], server: { host: '127.0.0.1', port: 0 } })
  await server.listen(); t.after(() => server.close())
  const url = server.resolvedUrls?.local[0]; assert(url)
  const script = `const assert=require('node:assert/strict');const {app,BrowserWindow}=require('electron');const {setTimeout:delay}=require('node:timers/promises');app.setPath('userData',require('node:path').join(process.cwd(),'profile'));app.on('window-all-closed',()=>{});
    (async()=>{await app.whenReady();const win=new BrowserWindow({show:false,width:1280,height:850,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});win.webContents.on('console-message',d=>console.error('Renderer:',d.message));const run=s=>win.webContents.executeJavaScript(s);const wait=async s=>{for(let i=0;i<240;i++){if(await run('Boolean('+s+')'))return;await delay(50)}throw new Error('Timeout '+s+' '+await run('document.body.innerText'))};
    const visible=s=>'[...document.querySelectorAll('+JSON.stringify(s)+')].find(e=>e.getBoundingClientRect().width&&e.getBoundingClientRect().height)';
    const clickLabel=async label=>{const s='document.querySelector('+JSON.stringify('[aria-label="'+label+'"]')+')';await wait(s);await run(s+'.click()')};
    const route=()=>run('JSON.parse(JSON.stringify(window.fixture.router.currentRoute.value))');
    const primary=async()=>{const s=visible('.conversation-tab button');await wait(s);await run(s+'.click()')};
    await win.loadURL(${JSON.stringify(url)});await wait('document.querySelector(".projects-sidebar") && window.fixture');
    for(const observed of [false,true]){
      await run('window.fixture.router.push({name:"chat",params:{projectId:"a",sessionId:'+(observed?'window.fixture.observedId':'"bot:history"')+'}})');
      const id=await run(observed?'window.fixture.observedId':'"bot:history"');
      await wait(visible(observed?'.observed-message':'.chat-workspace'));
      if(!observed) await wait('document.body.innerText.includes("Existing history fixture")');
      await clickLabel('Project A settings');await wait(visible('.project-settings-view'));
      await wait('('+visible('.project-settings-view')+').querySelector("h1").textContent==="Project A settings"');
      assert.equal((await route()).name,'project-settings');assert.equal((await route()).params.projectId,'a');
      await primary();await wait('window.fixture.router.currentRoute.value.name==="chat"');assert.equal((await route()).params.sessionId,id);
      // The settings document tab must restore its section, rather than General.
      await run('window.fixture.router.push({name:"project-settings",params:{projectId:"a",section:"learning"}})');
      await wait('window.fixture.router.currentRoute.value.params.section==="learning"');
      await primary();await wait('window.fixture.router.currentRoute.value.name==="chat"');
      await run('[...document.querySelectorAll(".document-tab button[role=tab]")].find(e=>e.textContent.trim()==="Project settings" && e.getBoundingClientRect().width).click()');
      await wait('window.fixture.router.currentRoute.value.name==="project-settings"');
      assert.equal((await route()).params.section,'learning');
      await primary();await wait('window.fixture.router.currentRoute.value.name==="chat"');
      await clickLabel('Project A knowledge');await wait(visible('.knowledge-document'));
      assert.equal((await route()).query.panel,'knowledge');assert.equal((await route()).params.sessionId,id);
      await primary();await wait('!window.fixture.router.currentRoute.value.query.panel');
      if(observed){assert.equal(await run('!!'+visible('.message-input')),false);await wait(visible('.observed-message'))}
      // Inactive cached A must never send navigation events into B.
      await clickLabel('Project B settings');await wait('window.fixture.router.currentRoute.value.params.projectId==="b"');await wait(visible('.project-settings-view'));
      await wait('('+visible('.project-settings-view')+').querySelector("h1").textContent==="Project B settings"');
      await clickLabel('Project B knowledge');await wait('window.fixture.router.currentRoute.value.params.projectId==="b" && window.fixture.router.currentRoute.value.query.panel==="knowledge"');await wait(visible('.knowledge-document'));
      await delay(150);assert.equal((await route()).params.projectId,'b');
      await run('window.fixture.router.push({name:"chat",params:{projectId:"a",sessionId:'+JSON.stringify(id)+'}})');await wait(visible(observed?'.observed-message':'.chat-workspace'));
      assert.equal((await route()).params.sessionId,id);
    }
    // Project identity opens observation-only dashboard, never a coordinator session.
    for (const project of ['A','B']) {
      await clickLabel('Project '+project+' knowledge');await wait(visible('.knowledge-document'));
      await run('[...document.querySelectorAll(".project-entry")].find(e=>e.textContent==="Project '+project+'").click()');
      await wait('window.fixture.router.currentRoute.value.name==="project-dashboard"');
      await wait(visible('.project-workbench'));await wait(visible('[data-overview-canvas]'));
      await run('[...document.querySelectorAll(".work-view-switch button")].find(e=>e.textContent==="Board").click()');await wait(visible('.work-filters'));
      await run('[...document.querySelectorAll(".work-view-switch button")].find(e=>e.textContent==="Usage").click()');await wait(visible('.project-usage'));
      assert.equal((await route()).params.sessionId,undefined);
    }
    await run('[...document.querySelectorAll(".work-view-switch button")].find(e=>e.textContent==="Dashboard").click()');
    await run('document.querySelector(".new-work").click()');
    await wait('window.fixture.router.currentRoute.value.name==="chat"');
    await wait(visible('textarea'));
    await wait('('+visible('textarea')+').value.includes("Help me organize a new work item:")');
    assert.equal((await route()).params.projectId,'b');
    await run('window.fixture.router.push({name:"project-dashboard",params:{projectId:"a"}})');
    await wait(visible('[data-overview-canvas]'));
    win.setSize(390,844);await delay(200);
    await wait(visible('.work-view-switch'));
    assert.equal(await run('document.documentElement.scrollWidth <= window.innerWidth'),true);
    await win.close();console.log('OBSERVATION_NAVIGATION_OK');app.exit(0)})().catch(e=>{console.error(e);app.exit(1)});`
  await build({ stdin: { contents: script, resolveDir: root, sourcefile: 'observation-navigation.cjs', loader: 'js' }, outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(desktopRequire('electron') as string, [resolve(directory, 'main.cjs')], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''; child.stdout.setEncoding('utf8').on('data', chunk => { log += chunk }); child.stderr.setEncoding('utf8').on('data', chunk => { log += chunk })
  const timer = setTimeout(() => child.kill(), 75_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close'); assert.equal(code, 0, log); assert.match(log, /OBSERVATION_NAVIGATION_OK/)
  assert.equal(requests.some(request => /coordinator|orchestrator/.test(request.path)), false, 'Dashboard navigation never accesses a dedicated session')
  for (const id of ['a', 'b']) for (const path of ['/api/work', '/api/project/usage']) assert.ok(requests.some(request => request.path === `/projects/${id}${path}`), `Dashboard reads ${id}${path}`)
  assert.deepEqual(requests.filter(request => request.method !== 'GET'), [], 'Navigation must never prepare/send/run or create an execution')
  assert.equal(requests.some(request => /\/sessions\/.*observed-group/.test(decodeURIComponent(request.path))), false, 'Observed group IDs are never local sessions')
  for (const projectId of ['a', 'b']) assert.ok(requests.some(request => request.path === `/projects/${projectId}/api/knowledge`), `Knowledge uses ${projectId}'s project scope`)
})
