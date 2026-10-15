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
test('observer and organizer reuse chat bubbles and bounded conversation disclosures at desktop and mobile widths', { timeout: 90_000 }, async t => {
  const directory = resolve(root, '.test-artifacts', `automation-detail-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const chatSource = await readFile(resolve(root, 'app/src/components/ChatTab.vue'), 'utf8')
  const chatStyles = chatSource.split('<style scoped>')[1]!.split('</style>')[0]!
  assert.match(chatSource, /class="chat-bubble automation-bubble"/)
  assert.match(chatSource, /:name="conversationTitle"/)
  const server = await createServer({ configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'cache'), optimizeDeps: { noDiscovery: true, include: ['vue'] }, plugins: [vue(), {
    name: 'automation-workspace-fixture', resolveId: id => id === '/automation-detail-entry.ts' ? '\0automation-detail-entry' : undefined,
    load(id) { if (id !== '\0automation-detail-entry') return; return `
      import {createApp,h,ref} from 'vue'; import AutomationPayload from '/src/components/AutomationPayload.vue'; import AutomationConversationInfo from '/src/components/AutomationConversationInfo.vue'; import '/src/styles.css';
      const conversation={automation:ref({id:'system:work-organizer',name:'Topic organization',source:'system',schedule:'Event driven',enabled:true}),run:ref({title:'RAW TITLE',status:'completed',startedAt:'2026-10-11T12:00:00Z',organization:{status:'completed',coveredCount:2,manifestCount:2,patches:1}}),error:ref(null),historyError:ref(null),loading:ref(false),refresh(){},retry(){}};
      const bubble=(id,input,source)=>h('div',{class:'chat-message-entry'},[h('div',{class:['chat-bubble','automation-bubble',input?'chat-user':'chat-assistant']},[h(AutomationPayload,{source:JSON.stringify(source),input,automationId:id})])]);
      createApp({render:()=>h('div',{style:'display:flex;flex-direction:column;height:100vh'},[h(AutomationConversationInfo,{conversation}),h('div',{class:'chat-messages'},[h('div',{class:'chat-message-list'},[
        bubble('system:work-observer',true,{originalGoal:{text:'Fix navigation'},previous:{summary:'Evidence '.repeat(300),next:'Review'},events:[{}],prompt:'SECRET'}),
        bubble('system:work-observer',false,{title:'Navigation',objective:'Fix menu',summary:'Patched',next:'Review'}),
        bubble('system:work-organizer',true,{mode:'delta',manifest:Array.from({length:30},()=>({title:'Navigation topic',objective:'Keep menu usable',summary:'Semantic summary'})),prompt:'SECRET'}),
        bubble('system:work-organizer',false,{status:'completed',coveredCount:2,manifestCount:2,patches:1})
      ])])])}).mount('#app');`
    }, configureServer(server) { server.middlewares.use((req,res,next)=>{if(!req.url?.startsWith('/__automation_detail'))return next();res.setHeader('Content-Type','text/html');res.end('<html><head><style>'+chatStyles.replaceAll(':deep(', ':is(')+'</style></head><body style="margin:0"><div id="app" style="display:flex;width:100%;height:100vh"></div><script type="module" src="/automation-detail-entry.ts"></script></body></html>')}) },
  }], server:{host:'127.0.0.1',port:0,watch:null,hmr:false} })
  await server.listen(); t.after(()=>server.close())
  const main=resolve(directory,'main.cjs')
  await writeFile(main, `const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict'); app.setPath('userData',${JSON.stringify(directory)});app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1100,height:800,webPreferences:{contextIsolation:true,nodeIntegration:false}});const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');const wait=()=>new Promise(r=>setTimeout(r,400));try{
    await win.loadURL(${JSON.stringify(new URL('__automation_detail',server.resolvedUrls!.local[0]).href)});
    for(let i=0;i<100;i++){if(await run(()=>document.querySelectorAll('.automation-presentation').length===4))break;await wait()}
    assert.equal(await run(()=>document.querySelectorAll('.automation-payload .tool-payload').length),0);
    assert.equal(await run(()=>document.body.textContent.includes('SECRET')),false);
    assert.equal(await run(()=>document.body.textContent.includes('RAW TITLE')),false);
    assert.equal(await run(()=>document.querySelectorAll('.automation-presentation .message-preview-card[data-expanded="false"]').length),2);
    assert.equal(await run(()=>document.querySelectorAll('.automation-presentation .message-preview-card[data-expanded="true"]').length),2);
    for(const width of [1100,390]){win.setSize(width,800);await wait();
      assert.ok(await run(()=>document.documentElement.scrollWidth<=innerWidth));
      assert.ok(await run(()=>Array.from(document.querySelectorAll('.chat-user .message-preview-content')).every(e=>e.clientHeight<130)));
      assert.ok(await run(()=>{const user=document.querySelector('.chat-user');return getComputedStyle(user).alignSelf==='flex-end'&&parseFloat(getComputedStyle(user).fontSize)<15}));
      assert.ok(await run(()=>getComputedStyle(document.querySelector('.chat-assistant')).alignSelf==='flex-start'));
    }
    await run(()=>document.querySelector('.chat-user .message-preview-toggle').click());await wait();
    assert.equal(await run(()=>document.querySelector('.chat-user .message-preview-card').dataset.expanded),'true');
    assert.ok(await run(()=>document.querySelector('.chat-user .message-preview-content').clientHeight>130));
    await run(()=>document.querySelector('.automation-payload summary').click());await wait();
    assert.ok(await run(()=>document.querySelector('.automation-payload .tool-payload').textContent.includes('SECRET')));
    assert.ok(await run(()=>document.querySelector('.automation-payload .tool-payload').clientHeight<=300));
    await run(()=>document.querySelector('.automation-info .message-preview-toggle').click());await wait();
    assert.equal(await run(()=>document.querySelector('.automation-info').dataset.expanded),'true');
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
