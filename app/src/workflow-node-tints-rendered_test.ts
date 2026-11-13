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
test('node category tints render independently of state in both themes', { timeout: 90_000 }, async t => {
  const directory = resolve(root, '.test-artifacts', `node-tints-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const server = await createServer({ configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'cache'), optimizeDeps: { noDiscovery: true, include: ['vue','vue-router','@vue-flow/core'] }, plugins: [vue(), UnoCSS({configFile:resolve(root,'app/unocss.config.ts')}), {
    name:'tint-fixture', resolveId:id=>id==='/tints.ts'?'\0tints':undefined,
    load(id) { if(id!=='\0tints')return; return `
      import 'uno.css';import '/src/styles.css';import {createApp,h} from 'vue';import {createRouter,createMemoryHistory} from 'vue-router';import Graph from '/src/components/WorkflowGraph.vue';import {botCanvas} from '/src/bot-workflows.ts';
      const connection=(id,enabled=true)=>({id,displayName:id,platform:'telegram',purpose:'fixture',enabled,health:enabled?'connected':'disabled'});
      const bots={connections:[connection('Isolated platform connector'),connection('Bound connector')],deployments:[{id:'Isolated published agent',state:'quarantined'},{id:'Bound deployment',state:'valid',agent:'general'}],bindings:[{id:'binding',connectionId:'Bound connector',deploymentId:'Bound deployment',platform:'telegram',topic:'Complete binding chain',enabled:true,subscribed:true,listener:true,kind:'topic',sessionIds:['web:fixture']}],warnings:[],routing:'not-probed',processingSuccess:'unknown'};
      const definition={id:'fixture',name:'Workflow states',enabled:false,revision:1,source:{kind:'external',id:'fixture'},gate:{kind:'revision-dedupe',first:'emit'},nodes:[{kind:'host-action',handler:'fixture'}]};
      const run={id:'run',workflow:'fixture',definition,timestamp:'2026-11-12',status:'blocked',cursor:0,attempts:1,nextAt:0,started:true};
      const router=createRouter({history:createMemoryHistory(),routes:[{path:'/chat/:sessionId',name:'chat',component:{render:()=>null}},{path:'/projects/:projectId/settings/:section',name:'project-settings',component:{render:()=>null}}]});const app=createApp({render:()=>h(Graph,{style:{flex:'1',width:'100%'},projectId:'fixture',flows:[{definition,run},...botCanvas(bots)]})});app.use(router);app.mount('#app');`
    },configureServer(server){server.middlewares.use((req,res,next)=>{if(!req.url?.startsWith('/__tints'))return next();res.setHeader('Content-Type','text/html');res.end('<html><body style="margin:0"><div id="app" style="display:flex;width:100%;height:100vh"></div><script type="module" src="/tints.ts"></script></body></html>')})}
  }],server:{host:'127.0.0.1',port:0,watch:null,hmr:false}})
  await server.listen();t.after(()=>server.close())
  const main=resolve(directory,'main.cjs')
  await writeFile(main,`const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');app.setPath('userData',${JSON.stringify(directory)});app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1600,height:1000,webPreferences:{contextIsolation:true,nodeIntegration:false}});const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');const wait=()=>new Promise(r=>setTimeout(r,300));try{
    await win.loadURL(${JSON.stringify(new URL('__tints',server.resolvedUrls!.local[0]).href)});
    for(let i=0;i<100;i++){if(await run(()=>document.querySelectorAll('.graph-node').length===9))break;await wait()}
    assert.equal(await run(()=>document.querySelectorAll('.graph-node').length),9);
    for(const dark of [false,true]){
      await win.webContents.executeJavaScript('document.documentElement.classList.toggle("dark",'+dark+')');await wait();
      const colors=await run(()=>Object.fromEntries(Array.from(document.querySelectorAll('.graph-node')).map(el=>[el.dataset.nodeType,getComputedStyle(el).backgroundColor])));
      assert.deepEqual(Object.keys(colors).sort(),['action','binding','connection','deployment','gate','session','source']);assert.equal(new Set(Object.values(colors)).size,7);
      assert.ok(await run(()=>{const ctx=document.createElement('canvas').getContext('2d');const lum=color=>{ctx.fillStyle=color;ctx.fillRect(0,0,1,1);const c=Array.from(ctx.getImageData(0,0,1,1).data).slice(0,3).map(v=>{v/=255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4});return c[0]*.2126+c[1]*.7152+c[2]*.0722};return Array.from(document.querySelectorAll('.graph-node')).every(el=>{const bg=lum(getComputedStyle(el).backgroundColor);return [el.querySelector('strong'),el.querySelector('small')].every(text=>{const fg=lum(getComputedStyle(text).color);return (Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05)>=4.5})})}),'node text contrasts with category surfaces');
      assert.equal(await run(()=>getComputedStyle(document.querySelector('.graph-node[data-node-type=action]')).borderStyle),'dashed');
      assert.ok(await run(()=>{const el=document.querySelector('.graph-node span[data-state=blocked]');const probe=document.createElement('span');probe.style.color='var(--c-warn)';document.body.append(probe);const same=getComputedStyle(el).color===getComputedStyle(probe).color;probe.remove();return same && getComputedStyle(el).backgroundColor===getComputedStyle(document.querySelector('.graph-toolbar button')).backgroundColor}));
      assert.ok(await run(()=>Array.from(document.querySelectorAll('.graph-group[data-projection]')).every(el=>!el.querySelector('.i-lucide-circle-pause,.i-lucide-circle-check'))));
      await run(()=>document.querySelectorAll('.graph-toolbar button')[2].click());await wait();
      if(${JSON.stringify(process.env.SHADOW_TINT_SCREENSHOT || '')})require('node:fs').writeFileSync(${JSON.stringify(process.env.SHADOW_TINT_SCREENSHOT || '')}+(dark?'.dark.png':'.light.png'),(await win.webContents.capturePage()).toPNG());
    }
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
