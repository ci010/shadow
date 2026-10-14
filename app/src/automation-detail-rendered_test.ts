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
test('unified rendered history menu selects automation runs and physical sessions with pagination, retry and focus restoration', { timeout: 90_000 }, async t => {
  const directory = resolve(root, '.test-artifacts', `automation-detail-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const server = await createServer({ configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'cache'), optimizeDeps: { noDiscovery: true, include: ['vue'] }, plugins: [vue(), {
    name: 'automation-workspace-fixture', resolveId: id => id === '/automation-detail-entry.ts' ? '\0automation-detail-entry' : undefined,
    load(id) { if (id !== '\0automation-detail-entry') return; return `
      import {createApp,h,ref,inject} from 'vue'; import HistoryMenu from '/src/components/ConversationHistoryMenu.vue'; import {automationConversationKey} from '/src/composables/useAutomationConversation.ts'; import AutomationDetail from '/src/components/AutomationDetail.vue'; import AutomationPayload from '/src/components/AutomationPayload.vue'; import '/src/styles.css';
      const Menu={setup(){const automation=inject(automationConversationKey);return()=>h(HistoryMenu,{apiBase:location.origin,sessionId:selected.value,physicalId:null,automation})}}; window.requests=[]; window.mode='valid'; const selected=ref('run:0'); const physical=ref(null); const Ordinary={setup(){return()=>h('div',{class:'ordinary-menu'},[h(HistoryMenu,{apiBase:location.origin+'/projects/fixture/',sessionId:'web:ordinary',physicalId:physical.value,onSelect:(id,newer)=>{physical.value=id;window.selection={id,newer}}})])}};
      const usage={providerCalls:3,toolCalls:2,inputTokens:0,outputTokens:null,totalTokens:null,knownUsageCalls:2,unknownUsageCalls:1,trackedSessions:1,untrackedSessions:0};
      const runs=Array.from({length:32},(_,i)=>({id:'id:'+i,sessionId:'run:'+i,title:'Organization '+i,status:i===1?'failed':'completed',scope:i%2?'delta':'full',startedAt:new Date(Date.UTC(2026,9,11,12-i)).toISOString()}));
      window.fetch=async(input)=>{const path=new URL(String(input),location.href).pathname;window.requests.push(path);
        if(path.includes('/api/sessions/')){if(window.physicalFail)return Response.json({}, {status:503}); const key=decodeURIComponent(path.split('/').pop());const index=key==='web:ordinary'?-1:Number(key.split(':')[1]);return Response.json({name:'Segment '+index,messages:[],previousPhysicalId:index<7?'physical:'+(index+1):null});} if(path.endsWith('/api/automations'))return Response.json({automations:[{id:'system:work-organizer',name:'Topic organization',source:'system',session:'fresh',schedule:'Event driven',enabled:true,editable:false}]});
        if(path.endsWith('/runs')){const offset=Number(new URL(String(input),location.href).searchParams.get('offset')||0);if(offset&&window.runFail)return Response.json({}, {status:503});return Response.json({runs:runs.slice(offset,offset+30),total:32,offset});}
        if(path.endsWith('/profile')){if(window.mode==='error')return Response.json({secret:'never display'}, {status:503});return Response.json({profile:{frequency:{description:'Event driven',scope:'current_runtime'},runs:{total:12,failed:1,partial:0,cancelled:0,unknown:0},usage,coverage:'partial',window:{from:'2026-10-10T00:00:00Z',asOf:'2026-10-11T00:00:00Z'},limitations:['No estimates']}});}
        return Response.json({});};
      createApp({render:()=>h(AutomationDetail,{apiBase:location.origin+'/projects/fixture/',automationId:'system:work-organizer',active:true,selectedSessionId:selected.value,onOpen:id=>selected.value=id},{default:()=>h('section',{class:'trace-fixture',style:'flex:1;min-height:0;overflow:auto'},[h(Menu),h(Ordinary),h('h2','Run trace'),h(AutomationPayload,{key:selected.value,source:JSON.stringify({mode:'delta',manifest:[{title:'Navigation topic',objective:'Keep menu usable',summary:'Semantic summary'}],prompt:'internal '.repeat(10000)}),input:true,automationId:'system:work-organizer'})])})}).mount('#app');`
    }, configureServer(server) { server.middlewares.use((req,res,next)=>{if(!req.url?.startsWith('/__automation_detail'))return next();res.setHeader('Content-Type','text/html');res.end('<html><body style="margin:0"><div id="app" style="display:flex;width:100%;height:100vh"></div><script type="module" src="/automation-detail-entry.ts"></script></body></html>')}) },
  }], server:{host:'127.0.0.1',port:0,watch:null,hmr:false} })
  await server.listen(); t.after(()=>server.close())
  const main=resolve(directory,'main.cjs')
  await writeFile(main, `const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict'); app.setPath('userData',${JSON.stringify(directory)});app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1100,height:800,webPreferences:{contextIsolation:true,nodeIntegration:false}});const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');const wait=()=>new Promise(r=>setTimeout(r,400));try{
    await win.loadURL(${JSON.stringify(new URL('__automation_detail',server.resolvedUrls!.local[0]).href)});
    for(let i=0;i<100;i++){if(await run(()=>document.querySelector('.profile-metrics')))break;await wait()}
    assert.equal(await run(()=>document.querySelector('.automation-payload').open),false);assert.equal(await run(()=>document.querySelector('.automation-payload .tool-payload')),null);
    assert.ok(await run(()=>document.querySelector('.automation-presentation').textContent.includes('Navigation topic')));
    assert.ok(await run(()=>document.querySelector('.automation-presentation').textContent.includes('Keep menu usable')));
    assert.ok(await run(()=>!document.querySelector('.automation-presentation').textContent.includes('internal internal')));
    assert.equal(await run(()=>document.querySelectorAll('.history-row').length),0);assert.equal(await run(()=>document.querySelector('.system-run-history')),null);
    await run(()=>document.querySelector('[aria-label="Conversation history"]').click());await wait(); assert.equal(await run(()=>document.querySelectorAll('.history-row').length),6);
    assert.equal(await run(()=>document.querySelectorAll('.system-run-history ul').length),0);
    assert.ok(await run(()=>document.querySelector('.composer-popover').getBoundingClientRect().bottom<=innerHeight));
    assert.ok(await run(()=>!document.querySelector('.history-row time').textContent.includes('T')));
    assert.ok(await run(()=>document.querySelector('.history-row time').title.length>10));
    assert.ok(await run(()=>document.querySelector('.automation-profile').textContent.includes('Input tokens0')));
    assert.ok(await run(()=>document.querySelector('.automation-profile').textContent.includes('Unknown')));
    assert.ok(await run(()=>window.requests.every(p=>!p.includes('//'))));
    await run(()=>{window.runFail=true;Array.from(document.querySelectorAll('.conversation-history button')).find(e=>e.textContent.trim()==='Load more').click()});await wait();assert.ok(await run(()=>document.querySelector('.conversation-history [role=alert]')));assert.equal(await run(()=>document.querySelectorAll('.history-row').length),6);
    await run(()=>{window.runFail=false;Array.from(document.querySelectorAll('.conversation-history button')).find(e=>e.textContent.trim()==='Retry').click()});await wait();assert.equal(await run(()=>document.querySelector('.conversation-history [role=alert]')),null);assert.equal(await run(()=>Array.from(document.querySelectorAll('.conversation-history button')).some(e=>e.textContent.trim()==='Load more')),false);
    await run(()=>document.querySelector('.history-pages button:last-child').click());await wait();assert.ok(await run(()=>document.querySelector('.history-row').textContent.includes('Organization 6')));
    await run(()=>document.querySelector('.history-toolbar [role=combobox]').click());await wait();await run(()=>Array.from(document.querySelectorAll('[role=option]')).find(e=>e.textContent.trim()==='Full').click());await wait();assert.equal(await run(()=>document.querySelectorAll('.history-row').length),6);
    await run(()=>document.querySelectorAll('.history-row')[1].click());await wait();assert.equal(await run(()=>document.querySelector('button[aria-label="Conversation history"]').getAttribute('aria-expanded')),'false'); await run(()=>document.querySelector('[aria-label="Conversation history"]').click());await wait();assert.ok(await run(()=>document.querySelector('.history-row.selected').textContent.includes('Organization 2')));
    await run(()=>document.querySelector('.composer-popover').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));await wait(); await run(()=>document.querySelector('.automation-payload summary').click());await wait();assert.ok(await run(()=>document.querySelector('.automation-payload .tool-payload').clientHeight<=300));
    await run(()=>document.querySelector('[aria-label="Conversation history"]').click());await wait(); await run(()=>document.querySelectorAll('.history-row')[3].click());await wait();assert.equal(await run(()=>document.querySelector('.automation-payload').open),false);
    await run(()=>{window.mode='error';document.querySelector('.automation-profile header button').click()});await wait();assert.ok(await run(()=>document.querySelector('.profile-error').textContent.includes('503')));assert.ok(await run(()=>!document.body.textContent.includes('never display')));
    await run(()=>{window.mode='valid';document.querySelector('.automation-profile header button').click()});await wait();assert.equal(await run(()=>document.querySelector('.profile-error')),null);
    for(const width of [1100,390]){win.setSize(width,800);await wait();assert.ok(await run(()=>document.documentElement.scrollWidth<=window.innerWidth));assert.ok(await run(()=>document.querySelector('.trace-fixture').clientHeight>300),JSON.stringify(await run(()=>({height:innerHeight,trace:document.querySelector('.trace-fixture').clientHeight,history:document.querySelector('.conversation-history')?.clientHeight,profile:document.querySelector('.automation-profile').clientHeight}))));}
    win.setSize(1100,800);await wait();
    await run(()=>document.querySelector('.ordinary-menu button').click());await wait();
    assert.equal(await run(()=>document.querySelectorAll('.history-row').length),6);
    assert.equal(await run(()=>document.querySelector('.history-row.selected').textContent.trim()),'Current session');
    await run(()=>document.querySelector('.history-pages button:last-child').click());await wait();assert.equal(await run(()=>document.querySelectorAll('.history-row').length),3);
    await run(()=>document.querySelectorAll('.history-row')[2].click());await wait();assert.deepEqual(await run(()=>window.selection),{id:'physical:7',newer:[null,'physical:0','physical:1','physical:2','physical:3','physical:4','physical:5','physical:6']});
    await run(()=>{window.physicalFail=true;document.querySelector('.ordinary-menu button').click()});await wait();assert.ok(await run(()=>document.querySelector('.conversation-history [role=alert]').textContent.includes('503')));
    await run(()=>{window.physicalFail=false;Array.from(document.querySelectorAll('.conversation-history button')).find(e=>e.textContent.trim()==='Retry').click()});await wait();assert.equal(await run(()=>document.querySelector('.conversation-history [role=alert]')),null);
    await run(()=>document.querySelector('.composer-popover').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})));await wait();assert.ok(await run(()=>document.activeElement===document.querySelector('.ordinary-menu button')));
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
