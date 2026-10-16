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

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
test('actual folder sidebar hover maps inactive historical system controllers to authorized feature preferences', { timeout: 90_000 }, async t => {
  const directory = resolve(root, '.test-artifacts', `automation-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    optimizeDeps: { noDiscovery: true, include: ['vue'] },
    plugins: [vue(), {
      name: 'automation-fixture',
      resolveId: id => id === '/automation-entry.ts' ? '\0automation-entry' : undefined,
      load(id) {
        if (id !== '\0automation-entry') return
        return `import {createApp,h} from 'vue';
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
          const app=createApp({render:()=>h(FoldersSidebar,{apiBase:location.origin+'/projects/fixture/',projectId:'fixture',sessions:[],activeSessionId:'',collapsed:new Set(),stages:{},sessionsLoading:false,sessionsError:'',resizeActive:true})});
          window.app=app;app.mount('#app');`
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
      const win=new BrowserWindow({show:false,width:600,height:800,webPreferences:{contextIsolation:true,nodeIntegration:false}});
      const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');
      const wait=()=>new Promise(r=>setTimeout(r,250));
      await win.loadURL(${JSON.stringify(new URL('__automation', server.resolvedUrls!.local[0]).href)});
      for(let i=0;i<100;i++){if(await run(()=>document.querySelectorAll('[data-automation-id]').length===2))break;await wait()}
      assert.equal(await run(()=>document.querySelectorAll('[data-automation-id]').length),2);
      for(const id of ['system:work-organizer','historical-organizer']){
        const before=id==='historical-organizer'?'Enable':'Disable';const after=before==='Disable'?'Enable':'Disable';
        await win.webContents.executeJavaScript("document.querySelector("+JSON.stringify('[data-automation-id="'+id+'"]')+").parentElement.dispatchEvent(new PointerEvent('pointerenter',{pointerType:'mouse'}))");await wait();
        await wait();
        assert.equal(await run(()=>document.querySelector('.shared-hover-info')?.getAttribute('role')),'dialog');
        assert.equal(await run(()=>document.querySelector('.shared-hover-info .automation-action')?.textContent.trim()),before);
        assert.equal(await run(()=>document.querySelector('.automation-history')?.textContent.trim()),'Inactive');
        await run(()=>document.querySelector('.shared-hover-info .automation-action').click());await wait();
        assert.equal(await run(()=>document.querySelector('.shared-hover-info .automation-action')?.textContent.trim()),after);
        await run(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})));await wait();
        await win.webContents.executeJavaScript("document.querySelector("+JSON.stringify('[data-automation-id="'+id+'"]')+").parentElement.dispatchEvent(new PointerEvent('pointerenter',{pointerType:'mouse'}))");await wait();
        assert.equal(await run(()=>document.querySelector('.shared-hover-info .automation-action')?.textContent.trim()),after);
        await run(()=>document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape'})));await wait();
      }
      assert.deepEqual(await run(()=>window.patches),['system:work-organizer','system:work-organizer'].map((id,i)=>({path:'/projects/fixture/api/automations/'+encodeURIComponent(id),body:{enabled:i===1}})));
      await win.loadURL(${JSON.stringify(new URL('__automation?denied', server.resolvedUrls!.local[0]).href)});
      for(let i=0;i<100;i++){if(await run(()=>document.querySelectorAll('[data-automation-id]').length===2))break;await wait()}
      await run(()=>document.querySelector('[data-automation-id]').parentElement.dispatchEvent(new PointerEvent('pointerenter',{pointerType:'mouse'})));await wait();
      assert.equal(await run(()=>document.querySelectorAll('.shared-hover-info .automation-action').length),0);
      assert.equal(await run(()=>document.querySelector('.shared-hover-info')?.getAttribute('role')),'tooltip');
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
