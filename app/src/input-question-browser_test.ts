import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
test('input Q&A cards render safely with attachment actions across locales, themes, mobile and reload', { timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `input-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const server = await createServer({ configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'cache'),
    optimizeDeps: { noDiscovery: true }, plugins: [vue(), {
      name: 'input-fixture',
      resolveId: id => id === '/input-fixture.js' ? '\0input-fixture' : undefined,
      load(id) {
        if (id !== '\0input-fixture') return
        return `import '/src/styles.css';
          import { createApp, h, ref, computed, nextTick } from 'vue';
          import InputQuestion from '/src/components/InputQuestion.vue';
          import { inlineInputQuestions } from '/src/input-history.ts';
          import { i18n } from '/src/i18n.ts';
          const at = '2026-10-12T08:00:00.000Z';
          const call = {event:'tool_call',toolCallId:'a',content:'',toolCall:{name:'ask',arguments:{kind:'input',question:'<img src=x onerror=alert(1)> Which file? '+ 'long-path/'.repeat(30)}}};
          const result = {event:'tool_result',toolCallId:'a',content:JSON.stringify({requestId:'r',text:'<script>alert(1)</script> 文件.txt',answeredBy:'user',answeredAt:at,media:['/uploads/file.txt']})};
          const messages = ref([call,result]);
          const pending = ref(null);
          window.__opened = 0;
          window.__set = async (locale, theme, mode) => {
            i18n.global.locale.value = locale; document.documentElement.classList.toggle('dark', theme === 'dark');
            messages.value = mode === 'answered' ? [call,result] : [call];
            pending.value = mode === 'waiting' ? {kind:'input',id:'r',sessionId:'web:chat-owner',question:call.toolCall.arguments.question,origin:{physicalId:'p',toolCallId:'a'},recipient:{kind:'user',sessionId:'web:chat-owner'},createdAt:at,deadline:null} : null;
            await nextTick();
          };
          createApp({setup(){const history=computed(()=>inlineInputQuestions(messages.value,pending.value));return()=>h(InputQuestion,{entry:history.value.entries.get(0),apiBase:location.origin,sessionId:'web:chat-owner',workdir:{kind:'local',displayPath:'/uploads',available:true},onOpen:()=>window.__opened++})}}).mount('#app');`
      },
      configureServer(server) { server.middlewares.use((req, res, next) => {
        if (req.url !== '/__input') return next()
        res.setHeader('Content-Type', 'text/html')
        res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><main id="app" style="padding:8px;--conversation-item-max-width:100%"></main><script type="module" src="/input-fixture.js"></script></body></html>')
      }) },
    }], server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  t.after(() => server.close())
  const script = resolve(directory, 'main.cjs')
  await writeFile(script, `const {app,BrowserWindow}=require('electron'); const assert=require('node:assert/strict');
    app.setPath('userData',require('node:path').join(process.cwd(),'profile'));app.on('window-all-closed',()=>{});
    app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1100,height:800,webPreferences:{contextIsolation:true,nodeIntegration:false}});
      try {await win.loadURL(process.env.INPUT_URL+'__input');
        for(let i=0;i<100;i++){if(await win.webContents.executeJavaScript('!!window.__set && !!document.querySelector(".input-answer")'))break;await new Promise(r=>setTimeout(r,100));}
        for(const width of [1100,390]) for(const locale of ['en','zh-CN']) for(const theme of ['light','dark']) {
          win.setSize(width,800); await win.webContents.executeJavaScript('window.__set('+JSON.stringify(locale)+','+JSON.stringify(theme)+',"answered")');
          const view=await win.webContents.executeJavaScript(\`(()=>{const card=document.querySelector('.input-question');const prompt=card.querySelector('h2');return {text:card.innerText,unsafe:card.querySelectorAll('script,img').length,width:card.getBoundingClientRect().width,viewport:innerWidth,font:parseFloat(getComputedStyle(prompt).fontSize),button:!!card.querySelector('.attachment-open'),overflow:document.documentElement.scrollWidth>innerWidth}})()\`);
          assert.equal(view.unsafe,0);assert.equal(view.overflow,false);assert.ok(view.font>=18);assert.ok(view.button);assert.ok(view.text.includes('文件.txt'));assert.ok(view.text.includes(locale==='en'?'Answered by user':'用户已回答'));
        }
        await win.webContents.executeJavaScript('document.querySelector(".attachment-open").click()');assert.equal(await win.webContents.executeJavaScript('window.__opened'),1);
        await win.webContents.executeJavaScript('window.__set("en","light","waiting")');assert.match(await win.webContents.executeJavaScript('document.querySelector(".input-question").innerText'),/Needs your reply/);
        await win.webContents.executeJavaScript('window.__set("en","light","unknown")');assert.match(await win.webContents.executeJavaScript('document.querySelector(".input-question").innerText'),/No confirmed answer/);
        await win.loadURL(process.env.INPUT_URL+'__input');for(let i=0;i<100;i++){if(await win.webContents.executeJavaScript('!!document.querySelector(".input-answer")'))break;await new Promise(r=>setTimeout(r,100));}
        assert.match(await win.webContents.executeJavaScript('document.querySelector(".input-question").innerText'),/文件.txt/);
        console.log('INPUT_BROWSER_OK');win.destroy();app.exit(0);
      }catch(error){console.error(error);win.destroy();app.exit(1);}
    });`)
  const env: NodeJS.ProcessEnv = { INPUT_URL: server.resolvedUrls!.local[0] }
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) if (process.env[key] !== undefined) env[key] = process.env[key]
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = directory
  const child = spawn(desktopRequire('electron') as string, [script], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const timer = setTimeout(() => child.kill(), 75_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, output)
  assert.match(output, /INPUT_BROWSER_OK/)
})
