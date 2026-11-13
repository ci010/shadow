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
test('actual folder sidebar keeps one icon-bearing Workflow route and ordinary chats', { timeout: 90_000 }, async t => {
  const directory = resolve(root, '.test-artifacts', `automation-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    optimizeDeps: { noDiscovery: true, include: ['vue', 'vue-router'] },
    plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app', 'unocss.config.ts') }), {
      name: 'automation-fixture',
      resolveId: id => id === '/automation-entry.ts' ? '\0automation-entry' : undefined,
      load(id) {
        if (id !== '\0automation-entry') return
        return `import 'uno.css';import '/src/styles.css';import {createApp,h} from 'vue'; import {createRouter,createMemoryHistory} from 'vue-router';
          import FoldersSidebar from '/src/components/FoldersSidebar.vue';
          window.patches=[];window.allowed=!location.search.includes('denied');
          const jobs=['work-organizer'].map(kind=>({id:'system:'+kind,name:'话题整理',source:'system',session:'fresh',schedule:'Event-driven / manual',enabled:false,configuredEnabled:true,editable:false,canToggle:true,toggleId:'system:'+kind,toggleEnabled:true}));
          jobs.push({...jobs[0],id:'historical-organizer',enabled:false,configuredEnabled:false});
          window.fetch=async(input,init={})=>{
            const url=new URL(String(input),location.href);
            if(url.pathname.endsWith('/api/automations'))return Response.json({automations:jobs.map(j=>({...j,canToggle:window.allowed}))});
            if(init.method==='PATCH'){
              window.patches.push({path:url.pathname,body:JSON.parse(init.body)});
              if(!window.allowed)return Response.json({}, {status:403});
              const job=jobs.find(j=>url.pathname.endsWith(encodeURIComponent(j.id)));for(const related of jobs.filter(j=>j.toggleId===job.id)){related.toggleEnabled=JSON.parse(init.body).enabled;}
              return Response.json({automation:job});
            }
            if(url.pathname.endsWith('/api/folders'))return Response.json({folders:[]});
            return Response.json({});
          };
          const app=createApp({render:()=>h(FoldersSidebar,{apiBase:location.origin+'/projects/fixture/',projectId:'fixture',sessions:[{sessionId:'web:ordinary',label:'Ordinary conversation',title:'Ordinary conversation',isDirectChat:true,isCurrent:true,parentSessionId:null,depth:0,mode:'session'}],activeSessionId:'',collapsed:new Set(),stages:{},sessionsLoading:false,sessionsError:'',resizeActive:true})});
          const router=createRouter({history:createMemoryHistory(),routes:[{path:'/projects/:projectId/workflows',name:'project-workflows',component:{render:()=>null}},{path:'/projects/:projectId/chat/:sessionId?',name:'chat',component:{render:()=>null}}]});await router.push('/projects/fixture/chat/web:ordinary');window.router=router;app.use(router);window.app=app;app.mount('#app');`
      },
      configureServer(server) { server.middlewares.use((req,res,next) => {
        if (!req.url?.startsWith('/__automation')) return next()
        res.setHeader('Content-Type','text/html')
        res.end('<html><body><div id="app" style="width:300px;height:700px"></div><script type="module" src="/automation-entry.ts"></script></body></html>')
      }) },
    }], server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  })
  await server.listen()
  t.after(() => server.close())
  const main = resolve(directory, 'main.cjs')
  await writeFile(main, `
    const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');
    app.setPath('userData',${JSON.stringify(directory)});
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:900,height:800,webPreferences:{contextIsolation:true,nodeIntegration:false}});
      const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');
      const wait=()=>new Promise(r=>setTimeout(r,250));
      await win.loadURL(${JSON.stringify(new URL('__automation', server.resolvedUrls!.local[0]).href)});
      for(let i=0;i<100;i++){if(await run(()=>!!document.querySelector('.automations-sidebar a')))break;await wait()}
      assert.equal(await run(()=>document.querySelectorAll('.automations-sidebar a').length),1);
      assert.equal(await run(()=>document.querySelectorAll('[data-automation-id],.automations-heading').length),0);
      assert.equal(await run(()=>document.querySelector('.automations-sidebar a').textContent.trim()),'Workflows');
      assert.ok(await run(()=>{const icon=document.querySelector('.automations-sidebar .i-lucide-workflow');return icon&&getComputedStyle(icon).maskImage!=='none'&&icon.getBoundingClientRect().width===16}));
      assert.ok(await run(()=>document.body.textContent.includes('Ordinary conversation')));
      assert.ok(await run(()=>{
        const entry=document.querySelector('.automations-sidebar a');
        const icon=entry.querySelector('.automation-icon').getBoundingClientRect();
        const peer=document.querySelector('.chat-new-row .tree-icon').getBoundingClientRect();
        const row=entry.getBoundingClientRect();
        return Math.abs(icon.left-peer.left)<1 && row.height===40 && Math.abs(icon.top+icon.height/2-row.top-row.height/2)<1;
      }), 'Workflow icon shares the tree icon column and is vertically centered in its taller row');
      await run(()=>document.querySelector('[aria-label="Collapse folders"]').click());await wait();
      assert.ok(await run(()=>{
        const entry=document.querySelector('.automations-sidebar a');
        const row=entry.getBoundingClientRect(), icon=entry.querySelector('.automation-icon').getBoundingClientRect();
        return entry.classList.contains('is-rail') && row.width===44 && row.height===44
          && Math.abs(icon.left+icon.width/2-row.left-row.width/2)<1 && Math.abs(icon.top+icon.height/2-row.top-row.height/2)<1;
      }), 'Collapsed rail remains a centered 44px target');
      await run(()=>document.querySelector('.automations-sidebar a').click());await wait();
      assert.equal(await run(()=>window.router.currentRoute.value.name),'project-workflows');
      assert.deepEqual(await run(()=>window.patches),[]);
      await win.loadURL(${JSON.stringify(new URL('__automation?denied', server.resolvedUrls!.local[0]).href)});
      for(let i=0;i<100;i++){if(await run(()=>!!document.querySelector('.automations-sidebar a')))break;await wait()}
      assert.equal(await run(()=>document.querySelectorAll('.automations-sidebar a').length),1);
      assert.ok(await run(()=>{const icon=document.querySelector('.automations-sidebar .i-lucide-workflow');return icon&&getComputedStyle(icon).maskImage!=='none'&&icon.getBoundingClientRect().width===16}));
      assert.equal(await run(()=>document.querySelectorAll('[data-automation-id]').length),0);
      console.log('AUTOMATION_REAL_HOVER_OK');app.exit(0);
    }).catch(error=>{console.error(error);app.exit(1)});
  `)
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['SystemRoot','WINDIR','PATH','Path','ComSpec','PATHEXT','DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR']) if (process.env[key] !== undefined) env[key] = process.env[key]
  for (const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TMP','TEMP','TMPDIR','XDG_CONFIG_HOME','XDG_CACHE_HOME']) env[key] = directory
  const child = spawn(desktopRequire('electron') as string, [main], { cwd: directory, env, windowsHide: true, stdio: ['ignore','pipe','pipe'] })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })
  const timer = setTimeout(() => child.kill(), 75_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child,'close')
  assert.equal(code,0,output)
  assert.match(output,/AUTOMATION_REAL_HOVER_OK/)
})
