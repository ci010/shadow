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
test('automation dispatch model selection saves, resets and remains in bottom dock at desktop and mobile widths', { timeout: 90_000 }, async t => {
  const directory = resolve(root, '.test-artifacts', `automation-detail-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const chatSource = await readFile(resolve(root, 'app/src/components/ChatTab.vue'), 'utf8')
  const chatStyles = chatSource.split('<style scoped>')[1]!.split('</style>')[0]!
  assert.ok(chatSource.indexOf('<AutomationConversationSettings') > chatSource.indexOf('ref="composerDock"'))
  const detail = await readFile(resolve(root, 'app/src/components/AutomationDetail.vue'), 'utf8')
  assert.ok(detail.indexOf('<AutomationConversationSettings') > detail.indexOf('<slot />'))
  assert.match(detail, /!selectedSessionId/)
  const server = await createServer({ configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'cache'), optimizeDeps: { noDiscovery: true, include: ['vue'] }, plugins: [vue(), {
    name: 'automation-workspace-fixture', resolveId: id => id === '/automation-detail-entry.ts' ? '\0automation-detail-entry' : undefined,
    load(id) { if (id !== '\0automation-detail-entry') return; return `
      import {createApp,h,ref} from 'vue'; import Settings from '/src/components/AutomationConversationSettings.vue'; import {provideModelSelection} from '/src/model-selection.ts'; import '/src/styles.css';
      const job=ref({id:'system:work-organizer',name:'Organization',source:'system',schedule:'Event driven',enabled:true,canConfigureModel:true,defaultModel:'quick@provider'});
      window.patches=[];window.saved=0;window.fail=false;
      window.fetch=async (url,init)=>{if(init?.method==='PATCH'){const body=JSON.parse(init.body);window.patches.push({url:String(url),body}); if(window.fail)return new Response('{}',{status:403});job.value={...job.value,model:body.model??undefined};return Response.json({automation:job.value})}return Response.json({profile:{usage:{providerCalls:2,inputTokens:120,outputTokens:30,totalTokens:150},frequency:{description:'Event driven',scope:'runtime'},runs:{total:1},window:{from:'2026-10-11T00:00:00Z',asOf:'2026-10-12T00:00:00Z'},coverage:'complete',limitations:[]}})};
      createApp({setup(){provideModelSelection({current:ref('project@provider'),options:ref(['quick@provider','chosen@provider']),disabled:ref(true),loading:ref(false),error:ref(''),select:async()=>{throw Error('must not mutate run session')}});return()=>h('div',{style:'display:flex;flex-direction:column;height:100vh;width:100%;min-width:0'},[h('div',{class:'chat-messages',style:'flex:1;min-height:0'},'Read-only automation transcript'),h('div',{class:'conversation-dock',style:'position:relative;flex:0 0 auto'},[h(Settings,{apiBase:'http://localhost/api/projects/fixture',job:job.value,active:true,onSaved:()=>window.saved++})])])}}).mount('#app');`
    }, configureServer(server) { server.middlewares.use((req,res,next)=>{if(!req.url?.startsWith('/__automation_detail'))return next();res.setHeader('Content-Type','text/html');res.end('<html><head><style>'+chatStyles.replaceAll(':deep(', ':is(')+'</style></head><body style="margin:0"><div id="app" style="display:flex;width:100%;height:100vh"></div><script type="module" src="/automation-detail-entry.ts"></script></body></html>')}) },
  }], server:{host:'127.0.0.1',port:0,watch:null,hmr:false} })
  await server.listen(); t.after(()=>server.close())
  const main=resolve(directory,'main.cjs')
  await writeFile(main, `const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict'); app.setPath('userData',${JSON.stringify(directory)});app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1100,height:800,webPreferences:{contextIsolation:true,nodeIntegration:false}});const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');const wait=()=>new Promise(r=>setTimeout(r,400));try{
    await win.loadURL(${JSON.stringify(new URL('__automation_detail',server.resolvedUrls!.local[0]).href)});
    for(let i=0;i<100;i++){if(await run(()=>document.querySelector('.model-label')))break;await wait()}
    assert.ok(await run(()=>document.querySelector('.model-label').textContent.includes('quick')));
    assert.equal(await run(()=>document.querySelector('.settings-row button').disabled),false);
    for(const width of [1100,390]){win.setSize(width,800);await wait();
      assert.ok(await run(()=>document.documentElement.scrollWidth<=innerWidth));
      assert.ok(await run(()=>{const header=document.querySelector('.automation-profile header');const title=header.querySelector('strong');const button=header.querySelector('button');return getComputedStyle(title).whiteSpace==='nowrap' && getComputedStyle(button).whiteSpace==='nowrap' && title.getBoundingClientRect().right<button.getBoundingClientRect().left && !header.querySelector('.frequency')}));
      assert.ok(await run(()=>{const box=document.querySelector('.automation-settings-box');const css=getComputedStyle(box);return css.backgroundColor!=='rgba(0, 0, 0, 0)' && parseFloat(css.borderTopWidth)>0 && css.borderTopLeftRadius===getComputedStyle(document.documentElement).getPropertyValue('--radius-overlay').trim() && css.paddingRight==='12px'}));
      assert.ok(await run(()=>{const card=document.querySelector('.automation-conversation-settings').getBoundingClientRect();return card.left>0 && card.right<innerWidth && !!document.querySelector('.automation-settings-box .settings-row') && !!document.querySelector('.automation-settings-box .automation-profile')}));
      assert.ok(await run(()=>{const stats=document.querySelector('.automation-profile').getBoundingClientRect();const transcript=document.querySelector('.chat-messages').getBoundingClientRect();return stats.top>=transcript.bottom && stats.bottom<=innerHeight+1}));
    }
    await run(()=>document.querySelector('.settings-row button').click());await wait();
    await run(()=>Array.from(document.querySelectorAll('.model-option')).find(e=>e.textContent.includes('chosen')).click());await wait();
    assert.equal(await run(()=>window.saved),1);
    assert.deepEqual(await run(()=>window.patches[0].body),{model:'chosen@provider'});
    assert.ok(await run(()=>window.patches[0].url.endsWith('/api/automations/system%3Awork-organizer')));
    assert.ok(await run(()=>document.querySelector('.model-label').textContent.includes('chosen')));
    await run(()=>document.querySelector('.settings-row button').click());await wait();
    await run(()=>document.querySelector('.model-option').click());await wait();
    assert.deepEqual(await run(()=>window.patches[1].body),{model:null});
    assert.ok(await run(()=>document.querySelector('.model-label').textContent.includes('quick')));
    await run(()=>{window.fail=true;document.querySelector('.settings-row button').click()});await wait();
    await run(()=>Array.from(document.querySelectorAll('.model-option')).find(e=>e.textContent.includes('chosen')).click());await wait();
    assert.equal(await run(()=>window.saved),2);
    assert.ok(await run(()=>document.querySelector('[role=alert]').textContent.includes('denied')));
    assert.ok(await run(()=>document.querySelector('.model-label').textContent.includes('quick')));
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
