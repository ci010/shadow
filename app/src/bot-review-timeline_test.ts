import assert from 'node:assert/strict'
import test from 'node:test'
import { readFile, mkdir, writeFile, rm } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { botReviewPositions } from './bot-review-timeline.ts'
import type { BotReviewRecord } from '../../src/agent-authoring/bot-review-contract.ts'

const origin={sessionId:'web:owner',physicalId:'physical',toolCallId:'host-call'}
const draft={id:'11111111-1111-4111-a111-111111111111',origin,baseRevision:1,hash:'a'.repeat(64),change:{kind:'bot.save' as const,package:{id:'support',source:{'BOT.md':'---\nname: support\nplatform: discord\nbotInstanceId: fixture\nchannels: []\ntools: []\nreadDomains: []\n---\n'+'Frozen source\n'.repeat(200)}}},actor:{kind:'owner' as const,id:'shadow-owner'},createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),status:'pending' as const,affectedBindings:[],warning:'Frozen review',validationHash:'validation'}
const record:BotReviewRecord={version:1,projectId:'a',id:draft.id,origin,createdAt:draft.createdAt,currentRevision:1,status:'pending',candidate:{kind:'discord',draft}}

test('Bot timeline positions use trusted call IDs; completed records remain at the original anchor',()=>{
  const messages=[{timestamp:'2000-01-01T00:00:00.000Z'},{toolCallId:'host-call',event:'tool_call'},{toolCallId:'host-call',event:'tool_result'}]
  assert.equal(botReviewPositions([record],messages).get(2)?.[0]?.id,record.id)
  assert.equal(botReviewPositions([{...record,status:'applied',decidedAt:new Date().toISOString()}],messages).get(2)?.[0]?.status,'applied')
})
test('Bot timeline is inside history, never the global composer; theme and no polling checks',async()=>{
  const chat=await readFile(new URL('./components/ChatTab.vue',import.meta.url),'utf8')
  assert(chat.indexOf('= useBotReviews(') > chat.indexOf('const viewingPhysicalId = ref'), 'immediate review watcher must follow segment ref initialization')
  assert(!chat.includes('<BotPublicationReview '))
  assert(chat.indexOf('<BotReviewCard ')>chat.indexOf('ref="messagesContainer"'))
  assert(!chat.slice(chat.indexOf('<template #composer>')).includes('<BotReviewCard '))
  const source=await readFile(new URL('./components/BotReviewCard.vue',import.meta.url),'utf8')
  for(const match of source.matchAll(/border-radius:([^;}]+)/g)) assert.match(match[1]!,/^var\(--radius-/)
  const timeline=await readFile(new URL('./bot-review-timeline.ts',import.meta.url),'utf8')
  assert(!timeline.includes('setInterval'))
})

