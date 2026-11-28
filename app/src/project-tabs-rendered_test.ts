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
test('cross-project headers keep Project order and mounted file state', { timeout: 60000 }, async t => {
  await mkdir(resolve('.test-artifacts'), { recursive: true })
  const dir = await mkdtemp(resolve('.test-artifacts/project-tabs-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const server = await createServer({ configFile: false, envDir: false, cacheDir: resolve(dir, 'vite-cache'), root: resolve('app'), logLevel: 'error', optimizeDeps: { noDiscovery: true, include: ['vue'] }, plugins: [vue(), {
    name: 'drag-fixture',
    resolveId: id => id === '/fixture.ts' ? '\0fixture' : undefined,
    load(id) { if (id === '\0fixture') return `import {createResourceApp as createApp} from '/src/stores/app.ts';import {h,provide,ref,computed} from 'vue';import Host from '/src/components/EditorGroupHost.vue';import View from '/src/components/EditorViewHost.vue';import {createEditorGroups,EditorGroupsKey} from '/src/editor-groups.ts';import {projectTopTabGroups} from '/src/project-top-tabs.ts';const groups=createEditorGroups();window.groups=groups;const active=ref('a');window.active=active;const projects=[{id:'a',name:'Alpha'},{id:'b',name:'Beta'}];const descriptors=[['chat-a','a'],['video-a','a'],['chat-b','b']].map(([id,projectId])=>({id,projectId,owner:projectId,label:id,icon:'',closable:true,select(){active.value=projectId},close(){groups.unregister(id)}}));createApp({setup(){provide(EditorGroupsKey,groups);const tabs=computed(()=>projectTopTabGroups(groups,projects,()=>true));return()=>h('div',{style:'height:100vh;display:flex'},[...projects.map(p=>h(Host,{projectId:p.id,projectName:p.name,active:active.value===p.id,style:active.value===p.id?'':'display:none',otherProjectTabs:tabs.value.filter(g=>g.id!==p.id),onActivateProjectTab:id=>groups.activate(id)})),...descriptors.filter(d=>groups.descriptors.has(d.id)||!window.ready).map(descriptor=>h(View,{key:descriptor.id,descriptor},()=>h('textarea',{'data-fixture':descriptor.id})))])}}).mount('#app');window.ready=true;` },
    configureServer(s) { s.middlewares.use((req,res,next) => { if (req.url !== '/') return next();res.setHeader('content-type','text/html');res.end('<div id="app"></div><script type="module" src="/fixture.ts"></script>') }) },
  }], server: { host: '127.0.0.1', port: 0 } })
  await server.listen();t.after(() => { server.httpServer?.closeAllConnections(); return server.close() })
  const script = `const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const {setTimeout:delay}=require('node:timers/promises');app.setPath('userData',process.cwd()+'/profile');(async()=>{await app.whenReady();const win=new BrowserWindow({show:false,width:1200,height:800});const run=s=>win.webContents.executeJavaScript(s);await win.loadURL(${JSON.stringify(server.resolvedUrls!.local[0])});for(let i=0;i<100;i++){if(await run('!!document.querySelector("textarea")'))break;await delay(50)}await run('window.input=document.querySelector("[data-fixture=video-a]");window.input.value="retained video state";window.groups.move("video-a","right")');for(const id of ['chat-a','chat-b','video-a','chat-b']){await run('(()=>{const h=[...document.querySelectorAll(".editor-workspace")].find(e=>e.style.display!=="none");const b=[...h.querySelectorAll(".project-editor-label")].find(e=>e.textContent==='+JSON.stringify(id)+');if(b)b.click();else window.groups.activate('+JSON.stringify(id)+')})()');await delay(30);assert.deepEqual(await run('(()=>{const h=[...document.querySelectorAll(".editor-workspace")].find(e=>e.style.display!=="none");return [...h.querySelectorAll(".editor-tab-label,.project-editor-label > span:last-child")].map(e=>e.textContent)})()'),['chat-a','video-a','chat-b']);assert.equal(await run('document.querySelector("[data-fixture=video-a]")===window.input'),true);assert.equal(await run('window.input.value'),'retained video state')}console.log('PROJECT_TABS_PASS');win.destroy();app.quit()})().catch(e=>{console.error(e);app.exit(1)});`
  const main = resolve(dir,'main.cjs');await writeFile(main, script)
  const child = spawn(require('electron'), [main], { cwd: dir, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, stdio: ['ignore','pipe','pipe'] })
  let output='';child.stdout.on('data',d=>output+=d);child.stderr.on('data',d=>output+=d)
  t.after(() => { if (child.exitCode === null) child.kill() })
  const [code] = await once(child,'exit');assert.equal(code,0,output);assert.match(output,/PROJECT_TABS_PASS/)
})
