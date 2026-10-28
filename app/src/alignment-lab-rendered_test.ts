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
test('unified editor exercises pointer arrangement, source clocks, native imports, locales and other alignment views offline', { timeout: 150_000 }, async t => {
  const directory = resolve(root, '.test-artifacts', `alignment-lab-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  // Screenshots intentionally retained for visual review.
  await mkdir(resolve(root, '.test-artifacts/ui-polish'), { recursive: true })
  const server = await createServer({ configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    optimizeDeps: { noDiscovery: true, include: ['vue', '@annotorious/annotorious', '@vue-flow/core', '@vue-flow/background', '@vue-flow/controls', 'wavesurfer.js', 'wavesurfer.js/dist/plugins/regions.esm.js', 'wavesurfer.js/dist/plugins/timeline.esm.js', 'vue-draggable-plus', '@google/model-viewer'] },
    plugins: [vue(), {
      name: 'alignment-lab-fixture', resolveId: id => id === '/lab-entry.ts' ? '\0lab-entry' : undefined,
      load(id) { if (id === '\0lab-entry') return `import {createApp,nextTick} from 'vue';window.alignmentFlush=nextTick;import Lab from '/src/components/alignment/AlignmentLab.vue';import {setLocalePreference} from '/src/i18n.ts';import '/src/styles.css';setLocalePreference('en');createApp(Lab).mount('#app');` },
      configureServer(server) { server.middlewares.use((req,res,next) => { if (!req.url?.startsWith('/__lab')) return next();res.setHeader('Content-Type','text/html');res.end('<html><body><div id="app"></div><script type="module" src="/lab-entry.ts"></script></body></html>') }) },
    }], server: { host: '127.0.0.1', port: 0, watch: null, hmr: false } })
  await server.listen(); t.after(() => server.close())
  const main = resolve(directory, 'main.cjs')
  await writeFile(main, `
const {app,BrowserWindow,Menu}=require('electron');const assert=require('node:assert/strict');
app.setPath('userData',${JSON.stringify(directory)});
app.whenReady().then(async()=>{
 Menu.setApplicationMenu(null);
 const win=new BrowserWindow({show:false,width:1440,height:900,webPreferences:{contextIsolation:true,nodeIntegration:false}});
 const network=[];win.webContents.session.webRequest.onBeforeRequest((details,callback)=>{if(/^https?:/.test(details.url))network.push(details.url);callback({})});
 win.webContents.on('console-message',(_e,...args)=>console.log('RENDERER',...args));
 const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');
 const exec=code=>win.webContents.executeJavaScript(code);
 const wait=()=>new Promise(r=>setTimeout(r,100));
 const until=async(fn)=>{for(let i=0;i<400;i++){if(await run(fn))return;await wait()}throw new Error('Timed out: '+fn+'; '+await run(()=>document.body.innerText.slice(-3000)))};
 const click=async(selector)=>exec('(async()=>{document.querySelector('+JSON.stringify(selector)+').click();await window.alignmentFlush()})()');
 const fill=async(selector,value)=>exec('(()=>{const el=document.querySelector('+JSON.stringify(selector)+');el.value='+JSON.stringify(value)+';el.dispatchEvent(new Event(el.tagName==="SELECT"?"change":"input",{bubbles:true}));return window.alignmentFlush()})()');
 const input=async(event)=>{
   const type=event.type==='mouseDown'?'pointerdown':event.type==='mouseUp'?'pointerup':'pointermove';
   await exec('window.alignmentPointer=new Promise(resolve=>document.addEventListener('+JSON.stringify(type)+',()=>resolve(),{once:true,capture:true}));true');
   win.webContents.sendInputEvent(event);
   await exec('window.alignmentPointer.then(()=>window.alignmentFlush()).then(()=>new Promise(requestAnimationFrame))');
 };
 const tab=async(id)=>{await click('[data-view="'+id+'"]');await wait()};
 // Read only a newly prepared, render-committed snapshot. A pre-existing textarea
 // can otherwise expose the previous export while Vue/native input work is pending.
 const prepare=async(id)=>{
   await exec('window.alignmentFlush()');
   const disabled=await exec('document.querySelector("#view-'+id+' .intent-prepare").disabled');
   assert.equal(disabled,false,'Request must be valid before preparing');
   await click('#view-'+id+' .intent-prepare');
   const read='(()=>{const root=document.querySelector("#view-'+id+'"),el=root.querySelector(".intent-output textarea");if(!el||root.querySelector(".intent-stale"))return null;const doc=JSON.parse(el.value.slice(el.value.indexOf("{")));return doc.annotations.length===root.querySelectorAll(".intent-target").length?doc:null})()';
   for(let i=0;i<100;i++){const value=await exec(read);if(value)return value;await exec('new Promise(requestAnimationFrame)')}
   throw new Error('Prepared export did not become current: '+id);
 };

 win.setContentSize(1440,900);
 await win.loadURL(${JSON.stringify(new URL('__lab?view=timeline', server.resolvedUrls!.local[0]).href)});
 await until(()=>document.querySelectorAll('#view-storyboard .clip').length===4 && document.querySelector('#view-storyboard .editor')?.getAttribute('aria-busy')==='false' && !!document.querySelector('#view-storyboard .intent-source'));
 assert.equal(await run(()=>document.querySelectorAll('[role="tab"]').length),4);
 // Native range semantics, real units, buttons, endpoints, and actual keyboard input.
 assert.equal(await run(()=>document.querySelector('.alignment-zoom output').textContent.trim()),'48 px/s');
 await click('.zoom-plus'); assert.equal(await run(()=>document.querySelector('.alignment-zoom input').value),'52');
 await click('.zoom-minus'); assert.equal(await run(()=>document.querySelector('.alignment-zoom input').value),'48');
 await run(()=>document.querySelector('.alignment-zoom input').focus());
 win.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'});await wait();
 assert.equal(await run(()=>document.querySelector('.alignment-zoom input').value),'52');
 await fill('.alignment-zoom input','120');assert.equal(await run(()=>document.querySelector('.zoom-plus').disabled),true);
 await fill('.alignment-zoom input','16');assert.equal(await run(()=>document.querySelector('.zoom-minus').disabled),true);
 await fill('.alignment-zoom input','48');

 await fill('#view-storyboard .intent-overall','Keep the quiet opening');
 await click('#view-storyboard .clip-body');
 await until(()=>!!document.querySelector('#view-storyboard .intent-description'));
 await fill('#view-storyboard .intent-description','Hold this shot');
 let board=await prepare('storyboard');assert.equal(board.annotations[0].target.selector.type,'sequence');
 const dragEditor=async(selector,dx)=>{
  const p=await exec('(()=>{const r=document.querySelector('+JSON.stringify(selector)+').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()');
  await input({type:'mouseDown',...p,button:'left',clickCount:1});
  await input({type:'mouseMove',x:p.x+dx,y:p.y,modifiers:['leftButtonDown']});
  await input({type:'mouseUp',x:p.x+dx,y:p.y,button:'left',clickCount:1});
 };
 await dragEditor('#view-storyboard [data-shot-id="arrival"] .right',96);
 assert.equal(await run(()=>document.querySelector('#view-storyboard input[type=number]').value),'6');
 await dragEditor('#view-storyboard [data-shot-id="arrival"] .clip-body',210);
 board=await prepare('storyboard');
 const order=board.annotations.find(a=>a.target.id==='sequence-order').target.selector.shots;
 assert.equal(order[0].id,'window');assert.equal(order[1].duration,6);
 await dragEditor('#view-storyboard .ruler',0);
 assert.ok(await run(()=>parseFloat(document.querySelector('#view-storyboard .time-label').textContent)>0));
 await exec('Array.from(document.querySelectorAll("#view-storyboard .transport button")).find(b=>b.textContent==="Play").click()');
 await until(()=>document.querySelector('#view-storyboard .transport').textContent.includes('Pause'));
 await tab('image');await tab('storyboard');
 assert.ok(await run(()=>document.querySelector('#view-storyboard .transport').textContent.includes('Play')));
 await run(()=>{window.confirm=()=>false});
 await fill('#view-storyboard select[aria-label="Demo scene"]','audio');
 assert.equal(await run(()=>document.querySelector('#view-storyboard .intent-overall').value),'Keep the quiet opening');
 assert.equal(await run(()=>document.querySelector('#view-storyboard select[aria-label="Demo scene"]').value),'storyboard');
 await require('node:fs/promises').writeFile(${JSON.stringify(resolve(root,'.test-artifacts','editor-desktop.png'))},(await win.webContents.capturePage()).toPNG());
 await run(()=>{window.confirm=()=>true});
 await fill('#view-storyboard select[aria-label="Demo scene"]','audio');
 await until(()=>!!document.querySelector('#view-storyboard .source-audio') && document.querySelector('#view-storyboard .editor')?.getAttribute('aria-busy')==='false' && document.querySelector('#view-storyboard .intent-source')?.textContent.includes('Synthesized PCM'));
 assert.equal(await run(()=>document.querySelector('#view-storyboard .intent-overall').value),'');
 await exec('Array.from(document.querySelectorAll("#view-storyboard button")).find(b=>b.textContent==="Anchor range").click()');
 await until(()=>!!document.querySelector('#view-storyboard .intent-description'));
 await fill('#view-storyboard .intent-description','Soften the first tone');
 const time=await prepare('storyboard');assert.equal(time.annotations[0].target.selector.type,'time-range');
 await require('node:fs/promises').writeFile(${JSON.stringify(resolve(root,'.test-artifacts','editor-audio.png'))},(await win.webContents.capturePage()).toPNG());
 assert.equal(await run(()=>Math.round(document.querySelector('#view-storyboard .audio-lane').getBoundingClientRect().width)),576,'12 seconds at 48 px/sec, not viewport width');
 assert.equal(await run(()=>document.querySelectorAll('#view-storyboard .clip').length),0,'Audio must not show unrelated picture clips');
 await dragEditor('#view-storyboard .ruler',0);
 assert.ok(await run(()=>Math.abs(document.querySelector('#view-storyboard audio').currentTime-parseFloat(document.querySelector('#view-storyboard .time-label').textContent))<.1));
 await exec('Array.from(document.querySelectorAll("#view-storyboard .transport button")).find(b=>b.textContent==="Play").click()');
 await until(()=>!document.querySelector('#view-storyboard audio').paused);
 await tab('image');await tab('storyboard');
 assert.equal(await run(()=>document.querySelector('#view-storyboard audio').paused),true);
 // Native local file import uses the same workspace and source-second ruler.
 await exec('(async()=>{const {timelineDemoWav}=await import("/src/alignment-timeline.ts");const input=document.querySelector("#view-storyboard .media-import"),transfer=new DataTransfer();transfer.items.add(new File([timelineDemoWav()],"imported-tone.wav",{type:"audio/wav"}));input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}))})()');
 await until(()=>document.querySelector('#view-storyboard .intent-source').textContent.includes('imported-tone.wav'));
 assert.equal(await run(()=>document.querySelector('#view-storyboard audio').duration),12);
 await exec('Array.from(document.querySelectorAll("#view-storyboard button")).find(b=>b.textContent==="Anchor range").click()');
 await fill('#view-storyboard .intent-description','Imported source range');
 assert.equal((await prepare('storyboard')).annotations[0].target.selector.duration,12);
 // Generate a genuine video file offline via Chromium's canvas encoder.
 await exec('(async()=>{const canvas=document.createElement("canvas");canvas.width=160;canvas.height=90;const ctx=canvas.getContext("2d"),stream=canvas.captureStream(12),chunks=[];const recorder=new MediaRecorder(stream,{mimeType:"video/webm"});const done=new Promise(resolve=>{recorder.onstop=resolve});recorder.ondataavailable=e=>chunks.push(e.data);recorder.start();for(let i=0;i<8;i++){ctx.fillStyle=i%2?"#aaba88":"#334455";ctx.fillRect(0,0,160,90);await new Promise(r=>setTimeout(r,90))};recorder.stop();await done;stream.getTracks().forEach(t=>t.stop());const input=document.querySelector("#view-storyboard .media-import"),transfer=new DataTransfer();transfer.items.add(new File(chunks,"local-video.webm",{type:"video/webm"}));input.files=transfer.files;input.dispatchEvent(new Event("change",{bubbles:true}))})()');
 await until(()=>document.querySelector('#view-storyboard .intent-source').textContent.includes('local-video.webm'));
 await until(()=>document.querySelector('#view-storyboard video')?.readyState>=2);
 await exec('Array.from(document.querySelectorAll("#view-storyboard button")).find(b=>b.textContent==="Anchor range").click()');
 await fill('#view-storyboard .intent-description','Local video range');
 const nativeVideo=await prepare('storyboard');assert.equal(nativeVideo.annotations[0].target.selector.trackId,'video');assert.ok(nativeVideo.annotations[0].target.selector.end<=1);
 await exec('Array.from(document.querySelectorAll("#view-storyboard .transport button")).find(b=>b.textContent==="Play").click()');
 await until(()=>!document.querySelector('#view-storyboard video').paused);
 await tab('image');await tab('storyboard');assert.equal(await run(()=>document.querySelector('#view-storyboard video').paused),true);
 await require('node:fs/promises').writeFile(${JSON.stringify(resolve(root,'.test-artifacts','editor-local-video.png'))},(await win.webContents.capturePage()).toPNG());
 await fill('#view-storyboard select[aria-label="Demo scene"]','video');
 await until(()=>document.querySelectorAll('#view-storyboard .clip').length===4 && document.querySelector('#view-storyboard .editor')?.getAttribute('aria-busy')==='false' && document.querySelector('#view-storyboard .intent-source')?.textContent.includes('Animatic'));
 assert.ok(await run(()=>document.querySelector('#view-storyboard .transport').textContent.includes('Simulated animatic')));
 await exec('Array.from(document.querySelectorAll(".lab-languages button")).find(b=>b.textContent==="中文").click()');
 await wait();
 await require('node:fs/promises').writeFile(${JSON.stringify(resolve(root,'.test-artifacts/ui-polish','editor-zh-desktop.png'))},(await win.webContents.capturePage()).toPNG());
 const zoomRect=await run(()=>{const r=document.querySelector('.alignment-zoom').getBoundingClientRect();return {x:Math.floor(r.x)-6,y:Math.floor(r.y)-6,width:Math.ceil(r.width)+12,height:Math.ceil(r.height)+12}});
 await require('node:fs/promises').writeFile(${JSON.stringify(resolve(root,'.test-artifacts/ui-polish','zoom.png'))},(await win.webContents.capturePage(zoomRect)).toPNG());
 await tab('image');await click('.open-image');await until(()=>!!document.querySelector('.image-prompt-details'));await wait();
 await require('node:fs/promises').writeFile(${JSON.stringify(resolve(root,'.test-artifacts/ui-polish','image-detail.png'))},(await win.webContents.capturePage()).toPNG());
 await tab('storyboard');
 win.setContentSize(430,940);await wait();
 assert.equal(await run(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true);
 await require('node:fs/promises').writeFile(${JSON.stringify(resolve(root,'.test-artifacts/ui-polish','editor-narrow.png'))},(await win.webContents.capturePage()).toPNG());
 win.setContentSize(1440,900);await wait();
 await exec('Array.from(document.querySelectorAll(".lab-languages button")).find(b=>b.textContent==="English").click()');await wait();
 await tab('graph');
 await until(()=>document.querySelectorAll('#view-graph .vue-flow__node').length===5 && document.querySelector('#view-graph .graph-connect')?.disabled===false);
 const nodePoint=await run(()=>{const r=document.querySelector('#view-graph .vue-flow__node[data-id="script"]').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}});
 win.webContents.sendInputEvent({type:'mouseDown',...nodePoint,button:'left',clickCount:1});
 win.webContents.sendInputEvent({type:'mouseUp',...nodePoint,button:'left',clickCount:1});
 await until(()=>document.querySelector('#view-graph .graph-annotate')?.disabled===false);
 await click('#view-graph .graph-annotate');await until(()=>document.querySelectorAll('#view-graph .intent-target').length===1);
 await fill('#view-graph .intent-description','Keep the script grounded in the brief');
 await click('#view-graph .graph-connect');
 await until(()=>document.querySelectorAll('#view-graph .intent-target').length===2);
 await fill('#view-graph .intent-description','Review the brief before generating shots');
 const graph=await prepare('graph');
 assert.deepEqual(graph.annotations.find(a=>a.target.selector.proposedConnection).target.selector.proposedConnection,{source:'brief',target:'review'});
 await until(()=>document.querySelectorAll('#view-graph .vue-flow__edge').length===6);
 await click('#view-graph .intent-remove');
 await until(()=>document.querySelectorAll('#view-graph .vue-flow__edge').length===5);
 await run(()=>{window.originalConfirm=window.confirm;window.confirm=()=>false;window.chooseGraphFixture=()=>{const input=document.querySelector('#view-graph input[type=file]');const transfer=new DataTransfer();transfer.items.add(new File([JSON.stringify({nodes:[{id:'a',label:'Input'},{id:'b',label:'Review'}],edges:[{id:'ab',source:'a',target:'b'}]})],'graph-fixture.json',{type:'application/json'}));input.files=transfer.files;input.dispatchEvent(new Event('change',{bubbles:true}))};window.chooseGraphFixture()});
 await wait();assert.equal(await run(()=>document.querySelectorAll('#view-graph .vue-flow__node').length),5,'Declining replacement preserves graph and instructions');
 await run(()=>{window.confirm=()=>true;window.chooseGraphFixture()});
 await until(()=>document.querySelectorAll('#view-graph .vue-flow__node').length===2);
 assert.equal(await run(()=>document.querySelectorAll('#view-graph .intent-target').length),0,'Accepted source replacement clears old graph anchors');
 await run(()=>{window.confirm=window.originalConfirm});
 await tab('spatial');
 await until(()=>!!document.querySelector('#view-spatial model-viewer')?.loaded);
 await exec('Array.from(document.querySelectorAll("#view-spatial button")).find(b=>b.textContent==="Add surface hotspots").click()');
 const hit=await run(()=>{const model=document.querySelector('#view-spatial model-viewer'),r=model.getBoundingClientRect();for(const fy of [.5,.4,.6])for(const fx of [.5,.4,.6,.3,.7]){const x=Math.round(r.left+r.width*fx),y=Math.round(r.top+r.height*fy);if(model.positionAndNormalFromPoint(x,y))return {x,y}}return null});
 assert.ok(hit,'The generated GLB must expose an actual rendered surface');
 win.webContents.sendInputEvent({type:'mouseDown',...hit,button:'left',clickCount:1});
 win.webContents.sendInputEvent({type:'mouseUp',...hit,button:'left',clickCount:1});
 await until(()=>document.querySelectorAll('#view-spatial .intent-target').length===1);
 await fill('#view-spatial .intent-description','Change the finish on this face, preserving the geometry');
 const spatial=await prepare('spatial');
 assert.equal(spatial.annotations[0].target.selector.position.length,3);
 assert.ok(spatial.annotations[0].target.selector.position.every(n=>Number.isFinite(n)&&Math.abs(n)<10),'Points are model-space, not screen coordinates');
 assert.ok(spatial.annotations[0].target.selector.camera.orbit);
 await tab('spatial');await until(()=>!!document.querySelector('#view-spatial model-viewer')?.loaded);
 assert.equal(await run(()=>document.querySelectorAll('#view-spatial .intent-target').length),1,'Hotspot survives switching views');
 win.setContentSize(430,940);await wait();
 assert.equal(await run(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true,'Narrow layout must not overflow the viewport');
 assert.equal(network.some(url=>new URL(url).pathname.startsWith('/api/') || /^\\/projects\\/[^/]+\\/api\\//.test(new URL(url).pathname)),false,'Lab must not call the backend: '+JSON.stringify(network.filter(url=>new URL(url).pathname.startsWith('/api/'))));
 assert.equal(network.some(url=>!url.startsWith(${JSON.stringify(server.resolvedUrls!.local[0])})),false,'Lab samples must not fetch external assets');
 console.log('MULTIMODAL_ALIGNMENT_OK');app.exit(0);
}).catch(error=>{console.error(error);app.exit(1)});
`)
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['SystemRoot','WINDIR','PATH','Path','ComSpec','PATHEXT','DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR']) if (process.env[key] !== undefined) env[key] = process.env[key]
  for (const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TMP','TEMP','TMPDIR','XDG_CONFIG_HOME','XDG_CACHE_HOME']) env[key] = directory
  const child = spawn(desktopRequire('electron') as string, [main], { cwd: directory, env, windowsHide: true, stdio: ['ignore','pipe','pipe'] })
  let output = ''; child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk }); child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })
  const timer = setTimeout(() => child.kill(), 130_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child,'close'); assert.equal(code,0,output); assert.match(output,/MULTIMODAL_ALIGNMENT_OK/)
})
