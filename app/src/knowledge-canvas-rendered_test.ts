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
test('knowledge canvas keeps screen-space targets, bounded overlays and ordinary reading across pane sizes', {
  timeout: 90000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY,
}, async t => {
  const directory = resolve(process.env.SHADOW_SESSION_DATA_DIR ?? resolve(root, '.test-artifacts'), `knowledge-canvas-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  // Retain screenshots only when an explicit evidence directory is supplied.
  if (!process.env.SHADOW_SESSION_DATA_DIR) t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const server = await createServer({ configFile: false, envDir: false, root: resolve(root, 'app'), cacheDir: resolve(directory, 'cache'), logLevel: 'error', optimizeDeps: { noDiscovery: true, include: ['vue'] }, plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app/unocss.config.ts') }), {
    name: 'knowledge-canvas-fixture', resolveId: id => id === '/fixture.ts' ? '\0fixture' : undefined,
    load(id) {
      if (id !== '\0fixture') return
      return `import {createResourceApp as createApp} from '/src/stores/app.ts';import {h,ref} from 'vue';import {createRouter,createMemoryHistory} from 'vue-router';import View from '/src/components/KnowledgeView.vue';import {setLocalePreference} from '/src/i18n.ts';import '/src/styles.css';import 'virtual:uno.css';setLocalePreference('en');
      const entries=Array.from({length:230},(_,i)=>({id:'memory/topics/synthetic-'+i+'.md',path:'memory/topics/synthetic-'+i+'.md',title:['Reference navigation','Knowledge canvas','Session context','Design notes','Search behavior','Graph layout'][i%6]+' '+i,kind:i%7===0?'skill':i%3===0?'memory':'wiki',source:'project',deletable:true,revision:'synthetic'}));entries[0].path='memory/events/synthetic.jsonl';
      const links=Array.from({length:814},(_,i)=>({source:entries[i%230].id,target:entries[(i%230+1+Math.floor(i/230)*19)%230].id,label:'Explicit synthetic link'}));
      window.fetch=async input=>{const url=new URL(String(input),location.origin);const id=url.searchParams.get('id');return Response.json(id?{entry:entries.find(e=>e.id===id),content:id===entries[0].id?JSON.stringify({when:'2026-01-01T10:00:00Z',who:'Synthetic fixture',what:'Navigation remains readable.',why:'Verify normal event reading without graph transforms.',refs:[entries[1].id]}):'# Synthetic reading document\\n\\n'+('Ordinary reading, selection and explicit references remain available without panning or zooming.\\n\\n'.repeat(35))}:{entries,links})};
      const selected=ref('');window.openDocument=i=>selected.value=i===undefined?'':entries[i].id;const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',name:'chat',component:{render:()=>null}}]});const app=createApp({render:()=>h(View,{apiBase:location.origin,projectId:'synthetic',sharedExplorer:true,entryId:selected.value,onSelect:id=>selected.value=id,onHome:()=>selected.value=''})});app.use(router);app.mount('#app');`
    },
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url !== '/') return next()
      res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;height:100%;overflow:hidden}#app.synthetic-root{height:calc(100vh - 40px);display:flex}#tab{height:40px;padding:8px 16px;box-sizing:border-box;font:13px system-ui;color:var(--c-text);background:var(--c-bg-card);border-bottom:1px solid var(--c-border)}</style></head><body><div id="tab">Knowledge · synthetic fixture</div><div id="app" class="synthetic-root"></div><script type="module" src="/fixture.ts"></script></body></html>')
    }) },
  }], server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  t.after(() => { server.httpServer?.closeAllConnections(); return server.close() })
  const script = `const assert=require('node:assert/strict');const {app,BrowserWindow}=require('electron');const fs=require('node:fs/promises');const {setTimeout:delay}=require('node:timers/promises');app.setPath('userData',require('node:path').join(process.cwd(),'profile'));app.on('window-all-closed',()=>{});
    (async()=>{await app.whenReady();const win=new BrowserWindow({show:false,width:1280,height:800,useContentSize:true,webPreferences:{backgroundThrottling:false}});const run=s=>win.webContents.executeJavaScript(s);const wait=async s=>{for(let i=0;i<200;i++){if(await run('Boolean('+s+')'))return;await delay(50)}throw Error('Timeout '+s+' '+await run('document.body.innerText'))};
    const shot=async name=>{await delay(100);await fs.writeFile(require('node:path').join(process.cwd(),name+'.png'),(await win.webContents.capturePage()).toPNG())};
    await win.loadURL(${JSON.stringify(server.resolvedUrls!.local[0])});await wait('document.querySelectorAll(".node").length===230');
    assert.equal(await run('document.querySelectorAll(".edge").length'),814);
    const dot=()=>run('document.querySelector(".dot").getBoundingClientRect().width');
    const fit=()=>run('[...document.querySelectorAll("button")].find(e=>e.textContent==="Fit diagram").click()');
    const geometry=()=>run('({canvas:document.querySelector(".graph-canvas").getBoundingClientRect().toJSON(),toolbar:document.querySelector(".graph-toolbar").getBoundingClientRect().toJSON(),width:innerWidth,height:innerHeight})');
    for(const [width,height] of [[1280,800],[700,600],[390,760],[320,560]]){
      win.setContentSize(width,height);await delay(150);await fit();await delay(50);const g=await geometry();
      assert.equal(g.canvas.height,height-40);assert(g.toolbar.right<=width);assert(g.toolbar.left>=0);assert(Math.abs(await dot()-11)<.1,'11px dots at fit');assert.equal(await run('document.querySelector(".hit").getBoundingClientRect().width'),28);
      assert(await run('document.querySelectorAll(".graph-labels text").length<=24'));
      await shot('fit-'+width);
      const beforePan=await run('document.querySelector(".node").getAttribute("transform")');
      win.webContents.sendInputEvent({type:'mouseMove',x:20,y:height-20});win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,x:20,y:height-20});win.webContents.sendInputEvent({type:'mouseMove',x:50,y:height-50});win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,x:50,y:height-50});await delay(100);
      assert.notEqual(await run('document.querySelector(".node").getAttribute("transform")'),beforePan,'empty canvas drag pans');await fit();
      await run('document.querySelector(".node").dispatchEvent(new KeyboardEvent("keydown",{key:"Enter",bubbles:true,cancelable:true}))');await wait('document.querySelector(".graph-selection")');
      const selection=await run('document.querySelector(".graph-selection").getBoundingClientRect().toJSON()');assert(selection.left>=0&&selection.right<=width&&selection.bottom<=height,'selection actions stay inside pane');await shot('selected-'+width);
      await run('[...document.querySelectorAll("button")].find(e=>e.getAttribute("aria-label")==="Clear selection").click()');await wait('!document.querySelector(".graph-selection")');
      await run('[...document.querySelectorAll("button")].find(e=>e.getAttribute("aria-label")==="Zoom in").click()');await wait('document.querySelector("output").textContent==="130%"');assert(Math.abs(await dot()-11)<.1,'zoom keeps dot screen size');
      const zoomed=await run('document.querySelector(".node").getAttribute("transform")');await fit();await wait('document.querySelector("output").textContent==="100%"');assert.notEqual(await run('document.querySelector(".node").getAttribute("transform")'),zoomed);
      await run('document.querySelector("details summary").click()');await delay(50);const popup=await run('document.querySelector(".canvas-popover").getBoundingClientRect().toJSON()');assert(popup.left>=0&&popup.right<=width,'filter stays inside pane');await shot('filter-'+width);
      await run('document.querySelector("input[type=search]").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))');assert.equal(await run('document.querySelector("details").open'),false);assert.equal(await run('document.activeElement.tagName'),'SUMMARY');
    }
    win.setContentSize(1280,800);await delay(150);await run('document.documentElement.classList.add("dark")');await shot('fit-dark');
    await run('document.querySelectorAll(".node")[50].dispatchEvent(new MouseEvent("click",{bubbles:true}))');await wait('document.querySelector(".graph-selection")');assert(await run('document.querySelectorAll(".graph-labels text").length>0'));await shot('selected-dark');
    await run('[...document.querySelectorAll("button")].find(e=>e.getAttribute("aria-label")==="Zoom in").click()');await wait('document.querySelector("output").textContent==="130%"');await shot('zoom-dark');
    await run('document.querySelector(".graph-canvas").dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true,cancelable:true}))');await wait('!document.querySelector(".graph-selection")');
    await run('document.querySelector("details summary").click();const input=document.querySelector("input[type=search]");input.value="no synthetic result";input.dispatchEvent(new Event("input",{bubbles:true}))');await wait('!document.querySelector(".node")');assert(await run('!!document.querySelector(".graph-canvas")'));await shot('empty-dark');
    await run('window.openDocument(1)');await wait('document.querySelector(".knowledge-preview")');assert.equal(await run('getComputedStyle(document.querySelector(".knowledge-scroll")).overflowY'),'auto');assert.equal(await run('getComputedStyle(document.querySelector(".knowledge-preview")).maxHeight'),'none');await run('document.querySelector(".knowledge-scroll").scrollTop=220');assert(await run('document.querySelector(".knowledge-scroll").scrollTop>0'));await shot('document-dark');
    win.setContentSize(390,760);await delay(150);await run('document.documentElement.classList.remove("dark");document.querySelector(".knowledge-scroll").scrollTop=0');await shot('document-mobile');
    await run('window.openDocument(0)');await wait('document.querySelector(".knowledge-events")');await shot('events-mobile');
    win.close();console.log('KNOWLEDGE_CANVAS_OK '+process.cwd());app.quit();})().catch(error=>{console.error(error);app.exit(1)});`
  const entry = resolve(directory, 'main.cjs'); await writeFile(entry, script)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron') as string, [entry], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
  const timer = setTimeout(() => child.kill(), 75000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close'); assert.equal(code, 0, output); assert.match(output, /KNOWLEDGE_CANVAS_OK/)
  if (process.env.SHADOW_SESSION_DATA_DIR) console.log(output.trim())
})
