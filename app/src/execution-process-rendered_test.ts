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
test('execution process renders ordered reasoning, preserves manual choices and exposes failures', {
  timeout: 60_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `execution-process-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    optimizeDeps: { noDiscovery: true },
    plugins: [vue(), {
      name: 'execution-process-fixture',
      resolveId(id, importer) {
        if (id === '/process-fixture.js') return '\0process-fixture'
        if (importer?.includes('ToolActivityGroup.vue') && (id === './ToolPayload.vue' || id === './ToolFileDiffPreview.vue')) return '\0payload-stub'
      },
      load(id) {
        if (id === '\0payload-stub') return `import {h} from 'vue'; export default {props:['source'],render(){return h('pre',this.source)}}`
        if (id !== '\0process-fixture') return
        return `import {createApp, reactive, h} from 'vue';
          import ToolActivityGroup from '/src/components/ToolActivityGroup.vue';
          import {groupToolActivity} from '/src/tool-activity.ts';
          import {i18n} from '/src/i18n.ts';
          const messages = [
            {role:'assistant',content:'',reasoningText:'思考中'},
            {role:'assistant',event:'tool_call',content:'',toolCallId:'read',toolCall:{name:'read',arguments:{path:'a.ts'}}},
            {event:'tool_result',content:'File contents',toolCallId:'read'},
            {role:'assistant',content:'',reasoningText:'Second reasoning',usage:{promptTokens:20,completionTokens:3,totalTokens:23}},
            {role:'assistant',content:'',usage:{promptTokens:10,completionTokens:2,totalTokens:12}}
          ];
          const matchMedia=window.matchMedia.bind(window);
          window.matchMedia=query=>query.includes('prefers-reduced-motion')?{matches:true,addEventListener(){},removeEventListener(){}}:matchMedia(query);
          const state=reactive({running:true,batch:groupToolActivity(messages).get(0)});
          window.__update = (running, failed=false) => {
            state.running=running;
            const next=messages.map(m=>({...m}));
            if(failed) next[2].content='Error: file missing';
            state.batch=groupToolActivity(next).get(0);
          };
          window.__empty = () => { state.batch={end:1,entries:[],files:0,incomplete:false,usages:[{index:0,usage:{promptTokens:5,completionTokens:1,totalTokens:6}}]} };
          createApp({setup:()=>()=>h(ToolActivityGroup,{batch:state.batch,running:state.running,defaultOpen:state.running,renderContent:text=>'<p>'+text+'</p>'})}).use(i18n).mount('#app');`
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== '/__process') return next()
          response.setHeader('Content-Type', 'text/html')
          response.end('<html><body><div id="app"></div><script type="module" src="/process-fixture.js"></script></body></html>')
        })
      },
    }], server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  t.after(() => server.close())
  const url = `${server.resolvedUrls!.local[0]}__process`
  await writeFile(resolve(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',require('node:path').join(process.cwd(),'profile'));
    app.on('window-all-closed',()=>{});
    app.whenReady().then(async()=>{
      const window=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,backgroundThrottling:false}});
      try {
        window.webContents.on('console-message',details=>{if(details.level==='error')console.error(details.message)});
        await window.loadURL(${JSON.stringify(url)});
        const result=await window.webContents.executeJavaScript(\`(async()=>{
          const wait=()=>new Promise(resolve=>setTimeout(resolve,300));
          const check=(condition,message)=>{if(!condition)throw Error(message)};
          for(let i=0;i<40 && !document.querySelector('.tool-activity');i++) await wait();
          const group=()=>document.querySelector('.tool-activity');
          const entries=()=>[...document.querySelectorAll('.tool-entry')];
          check(group().open,'running opens group');
          check(entries().map(e=>e.dataset.msgIdx).join(',')==='0,1,3','original indices/order');
          check(entries().every(e=>!e.open),'running opens outer process only');
          entries()[0].querySelector('summary').click();await wait();
          check(document.querySelector('.thinking-content').textContent==='思考中','real reasoning retained');
          check(document.querySelectorAll('.tool-entry').length===3,'usage-only does not add empty reasoning row');
          check(document.querySelector('[data-msg-idx="4"]').textContent.includes('12'),'usage-only stats retained at original index');
          window.__update(false);await wait();check(!group().open,'completion collapses by default');
          window.__update(true);await wait();check(group().open,'new running default opens');
          group().querySelector('summary').click();await wait();check(!group().open,'manual close');
          window.__update(true);await wait();check(!group().open,'updates retain manual close');
          window.__update(false);await wait();check(!group().open,'completion retains manual close');
          group().querySelector('summary').click();await wait();check(group().open,'manual open');
          window.__update(true);await wait();window.__update(false);await wait();check(group().open,'manual open survives completion');
          entries()[2].querySelector('summary').click();await wait();
          check(document.querySelector('.activity-usage').textContent.includes('23'),'round usage in node details');
          entries()[1].querySelector('summary').click();await wait();
          check(document.querySelector('.tool-arguments').textContent.includes('a.ts'),'arguments expandable');
          check(document.querySelector('.tool-result').textContent.includes('File contents'),'result expandable');
          group().querySelector('summary').click();await wait();
          window.__update(false,true);await wait();check(group().open,'failure overrides manual close');
          check(group().textContent.includes('Failed'),'failure visible');
          check(entries()[1].open,'new failure opens its entry');
          entries()[1].querySelector('summary').click();await wait();check(!entries()[1].open,'failed entry can be collapsed');
          window.__update(false,true);await wait();check(!entries()[1].open,'updates retain failed entry collapse');
          group().querySelector('summary').click();await wait();check(!group().open,'failed group can be collapsed');
          window.__update(true,true);await wait();check(!group().open,'running updates retain failed group collapse');
          window.__update(false,true);await wait();check(!group().open,'completion retains failed group collapse');
          group().querySelector('summary').click();await wait();check(group().open,'failed group can be reopened');
          entries()[1].querySelector('summary').click();await wait();check(entries()[1].open,'failed entry can be reopened');
          window.__empty();await wait();check(!document.querySelector('.tool-activity'),'pure usage has no visible group, even with direct batch prop');
          return 'EXECUTION_PROCESS_RENDER_OK';
        })()\`);
        console.log(result);app.exit(0);
      }catch(error){console.error(error);app.exit(1)}
    });`)
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR']) env[key] = directory
  const child = spawn(desktopRequire('electron') as string, [resolve(directory, 'main.cjs')], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })
  const timer = setTimeout(() => child.kill(), 45_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, output)
  assert.match(output, /EXECUTION_PROCESS_RENDER_OK/)
})
