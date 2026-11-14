import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'


const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
test('Connection receivers render selectable parent blocks and read-only content navigation', { timeout: 90_000 }, async t => {
  const directory = resolve(root, '.test-artifacts', `connection-sinks-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const server = await createServer({ configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'cache'), optimizeDeps: { noDiscovery: true, include: ['vue','vue-router','@vue-flow/core'] }, plugins: [vue(), UnoCSS({configFile:resolve(root,'app/unocss.config.ts')}), {
    name:'tint-fixture', resolveId:id=>id==='/tints.ts'?'\0tints':undefined,
    load(id) { if(id!=='\0tints')return; return `
      import 'uno.css';import '/src/styles.css';import {createApp,h} from 'vue';import {createRouter,createMemoryHistory} from 'vue-router';import Graph from '/src/components/WorkflowGraph.vue';import {connectionSinkCanvas} from '/src/connection-sinks.ts';
      const address={projectId:'fixture',botInstanceId:'conn',platform:'discord',conversationId:'parent'};
      const sink={kind:'connection-sink',id:'connection:conn',projectId:'fixture',connectionId:'conn',connectionPath:'v:connections/conn/overview.json',sinkPath:'v:connections/conn/sink.json',sink:{kind:'common-receipt',reacts:false,navigation:{kind:'connection-content',projectId:'fixture',connectionId:'conn'}},receivers:[{id:'parent',name:'Forum parent',address,path:'v:connections/conn/receivers/parent.json',navigation:{kind:'channel-content',address,guildId:'guild',channelType:15,view:'threads'}}],bots:[],guidePath:'v:bots/authoring'};
      window.inspections=[];
      const router=createRouter({history:createMemoryHistory(),routes:[{path:'/chat/:sessionId',name:'chat',component:{render:()=>null}},{path:'/projects/:projectId/settings/:section',name:'project-settings',component:{render:()=>null}}]});const app=createApp({render:()=>h(Graph,{style:{flex:'1',width:'100%'},projectId:'fixture',flows:[connectionSinkCanvas(sink,'fixture','Transport')],onInspect:(...args)=>window.inspections.push(args)})});app.use(router);app.mount('#app');`
    },configureServer(server){server.middlewares.use((req,res,next)=>{if(!req.url?.startsWith('/__tints'))return next();res.setHeader('Content-Type','text/html');res.end('<html><body style="margin:0"><div id="app" style="display:flex;width:100%;height:100vh"></div><script type="module" src="/tints.ts"></script></body></html>')})}
  }],server:{host:'127.0.0.1',port:0,watch:null,hmr:false}})
  await server.listen();t.after(()=>server.close())
  const main=resolve(directory,'main.cjs')
  await writeFile(main,`const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');app.setPath('userData',${JSON.stringify(directory)});app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1600,height:1000,webPreferences:{contextIsolation:true,nodeIntegration:false}});const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');const wait=()=>new Promise(r=>setTimeout(r,300));try{
    await win.loadURL(${JSON.stringify(new URL('__tints',server.resolvedUrls!.local[0]).href)});
    for(let i=0;i<100;i++){if(await run(()=>document.querySelectorAll('.graph-node').length===2))break;await wait()}
    assert.equal(await run(()=>document.querySelectorAll('.graph-node').length),2);
    assert.equal(await run(()=>document.querySelectorAll('.graph-node[data-node-type=sink]').length),1);
    assert.equal(await run(()=>document.querySelector('.graph-node[data-node-type=sink] strong').textContent),'Message receiver');
    assert.equal(await run(()=>document.querySelectorAll('.graph-node[data-node-type=deployment],.graph-node[data-node-type=session],.group-toggle').length),0);
    await run(()=>document.querySelector('.graph-node[data-node-type=sink]').click());
    assert.deepEqual(await run(()=>window.inspections.at(-1)),['connection:conn','receiver:parent']);
    await run(()=>document.querySelector('.group-conversation').click());
    assert.deepEqual(await run(()=>window.inspections.at(-1)),['connection:conn',undefined]);
    assert.equal(await run(()=>document.querySelector('.group-conversation').textContent.trim()),'Open connection content');
    assert.ok(await run(()=>document.querySelector('.graph-node[data-node-type=sink]').textContent.includes('Forum parent')));
    console.log('WORKFLOW_RENDERED_OK');app.exit(0);
  }catch(error){console.error(error);app.exit(1)}});`)
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['SystemRoot','WINDIR','PATH','Path','ComSpec','PATHEXT','DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR']) if (process.env[key] !== undefined) env[key] = process.env[key]
  for (const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TMP','TEMP','TMPDIR','XDG_CONFIG_HOME','XDG_CACHE_HOME']) env[key] = directory
  const child = spawn(desktopRequire('electron') as string, [main], { cwd: directory, env, windowsHide: true, stdio: ['ignore','pipe','pipe'] }); let output = ''
  child.stdout.setEncoding('utf8').on('data', chunk => output += chunk); child.stderr.setEncoding('utf8').on('data', chunk => output += chunk)
  const timer = setTimeout(() => child.kill(), 75_000); t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close'); assert.equal(code, 0, output); assert.match(output, /WORKFLOW_RENDERED_OK/)
})
