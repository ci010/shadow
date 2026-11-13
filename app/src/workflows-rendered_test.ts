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
import { SESSION_CLEANUP_AUTOMATION } from '../../src/cron/defaults.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
test('workflow visualization renders durable revisions, safe controls, real resource links and responsive read-only states', { timeout: 90_000 }, async t => {
  const directory = resolve(root, '.test-artifacts', `workflows-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const server = await createServer({ configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'cache'), optimizeDeps: { noDiscovery: true, include: ['vue', 'vue-router', '@vue-flow/core'] }, plugins: [vue(), {
    name: 'workflow-fixture', resolveId: id => id === '/workflow-entry.ts' ? '\0workflow-entry' : undefined,
    load(id) { if (id !== '\0workflow-entry') return; return `
      import {createApp,h,reactive} from 'vue'; import {createRouter,createMemoryHistory} from 'vue-router'; import WorkflowManager from '/src/components/WorkflowManager.vue'; import AutomationSidebar from '/src/components/AutomationSidebar.vue'; import '/src/styles.css';
      const source={id:'external:issue-intake',name:'Issue intake',revision:1,enabled:true,owner:'web:owner',source:{kind:'external',id:'synthetic-source'},binding:{demand:{repository:'synthetic/repo'}},gate:{kind:'revision-dedupe',first:'emit'},nodes:[{kind:'work-map',objective:'Review external issues; no execution authority',titleField:'title',revisionField:'updatedAt',ownership:'exclusive-until-local-edit'}]};
      const schedule={id:'schedule:daily',name:'Daily review',revision:2,enabled:false,source:{kind:'schedule',id:'daily'},nodes:[{kind:'schedule-action',action:'agent',job:{task:'Synthetic task',schedule:'every 1h',timezone:'UTC',session:'fresh',agentType:'general'}}]};
      const run={id:'flow-run-not-session',workflow:source.id,definition:structuredClone(source),timestamp:'2026-11-12T10:00:00Z',status:'blocked',cursor:0,attempts:1,nextAt:0,started:true,error:'interrupted_effect',output:{workKey:'work:synthetic'}};
      const github={id:'github:fixture',name:'https://github.com/synthetic/repo/pull/2',revision:1,enabled:true,source:{kind:'github-resource',id:'PR_fixture'},gate:{kind:'revision-dedupe',first:'emit'},nodes:[{kind:'github-notify',subscription:{resourceId:'PR_fixture',workKey:'work:github',sessionId:'web:github-target',assignmentRevision:7,enabled:true,mode:'silent',events:['ci']}}]};
      window.data={projectId:'fixture',sources:[{kind:'external',id:'synthetic-source',enabled:true,nextAt:1794481200000,error:'collection_failed'}],definitions:[source,schedule,github,{...schedule,id:'schedule:fixed',name:'Fixed-session reminder',enabled:true,nodes:[{kind:'schedule-action',action:'session',job:{schedule:'0 9 * * 1',session:'existing',target:{sessionId:'web:fixed-target'},task:'Deliver the weekly reminder'}}]},{...schedule,id:'schedule:cleanup',name:'Session cleanup',nodes:[{kind:'schedule-action',action:'agent',job:${JSON.stringify(SESSION_CLEANUP_AUTOMATION)}}]}],runs:[run,{...run,id:'schedule-run',workflow:schedule.id,definition:{...schedule,revision:1,gate:{kind:'revision-dedupe',first:'emit'}},status:'completed',cursor:1,error:undefined,output:{sessionId:'web:actual-model-session'}}]};
      window.requests=[];window.mode='normal';window.controls=[];window.fixture=reactive({active:true,projectId:'fixture',apiBase:location.origin+'/projects/fixture'});
      window.fetch=async(input,init)=>{const url=new URL(String(input),location.href);window.requests.push(url.pathname);if(url.pathname.endsWith('/control')){window.controls.push(JSON.parse(init.body));return Response.json({saved:true})}if(window.mode==='error')return Response.json({secret:'DO-NOT-DISPLAY'}, {status:403});return Response.json(window.mode==='empty'?{...window.data,definitions:[],runs:[]}:window.data)};
      const router=createRouter({history:createMemoryHistory(),routes:[{path:'/projects/:projectId/workflows',name:'project-workflows',component:WorkflowManager},{path:'/projects/:projectId/chat/:sessionId?',name:'chat',component:{render:()=>h('div','Chat')}},{path:'/projects/:projectId/dashboard',name:'project-dashboard',component:{render:()=>h('div','Work')}}]});window.router=router;await router.push('/projects/fixture/workflows');await router.isReady();
      window.sidebar=reactive({show:false,jobs:[{id:'cron:legacy',name:'Legacy review',source:'cron',session:'fresh',enabled:true,schedule:'daily'}],selected:''});
      const app=createApp({render:()=>window.sidebar.show?h(AutomationSidebar,{projectId:'fixture',apiBase:window.fixture.apiBase,active:true,groups:[],stages:{},onSelect:id=>window.sidebar.selected=id}):h(WorkflowManager,window.fixture)});
      app.provide(Symbol.for('shadow.automation-catalog'),{acquire:()=>({state:reactive({get jobs(){return window.sidebar.jobs},loading:false,loaded:true,error:'',revision:0}),refresh:()=>{},release:()=>{}})});app.use(router).mount('#app');`
    }, configureServer(server) { server.middlewares.use((req,res,next)=>{if(!req.url?.startsWith('/__workflows'))return next();res.setHeader('Content-Type','text/html');res.end('<html><body style="margin:0"><div id="app" style="display:flex;width:100%;height:100vh"></div><script type="module" src="/workflow-entry.ts"></script></body></html>')}) },
  }], server: { host: '127.0.0.1', port: 0, watch: null, hmr: false } })
  await server.listen(); t.after(() => server.close())
  const main = resolve(directory, 'main.cjs')
  await writeFile(main, `const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');app.setPath('userData',${JSON.stringify(directory)});app.whenReady().then(async()=>{const win=new BrowserWindow({show:false,width:1200,height:850,webPreferences:{contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});win.webContents.on('console-message',event=>console.log(event.message));const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');const wait=()=>new Promise(r=>setTimeout(r,250));try{
    await win.loadURL(${JSON.stringify(new URL('__workflows',server.resolvedUrls!.local[0]).href)});
    for(let i=0;i<100;i++){if(await run(()=>document.querySelectorAll('.graph-node').length===12))break;await wait()}
    assert.equal(await run(()=>document.querySelectorAll('.graph-node').length),12);
    assert.equal(await run(()=>document.querySelectorAll('.graph-group').length),5);
    assert.equal(await run(()=>document.querySelectorAll('.vue-flow').length),1);
    assert.equal(await run(()=>document.querySelectorAll('.workflow-inventory').length),0);
    assert.ok(await run(()=>Array.from(document.querySelectorAll('.vue-flow__edge')).every(edge=>{const id=JSON.parse(edge.dataset.id);return window.data.definitions.some(flow=>flow.id===id[0])})));
    assert.ok(await run(()=>Array.from(document.querySelectorAll('.graph-group')).every(group=>{const box=group.getBoundingClientRect();return Array.from(document.querySelectorAll('.graph-node')).filter(node=>node.dataset.flow===group.dataset.workflow).every(node=>{const n=node.getBoundingClientRect();return n.left>=box.left && n.right<=box.right+1 && n.top>=box.top && n.bottom<=box.bottom+1})})));

    assert.equal(await run(()=>document.querySelectorAll('.vue-flow__edge').length),7);
    assert.equal(await run(()=>document.querySelectorAll('.vue-flow__node.draggable,.vue-flow__node.connectable').length),0);
    await wait();
    assert.ok(await run(()=>document.querySelector('.vue-flow__transformationpane').style.transform.includes('scale(1)')));
    assert.equal(await run(()=>document.querySelectorAll('.workflow-inspector').length),0);
    assert.equal(await run(()=>Array.from(document.querySelectorAll('.graph-node')).filter(node=>node.dataset.flow==='schedule:daily').length),2);
    assert.ok(await run(()=>document.querySelector('.workflow-graph').textContent.includes('every 1h')));
    assert.ok(await run(()=>document.querySelector('.workflow-graph').textContent.includes('Timezone: UTC')));
    assert.ok(await run(()=>document.querySelector('.workflow-graph').textContent.includes('web:fixed-target')));
    assert.ok(await run(()=>document.querySelector('.workflow-graph').textContent.includes('Fresh session each run')));
    assert.ok(await run(()=>document.querySelector('.workflow-graph').textContent.includes('Perform recoverable session cleanup')));
    assert.ok(await run(()=>document.querySelector('.workflow-graph').textContent.includes('0 3 * * *')));

    assert.ok(await run(()=>document.querySelector('.graph-group[data-enabled=false]').textContent.includes('Paused')));
    if(${JSON.stringify(process.env.SHADOW_WORKFLOW_SCREENSHOT || '')})require('node:fs').writeFileSync(${JSON.stringify(process.env.SHADOW_WORKFLOW_SCREENSHOT || '')},(await win.webContents.capturePage()).toPNG());
    await run(()=>document.body.dispatchEvent(new KeyboardEvent('keydown',{key:'h',bubbles:true,cancelable:true})));
    assert.equal(await run(()=>Array.from(document.querySelectorAll('.graph-toolbar button')).find(e=>e.textContent.includes('(H)')).getAttribute('aria-pressed')),'false');
    await run(()=>{const pane=document.querySelector('.graph-canvas');pane.focus();pane.dispatchEvent(new KeyboardEvent('keydown',{key:'h',bubbles:true,cancelable:true}))});await wait();
    assert.equal(await run(()=>document.querySelector('.graph-canvas').classList.contains('hand-mode')),true);
    await run(()=>document.querySelector('.graph-canvas').dispatchEvent(new KeyboardEvent('keydown',{key:'v',bubbles:true,cancelable:true})));await wait();
    assert.equal(await run(()=>document.querySelector('.graph-canvas').classList.contains('hand-mode')),false);
    await run(()=>document.querySelector('.graph-canvas').dispatchEvent(new KeyboardEvent('keydown',{key:' ',bubbles:true,cancelable:true})));await wait();
    assert.equal(await run(()=>document.querySelector('.graph-canvas').classList.contains('hand-mode')),true);
    await run(()=>document.querySelector('.graph-canvas').dispatchEvent(new KeyboardEvent('keyup',{key:' ',bubbles:true,cancelable:true})));await wait();
    assert.equal(await run(()=>document.querySelector('.graph-canvas').classList.contains('hand-mode')),false);
    const beforeWheel=await run(()=>document.querySelector('.vue-flow__transformationpane').style.transform);
    assert.equal(await run(()=>{const event=new WheelEvent('wheel',{deltaY:80,bubbles:true,cancelable:true});document.querySelector('.graph-canvas').dispatchEvent(event);return event.defaultPrevented}),true);
    for(let i=0;i<20 && await run(()=>document.querySelector('.vue-flow__transformationpane').style.transform)===beforeWheel;i++)await wait();
    assert.notEqual(await run(()=>document.querySelector('.vue-flow__transformationpane').style.transform),beforeWheel);
    assert.equal(await run(()=>{document.querySelector('.workflow-heading button').focus();const event=new WheelEvent('wheel',{deltaY:80,bubbles:true,cancelable:true});document.querySelector('.graph-canvas').dispatchEvent(event);return event.defaultPrevented}),false);
    const initialZoom=await run(()=>document.querySelector('.vue-flow__transformationpane').style.transform);
    await run(()=>Array.from(document.querySelectorAll('.graph-toolbar button')).find(e=>e.textContent==='Zoom in').click());await wait();
    for(let i=0;i<20 && await run(()=>document.querySelector('.vue-flow__transformationpane').style.transform)===initialZoom;i++)await wait();
    assert.notEqual(await run(()=>document.querySelector('.vue-flow__transformationpane').style.transform),initialZoom);
    assert.equal(await run(()=>window.controls.length),0);
    const beforeMiddle=await run(()=>document.querySelector('.vue-flow__transformationpane').style.transform);
    const point=await run(()=>{const r=document.querySelector('.graph-canvas').getBoundingClientRect();return {x:Math.round(r.right-40),y:Math.round(r.top+100)}});
    win.webContents.sendInputEvent({type:'mouseDown',button:'middle',clickCount:1,...point});
    win.webContents.sendInputEvent({type:'mouseMove',button:'middle',x:point.x-70,y:point.y+30,movementX:-70,movementY:30});
    win.webContents.sendInputEvent({type:'mouseUp',button:'middle',clickCount:1,x:point.x-70,y:point.y+30});
    for(let i=0;i<20 && await run(()=>document.querySelector('.vue-flow__transformationpane').style.transform)===beforeMiddle;i++)await wait();
    assert.notEqual(await run(()=>document.querySelector('.vue-flow__transformationpane').style.transform),beforeMiddle);
    const beforeZoomWheel=await run(()=>document.querySelector('.vue-flow__transformationpane').style.transform);
    await run(()=>{const pane=document.querySelector('.graph-canvas');pane.focus();pane.dispatchEvent(new WheelEvent('wheel',{deltaY:90,ctrlKey:true,clientX:100,clientY:300,bubbles:true,cancelable:true}))});
    for(let i=0;i<20 && await run(()=>document.querySelector('.vue-flow__transformationpane').style.transform)===beforeZoomWheel;i++)await wait();
    assert.notEqual(await run(()=>document.querySelector('.vue-flow__transformationpane').style.transform),beforeZoomWheel);
    assert.equal(await run(()=>{const pane=document.querySelector('.graph-canvas');const event=new KeyboardEvent('keydown',{key:'!',code:'Digit1',shiftKey:true,bubbles:true,cancelable:true});pane.dispatchEvent(event);return event.defaultPrevented}),true);
    await run(()=>document.querySelector('.group-heading').click());await wait();
    assert.ok(await run(()=>document.querySelector('aside.workflow-inspector')));
    assert.equal(await run(()=>{const pane=document.querySelector('.graph-canvas');pane.focus();const event=new KeyboardEvent('keydown',{key:'@',code:'Digit2',shiftKey:true,bubbles:true,cancelable:true});pane.dispatchEvent(event);return event.defaultPrevented}),true);
    await wait();

    assert.ok(await run(()=>document.querySelector('.workflow-inspector').getBoundingClientRect().left>document.querySelector('.workflow-graph').getBoundingClientRect().left));
    if(${JSON.stringify(process.env.SHADOW_WORKFLOW_SCREENSHOT || '')})require('node:fs').writeFileSync(${JSON.stringify((process.env.SHADOW_WORKFLOW_SCREENSHOT || '') + '.inspector.png')},(await win.webContents.capturePage()).toPNG());
    assert.ok(await run(()=>document.body.textContent.includes('A workflow run is not a model session')));
    assert.equal(await run(()=>document.querySelectorAll('input,textarea,select,[draggable=true],form').length),0);
    assert.ok(await run(()=>document.body.textContent.includes('Source collection failed.')));
    assert.ok(await run(()=>document.body.textContent.includes('Next collection check')));
    await run(()=>document.querySelector('.workflow-run-choice').click());await wait();
    assert.ok(await run(()=>document.querySelector('.workflow-run-detail').textContent.includes('flow-run-not-session')));
    assert.equal(await run(()=>document.querySelector('a[href*="actual-model-session"]')),null);
    assert.ok(await run(()=>document.querySelector('a[href*="work=work"]')));
    assert.ok(await run(()=>document.querySelector('.workflow-node[data-state=blocked]')));
    assert.ok(await run(()=>document.querySelector('.graph-node[data-state=blocked]')));
    await run(()=>Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()==='Retry run').click());await wait();
    assert.equal(await run(()=>window.controls.length),0);assert.ok(await run(()=>document.querySelector('.workflow-confirm')));
    await run(()=>Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()==='Keep blocked').click());await wait();assert.equal(await run(()=>window.controls.length),0);
    await run(()=>{Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()==='Retry run').click()});await wait();
    await run(()=>Array.from(document.querySelectorAll('button')).find(e=>e.textContent.trim()==='I inspected effects — retry').click());await wait();
    assert.deepEqual(await run(()=>window.controls[0]),{id:'flow-run-not-session',action:'retry',acknowledgeReplay:true});
    await run(()=>{window.data.definitions[0].revision=2;window.data.definitions[0].name='Edited in chat';window.data.definitions[0].nodes=[{kind:'record',label:'<img src=x onerror=alert(1)>'}];document.querySelector('.workflow-heading button').click()});await wait();
    assert.ok(await run(()=>document.querySelector('.workflow-title').textContent.includes('Edited in chat')));
    assert.ok(await run(()=>document.querySelector('.workflow-map-heading').textContent.includes('Revision 1')));
    assert.ok(await run(()=>document.querySelector('.workflow-graph').textContent.includes('Map to Work')));
    await run(()=>Array.from(document.querySelectorAll('.workflow-map-heading button')).find(e=>e.textContent.trim()==='Current definition').click());await wait();
    assert.ok(await run(()=>document.querySelector('.workflow-map-heading').textContent.includes('Revision 2')));
    assert.ok(await run(()=>document.querySelector('.workflow-graph').textContent.includes('Record')));
    await run(()=>{document.querySelector('.graph-text > summary').click();document.querySelectorAll('.workflow-node summary')[2].click()});await wait();
    assert.equal(await run(()=>document.querySelectorAll('.workflow-node img').length),0);assert.ok(await run(()=>document.querySelector('.graph-text pre').textContent.length>0));
    await run(()=>document.querySelectorAll('.group-heading')[1].click());await wait();await run(()=>document.querySelector('.workflow-run-choice').click());await wait();
    assert.ok(await run(()=>document.querySelector('a[href*="actual-model-session"]')));
    assert.equal(await run(()=>Array.from(document.querySelectorAll('.graph-node')).filter(node=>node.dataset.flow==='schedule:daily').length),3,'Legacy run snapshot still displays its actual gate');
    assert.ok(await run(()=>window.requests.every(p=>p.startsWith('/projects/fixture/api/workflows'))));
    await run(()=>document.querySelectorAll('.group-heading')[2].click());await wait();
    assert.ok(await run(()=>document.querySelector('.workflow-graph').textContent.includes('github-resource · PR_fixture')));
    assert.ok(await run(()=>document.querySelector('.graph-text').textContent.includes('web:github-target')));
    assert.ok(await run(()=>document.querySelector('.graph-text').textContent.includes('work:github · r7')));
    assert.ok(await run(()=>document.querySelector('a[href*="github-target"]')));
    assert.ok(await run(()=>document.body.textContent.includes('Inbox acceptance is not user visibility or completed Work.')));
    await run(()=>{const flow=window.data.definitions[3];window.data.runs.push({...window.data.runs[0],id:'fixed-running',workflow:flow.id,definition:flow,status:'running',cursor:0,error:undefined});document.querySelector('.workflow-heading button').click()});await wait();
    assert.ok(await run(()=>document.querySelector('.vue-flow__edge.animated')));
    win.webContents.debugger.attach('1.3');await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await wait();
    assert.equal(await run(()=>getComputedStyle(document.querySelector('.vue-flow__edge.animated path')).animationName),'none');
    win.webContents.debugger.detach();
    await run(()=>{window.mode='error';document.querySelector('.workflow-heading button').click()});await wait();
    assert.ok(await run(()=>document.querySelector('[role=alert]')));assert.ok(await run(()=>!document.body.textContent.includes('DO-NOT-DISPLAY')));assert.equal(await run(()=>document.querySelector('.workflow-title button').disabled),true);
    await run(()=>{window.mode='normal';document.querySelector('.workflow-heading button').click()});await wait();
    for(const dark of [false,true]){await win.webContents.executeJavaScript('document.documentElement.classList.toggle("dark",'+dark+')');for(const width of [1200,390]){win.setSize(width,850);await wait();assert.ok(await run(()=>document.documentElement.scrollWidth<=innerWidth));assert.ok(await run(()=>document.querySelector('.workflow-heading').getBoundingClientRect().height<160));assert.equal(await run(()=>document.querySelectorAll('input,textarea,form,[draggable=true]').length),0)}}
    if(${JSON.stringify(process.env.SHADOW_WORKFLOW_SCREENSHOT || '')})require('node:fs').writeFileSync(${JSON.stringify((process.env.SHADOW_WORKFLOW_SCREENSHOT || '') + '.narrow.png')},(await win.webContents.capturePage()).toPNG());
    await run(()=>document.querySelector('.inspector-toolbar button').click());await wait();
    assert.equal(await run(()=>document.querySelector('.workflow-inspector')),null);
    await run(()=>document.querySelector('.graph-node').click());await wait();
    assert.equal(await run(()=>document.querySelector('.graph-text').open),true);
    assert.equal(await run(()=>document.querySelector('.workflow-node').open),true);
    await run(()=>{document.querySelector('.workflow-heading button').focus()});assert.equal(await run(()=>document.activeElement.textContent.trim()),'Refresh');
    await run(()=>{window.mode='empty';document.querySelector('.workflow-heading button').click()});await wait();assert.ok(await run(()=>document.querySelector('.workflow-empty').textContent.includes('No workflows yet')));
    await run(()=>{window.fixture.active=false});await wait();const count=await run(()=>window.requests.length);await run(()=>document.querySelector('.workflow-heading button').click());await wait();assert.equal(await run(()=>window.requests.length),count);
    await run(()=>{window.fixture.projectId='other';window.fixture.apiBase=location.origin+'/projects/other';window.data={projectId:'other',definitions:[],runs:[]};window.fixture.active=true});await wait();assert.ok(await run(()=>window.requests.at(-1).startsWith('/projects/other/')));
    await run(()=>{window.sidebar.show=true});await wait();
    assert.equal(await run(()=>document.querySelector('.automations-heading').getAttribute('aria-label')),'Workflows');
    assert.ok(await run(()=>document.querySelector('a[href="/projects/fixture/workflows"]')));
    await run(()=>document.querySelector('[data-automation-id="cron:legacy"]').click());await wait();
    assert.equal(await run(()=>window.sidebar.selected),'cron:legacy');
    await run(()=>{window.sidebar.jobs=[]});await wait();
    assert.ok(await run(()=>document.querySelector('a[href="/projects/fixture/workflows"]')));
    await run(()=>document.querySelector('.automations-heading').click());await wait();
    assert.equal(await run(()=>document.querySelector('.automations-heading').getAttribute('aria-expanded')),'false');
    console.log('WORKFLOW_RENDERED_OK');app.exit(0);
  }catch(error){console.error(error);app.exit(1)}});`)
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['SystemRoot','WINDIR','PATH','Path','ComSpec','PATHEXT','DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR']) if (process.env[key] !== undefined) env[key] = process.env[key]
  for (const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TMP','TEMP','TMPDIR','XDG_CONFIG_HOME','XDG_CACHE_HOME']) env[key] = directory
  const child = spawn(desktopRequire('electron') as string, [main], { cwd: directory, env, windowsHide: true, stdio: ['ignore','pipe','pipe'] }); let output = ''
  child.stdout.setEncoding('utf8').on('data', chunk => output += chunk); child.stderr.setEncoding('utf8').on('data', chunk => output += chunk)
  const timer = setTimeout(() => child.kill(), 75_000); t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close'); assert.equal(code, 0, output); assert.match(output, /WORKFLOW_RENDERED_OK/)
})
