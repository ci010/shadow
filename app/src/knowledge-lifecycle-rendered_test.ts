import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'

const root = fileURLToPath(new URL('../..', import.meta.url))
const require = createRequire(new URL('../../desktop/package.json', import.meta.url))
test('production knowledge documents retain identity through close, reopen and shared shortcuts', {
  timeout: 90000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `knowledge-lifecycle-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const server = await createServer({ configFile: false, envDir: false, root: resolve(root, 'app'), cacheDir: resolve(directory, 'cache'), logLevel: 'error', optimizeDeps: { noDiscovery: true, include: ['vue'] }, plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app/unocss.config.ts') }), {
    name: 'knowledge-lifecycle-fixture', resolveId: id => id === '/fixture.ts' ? '\0fixture' : undefined,
    load(id) {
      if (id !== '\0fixture') return
      return `import {createResourceApp as createApp} from '/src/stores/app.ts';import {h,provide,ref} from 'vue';import {createRouter,createMemoryHistory} from 'vue-router';import Host from '/src/components/EditorGroupHost.vue';import Workbench from '/src/components/files/FileWorkbench.vue';import {createEditorGroups,EditorGroupsKey} from '/src/editor-groups.ts';import {setLocalePreference} from '/src/i18n.ts';import '/src/styles.css';setLocalePreference('en');
      const entries=['A','B'].map(title=>({id:'memory/topics/'+title+'.md',path:'memory/topics/'+title+'.md',title,kind:'wiki',source:'project',deletable:true,revision:'1'}));const catalog={entries,links:[{source:entries[0].id,target:entries[1].id,label:'B'}]};window.fetch=async input=>{const url=new URL(String(input),location.origin);const id=url.searchParams.get('id');return Response.json(id?{entry:entries.find(e=>e.id===id),content:'# '+id}:catalog)};
      const groups=createEditorGroups();window.groups=groups;const request=ref({});window.openKnowledge=id=>request.value={entryId:id};const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',name:'chat',component:{render:()=>null}}]});window.router=router;
      const app=createApp({setup(){provide(EditorGroupsKey,groups);return()=>[h(Host,{projectId:'p',active:true}),h(Host,{projectId:'hidden',active:false,style:'display:none'}),h(Workbench,{apiBase:location.origin,projectId:'p',sessionId:'',contextKey:'owner',active:true,keyboardActive:true,knowledgeEnabled:true,knowledgeRequest:request.value,explorerEnabled:false},{default:()=>h('textarea',{'data-conversation':true})})]}});app.use(router);app.mount('#groups');`
    },
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><body style="margin:0"><div id="groups" style="display:flex;height:360px"></div><div id="standalone" style="display:flex;height:360px"></div><script type="module" src="/fixture.ts"></script></body></html>'); return }
      if (!req.url?.startsWith('/api/')) return next()
      res.setHeader('Content-Type', 'application/json'); res.end('{}')
    }) },
  }], server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  t.after(() => { server.httpServer?.closeAllConnections(); return server.close() })
  const script = `const assert=require('node:assert/strict');const {app,BrowserWindow}=require('electron');const {setTimeout:delay}=require('node:timers/promises');app.setPath('userData',require('node:path').join(process.cwd(),'profile'));app.on('window-all-closed',()=>{});
    (async()=>{await app.whenReady();const win=new BrowserWindow({show:false,width:1300,height:850,webPreferences:{backgroundThrottling:false}});win.webContents.on('console-message',d=>console.error('Renderer:',d.message));const run=s=>win.webContents.executeJavaScript(s);const wait=async s=>{for(let i=0;i<200;i++){if(await run('Boolean('+s+')'))return;await delay(50)}throw Error('Timeout '+s+' '+await run('document.body.innerText'))};
    await win.loadURL(${JSON.stringify(server.resolvedUrls!.local[0])});await wait('window.groups&&document.querySelector(".graph-canvas svg")');
    const active='window.groups.active("p")';
    const view='[...document.querySelectorAll(".editor-view")].find(e=>e.style.display!=="none"&&e.querySelector(".knowledge"))';
    const text=()=>run('('+view+').innerText');
    const open=async id=>{await run('window.openKnowledge('+JSON.stringify(id)+')');await wait(active+'.explorer?.entryId==='+JSON.stringify(id));await wait('('+view+').querySelector(".knowledge-preview")');};
    await open('memory/topics/A.md');assert.match(await text(),/memory\\/topics\\/A.md/);
    // Follow a real preview reference by opening a sibling; the A view must stay A.
    await run('('+view+').querySelector(".relations section:last-child button").click()');await wait(active+'.explorer?.entryId==="memory/topics/B.md"');
    const close=async meta=>{await run('document.dispatchEvent(new KeyboardEvent("keydown",{key:"w",ctrlKey:'+!meta+',metaKey:'+!!meta+',bubbles:true,cancelable:true}))');await delay(100)};
    await close(false);await wait(active+'.explorer?.entryId==="memory/topics/A.md"');assert.match(await text(),/memory\\/topics\\/A.md/);assert.doesNotMatch(await text(),/# memory\\/topics\\/B.md/);
    // Use the descriptor rather than assuming an internal tab-key spelling.
    await run('window.groups.activate([...window.groups.descriptors.values()].find(d=>d.explorer&&!d.explorer.entryId).id)');await wait('('+view+').querySelector(".graph-canvas")');
    assert.equal(await run('!!('+view+').querySelector(".maintenance")'),false);
    await run('[...('+view+').querySelectorAll("button")].find(e=>e.textContent==="Link health").click()');await wait('('+view+').querySelector(".maintenance")');await run('[...('+view+').querySelectorAll("button")].find(e=>e.textContent==="Link health").click()');await wait('!('+view+').querySelector(".maintenance")');
    const beforeZoom=await run('('+view+').querySelector(".node").getAttribute("transform")');await run('('+view+').querySelector(".graph-canvas svg").dispatchEvent(new WheelEvent("wheel",{deltaY:-150,bubbles:true,cancelable:true}))');await delay(50);assert.notEqual(await run('('+view+').querySelector(".node").getAttribute("transform")'),beforeZoom);await run('[...('+view+').querySelectorAll("button")].find(e=>e.textContent==="Fit diagram").click()');await delay(50);assert.equal(await run('('+view+').querySelector(".node").getAttribute("transform")'),beforeZoom);
    await run('('+view+').querySelector(".node").dispatchEvent(new MouseEvent("click",{bubbles:true}))');await wait('('+view+').querySelector(".graph-selection button")');assert.equal(await run('!!('+view+').querySelector(".graph-canvas")'),true,'selection keeps graph mounted');
    await run('[...('+view+').querySelectorAll("button")].find(e=>e.textContent==="Open document").click()');await wait(active+'.explorer?.entryId');
    await run('window.groups.move('+active+'.id,"right")');await close(true);await delay(100);assert.equal(await run('window.groups.state("p").right.length'),0);
    await open('memory/topics/B.md');await run('const d=document.createElement("div");d.id="test-overlay";d.setAttribute("role","dialog");d.textContent="modal";document.body.append(d)');await close(false);assert.equal(await run(active+'.explorer.entryId'),'memory/topics/B.md','overlay blocks global close');await run('document.querySelector("#test-overlay").remove()');
    await run('document.dispatchEvent(new KeyboardEvent("keydown",{key:"Tab",ctrlKey:true,bubbles:true,cancelable:true}))');await delay(100);assert.notEqual(await run(active+'.explorer?.entryId'),'memory/topics/B.md','shared Ctrl+Tab cycles');
    await open('memory/topics/B.md');await close(false);await open('memory/topics/B.md');assert.match(await text(),/memory\\/topics\\/B.md/);
    assert.equal(await run('window.groups.state("hidden").left.length'),0,'hidden host cannot compete');
    await run('window.groups.close([...window.groups.descriptors.values()].find(d=>d.explorer&&!d.explorer.entryId).id)');await delay(100);assert.equal(await run(active+'.explorer.entryId'),'memory/topics/B.md','closing home does not close or replace an entry');
    await run('for(const id of [...window.groups.state("p").left,...window.groups.state("p").right])window.groups.close(id)');await delay(100);assert.equal(await run('window.groups.active("p")'),undefined);await open('memory/topics/A.md');assert.match(await text(),/memory\\/topics\\/A.md/);
    win.close();console.log('KNOWLEDGE_LIFECYCLE_OK');app.quit();})().catch(error=>{console.error(error);app.exit(1)});`
  const entry = resolve(directory, 'main.cjs'); await writeFile(entry, script)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron') as string, [entry], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
  const timer = setTimeout(() => child.kill(), 75000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close'); assert.equal(code, 0, output); assert.match(output, /KNOWLEDGE_LIFECYCLE_OK/)
})
