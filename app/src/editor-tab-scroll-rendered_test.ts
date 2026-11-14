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
test('rendered tab strips reserve a thin rail and consume wheel without layout shifts', { timeout: 60000 }, async t => {
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
  const script = `const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const {setTimeout:delay}=require('node:timers/promises');app.setPath('userData',process.cwd()+'/profile');(async()=>{await app.whenReady();const win=new BrowserWindow({show:false,width:1200,height:800,webPreferences:{backgroundThrottling:false}});const run=s=>win.webContents.executeJavaScript(s);await win.loadURL(${JSON.stringify(server.resolvedUrls!.local[0])});for(let i=0;i<200;i++){if(await run('!!document.querySelector(".editor-tab")'))break;await delay(50)}
  const height=()=>run('document.querySelector(".editor-workspace-header").getBoundingClientRect().height');const before=await height();
  await run('for(let i=0;i<20;i++)window.groups.open({id:"extra"+i,projectId:"a",owner:"fixture",label:"Document "+i+" 很长的会话标题".repeat(30),icon:"",closable:true,select(){},close(){}},"right")');await delay(100);
  assert.equal(await height(),before);assert.equal(before,40);
  assert.equal(await run('Array.from(document.querySelectorAll(".editor-tab")).every(el=>el.getBoundingClientRect().width<=240)'),true);
  assert.equal(await run('(()=>{const label=document.querySelectorAll(".editor-tab-label")[2];return label.scrollWidth>label.clientWidth&&getComputedStyle(label).textOverflow==="ellipsis"&&label.textContent===window.groups.descriptors.get("extra0").label})()'),true);
  await run('const tab=document.querySelectorAll("[role=tab]")[2];tab.focus();tab.parentElement.dispatchEvent(new PointerEvent("pointerenter"))');await delay(700);
  assert.deepEqual(await run('(()=>{const tab=document.querySelectorAll("[role=tab]")[2];return {hint:tab.hasAttribute("aria-describedby"),text:tab.textContent===window.groups.descriptors.get("extra0").label, popup:document.getElementById(tab.getAttribute("aria-describedby"))?.textContent===tab.textContent}})()'),{hint:true,text:true,popup:true});
  assert.equal(await run('getComputedStyle(document.querySelector(".editor-tabs"),"::-webkit-scrollbar").height'),'3px');
  const wheel=async(init)=>run('(()=>{const el=document.querySelector("[data-editor-header-group=right] .editor-tabs");const before=el.scrollLeft;const e=new WheelEvent("wheel",{bubbles:true,cancelable:true,...'+JSON.stringify(init)+'});el.dispatchEvent(e);return {before,after:el.scrollLeft,prevented:e.defaultPrevented}})()');
  let result=await wheel({deltaY:50});assert.equal(result.after-result.before,50);assert.equal(result.prevented,true);
  result=await wheel({deltaX:20,deltaY:80});assert.equal(result.after-result.before,20);
  result=await wheel({deltaY:50,ctrlKey:true});assert.equal(result.after,result.before);assert.equal(result.prevented,false);
  assert.equal(await run('(()=>{const el=document.querySelector("[data-editor-header-group=left] .editor-tabs");const e=new WheelEvent("wheel",{deltaY:40,cancelable:true,bubbles:true});el.dispatchEvent(e);return e.defaultPrevented})()'),false);
  await win.setSize(800,800);await delay(100);assert.equal(await height(),before);
  await run('document.querySelector("[data-editor-header-group=right] [role=tab]").dispatchEvent(new KeyboardEvent("keydown",{key:"End",bubbles:true,cancelable:true}))');await delay(100);
  assert.equal(await run('(()=>{const tab=document.activeElement;const item=tab.closest(".editor-tab").getBoundingClientRect();const strip=tab.closest(".editor-tabs").getBoundingClientRect();return item.right<=strip.right+1&&item.left>=strip.left-1&&window.scrollY===0})()'),true);
  console.log('DOM_DRAG_PASS');win.destroy();app.quit()})().catch(e=>{console.error(e);app.exit(1)});`
  const main = resolve(dir,'main.cjs');await writeFile(main, script)
  const child = spawn(require('electron'), [main], { cwd: dir, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, stdio: ['ignore','pipe','pipe'] })
  let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d)
  t.after(() => { if (child.exitCode === null) child.kill() })
  const [code] = await once(child,'exit');assert.equal(code,0,output);assert.match(output,/DOM_DRAG_PASS/)
})
