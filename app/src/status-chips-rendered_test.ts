import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer, normalizePath } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { parse } from 'vue/compiler-sfc'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))

test('composer status chips share rendered boundaries across phone sizes, copy and running states', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `status-chips-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const chatSource = await readFile(resolve(root, 'app/src/components/ChatTab.vue'), 'utf8')
  const chatStyle = parse(chatSource).descriptor.styles[0].content
  // Use the production status markup and CSS, not a separately styled lookalike.
  const statusStart = chatSource.indexOf('          <div v-if="isExecution')
  const statusEnd = chatSource.indexOf('\n        </div>\n        <YieldQuestion')
  assert.ok(statusStart >= 0 && statusEnd > statusStart, 'production status markup is available')
  const statusMarkup = chatSource.slice(statusStart, statusEnd)
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    optimizeDeps: { noDiscovery: true, include: ['vue'] },
    plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app/unocss.config.ts') }), {
      name: 'status-chip-fixture',
      resolveId: id => id === '/popup-entry.ts' ? '\0popup-entry' : id === '/popup-fixture.vue' ? normalizePath(resolve(directory, 'fixture.vue')) : undefined,
      load(id) {
        if (id === '\0popup-entry') return `import 'uno.css'; import '/src/styles.css'; import {createResourceApp as createApp} from '/src/stores/app.ts'; import Fixture from '/popup-fixture.vue'; createApp(Fixture).mount('#app');`
        if (id !== normalizePath(resolve(directory, 'fixture.vue'))) return
        return `<script setup>
          import {ref} from 'vue';
          import {i18n,t} from '/src/i18n.ts';
          import SessionWorkControls from '/src/components/SessionWorkControls.vue';
          import SessionActivity from '/src/components/SessionActivity.vue';
          import WorkingWave from '/src/components/WorkingWave.vue';
          const stage=ref('llm'), running=ref(true), label=ref('1个子智能体正在工作');
          const isExecution=false, viewingPhysicalId=null, isCall=false;
          const sessionStage=stage, sessionWorking=running, composerWorking=running;
          const activeSubagents=[{sessionId:'worker',label:'测试 worker',mode:'task',executionStatus:'running'}];
          const activeSubagentActivity={}, activeSubagentDetails='统一修复手机端布局与长期配对连接';
          const subagentActivityLabel=()=>label.value;
          const isWaitingStage=s=>s==='waiting';
          const streamingToolCallData=null;
          window.__setChipState=(s,text,locale)=>{stage.value=s;running.value=s!=='idle';label.value=text;i18n.global.locale.value=locale;document.querySelector('main').classList.toggle('mobile-chat',innerWidth<=700)};
        </script><template><main>
          <div class="session-status-row">
            <SessionWorkControls api-base="/fixture" session-id="web:fixture" :active="false" :subagents="activeSubagents" />
            ${statusMarkup}
          </div>
        </main></template><style scoped>${chatStyle}</style>`
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
      for(const locale of ['zh-CN','en']) {
      for(const width of [320,360,393,700,900]) {
        win.setSize(width,700);
        for(const [stage,text] of [['llm','1个子智能体正在工作'],['tool','12 subagents are working on a very long task description'],['waiting','等待回复 · 1个子智能体'],['idle','1个子智能体正在工作']]) {
          await win.webContents.executeJavaScript('window.__setChipState('+JSON.stringify(stage)+','+JSON.stringify(text)+','+JSON.stringify(locale)+')');
          await new Promise(r=>setTimeout(r,70));
          const boxes=await run(()=>{
            const button=document.querySelector('[data-session-work="subagents"]'), chip=document.querySelector('.chat-working');
            const box=el=>{const r=el.getBoundingClientRect();return {top:r.top,bottom:r.bottom,height:r.height,left:r.left,right:r.right}};
            const wave=chip.querySelector('.working-wave');
            const label=chip.querySelector('.subagent-status-label');
            return {button:box(button),chip:box(chip),wave:wave&&box(wave),label:box(label),overflow:document.documentElement.scrollWidth>innerWidth,ellipsis:getComputedStyle(label).textOverflow};
          });
          const message=locale+' '+width+'px '+stage;
          assert.equal(boxes.chip.top,boxes.button.top,message+' top');
          assert.equal(boxes.chip.bottom,boxes.button.bottom,message+' bottom');
          assert.equal(boxes.chip.height,width<=700?44:32,message+' density');
          assert.equal(boxes.overflow,false,message+' page overflow');
          assert.ok(boxes.chip.right<=width,message+' chip contained');
          assert.ok(boxes.label.right<=boxes.chip.right,message+' label contained');
          assert.equal(boxes.ellipsis,'ellipsis');
          if(boxes.wave) assert.ok(Math.abs((boxes.wave.top+boxes.wave.bottom)-(boxes.chip.top+boxes.chip.bottom))<1,message+' icon centered');
          if(width===320 || width===393) {
            const image=await win.webContents.capturePage();
            require('node:fs').writeFileSync(require('node:path').join(process.env.CHIP_SCREENSHOT_DIR||${JSON.stringify(directory)},'status-chip-'+locale+'-'+width+'-'+stage+'.png'),image.toPNG());
          }
        }
      }
      }
      console.log('STATUS_CHIPS_OK');app.exit(0);
    }).catch(error=>{console.error(error);app.exit(1)});
  `)
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) if (process.env[key] !== undefined) env[key] = process.env[key]
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = directory
  if (process.env.CHIP_SCREENSHOT_DIR) env.CHIP_SCREENSHOT_DIR = process.env.CHIP_SCREENSHOT_DIR
  const child = spawn(desktopRequire('electron') as string, [main], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })
  const timer = setTimeout(() => child.kill(), 75_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, output)
  assert.match(output, /STATUS_CHIPS_OK/)
})
