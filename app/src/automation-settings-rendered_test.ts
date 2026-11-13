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
const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
test('conversation notices render only actionable status, never workflow configuration', { timeout: 90_000 }, async t => {
  const directory = resolve(root, '.test-artifacts', `automation-detail-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const chatSource = await readFile(resolve(root, 'app/src/components/ChatTab.vue'), 'utf8')
  const chatStyles = chatSource.split('<style scoped>')[1]!.split('</style>')[0]!
  assert.doesNotMatch(chatSource, /AutomationConversationProjection/)
  const detail = await readFile(resolve(root, 'app/src/components/AutomationDetail.vue'), 'utf8')
  assert.doesNotMatch(detail, /AutomationConversationProjection/)
  assert.match(detail, /!selectedSessionId/)
  const server = await createServer({ configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'cache'), optimizeDeps: { noDiscovery: true, include: ['vue'] }, plugins: [vue(), {
    name: 'automation-workspace-fixture', resolveId: id => id === '/automation-detail-entry.ts' ? '\0automation-detail-entry' : undefined,
    load(id) { if (id !== '\0automation-detail-entry') return; return `
      import {createApp,h,ref} from 'vue'; import Info from '/src/components/AutomationConversationInfo.vue'; import '/src/styles.css';
      const conversation={automation:ref({id:'learning:reflector',schedule:'secret schedule',task:'secret prompt',enabled:true}),run:ref(null),error:ref(''),historyError:ref(''),loading:ref(false),refresh(){window.refreshed++},retry(){window.retried++}};
      window.refreshed=0;window.retried=0;window.conversation=conversation;
      createApp({render:()=>h('div',{style:'display:flex;flex-direction:column;height:100vh;width:100%;min-width:0'},[h('h1','Ordinary title'),h(Info,{conversation}),h('div',{class:'chat-messages'},'Ordinary transcript')])}).mount('#app');`
    }, configureServer(server) { server.middlewares.use((req,res,next)=>{if(!req.url?.startsWith('/__automation_detail'))return next();res.setHeader('Content-Type','text/html');res.end('<html><head><style>'+chatStyles.replaceAll(':deep(', ':is(')+'</style></head><body style="margin:0"><div id="app" style="display:flex;width:100%;height:100vh"></div><script type="module" src="/automation-detail-entry.ts"></script></body></html>')}) },
  }], server:{host:'127.0.0.1',port:0,watch:null,hmr:false} })
  await server.listen(); t.after(()=>server.close())
  const main=resolve(directory,'main.cjs')
  await writeFile(main, `const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict'); app.setPath('userData',${JSON.stringify(directory)});app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1100,height:800,webPreferences:{contextIsolation:true,nodeIntegration:false}});const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');const wait=()=>new Promise(r=>setTimeout(r,400));try{
    await win.loadURL(${JSON.stringify(new URL('__automation_detail',server.resolvedUrls!.local[0]).href)});
    for(let i=0;i<100;i++){if(await run(()=>document.querySelector('.chat-messages')))break;await wait()}
    assert.equal(await run(()=>document.querySelector('.automation-context')),null);
    for(const width of [1100,390]){win.setSize(width,800);await wait();
      assert.equal(await run(()=>document.querySelector('.automation-info,.automation-projection,form,input,select')),null);
      assert.ok(await run(()=>document.documentElement.scrollWidth<=innerWidth));
      assert.ok(await run(()=>document.querySelector('h1').textContent==='Ordinary title' && document.querySelector('.chat-messages').textContent==='Ordinary transcript'));
      await run(()=>{window.conversation.error.value='Unavailable';window.conversation.historyError.value='History failed';window.conversation.automation.value.notice='Read-only access';});await wait();
      assert.equal(await run(()=>document.querySelectorAll('[role=alert]').length),2);
      assert.equal(await run(()=>document.querySelector('[role=status]').textContent),'Read-only access');
      await run(()=>{for(const button of document.querySelectorAll('.automation-note button'))button.click();window.conversation.error.value='';window.conversation.historyError.value='';window.conversation.automation.value.notice='';});await wait();
      assert.equal(await run(()=>document.querySelector('.automation-context')),null);
      assert.equal(await run(()=>document.body.textContent.includes('secret schedule')||document.body.textContent.includes('secret prompt')),false);
    }
    assert.equal(await run(()=>window.refreshed),2);assert.equal(await run(()=>window.retried),2);
    console.log('AUTOMATION_DETAIL_REAL_OK');app.exit(0);
  }catch(e){console.error(e);app.exit(1)}});`)
  const env:NodeJS.ProcessEnv={}
  for(const key of ['SystemRoot','WINDIR','PATH','Path','ComSpec','PATHEXT','DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR'])if(process.env[key]!==undefined)env[key]=process.env[key]
  for(const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TMP','TEMP','TMPDIR','XDG_CONFIG_HOME','XDG_CACHE_HOME'])env[key]=directory
  const child=spawn(desktopRequire('electron') as string,[main],{cwd:directory,env,windowsHide:true,stdio:['ignore','pipe','pipe']});let output=''
  child.stdout.setEncoding('utf8').on('data',chunk=>output+=chunk);child.stderr.setEncoding('utf8').on('data',chunk=>output+=chunk)
  const timer=setTimeout(()=>child.kill(),75000);t.after(()=>{clearTimeout(timer);if(child.exitCode===null)child.kill()})
  const [code]=await once(child,'close');assert.equal(code,0,output);assert.match(output,/AUTOMATION_DETAIL_REAL_OK/)
})
