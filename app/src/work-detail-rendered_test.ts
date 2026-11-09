import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))

test('Work detail hierarchy and read-only roles survive narrow localized layouts', {
  timeout: 90000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `work-detail-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    optimizeDeps: { noDiscovery: true, include: ['vue', 'vue-i18n', 'zod', 'dompurify'] },
    plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app/unocss.config.ts') }), {
      name: 'work-detail-fixture',
      resolveId: id => id === '/detail-entry.ts' ? '\0detail-entry' : undefined,
      load: id => id !== '\0detail-entry' ? undefined : `
        import '/src/styles.css'; import 'uno.css';
        import {createApp,h,reactive} from 'vue';
        import WorkAlignment from '/src/components/WorkAlignment.vue';
        import {i18n} from '/src/i18n.ts';
        const manager='virtual:manager-with-a-long-technical-session-id';
        const worker='web:worker-with-a-long-technical-session-id';
        const state=reactive({revision:1,canWrite:true});
        window.fixture=state; window.writes=[];
        window.setLocale=value=>{i18n.global.locale.value=value};
        const record={key:'topic:web:fixture',subject:{kind:'topic',sessionId:'web:fixture'},revision:1,sequence:1,
          definition:{objective:'Compare the release candidates using available measurements, preserving the original evidence and explaining uncertainty.',acceptance:['Report both candidates with source-backed evidence.','Explain the limitations of the comparison.'],boundaries:['Do not publish the report or modify production data.'],evidence:[]},
          origin:'human',changedBy:'human',changedAt:'2026-10-05T00:00:00Z',change:'goal',reason:'User outcome',paused:false,
          workflow:{title:'Compare release candidates',manager,assignee:worker,assignmentRevision:1,status:'blocked',blockedReason:'Waiting for the reviewer to confirm which measurements belong in the report. Work already completed remains available.',dependencies:[]},
          notes:{kind:'task',summary:'Input fixtures are available. The comparison includes measured token usage and excludes speculative scoring.',next:'Confirm the evidence needed for the release report',plan:['Read the usage report','Compare candidates'],artifacts:[]},
          authority:{manager,executor:worker,active:true},history:[]};
        window.record=record;
        window.fetch=async(url,options)=>{
          if(options?.method==='POST'){
            const body=JSON.parse(options.body);window.writes.push(body);
            throw new Error('Unexpected write from read-only detail');
          }
          return new Response(JSON.stringify({records:[record],effects:[]}));
        };
        createApp({render:()=>h('main',{style:'max-width:560px;margin:0 auto;padding:20px;box-sizing:border-box;background:var(--c-bg);'},[
          h(WorkAlignment,{apiBase:location.origin,sessionId:'',workKey:record.key,project:true,embedded:true,expanded:true,
            revision:state.revision,canWrite:state.canWrite,
            sessionCatalog:[{sessionId:manager,title:'Release coordinator'},{sessionId:worker,title:'Evaluation conversation'}]})
        ])}).mount('#app');`,
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== '/__detail') return next()
          response.setHeader('Content-Type', 'text/html')
          response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/detail-entry.ts"></script></body></html>')
        })
      },
    }], server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  })
  t.after(() => server.close())
  await server.listen()
  const main = resolve(directory, 'main.cjs')
  await writeFile(main, `
    const {app,BrowserWindow}=require('electron');
    const assert=require('node:assert/strict');
    const fs=require('node:fs/promises');
    app.setPath('userData',${JSON.stringify(directory)});
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:760,height:1100,webPreferences:{contextIsolation:true,nodeIntegration:false}});
      await win.loadURL(${JSON.stringify(new URL('__detail', server.resolvedUrls!.local[0]).href)});
      const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');
      const wait=async fn=>{for(let i=0;i<160;i++){if(await run(fn))return;await new Promise(r=>setTimeout(r,50));}throw new Error('Timed out: '+fn.toString());};
      await wait(()=>!!document.querySelector('.alignment-heading'));
      assert.equal(await run(()=>document.querySelector('h3').textContent),'Compare release candidates');
      assert.match(await run(()=>document.querySelector('.work-objective').textContent),/preserving the original evidence/);
      assert.equal(await run(()=>document.querySelector('.work-status').textContent.trim()),'blocked');
      assert.match(await run(()=>document.querySelector('.work-blocker').textContent),/Waiting for the reviewer/);
      assert.match(await run(()=>document.querySelector('.work-people').textContent),/Release coordinator/);
      assert.equal(await run(()=>document.querySelector('.technical-details').open),false);
      assert.equal(await run(()=>document.querySelectorAll('.work-criteria details').length),2);
      assert.equal(await run(()=>!!document.querySelector('textarea')),false);
      assert.equal(await run(()=>document.querySelectorAll('.work-people .person-row').length),2);
      assert.equal(await run(()=>document.querySelectorAll('.work-people [role=combobox], .session-link, .decision-owner').length),0);
      await run(()=>{document.querySelectorAll('.work-criteria details').forEach(el=>el.open=true);document.querySelector('.technical-details').open=true;});
      assert.equal(await run(()=>document.querySelector('.technical-details').innerText.includes('virtual:manager')),false);
      for(const width of [760,390]){
        win.setSize(width,1100);
        for(const locale of ['en','zh-CN']){
          await run(()=>document.documentElement.classList.toggle('dark'));
          await win.webContents.executeJavaScript('window.setLocale('+JSON.stringify(locale)+')');
          await new Promise(r=>setTimeout(r,200));
          assert.equal(await run(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);
          if(width===390)assert.ok(await run(()=>document.querySelector('.refresh-state').getBoundingClientRect().height)>=44);
          if(process.env.WORK_DETAIL_SCREENSHOTS){await fs.mkdir(process.env.WORK_DETAIL_SCREENSHOTS,{recursive:true});await fs.writeFile(require('node:path').join(process.env.WORK_DETAIL_SCREENSHOTS,width+'-'+locale+'.png'),(await win.webContents.capturePage()).toPNG());}
        }
      }
      assert.deepEqual(await run(()=>window.writes),[]);
      await run(()=>{window.record.definition.objective='A long goal that must remain fully accessible without overwhelming the heading. '.repeat(20);window.fixture.revision++;});
      await wait(()=>!!document.querySelector('.long-objective'));
      assert.equal(await run(()=>document.querySelector('.long-objective').open),false);
      await run(()=>document.querySelector('.long-objective summary').click());
      assert.ok(await run(()=>document.querySelector('.long-objective .work-objective').innerText.length)>1000);
      await run(()=>{document.querySelector('.refresh-state').focus();});
      assert.equal(await run(()=>document.activeElement.matches('.refresh-state')),true);
      await run(()=>{window.record.definition.objective=window.record.workflow.title;window.fixture.revision++;window.fixture.canWrite=false;});
      await wait(()=>!document.querySelector('.work-objective'));
      assert.equal(await run(()=>!!document.querySelector('.work-people [role=combobox]')),false);
      console.log('WORK_DETAIL_OK');app.exit(0);
    }).catch(error=>{console.error(error);app.exit(1)});
  `)
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XAUTHORITY', 'WORK_DETAIL_SCREENSHOTS']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = directory
  const child = spawn(desktopRequire('electron') as string, [main], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })
  const timer = setTimeout(() => child.kill(), 80000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, output)
  assert.match(output, /WORK_DETAIL_OK/)
})

test('Work discussion reuses the new-chat draft route without assignment or automatic sending', async () => {
  const source = (name: string) => readFile(new URL(`./components/${name}.vue`, import.meta.url), 'utf8')
  const [detail, workbench, projects, chat] = await Promise.all(['WorkAlignment', 'ProjectWorkbench', 'ProjectsWorkspace', 'ChatTab'].map(source))
  assert.ok(!detail.includes("action: 'assign'"))
  assert.ok(!workbench.includes('<DecisionOwner'))
  assert.match(workbench, /class="discuss-work" @click="discussSelected"/)
  assert.match(workbench, /emit\('compose', workReference\(props\.projectId, selected\.value, selectedItem\.value\?\.title\)/)
  const compose = projects.slice(projects.indexOf('async function composeFromDashboard'), projects.indexOf('const keyboardActive'))
  assert.match(compose, /await startDraft\(projectId\)/)
  assert.match(compose, /registry\.draft\(projectId, folder, remote\)/)
  assert.match(compose, /router\.push\(projectChatLocation\(resource\)\)/)
  assert.match(compose, /appendDraft\(text\)/)
  const append = chat.slice(chat.indexOf('async function appendDraft'), chat.indexOf('async function openProjectWork'))
  assert.match(append, /inputText\.value =/)
  assert.doesNotMatch(append, /fetch\(|send\(|submit\(/)
})
