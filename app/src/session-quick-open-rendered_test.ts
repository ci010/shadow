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
test('quick open lazily searches full automation history independently of navigation, failures and cancellation', { timeout: 90_000 }, async t => {
  const directory = resolve(root, '.test-artifacts', `quick-open-${randomUUID()}`)
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
        return `import {createApp,h,ref} from 'vue';
          import SessionQuickOpen from '/src/components/SessionQuickOpen.vue';
          import {createProjectLiveState} from '/src/project-live-state.ts';
          window.paths=[];window.selected=[];window.pending=false;
          const automation={jobId:'job',name:'Scheduled review',runId:'old',contextMode:'fresh',startedAt:'2026-01-01T00:00:00Z'};
          const request=async(input,init={})=>{
            const url=new URL(String(input),location.href); window.paths.push(url.pathname+url.search);
            if(url.pathname.endsWith('/api/folders'))return Response.json({folders:[]});
            if(url.pathname.endsWith('/stages'))return Response.json({activity:{}});
            if(url.pathname.includes('/projects/b/'))return Response.json({}, {status:503});
            if(window.pending && !url.search){window.pendingSignal=init.signal;return new Promise(resolve=>window.finish=()=>resolve(Response.json({sessions:[{sessionId:'old',title:'Hidden historical match',automation}]})))}
            return Response.json({sessions:[{sessionId:'ordinary',title:'Ordinary chat'},...(!url.search?[{sessionId:'old',mode:'task',title:'Hidden historical match',automation}]:[])]});
          };
          window.fetch=request;
          const state=createProjectLiveState({client:()=>({subscribe(topic,observer){queueMicrotask(()=>observer.reset('subscription'));return {ready:()=>Promise.resolve(),close(){}}}})}, {request,delayMs:0});
          const nav=state.acquireProject(location.origin,'a');window.nav=nav;nav.read();
          const open=ref(false);window.open=()=>open.value=true;
          const app=createApp({render:()=>open.value?h(SessionQuickOpen,{apiBase:location.origin,projects:[{id:'a',name:'Alpha'},{id:'b',name:'Beta'}],onClose:()=>open.value=false,onSelect:(...args)=>window.selected.push(args)}):h('button',{onClick:()=>open.value=true},'Open')});
          app.provide(Symbol.for('shadow.project-live-state'),state);app.onUnmount(()=>state.dispose());app.mount('#app');`

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
      for(let i=0;i<100;i++){if(await run(()=>window.nav?.sessions.state.value))break;await wait()}
      assert.deepEqual(await run(()=>window.nav.sessions.state.value.map(row=>row.sessionId)),['ordinary']);
      assert.equal(await run(()=>window.paths.some(path=>path.endsWith('/summary'))),false,'startup only requests navigation');
      await run(()=>window.open());
      for(let i=0;i<100;i++){if(await run(()=>document.querySelector('.failure') && document.querySelectorAll('[role="option"]').length))break;await wait()}
      assert.equal(await run(()=>document.querySelectorAll('[role="option"]').length),1,'empty search preserves ordinary defaults');
      assert.ok(await run(()=>window.paths.includes('/projects/a/api/sessions/summary')));
      assert.ok(await run(()=>document.querySelector('.failure').textContent.includes('Beta')),'one failed project does not hide Alpha');
      await run(()=>{const input=document.querySelector('input[type="search"]');input.value='historical';input.dispatchEvent(new Event('input',{bubbles:true}))});await wait();
      assert.equal(await run(()=>document.querySelectorAll('[role="option"]').length),1);
      assert.ok(await run(()=>document.querySelector('[role="option"]').textContent.includes('Automation')));
      assert.ok(await run(()=>document.querySelector('[role="option"]').textContent.includes('Hidden historical match')));
      await run(()=>document.querySelector('[role="option"]').click());await wait();
      assert.deepEqual(await run(()=>window.selected),[['a','old','job']]);
      assert.equal(await run(()=>!!document.querySelector('dialog')),false);
      await run(()=>{window.pending=true;window.open()});
      for(let i=0;i<100;i++){if(await run(()=>!!window.pendingSignal))break;await wait()}
      await run(()=>document.querySelector('dialog').dispatchEvent(new Event('cancel',{cancelable:true})));await wait();
      assert.equal(await run(()=>window.pendingSignal.aborted),true,'closing cancels full-summary request');
      await run(()=>window.finish());await wait();
      assert.deepEqual(await run(()=>window.nav.sessions.state.value.map(row=>row.sessionId)),['ordinary'],'late full response cannot poison navigation');
      console.log('QUICK_OPEN_HISTORY_OK');app.exit(0);
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
  assert.match(output,/QUICK_OPEN_HISTORY_OK/)
})
