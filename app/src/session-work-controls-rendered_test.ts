import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer, normalizePath } from 'vite'
import vue from '@vitejs/plugin-vue'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))

test('subagent popup has separate consistent gutters, square rows, focus and inspect behavior', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `subagent-popup-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    optimizeDeps: { noDiscovery: true, include: ['vue'] },
    plugins: [vue(), {
      name: 'subagent-popup-fixture',
      resolveId: id => id === '/popup-entry.ts' ? '\0popup-entry' : id === '/popup-fixture.vue' ? normalizePath(resolve(directory, 'fixture.vue')) : undefined,
      load(id) {
        if (id === '\0popup-entry') return `import '/src/styles.css'; import {createApp} from 'vue'; import Fixture from '/popup-fixture.vue'; createApp(Fixture).mount('#app');`
        if (id !== normalizePath(resolve(directory, 'fixture.vue'))) return
        return `<script setup>
          import SessionWorkControls from '/src/components/SessionWorkControls.vue';
          import SessionActivity from '/src/components/SessionActivity.vue';
          Object.defineProperty(document, 'hidden', {get:()=>false});
          const apiBase = window.location.origin + '/projects/fixture';
          const originalFetch = window.fetch;
          window.fetch = (url, options) => {
            if (String(url).includes('/scheduled-tasks')) return Promise.resolve(new Response(JSON.stringify({ sessionId:'web:inactive', tasks:[{id:'daily',name:'Daily reminder',task:'Check reports',schedule:'0 9 * * *',enabled:true,nextRun:'2027-01-02T09:00:00Z'}] }), {headers:{'Content-Type':'application/json'}}));
            if (String(url).includes('/background-tasks')) return Promise.resolve(new Response(JSON.stringify({sessionId:'web:inactive',total:0,tasks:[]}), {headers:{'Content-Type':'application/json'}}));
            return originalFetch(url, options);
          };
          window.__inspected = null;
          const inspect = id => { window.__inspected = id };
        </script><template><main style="position:fixed;left:24px;bottom:24px">
          <SessionWorkControls :api-base="apiBase" session-id="web:inactive" can-write :active="true"
            :subagents="[{sessionId:'worker',label:'测试 worker',mode:'task',executionStatus:'running'}]"
            @inspect="inspect" />
          <div id="activity-fixture">
            <SessionActivity stage="running" compact icon-only />
            <SessionActivity stage="running" status-icons />
            <SessionActivity stage="running" />
            <SessionActivity stage="tool" compact icon-only />
            <SessionActivity stage="tool" />
          </div>
        </main></template>`
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== '/__popup') return next()
          response.setHeader('Content-Type', 'text/html')
          response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/popup-entry.ts"></script></body></html>')
        })
      },
    }], server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  })
  await server.listen()
  t.after(() => server.close())
  const main = resolve(directory, 'main.cjs')
  await writeFile(main, `
    const {app,BrowserWindow}=require('electron');
    const assert=require('node:assert/strict');
    app.setPath('userData',${JSON.stringify(directory)});
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:900,height:700,webPreferences:{contextIsolation:true,nodeIntegration:false}});
      await win.loadURL(${JSON.stringify(new URL('__popup', server.resolvedUrls!.local[0]).href)});
      const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');
      for(let i=0;i<100;i++){if(await run(()=>!!document.querySelector('[data-session-work="subagents"]')))break;await new Promise(r=>setTimeout(r,50));}
      for(let i=0;i<100;i++){if(await run(()=>!!document.querySelector('[data-session-work="scheduled"]')))break;await new Promise(r=>setTimeout(r,50));}
      assert.equal(await run(()=>!!document.querySelector('[data-session-work="scheduled"]')),true);
      await run(()=>document.querySelector('[data-session-work="scheduled"]').click());
      await new Promise(r=>setTimeout(r,250));
      const schedule=await run(()=>({text:document.querySelector('.scheduled-tasks').textContent,time:document.querySelector('.scheduled-tasks time')?.dateTime}));
      assert.match(schedule.text,/Daily reminder/);assert.match(schedule.text,/0 9/);
      assert.equal(schedule.time,'2027-01-02T09:00:00Z');
      await run(()=>document.querySelector('.session-work-panel').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));
      await new Promise(r=>setTimeout(r,250));
      assert.equal(await run(()=>document.activeElement.matches('[data-session-work="scheduled"]')),true);
      const activities=await run(()=>[...document.querySelectorAll('#activity-fixture .session-activity')].map(item=>({
        wave:!!item.querySelector('.working-wave'),
        dot:getComputedStyle(item.querySelector('.activity-symbol'),'::after').content,
        bars:item.querySelectorAll('.working-wave i').length,
      })));
      assert.equal(activities.length,5);
      for(const item of activities.slice(0,3)){
        assert.equal(item.wave,true);assert.equal(item.bars,3);assert.equal(item.dot,'none');
      }
      assert.equal(activities[3].dot,'none');
      assert.equal(activities[4].dot,'""');
      for(const width of [900,390]){
        win.setSize(width,700);
        await run(()=>document.querySelector('[data-session-work="subagents"]').click());
        await new Promise(r=>setTimeout(r,250));
        const geometry=await run(()=>{
          const popup=document.querySelector('.subagent-panel'),row=popup.querySelector('.subagent-inspect');
          const p=getComputedStyle(popup),r=getComputedStyle(row);
          const a=popup.getBoundingClientRect(),b=row.getBoundingClientRect(),c=row.querySelector('.work-icon').getBoundingClientRect();
          row.focus();
          return {padding:p.paddingLeft,border:parseFloat(p.borderLeftWidth),rowPadding:r.paddingLeft,radius:r.borderRadius,gutter:b.left-a.left,inset:c.left-b.left,
            focused:document.activeElement===row,label:row.getAttribute('aria-label'),panelLabel:popup.getAttribute('aria-labelledby')};
        });
        assert.equal(geometry.padding,'6px');assert.equal(geometry.rowPadding,'12px');assert.equal(geometry.radius,'0px');
        assert.ok(Math.abs(geometry.gutter-(6+geometry.border))<0.1);assert.ok(Math.abs(geometry.inset-12)<0.1);assert.equal(geometry.focused,true);
        assert.ok(geometry.label.includes('测试 worker'));assert.ok(geometry.panelLabel);
        await run(()=>document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true})));
        await new Promise(r=>setTimeout(r,250));
        assert.equal(await run(()=>document.activeElement.matches('[data-session-work="subagents"]')),true);
      }
      await run(()=>document.querySelector('[data-session-work="subagents"]').click());
      await new Promise(r=>setTimeout(r,250));
      await run(()=>document.querySelector('.subagent-inspect').click());
      await new Promise(r=>setTimeout(r,250));
      assert.equal(await run(()=>window.__inspected),'worker');
      assert.equal(await run(()=>document.querySelector('[data-session-work="subagents"]').getAttribute('aria-expanded')),'false');
      console.log('SUBAGENT_POPUP_OK');app.exit(0);
    }).catch(error=>{console.error(error);app.exit(1)});
  `)
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) if (process.env[key] !== undefined) env[key] = process.env[key]
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = directory
  const child = spawn(desktopRequire('electron') as string, [main], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })
  const timer = setTimeout(() => child.kill(), 75_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, output)
  assert.match(output, /SUBAGENT_POPUP_OK/)
})