test('rendered Bot card: human-only exact commit, durable readonly collapsed reload and history scrolling',{timeout:60000,skip:process.platform==='linux'&&!process.env.DISPLAY&&!process.env.WAYLAND_DISPLAY},async t=>{
  const root=resolve(import.meta.dirname,'../..'),directory=resolve(root,'.test-artifacts',`timeline-${randomUUID()}`)
  await mkdir(directory,{recursive:true});t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:10,retryDelay:100}))
  const fixture=`import '/src/styles.css';import {createApp,h,ref,reactive} from 'vue';import Card from '/src/components/BotReviewCard.vue';import {setLocalePreference,i18n,t} from '/src/i18n.ts';
  setLocalePreference('en');window.locale=setLocalePreference;window.lang=()=>({locale:i18n.global.locale.value,text:t('Agent permission ceiling'),element:document.querySelector('article')?.lang,title:document.querySelector('h3')?.textContent});
  const initial=${JSON.stringify(record)};const review=ref(JSON.parse(localStorage.getItem('review')||'null')||initial);window.calls=[];window.updates=0;
  const view=reactive({apiBase:location.origin+'/projects/a',sessionId:'web:owner',shown:true});window.view=view;
  window.fetch=async(url,options)=>{window.calls.push({url:String(url),body:JSON.parse(options.body),signal:options.signal});if(window.hold)await new Promise(resolve=>{window.release=resolve});if(window.fail)return new Response('{}',{status:409});window.commitSuccess=true;return new Response('{}',{status:200})};
  window.reset=(status='pending',patch={})=>{review.value={...initial,status,...patch};localStorage.removeItem('review');window.commitSuccess=false};
  window.expire=()=>{review.value={...initial,candidate:{kind:'discord',draft:{...initial.candidate.draft,expiresAt:new Date(Date.now()+150).toISOString()}}}};
  window.patch=patch=>{review.value={...review.value,...patch}};
  window.switch=()=>{view.apiBase=location.origin+'/projects/b';view.sessionId='web:other';const origin={...initial.origin,sessionId:'web:other'};review.value={...initial,id:'22222222-2222-4222-a222-222222222222',projectId:'b',origin,candidate:{kind:'discord',draft:{...initial.candidate.draft,id:'22222222-2222-4222-a222-222222222222',origin,hash:'b'.repeat(64)}}}};
  createApp({render:()=>h('div',{class:'chat-messages',style:'height:300px;overflow:auto'},view.shown?[h(Card,{review:review.value,apiBase:view.apiBase,sessionId:view.sessionId,canSubmit:true,onUpdated:()=>{window.updates++;if(window.commitSuccess){window.commitSuccess=false;review.value={...review.value,status:'applied',decidedAt:'2026-01-01T00:00:00.000Z'};localStorage.setItem('review',JSON.stringify(review.value))}}})]:[])}).mount('#app');`
  await writeFile(resolve(directory,'fixture.ts'),fixture)
  await writeFile(resolve(directory,'index.html'),'<html><body><div id="app"></div><script type="module" src="./fixture.ts"></script></body></html>')
  const server=await createServer({root:resolve(root,'app'),configFile:false,envDir:false,cacheDir:resolve(directory,'cache'),optimizeDeps:{entries:[],noDiscovery:true,include:['vue','vue-i18n','zod','yaml']},plugins:[vue(),{
    name:'timeline-fixture',resolveId:id=>id==='/fixture.ts'?'\0fixture':undefined,load:id=>id==='\0fixture'?fixture:undefined,
    configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<div id="app"></div><script type="module" src="/fixture.ts"></script>')}else next()})},
  }],server:{host:'127.0.0.1',port:0},logLevel:'error'})
  await server.listen();t.after(()=>server.close())
  const address=server.httpServer!.address();assert(address&&typeof address!=='string')
  const url=`http://127.0.0.1:${address.port}/`
  const script=`const assert=require('node:assert/strict');const {app,BrowserWindow}=require('electron');const {setTimeout:delay}=require('node:timers/promises');app.setPath('userData',require('node:path').join(process.cwd(),'profile'));
  (async()=>{await app.whenReady();const win=new BrowserWindow({show:false,width:800,height:700,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}});const run=s=>win.webContents.executeJavaScript(s);const wait=async s=>{for(let i=0;i<200;i++){if(await run(s))return;await delay(30)}throw Error('Timeout '+s)};
  await win.loadURL(${JSON.stringify(url)});await wait('!!document.querySelector("article")');
  assert.equal(await run('window.calls.length'),0);assert.equal(await run('document.querySelector("button").disabled'),true);
  assert.match(await run('document.querySelector(".action-hint").textContent'),/Check the acknowledgement/);
  assert.equal(await run('document.querySelector("button").getAttribute("aria-describedby")'),await run('document.querySelector(".action-hint").id'));
  assert.equal(await run('!!document.querySelector(".card-heading .status-badge") && !!document.querySelector(".permission-group dl") && !!document.querySelector("footer .acknowledgement")'),true);
  assert.equal(await run('getComputedStyle(document.querySelector("h3")).fontSize'),'20px');assert.equal(await run('getComputedStyle(document.querySelector("footer")).padding'),'20px 24px');assert.equal(await run('getComputedStyle(document.querySelector(".permission-group dl")).display'),'grid');
  await run('window.locale("zh-CN")');await delay(50);assert.equal(await run('document.querySelector(".status-badge").textContent'),'等待审批');assert.equal(await run('document.querySelector(".permission-group h6").textContent'),'Agent 权限上限',JSON.stringify(await run('window.lang()')));await run('window.locale("en")');await delay(50);
  await run('window.patch({currentRevision:2})');await delay(30);assert.match(await run('document.querySelector(".action-hint").textContent'),/Reviewed revision 1; current configuration 2/);assert.equal(await run('document.querySelector("button").disabled'),true);
  await run('window.expire()');await wait('document.querySelector(".action-hint").textContent.includes("expired")');assert.equal(await run('document.querySelector("button").disabled'),true);await run('window.reset()');await delay(30);

  await run('document.querySelectorAll("details")[1].open=true');
  assert.equal(await run('document.querySelector(".chat-messages").scrollHeight>document.querySelector(".chat-messages").clientHeight'),true);
  await run('document.querySelector("button").scrollIntoView({block:"end"})');assert.equal(await run('document.querySelector(".chat-messages").scrollTop>0'),true);
  await run('document.querySelector("input").click()');await wait('!document.querySelector("button").disabled');await run('document.querySelector("button").click();document.querySelector("button")?.click()');await wait('window.calls.length===1');
  assert.deepEqual(await run('window.calls[0].body'),{hash:'a'.repeat(64)});assert.match(await run('window.calls[0].url'),/\\/commit$/);
  await wait('document.querySelectorAll("button").length===0');assert.equal(await run('document.querySelector("article>details").open'),false);
  assert.equal(await run('document.querySelector("summary").textContent.includes("Applied")'),true);
  await win.reload();await wait('!!document.querySelector("article")');assert.equal(await run('document.querySelectorAll("button").length'),0);assert.equal(await run('document.querySelector("article>details").open'),false);
  for(const status of ['cancelled','expired','stale']){await run('window.reset('+JSON.stringify(status)+')');await delay(30);assert.equal(await run('document.querySelectorAll("button").length'),0)}
  await run('window.reset();window.fail=true');await delay(30);await run('document.querySelector("input").click()');await wait('!document.querySelector("button").disabled');await run('document.querySelector("button").click()');await wait('!!document.querySelector("[role=alert]")');assert.match(await run('document.querySelector(".action-hint").textContent'),/failed/);assert.equal(await run('document.querySelector("button").disabled'),true);
  await run('window.fail=false;window.reset();window.hold=true');await delay(30);await run('document.querySelector("input").click()');await wait('!document.querySelector("button").disabled');await run('document.querySelector("button").click()');await wait('!!window.release');assert.match(await run('document.querySelector(".action-hint").textContent'),/Applying your decision/);
  const beforeSwitch=await run('window.updates');await run('window.switch()');await delay(30);assert.equal(await run('window.calls.at(-1).signal.aborted'),true);await run('window.fail=true;window.release()');await delay(50);assert.equal(await run('!!document.querySelector("[role=alert]")'),false);assert.equal(await run('window.updates'),beforeSwitch);assert.equal(await run('document.querySelector(".status-badge").textContent'),'Awaiting approval');assert.equal(await run('document.querySelector("input").checked'),false);
  await run('window.fail=false;window.commitSuccess=false;window.release=undefined;document.querySelector("input").click()');await wait('!document.querySelector("button").disabled');await run('document.querySelector("button").click()');await wait('!!window.release');const beforeUnmount=await run('window.updates');await run('window.view.shown=false');await delay(30);assert.equal(await run('window.calls.at(-1).signal.aborted'),true);await run('window.release();window.view.shown=true');await delay(50);assert.equal(await run('window.updates'),beforeUnmount);assert.equal(await run('document.querySelector("input").checked'),false);assert.equal(await run('document.querySelector("button").disabled'),true);
  assert.equal(await run('window.calls.length'),3,'obsolete responses never replay a decision');
  win.close();app.exit(0)})().catch(error=>{console.error(error);app.exit(1)});`
  await writeFile(resolve(directory,'main.cjs'),script)
  const require=createRequire(new URL('../../desktop/package.json',import.meta.url));const env:NodeJS.ProcessEnv={}
  for(const key of ['PATH','DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR'])if(process.env[key])env[key]=process.env[key]
  for(const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TMP','TEMP','TMPDIR','XDG_CONFIG_HOME','XDG_CACHE_HOME'])env[key]=directory
  const child=spawn(require('electron') as string,[resolve(directory,'main.cjs')],{cwd:directory,env,stdio:['ignore','pipe','pipe']});let log=''
  child.stdout.on('data',chunk=>{log+=chunk});child.stderr.on('data',chunk=>{log+=chunk})
  const timer=setTimeout(()=>child.kill(),50000);t.after(()=>{clearTimeout(timer);if(child.exitCode===null)child.kill()})
  const [code]=await once(child,'close');assert.equal(code,0,log)
})
