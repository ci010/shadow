import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'

const require = createRequire(new URL('../../desktop/package.json', import.meta.url))
test('rendered editor header DOM token route preserves views across empty groups', { timeout: 60000 }, async t => {
  await mkdir(resolve('.test-artifacts'), { recursive: true })
  const dir = await mkdtemp(resolve('.test-artifacts/editor-drag-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const server = await createServer({ configFile: false, envDir: false, root: resolve('app'), logLevel: 'error', optimizeDeps: { noDiscovery: true, include: ['vue'] }, plugins: [vue(), {
    name: 'drag-fixture',
    resolveId: id => id === '/fixture.ts' ? '\0fixture' : undefined,
    load(id) { if (id === '\0fixture') return `import {createApp,h,provide} from 'vue';import Host from '/src/components/EditorGroupHost.vue';import View from '/src/components/EditorViewHost.vue';import {createEditorGroups,EditorGroupsKey} from '/src/editor-groups.ts';import '/src/styles.css';const groups=createEditorGroups();window.groups=groups;const descriptors=['Conversation','Settings'].map(id=>({id,projectId:'a',owner:'fixture',label:id,icon:'',closable:true,select(){},close(){groups.unregister(id)}}));createApp({setup(){provide(EditorGroupsKey,groups);return()=>h('div',{style:'height:100vh;display:flex'},[h(Host,{projectId:'a',active:true}),...descriptors.map(descriptor=>h(View,{descriptor,initialSide:'right'},()=>h('textarea',{'data-fixture':descriptor.id})))])}}).mount('#app');` },
    configureServer(s) { s.middlewares.use((req,res,next) => { if (req.url !== '/') return next();res.setHeader('content-type','text/html');res.end('<div id="app"></div><script type="module" src="/fixture.ts"></script>') }) },
  }], server: { host: '127.0.0.1', port: 0 } })
  await server.listen();t.after(() => { server.httpServer?.closeAllConnections(); return server.close() })
  const script = `const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const {setTimeout:delay}=require('node:timers/promises');app.setPath('userData',process.cwd()+'/profile');(async()=>{await app.whenReady();const win=new BrowserWindow({show:true,width:1200,height:800,webPreferences:{backgroundThrottling:false}});const run=s=>win.webContents.executeJavaScript(s);const wait=async s=>{for(let i=0;i<100;i++){if(await run(s))return;await delay(50)}throw Error('timeout '+s+' '+await run('JSON.stringify(window.events)'))};await win.loadURL(${JSON.stringify(server.resolvedUrls!.local[0])});await wait('!!document.querySelector("textarea")');await run('window.events=[];["dragstart","dragend","blur","mousedown"].forEach(t=>window.addEventListener(t,e=>window.events.push(t+":"+e.target.tagName),true))');await run('window.input=document.querySelector("[data-fixture=Conversation]");window.input.value="Unsent draft";window.groups.activate("Conversation")');
  const rect=selector=>run('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');const r=e.getBoundingClientRect();return {x:Math.round(r.x+r.width/2),y:Math.round(r.y+r.height/2)}})()');
  const drag=async(id,side)=>{const before=await rect('[role=tab][id$="'+id+'"]');await run('window.transfer=new DataTransfer();document.querySelector('+JSON.stringify('[role=tab][id$="'+id+'"]')+').dispatchEvent(new DragEvent("dragstart",{bubbles:true,dataTransfer:window.transfer}))');await wait('document.querySelectorAll(".drag-target").length===2');assert.equal(await run('document.querySelectorAll(".editor-drop-label").length'),await run('[window.groups.state("a").left,window.groups.state("a").right].filter(items=>!items.length).length'));assert.deepEqual(await rect('[role=tab][id$="'+id+'"]'),before);await run('window.dispatchEvent(new Event("blur"))');assert.equal(await run('document.querySelectorAll(".drag-target").length'),2);const b=await rect('[data-editor-header-group='+side+'] .editor-tabs');await run('(()=>{const e=document.elementFromPoint('+b.x+','+b.y+');e.dispatchEvent(new DragEvent("dragover",{bubbles:true,cancelable:true,dataTransfer:window.transfer}));e.dispatchEvent(new DragEvent("drop",{bubbles:true,cancelable:true,dataTransfer:window.transfer}))})()');await wait('window.groups.side('+JSON.stringify(id)+')==='+JSON.stringify(side));};
  assert.equal(await run('document.querySelectorAll(".editor-drop-label").length'),0);await drag('Conversation','left');assert.equal(await run('document.querySelectorAll(".editor-drop-label").length'),0);assert.equal(await run('document.querySelector("[data-editor-group=left] textarea")===window.input'),true);assert.equal(await run('window.input.value'),'Unsent draft');await drag('Settings','left');await drag('Conversation','right');await drag('Settings','right');assert.equal(await run('document.querySelectorAll("[data-fixture=Conversation]").length'),1);assert.equal(await run('window.input.value'),'Unsent draft');await win.setSize(600,800);await drag('Conversation','left');assert.equal(await run('document.querySelectorAll(".drag-target").length'),0);
  await run('document.querySelector("[role=tab][id$=Conversation]").dispatchEvent(new KeyboardEvent("keydown",{key:"F10",shiftKey:true,bubbles:true,cancelable:true}))');await wait('!!document.querySelector(".editor-menu")');await run('document.querySelector(".editor-menu button").click()');await wait('window.groups.side("Conversation")==="right"');
  await run('document.querySelector("[role=tab][id$=Conversation]").dispatchEvent(new KeyboardEvent("keydown",{key:"Home",bubbles:true,cancelable:true}))');
  await run('window.transfer=new DataTransfer();document.querySelector("[role=tab][id$=Conversation]").dispatchEvent(new DragEvent("dragstart",{bubbles:true,dataTransfer:window.transfer}));window.dispatchEvent(new KeyboardEvent("keydown",{key:"Escape",bubbles:true}))');assert.equal(await run('document.querySelectorAll(".drag-target").length'),0);
  console.log('DOM_DRAG_PASS');win.destroy();app.quit()})().catch(e=>{console.error(e);app.exit(1)});`
  const main = resolve(dir,'main.cjs');await writeFile(main, script)
  const child = spawn(require('electron'), [main], { cwd: dir, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, stdio: ['ignore','pipe','pipe'] })
  let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d)
  t.after(() => { if (child.exitCode === null) child.kill() })
  const [code] = await once(child,'exit');assert.equal(code,0,output);assert.match(output,/DOM_DRAG_PASS/)
})
