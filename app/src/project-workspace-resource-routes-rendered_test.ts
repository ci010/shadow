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

test('real workspace routes retain cross-project conversation and video owners', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `workspace-resource-routes-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const projects = ['a', 'b'].map(id => ({ id, name: `Project ${id.toUpperCase()}`, createdAt: '2026-01-01' }))
  const requests: { path: string; method: string }[] = []
  let catalogReads = 0
  const server = await createServer({ configFile: false, envDir: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'cache'), optimizeDeps: { noDiscovery: true, include: ['vue', 'vue-router', '@vue-flow/core'] }, plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app/unocss.config.ts') }), {
    name: 'workspace-resource-routes-fixture',
    resolveId: id => id === '/fixture.ts' ? '\0navigation-fixture' : undefined,
    load(id) {
      if (id !== '\0navigation-fixture') return
      return `import {createResourceApp as createApp} from '/src/stores/app.ts';
        import {h,KeepAlive} from 'vue';import {RouterView} from 'vue-router';import router from '/src/router.ts';
        import {liveTransportKey} from '/src/stores/live.ts';import {setLocalePreference} from '/src/i18n.ts';import '/src/styles.css';import 'virtual:uno.css';setLocalePreference('en');
        window.fixture={router};
        const app=createApp({render:()=>h(RouterView,null,{default:({Component})=>h(KeepAlive,{include:'ProjectsWorkspace'},()=>h(Component,{key:'projects-workspace',apiBase:location.origin,visible:true}))})});
        // A ready legacy transport exercises real HTTP resource loading without a live backend.
        app.provide(liveTransportKey,{observeHost:(_base,cb)=>{cb({phase:'live'});return ()=>{}},observe:()=>()=>{},client:()=>({subscribe:()=>({ready:()=>Promise.resolve(),close(){}})})});
        app.use(router);router.push({name:'chat',params:{projectId:'a',sessionId:'web:one'}});router.isReady().then(()=>app.mount('#app'));`

    },
    configureServer(server) { server.middlewares.use((req, res, next) => {
      const url = new URL(req.url!, 'http://127.0.0.1')
      const path = url.pathname
      const json = (body: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)) }
      if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><body><div id="app"></div><script type="module" src="/fixture.ts"></script></body></html>'); return }
      if (!/^\/(?:projects\/[^/]+\/)?(?:api|debug)\//.test(path)) { next(); return }
      requests.push({ path, method: req.method! })
      if (path === '/api/projects') {
        if (++catalogReads === 2) { res.statusCode = 503; json({ error: 'Temporary catalog failure' }); return }
        json({ projects }); return
      }
      if (/\/status$/.test(path)) { json({ state: 'ready' }); return }
      if (path.endsWith('/api/sessions/summary')) { json({ sessions: [{ sessionId:'web:one',title:'First conversation',mode:'session' },{ sessionId:'web:two',title:'Second conversation',mode:'session' }] }); return }
      if (path.endsWith('/api/sessions/stages')) { json({ activity: {} }); return }
      if (path.endsWith('/api/work')) { json({ items: [], sessions: [], requests: [], effects: [] }); return }
      if (path.endsWith('/api/config')) { json({ agent: { model: 'fixture', workspace: '/synthetic/home', temperature: 0.5 } }); return }
      if (path.endsWith('/api/models')) { json({ models: ['fixture'], providers: [] }); return }
      if (path.endsWith('/api/service-groups')) { json({ revision: 'r1', agents: [], groups: [] }); return }
      if (path.endsWith('/api/knowledge')) { json({ entries: [], links: [] }); return }
      if (path.endsWith('/api/folders')) { json({ folders: [] }); return }
      json({ projects, sessions: [], nodes: [], activity: {}, jobs: [], requests: [], messages: [], tools: [], providers: [] })
    }) },
  }], server: { host: '127.0.0.1', port: 0, hmr: false, watch: { ignored: ['**/*'] } } })
  await server.listen(); t.after(() => server.close())
  const url = server.resolvedUrls?.local[0]; assert(url)
  const script = `const assert=require('node:assert/strict');const {app,BrowserWindow}=require('electron');const {setTimeout:delay}=require('node:timers/promises');app.setPath('userData',require('node:path').join(process.cwd(),'profile'));app.on('window-all-closed',()=>{});
    (async()=>{await app.whenReady();const win=new BrowserWindow({show:false,width:1280,height:850,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});win.webContents.on('console-message',d=>console.error('Renderer:',d.message));const run=s=>win.webContents.executeJavaScript(s);const wait=async s=>{for(let i=0;i<240;i++){if(await run('Boolean('+s+')'))return;await delay(50)}throw new Error('Timeout '+s+' '+await run('document.body.innerText'))};
    const visible=s=>'[...document.querySelectorAll('+JSON.stringify(s)+')].find(e=>e.getBoundingClientRect().width&&e.getBoundingClientRect().height)';
    const sidebar=async(project,label)=>{const s='[...document.querySelectorAll('+JSON.stringify('[data-project-id="'+project+'"] .session-select')+')].find(e=>e.textContent.includes('+JSON.stringify(label)+'))';await wait(s);await run(s+'.click()')};
    await win.loadURL(${JSON.stringify(url)});await wait('document.querySelector(".projects-sidebar") && window.fixture');
    await wait(visible('.chat-messages'));await wait('document.body.innerText.includes("First conversation")');
    await run(\`window.workspace=document.querySelector('.projects-workspace').__vueParentComponent;while(window.workspace.type.__name!=='ProjectsWorkspace')window.workspace=window.workspace.parent;window.groups=window.workspace.setupState.editorGroups;window.a=window.workspace.setupState.selected;\`);
    await run('window.fixture.router.push({name:"chat",params:{projectId:"b",sessionId:"web:one"}})');
    await wait('window.workspace.setupState.selected?.projectId==="b"');
    await wait('window.groups.active("b")?.label==="First conversation"');
    await run(\`window.explorer=[...document.querySelectorAll('.project-file-explorer')].map(e=>e.__vueParentComponent).find(c=>c.props.projectId==='b');window.explorer.setupState.openFile({path:'movie.mp4',entry:{name:'movie.mp4',type:'file',ext:'.mp4',size:10,mtime:null},source:{sessionWorkspace:true,sessionId:'web:one'}});window.b=window.workspace.setupState.selected;\`);
    await wait('document.querySelector("video")');
    await run('window.preview=document.querySelector("video").__vueParentComponent;while(window.preview.type.__name!=="FilePreviewModal")window.preview=window.preview.parent;window.ids=[...window.groups.descriptors.keys()];window.owners=[...window.workspace.setupState.instances];undefined;');
    for(const label of ['web:one','movie.mp4','web:one','movie.mp4']){
      await run(\`(()=>{const project=window.fixture.router.currentRoute.value.params.projectId==='b'?'a':'b';const tab=[...document.querySelectorAll('.project-editor-label')].find(e=>e.textContent.includes(project==='b'?'movie.mp4':'First conversation'));if(!tab)throw Error('Missing cross-project tab '+project+' '+document.body.innerText+' '+JSON.stringify([...window.groups.descriptors]));tab.click()})()\`);
      await delay(250);
      assert.deepEqual(await run('[...window.groups.descriptors.keys()]'),await run('window.ids'));
      assert.equal(await run('window.groups.active(window.fixture.router.currentRoute.value.params.projectId)?.label'),label==='movie.mp4'?'movie.mp4':'First conversation','clicked top tab remains focused after route settles');
      assert.equal(await run('!window.preview.isUnmounted && window.owners.every(([key,instance])=>window.workspace.setupState.instances.get(key)===instance)'),true);
      assert.deepEqual(await run('[...document.querySelectorAll(".editor-workspace")].filter(e=>e.getBoundingClientRect().width).flatMap(e=>[...e.querySelectorAll(".editor-tab-label,.project-editor-label > span:last-child")].map(n=>n.textContent))'),['First conversation','First conversation','movie.mp4']);
      assert.equal(await run('window.workspace.setupState.resources.includes(window.a)&&window.workspace.setupState.resources.includes(window.b)'),true);
    }
    // Loading/error catalog states retain the last successful Projects and must
    // neither forget their owners nor treat refresh as a new conversation click.
    for(let i=0;i<2;i++){
      await run('window.workspace.setupState.refresh()');
      assert.deepEqual(await run('[...window.groups.descriptors.keys()]'),await run('window.ids'));
      assert.equal(await run('window.groups.active("b")?.label'),'movie.mp4','catalog refresh does not steal document focus');
      assert.equal(await run('!window.preview.isUnmounted'),true);
    }
    // Sidebar selection while a file is focused must not evict that file.
    await sidebar('b','Second conversation');
    await wait('window.fixture.router.currentRoute.value.params.sessionId==="web:two"');
    assert.equal(await run('!window.preview.isUnmounted && window.ids.every(id=>window.groups.side(id))'),true,await run('JSON.stringify({route:window.fixture.router.currentRoute.value.fullPath,unmounted:window.preview.isUnmounted,ids:[...window.groups.descriptors.keys()],placements:window.ids.map(id=>window.groups.side(id))})'));
    await wait('window.workspace.setupState.instances.get(window.workspace.setupState.selected.key)?.canReplaceSidebarTab()');
    await run('window.replaced=window.workspace.setupState.selected.key');await sidebar('b','First conversation');
    await wait('window.fixture.router.currentRoute.value.params.sessionId==="web:one"');
    assert.equal(await run('!window.groups.side(window.replaced+":")'),true,'idle conversation replacement remains enabled');
    assert.equal(await run('!window.preview.isUnmounted && !!window.groups.side(window.ids[2])'),true,'replacing a conversation cannot evict the explorer video');
    // Folder drafts have a distinct key, despite sharing the no-session route.
    for(const projectId of ['a','b']) await run('window.workspace.setupState.startDraft('+JSON.stringify(projectId)+',{id:"folder-"+'+JSON.stringify(projectId)+',name:"Folder",path:"/synthetic/folder"})');
    assert.equal(await run('!window.preview.isUnmounted'),true);
    await win.close();console.log('WORKSPACE_RESOURCE_ROUTES_OK');app.exit(0)})().catch(e=>{console.error(e);app.exit(1)});`
  await build({ stdin: { contents: script, resolveDir: root, sourcefile: 'workspace-resource-routes.cjs', loader: 'js' }, outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(desktopRequire('electron') as string, [resolve(directory, 'main.cjs')], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''; child.stdout.setEncoding('utf8').on('data', chunk => { log += chunk }); child.stderr.setEncoding('utf8').on('data', chunk => { log += chunk })
  const timer = setTimeout(() => child.kill(), 75_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close'); assert.equal(code, 0, log); assert.match(log, /WORKSPACE_RESOURCE_ROUTES_OK/)
  assert.ok(catalogReads >= 3, 'catalog failure and recovery were exercised')
  assert.deepEqual(requests.filter(request => request.method !== 'GET'), [], 'navigation does not create sessions or submit input')
})
