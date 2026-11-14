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

test('draft editor labels follow locale without translating authored conversation names', {
  timeout: 120_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `draft-locale-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const server = await createServer({ configFile: false, envDir: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'cache'), optimizeDeps: { noDiscovery: true, include: ['vue', 'vue-router', '@vue-flow/core'] }, plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app/unocss.config.ts') }), {
    name: 'draft-locale-fixture',
    resolveId: id => id === '/fixture.ts' ? '\0draft-locale-fixture' : undefined,
    load(id) {
      if (id !== '\0draft-locale-fixture') return
      return `import {createApp,h} from 'vue'; import {createRouter,createMemoryHistory} from 'vue-router'; import Workspace from '/src/components/ProjectsWorkspace.vue'; import {setLocalePreference} from '/src/i18n.ts'; import '/src/styles.css'; import 'virtual:uno.css'; setLocalePreference('en'); document.documentElement.classList.add('dark');
        const router=createRouter({history:createMemoryHistory(),routes:[{path:'/projects/:projectId/dashboard',name:'project-dashboard',component:{render:()=>null}},{path:'/projects/:projectId/chat/:sessionId?',name:'chat',component:{render:()=>null}},{path:'/projects/:projectId/workflows',name:'project-workflows',component:{render:()=>null}},{path:'/projects/:projectId/settings/:section?',name:'project-settings',component:{render:()=>null}},{path:'/projects/:projectId/agents',name:'agents',component:{render:()=>null}},{path:'/settings/:section?',name:'settings',component:{render:()=>null}}]});
        window.fixture={router,setLocalePreference,chatObservers:[]};
        const app=createApp({render:()=>h(Workspace,{apiBase:location.origin,visible:true})});app.provide(Symbol.for('shadow.live-client-pool'),{onDispose:()=>()=>{},observeHost:(_base,callback)=>{callback({phase:'live'});return()=>{}},client:()=>({subscribe:(topic,observer)=>{if(topic.kind==='chat')window.fixture.chatObservers.push(observer);return {close(){},ready:async()=>{}}}})});app.use(router);router.push(new URLSearchParams(location.search).get('fixtureRoute') || {name:'chat',params:{projectId:'a'}});router.isReady().then(()=>app.mount('#app'));`
    },
    configureServer(server) { server.middlewares.use((req, res, next) => {
      const path = new URL(req.url!, 'http://fixture').pathname
      const json = (body: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)) }
      if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<html><body><div id="app"></div><script type="module" src="/fixture.ts"></script></body></html>'); return }
      if (!/^\/(?:projects\/[^/]+\/)?(?:api|debug)\//.test(path)) return next()
      if (req.method !== 'GET') { res.statusCode = 405; res.end('{}'); return }
      const projects = [{ id: 'a', name: 'Synthetic project', createdAt: '2026-01-01' }]
      if (path === '/api/projects') return json({ projects })
      if (/\/api\/sessions\/(summary|graph)$/.test(path)) return json({ sessions: [{ sessionId: 'web:chat-ordinary', name: 'New conversation', mode: 'session' }], nodes: [] })
      if (path.endsWith('/api/chat/session')) return json({ revision: 'a'.repeat(64), historyRevision: 'a'.repeat(64), data: { chatId: 'chat-ordinary', currentPhysicalId: 'synthetic', previousPhysicalId: null, segmentIndex: 0, history: [], tools: [], commandResults: [], decisionRecords: [] } })
      json({ projects, sessions: [], nodes: [], activity: {}, jobs: [], requests: [], messages: [], tools: [], providers: [] })
    }) },
  }], server: { host: '127.0.0.1', port: 0 } })
  await server.listen(); t.after(() => { server.httpServer?.closeAllConnections(); return server.close() })
  const url = server.resolvedUrls!.local[0]
  const script = `const assert=require('node:assert/strict');const {app,BrowserWindow}=require('electron');const {setTimeout:delay}=require('node:timers/promises');app.setPath('userData',require('node:path').join(process.cwd(),'profile'));app.on('window-all-closed',()=>{});
    (async()=>{await app.whenReady();const win=new BrowserWindow({show:false,width:1300,height:800,webPreferences:{backgroundThrottling:false}});win.webContents.on('console-message',d=>console.error('Renderer:',d.message));const run=s=>win.webContents.executeJavaScript(s);const wait=async s=>{for(let i=0;i<240;i++){if(await run('Boolean('+s+')'))return;await delay(50)}throw Error('Timeout '+s+' '+await run('document.body.innerText'))};
    const tab=label=>'[...document.querySelectorAll(".editor-tab [role=tab]")].find(e=>e.textContent.trim()==='+JSON.stringify(label)+' && e.getBoundingClientRect().width)';
    await win.loadURL(${JSON.stringify(url)});
    await wait(tab('New conversation'));
    await run('window.fixture.setLocalePreference("zh-CN")');await wait(tab('新对话'));
    assert.equal(await run('!!('+tab('New conversation')+')'),false);
    await run('window.fixture.setLocalePreference("en")');await wait(tab('New conversation'));
    await run('window.fixture.router.push({name:"chat",params:{projectId:"a",sessionId:"web:chat-ordinary"}})');
    await wait('[...document.querySelectorAll(".editor-tab [role=tab]")].filter(e=>e.textContent.trim()==="New conversation").length===2');
    await run('window.fixture.setLocalePreference("zh-CN")');await wait(tab('新对话'));
    assert.equal(await run('!!('+tab('New conversation')+')'),true,'authored same-name conversation is not translated');
    win.close();console.log('DRAFT_LOCALE_OK');app.quit();})().catch(e=>{console.error(e);app.exit(1)});`
  const entry = resolve(directory, 'main.cjs')
  await build({ stdin: { contents: script, resolveDir: directory }, outfile: entry, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
  const child = spawn(desktopRequire('electron') as string, [entry], { cwd: directory, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
  const timer = setTimeout(() => child.kill(), 80000); t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close'); assert.equal(code, 0, output); assert.match(output, /DRAFT_LOCALE_OK/)
})
