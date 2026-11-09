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
import UnoCSS from 'unocss/vite'
const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
test('isolated Work board keeps read receipts explicit and completed history accessible', { timeout: 90000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `work-completions-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const server = await createServer({ configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    optimizeDeps: { noDiscovery: true, include: ['vue', 'vue-router', 'vue-i18n', 'zod', 'dompurify'] },
    plugins: [{ name: 'isolate-unrelated-panels', enforce: 'pre', transform(source, id) {
      if (!id.replaceAll('\\', '/').endsWith('/components/ProjectWorkbench.vue')) return
      return source.replace(/import (QuickActions|ProjectGitHub|ProjectMicroApps|ProjectUsage) from '[^']+'/g, 'const $1 = { render: () => null }')
    } }, vue(), UnoCSS({ configFile: resolve(root, 'app/unocss.config.ts') }), {
      name: 'completion-fixture', resolveId: id => id === '/completion-entry.ts' ? '\0completion-entry' : undefined,
      load: id => id !== '\0completion-entry' ? undefined : `
        import '/src/styles.css'; import 'uno.css';
        import {createApp,h,reactive} from 'vue'; import {createRouter,createMemoryHistory} from 'vue-router';
        import ProjectWorkbench from '/src/components/ProjectWorkbench.vue'; import {i18n} from '/src/i18n.ts';
        const record={key:'topic:web:done',subject:{kind:'topic',sessionId:'web:done'},revision:1,sequence:2,
          definition:{objective:'Finished outcome',acceptance:[],boundaries:[],evidence:[]},origin:'human',changedBy:'human',changedAt:'2026-01-01T00:00:00Z',change:'goal',reason:'Fixture',paused:false,
          workflow:{title:'Finished outcome',manager:null,assignee:null,assignmentRevision:1,status:'done',dependencies:[],result:{summary:'Actual measured result',evidence:[]}},authority:{manager:null,executor:null,active:false},history:[]};
        const item={key:record.key,title:'Finished outcome',revision:1,sequence:2,status:'done',parentKey:null,dependencies:[],blockedReason:null,manager:null,assignee:null,paused:false,adopted:false,proposals:0,interpretationReview:false,changedAt:record.changedAt,result:record.workflow.result};
        const state=reactive({value:{items:[item,{...item,key:'topic:web:active',title:'Current work',status:'in_progress',result:undefined}],sessions:[],requests:[],effects:[]},revision:1,loading:false});
        const completions=[{key:item.key,completionId:'first',sequence:2,completedAt:'2026-01-02T00:00:00Z',unread:true}];
        window.writes=[]; window.state=state; window.record=record; window.completions=completions;
        window.setLocale=value=>{i18n.global.locale.value=value};
        window.requestPaths=[];
        window.fetch=async(url,options)=>{
          window.requestPaths.push(String(url));
          if(String(url).endsWith('/api/work/completions')) {
            if(options?.method==='POST'){if(window.failReads)return new Response('{}',{status:500});const body=JSON.parse(options.body);window.writes.push(body);for(const ref of body.items){const item=completions.find(item=>item.key===ref.key&&item.completionId===ref.completionId);if(item)item.unread=false;}}
            return new Response(JSON.stringify({items:completions}));
          }
          return new Response(JSON.stringify({records:[record],effects:[]}));
        };
        const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',component:{render:()=>null}}]});
        await router.push('/');await router.isReady();
        const app=createApp({render:()=>h(ProjectWorkbench,{apiBase:location.origin,projectId:'test',projectName:'Completion fixture',visible:true})});
        app.use(router);app.provide(Symbol.for('shadow.project-live-state'),{acquireProject:()=>({work:{state,refresh:async()=>{}},release(){}})});
        app.provide(Symbol.for('shadow.live-client-pool'),{client:()=>({subscribe:()=>({ready:async()=>{},close(){}})})});app.mount('#app');`,
      configureServer(server) { server.middlewares.use((request,response,next)=>{
        if(request.url!=='/__completions')return next();response.setHeader('Content-Type','text/html');response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body style="margin:0"><div id="app" style="height:100vh;display:flex"></div><script type="module" src="/completion-entry.ts"></script></body></html>')
      }) },
    }], server: { host: '127.0.0.1', port: 0, watch: null, hmr: false } })
  t.after(()=>server.close());await server.listen()
  const main=resolve(directory,'main.cjs')
  await writeFile(main, `
    const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');
    app.setPath('userData',${JSON.stringify(directory)});
    app.whenReady().then(async()=>{try{
      const win=new BrowserWindow({show:false,width:1250,height:950,webPreferences:{contextIsolation:true,nodeIntegration:false,offscreen:true,backgroundThrottling:false}});
      await win.loadURL(${JSON.stringify(new URL('__completions',server.resolvedUrls!.local[0]).href)});
      const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');
      const capture=async name=>{if(!process.env.WORK_COMPLETION_SCREENSHOTS)return;await new Promise(r=>setTimeout(r,200));const fs=require('node:fs/promises');await fs.mkdir(process.env.WORK_COMPLETION_SCREENSHOTS,{recursive:true});await fs.writeFile(require('node:path').join(process.env.WORK_COMPLETION_SCREENSHOTS,name+'.png'),(await win.webContents.capturePage()).toPNG(),{flag:'wx'});};
      const wait=async fn=>{for(let i=0;i<200;i++){if(await run(fn))return;await new Promise(r=>setTimeout(r,50));}throw new Error('Timed out: '+fn.toString()+' BODY '+await run(()=>document.body.innerText.slice(0,2000)));};
      await wait(()=>!!document.querySelector('.completion-entry'));
      assert.deepEqual(await run(()=>window.writes),[]);
      assert.deepEqual(await run(()=>[...document.querySelectorAll('.work-view-switch button')].map(el=>el.textContent)),['Dashboard','Board','Usage']);
      const transparentCanvas=selector=>win.webContents.executeJavaScript('('+((selector)=>{let el=document.querySelector(selector);if(!el)return false;while(el&&el!==document.body){const style=getComputedStyle(el);if(style.backgroundColor!=='rgba(0, 0, 0, 0)'||style.backgroundImage!=='none')return false;el=el.parentElement}return getComputedStyle(document.body).backgroundImage.includes('radial-gradient')}).toString()+')('+JSON.stringify(selector)+')');
      await wait(()=>!!document.querySelector('.graph-canvas .vue-flow'));
      for(const dark of [false,true]){
        await win.webContents.executeJavaScript('document.documentElement.classList.toggle("dark",'+dark+')');
        assert.equal(await transparentCanvas('.graph-canvas .vue-flow'),true,'Overview exposes the existing body dots through every canvas ancestor');
        assert.equal(await run(()=>!!document.querySelector('.vue-flow__background')),false,'No duplicate dot layer');
        assert.notEqual(await run(()=>getComputedStyle(document.querySelector('.canvas-toolbar')).backgroundColor),'rgba(0, 0, 0, 0)');
        await capture('overview-1250-'+(dark?'dark':'light'));
      }
      await run(()=>document.documentElement.classList.remove('dark'));
      await run(()=>[...document.querySelectorAll('button')].find(el=>el.textContent==='Board').click());
      await wait(()=>!!document.querySelector('.work-board'));
      await wait(()=>document.querySelector('.work-board').textContent.includes('Finished outcome'));
      assert.equal(await run(()=>[...document.querySelectorAll('.work-column h3')].some(el=>el.textContent.includes('Done'))),true);
      assert.deepEqual(await run(()=>window.writes),[],'Rendering done cards is not reading their details');
      await capture('active-board-1250-en');
      await run(()=>{
        window.originalItems=window.state.value.items;
        const base=window.originalItems[0];
        window.state.value.items=[{...base,key:'finished-parent',title:'Completed parent group'},...Array.from({length:3000},(_,i)=>({...base,key:'bulk-'+i,parentKey:'finished-parent',title:'Measured card '+i,
          blockedReason:i%3===0?'Variable height blocker with a long wrapping explanation. '.repeat(2+i%8):null,
          dependencies:i%2?['dependency']:[]}))];
      });
      await wait(()=>document.querySelector('[data-status="done"] h3').textContent.includes('3001'));
      await new Promise(r=>setTimeout(r,200));
      assert.ok(await run(()=>document.querySelectorAll('.work-item-card').length)<30,'3001 cards mount only a measured viewport');
      assert.match(await run(()=>document.querySelector('[data-status="done"]').textContent),/Completed parent group/);
      const noOverlap=()=>{const rows=[...document.querySelectorAll('[data-status="done"] .lane-row')].map(el=>el.getBoundingClientRect()).sort((a,b)=>a.top-b.top);return rows.every((rect,i)=>!i||rect.top>=rows[i-1].bottom-1)};
      assert.equal(await run(noOverlap),true);
      await run(()=>{document.querySelector('[data-status="done"] .work-lane').scrollTop=180000});
      await new Promise(r=>setTimeout(r,350));
      assert.ok(await run(()=>[...document.querySelectorAll('[data-status="done"] .work-item-card')].some(el=>Number(el.dataset.workKey.split('-')[1])>500)));
      assert.equal(await run(noOverlap),true);
      console.log('VIRTUAL_BOARD_DOM '+JSON.stringify(await run(()=>({items:window.state.value.items.length,mounted:document.querySelectorAll('.work-item-card').length,heights:[...document.querySelectorAll('[data-status="done"] .lane-row')].map(el=>el.getBoundingClientRect().height)}))));
      await run(()=>{const lane=document.querySelector('[data-status="done"] .work-lane');lane.focus();lane.dispatchEvent(new KeyboardEvent('keydown',{key:'End',bubbles:true,cancelable:true}));});
      await wait(()=>document.activeElement?.textContent==='Measured card 2999');
      await new Promise(r=>setTimeout(r,250));
      assert.equal(await run(noOverlap),true);
      assert.ok(await run(()=>document.querySelectorAll('.work-item-card').length)<30);
      await capture('virtual-board-end-1250-light');
      await run(()=>document.activeElement.click());
      await wait(()=>window.requestPaths.some(path=>path.endsWith('/api/work/bulk-2999')));
      assert.deepEqual(await run(()=>window.writes),[]);
      await run(()=>[...document.querySelectorAll('button')].find(el=>el.getAttribute('aria-label')==='Close coordination panel').click());
      await wait(()=>!!document.querySelector('[data-status="done"] .work-lane'));
      await run(()=>{const lane=document.querySelector('[data-status="done"] .work-lane');lane.focus();lane.dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true,cancelable:true}));});
      await wait(()=>document.activeElement?.textContent==='Completed parent group');
      await run(()=>document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'Tab',bubbles:true,cancelable:true})));
      await wait(()=>document.activeElement?.textContent==='Measured card 0');
      await run(()=>document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true,cancelable:true})));
      await wait(()=>document.activeElement?.textContent==='Measured card 1');
      await run(()=>document.activeElement.click());
      await wait(()=>!!document.querySelector('.alignment-heading'));
      assert.deepEqual(await run(()=>window.writes),[],'Unrelated or stale detail must not acknowledge the original completion');
      await run(()=>[...document.querySelectorAll('button')].find(el=>el.getAttribute('aria-label')==='Close coordination panel').click());
      await run(()=>{const input=document.querySelector('.work-search input');input.value='Measured card 2999';input.dispatchEvent(new Event('input',{bubbles:true}));});
      await wait(()=>document.querySelectorAll('.work-item-card').length===1);
      assert.equal(await run(()=>document.querySelector('.work-title').textContent),'Measured card 2999');
      await run(()=>{window.state.value.items.at(-1).status='blocked'});
      await wait(()=>!!document.querySelector('[data-status="blocked"] .work-item-card')&&!document.querySelector('[data-status="done"] .work-item-card'));
      await run(()=>{const input=document.querySelector('.work-search input');input.value='';input.dispatchEvent(new Event('input',{bubbles:true}));});
      await wait(()=>document.querySelectorAll('.work-item-card').length>1);
      for(const width of [1250,390]){
        win.setSize(width,950);
        await new Promise(r=>setTimeout(r,200));
        if(width===390){
          await wait(()=>!!document.querySelector('.lane-picker'));
          await run(()=>document.querySelector('.lane-picker [role="combobox"]').click());
          await wait(()=>!!document.querySelector('[role="option"]'));
          await run(()=>[...document.querySelectorAll('[role="option"]')].find(el=>el.textContent.includes('Done')).click());
          await wait(()=>!!document.querySelector('[data-status="done"]'));
          assert.equal(await run(()=>document.querySelectorAll('.work-column').length),1);
        }
        for(const dark of [false,true]){
          await win.webContents.executeJavaScript('document.documentElement.classList.toggle("dark",'+dark+')');
          await new Promise(r=>setTimeout(r,200));
          assert.equal(await run(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);
          assert.equal(await run(()=>{const lane=document.querySelector('[data-status="done"] .work-lane');return lane.clientHeight>100&&lane.scrollHeight>lane.clientHeight}),true);
          assert.equal(await run(noOverlap),true);
          assert.equal(await transparentCanvas('[data-status="done"] .work-lane'),true,'Board lanes expose the existing body dots');
          assert.notEqual(await run(()=>getComputedStyle(document.querySelector('.work-item-card')).backgroundColor),'rgba(0, 0, 0, 0)','Cards retain readable surfaces in both themes');
          assert.notEqual(await run(()=>getComputedStyle(document.querySelector('.work-search input')).backgroundColor),'rgba(0, 0, 0, 0)');
          assert.ok(await run(()=>document.querySelectorAll('.work-item-card').length)<35);
          await capture('virtual-board-'+width+'-'+(dark?'dark':'light'));
        }
      }
      win.setSize(1250,950);
      await run(()=>{document.documentElement.classList.remove('dark');window.state.value.items=window.originalItems;});
      await wait(()=>document.querySelector('.work-board').textContent.includes('Finished outcome'));
      await run(()=>document.querySelector('.completion-entry').click());
      await wait(()=>!!document.querySelector('.completion-history article'));
      assert.match(await run(()=>document.querySelector('.completion-history').textContent),/Actual measured result/);
      await capture('unread-results-1250-en');
      assert.deepEqual(await run(()=>window.writes),[]);
      await run(()=>document.querySelector('.result-heading button').click());
      await wait(()=>window.writes.length===1);
      assert.equal(await run(()=>window.writes[0].items[0].completionId),'first');
      await run(()=>[...document.querySelectorAll('button')].find(el=>el.getAttribute('aria-label')==='Close coordination panel').click());
      await run(()=>[...document.querySelectorAll('.completion-history button')].find(el=>el.textContent==='Unread only').click());
      await wait(()=>!!document.querySelector('.completion-history article'));
      assert.equal(await run(()=>window.writes.length),1);
      await run(()=>{window.completions[0]={...window.completions[0],completionId:'second',sequence:3,unread:true};window.state.revision++;});
      await wait(()=>!!document.querySelector('.completion-entry'));
      assert.equal(await run(()=>window.writes.length),1);
      await run(()=>document.querySelector('.result-heading button').click());
      await wait(()=>!!document.querySelector('.alignment-heading'));
      await new Promise(r=>setTimeout(r,200));
      assert.equal(await run(()=>window.writes.length),1,'A detail snapshot older than the completion must not mark it read');
      await run(()=>[...document.querySelectorAll('button')].find(el=>el.getAttribute('aria-label')==='Close coordination panel').click());
      await run(()=>{window.failReads=true;[...document.querySelectorAll('button')].find(el=>el.textContent==='Mark all as read').click();});
      await wait(()=>!!document.querySelector('.workbench-error'));
      assert.equal(await run(()=>window.writes.length),1);
      await run(()=>{window.failReads=false;document.querySelector('.workbench-error button').click();});
      await wait(()=>!document.querySelector('.workbench-error'));
      await run(()=>[...document.querySelectorAll('button')].find(el=>el.textContent==='Mark all as read').click());
      await wait(()=>window.writes.length===2);
      assert.equal(await run(()=>window.writes[1].items[0].completionId),'second');
      await run(()=>document.querySelector('.result-heading button').click());
      await run(()=>[...document.querySelectorAll('button')].find(el=>el.textContent==='Apps').click());
      await run(()=>{window.record.sequence=4;window.completions[0]={...window.completions[0],completionId:'third',sequence:4,unread:true};window.state.revision++;});
      await new Promise(r=>setTimeout(r,200));
      assert.equal(await run(()=>window.writes.length),2,'A hidden detail must not acknowledge background completion');
      await run(()=>[...document.querySelectorAll('button')].find(el=>el.textContent==='Back to work').click());
      await wait(()=>window.writes.length===3);
      await run(()=>[...document.querySelectorAll('button')].find(el=>el.getAttribute('aria-label')==='Close coordination panel').click());
      for(const width of [1250,390]){win.setSize(width,950);for(const locale of ['en','zh-CN']){
        await win.webContents.executeJavaScript('window.setLocale('+JSON.stringify(locale)+')');await run(()=>document.documentElement.classList.toggle('dark'));
        await new Promise(r=>setTimeout(r,150));assert.equal(await run(()=>document.documentElement.scrollWidth<=document.documentElement.clientWidth),true);
        if(width===390)assert.ok(await run(()=>document.querySelector('.result-heading button').getBoundingClientRect().height)>=44);
        await capture('completed-history-'+width+'-'+locale);
      }}
      console.log('WORK_COMPLETIONS_OK');app.exit(0);
    }catch(error){console.error(error);app.exit(1);}});
  `)
  const child=spawn(desktopRequire('electron') as string,[main],{cwd:root,env:{...process.env,ELECTRON_RUN_AS_NODE:undefined},stdio:['ignore','pipe','pipe']})
  let output='';child.stdout.setEncoding('utf8').on('data',chunk=>{output+=chunk});child.stderr.setEncoding('utf8').on('data',chunk=>{output+=chunk})
  const timer=setTimeout(()=>child.kill(),80000);t.after(()=>{clearTimeout(timer);if(child.exitCode===null)child.kill()})
  const [code]=await once(child,'close');assert.equal(code,0,output);assert.match(output,/WORK_COMPLETIONS_OK/)
  t.diagnostic(output.match(/VIRTUAL_BOARD_DOM .*/)?.[0] ?? 'No virtual board metrics')
})
