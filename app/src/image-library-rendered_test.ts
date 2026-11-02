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
test('image library renders masonry, shared prompt state, imports and retained region drafts', { timeout: 90_000 }, async t => {
  const directory = resolve(root, '.test-artifacts', `image-library-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'cache'),
    optimizeDeps: { noDiscovery: true, include: ['vue', '@annotorious/annotorious'] },
    plugins: [vue(), { name: 'image-library-fixture', resolveId: id => id === '/image-library-entry.ts' ? '\0image-library-entry' : undefined, load(id) { if(id === '\0image-library-entry') return `import '/src/styles.css';import {createApp} from 'vue';import Lab from '/src/components/alignment/ImageAlignmentLab.vue';createApp(Lab).mount('#app')` }, configureServer(server) {
      server.middlewares.use((req,res,next) => {
        if (req.url !== '/__images') return next()
        res.setHeader('Content-Type','text/html')
        res.end('<html><body style="margin:0"><div id="app"></div><script type="module" src="/image-library-entry.ts"></script></body></html>')
      })
    } }], server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  })
  await server.listen(); t.after(() => server.close())
  const main = resolve(directory, 'main.cjs')
  await writeFile(main, `
    const {app,BrowserWindow,Menu}=require('electron');const assert=require('node:assert/strict');
    app.setPath('userData',${JSON.stringify(directory)});
    app.whenReady().then(async()=>{
      Menu.setApplicationMenu(null);
      const win=new BrowserWindow({show:false,width:1440,height:1000,webPreferences:{contextIsolation:true,nodeIntegration:false}});
      win.webContents.on('console-message',(_e,...args)=>console.log('RENDERER',...args));
      const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');
      const until=async(fn)=>{for(let i=0;i<150;i++){if(await run(fn))return;await new Promise(r=>setTimeout(r,100))}throw new Error('Timed out: '+fn)};
      await win.loadURL(${JSON.stringify(new URL('__images', server.resolvedUrls!.local[0]).href)});
      await until(()=>document.querySelectorAll('.library-card').length===6);
      await until(()=>[...document.querySelectorAll('.library-card img')].every(i=>i.naturalWidth>0));
      assert.equal(await run(()=>new Set([...document.querySelectorAll('.library-card img')].map(i=>i.naturalWidth/i.naturalHeight)).size>3),true);
      assert.equal(await run(()=>getComputedStyle(document.querySelector('.image-masonry')).columnCount!=='1'),true);
      const edit=async(selector,value)=>win.webContents.executeJavaScript('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');e.value='+JSON.stringify(value)+';e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}))})()');
      await edit('.full-prompt','My manual prompt');await edit('.keyword-input','sky, green');
      await run(()=>{window.copied='';Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{window.copied=text}},configurable:true});window.exportPromise=null;HTMLAnchorElement.prototype.click=function(){window.exportPromise=fetch(this.href).then(r=>r.json())}});
      await run(()=>document.querySelector('.prompt-actions button').click());
      assert.equal(await run(()=>JSON.parse(window.copied).prompt),'My manual prompt');
      await run(()=>document.querySelectorAll('.prompt-actions button')[1].click());
      assert.deepEqual(await run(()=>window.exportPromise.then(value=>value.keywords)),['sky','green']);
      await run(()=>document.querySelectorAll('.select-image')[1].click());
      assert.notEqual(await run(()=>document.querySelector('.full-prompt').value),'My manual prompt');
      await run(()=>document.querySelectorAll('.select-image')[0].click());
      assert.equal(await run(()=>document.querySelector('.full-prompt').value),'My manual prompt');
      assert.equal(await run(()=>document.querySelector('.keyword-tags').textContent.includes('green')),true);
      await run(()=>document.querySelector('.detail-button').click());
      await until(()=>document.querySelector('.image-drawing-select')?.disabled===false);

      await edit('.alignment-description','Keep this unsaved region draft');
      const wait=()=>new Promise(r=>setTimeout(r,120));
      const draw=async(tool,points,shift=false)=>{
        if(tool) await edit('.alignment-controls select',tool);
        const b=await run(()=>{const r=document.querySelector('.alignment-image-host img').getBoundingClientRect();return {x:r.left,y:r.top,w:r.width,h:r.height}});
        const at=p=>({x:Math.round(b.x+p[0]*b.w),y:Math.round(b.y+p[1]*b.h)});
        win.webContents.sendInputEvent({type:'mouseDown',...at(points[0]),button:'left',clickCount:1,modifiers:shift?['shift']:[]});
        await wait();for(const p of points.slice(1)){win.webContents.sendInputEvent({type:'mouseMove',...at(p),modifiers:shift?['leftButtonDown','shift']:['leftButtonDown']});await wait()}
        win.webContents.sendInputEvent({type:'mouseUp',...at(points.at(-1)),button:'left',clickCount:1});
        await wait();
      };
      assert.equal(await run(()=>document.querySelector('.image-drawing-toolbar select').value),'freehand','Opening an image immediately arms freehand');
      await draw(undefined,[[.12,.12],[.12,.12]]);
      await until(()=>document.querySelectorAll('.alignment-region').length===1);
      assert.equal(await run(()=>document.querySelectorAll('.annotation-dot').length),1,'A click has a visible result');
      await run(()=>document.querySelector('.image-drawing-undo').click());
      await until(()=>document.querySelectorAll('.alignment-region').length===0);
      await draw(undefined,[[.15,.2],[.25,.25],[.35,.2]]);
      await until(()=>document.querySelectorAll('.alignment-region').length===1);
      await draw(undefined,[[.15,.4],[.25,.5],[.4,.45]],true);
      await until(()=>document.querySelectorAll('.alignment-region').length===2);
      await run(()=>{const e=document.querySelector('.alignment-region-description');e.value='Direct and Shift marking';e.dispatchEvent(new Event('input',{bubbles:true}))});
      await run(()=>document.querySelector('.alignment-apply').click());
      const direct=await run(()=>JSON.parse(document.querySelector('.lab-output pre').textContent));
      assert.ok(direct.regions[0].geometry.points.length>=3,'Default stroke retains freehand samples');
      assert.equal(direct.regions[1].geometry.points.length,2,'Shift gesture stores only straight-line endpoints');
      await run(()=>document.querySelector('.stroke-surface').focus());
      win.webContents.sendInputEvent({type:'keyDown',keyCode:'Z',modifiers:['control']});
      win.webContents.sendInputEvent({type:'keyUp',keyCode:'Z',modifiers:['control']});
      await until(()=>document.querySelectorAll('.alignment-region').length===1);
      await run(()=>document.querySelector('.image-drawing-undo').click());
      await until(()=>document.querySelectorAll('.alignment-region').length===0);
      await draw('rectangle',[[.1,.1],[.4,.4]]);
      await until(()=>document.querySelectorAll('.alignment-region').length===1);
      await draw(undefined,[[.6,.1],[.8,.3]]);
      await until(()=>document.querySelectorAll('.alignment-region').length===2);
      await run(()=>document.querySelector('.image-drawing-undo').click());
      await until(()=>document.querySelectorAll('.alignment-region').length===1);
      await run(()=>document.querySelector('.alignment-region').click());
      await until(()=>document.querySelector('.alignment-region-description'));
      await edit('.alignment-region-description','Make this blue');
      await draw('freehand',[[.2,.65],[.35,.55],[.55,.7],[.7,.5]]);
      await until(()=>document.querySelectorAll('.alignment-region').length===2);
      await edit('.alignment-region-description','Follow this open contour');
      assert.equal(await run(()=>document.querySelectorAll('.stroke-surface polyline.selected').length),1);
      await run(()=>document.querySelector('.alignment-apply').click());
      await run(()=>[...document.querySelectorAll('.alignment-controls button')].find(b=>b.textContent.includes('Export instructions')).click());
      const doc=await run(()=>window.exportPromise);
      assert.deepEqual(doc,await run(()=>JSON.parse(document.querySelector('.lab-output pre').textContent)));
      assert.equal(doc.regions.length,2);
      const line=doc.regions.find(r=>r.geometry?.type==='stroke');
      assert.equal(line.label,undefined);assert.ok(line.geometry.points.length>=4);
      assert.ok(Math.abs(line.geometry.points[0][0]-192)<5,'Stroke uses original pixels');
      assert.equal(line.geometry.points[0][0]===line.geometry.points.at(-1)[0],false,'Stroke stays open');
      await run(()=>document.querySelector('.alignment-region').click());
      await edit('.alignment-region-description','Window edited');
      await run(()=>document.querySelector('.stroke-surface polyline').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true})));
      await until(()=>document.querySelector('.alignment-region-description').value==='Follow this open contour');
      await run(()=>document.querySelector('.alignment-details button:last-of-type'));
      await win.webContents.executeJavaScript('document.querySelector(".alignment-panel").scrollIntoView()');
      await require('node:fs/promises').mkdir(${JSON.stringify(resolve(root,'.test-artifacts','image-annotation-visual'))},{recursive:true});
      await require('node:fs/promises').writeFile(${JSON.stringify(resolve(root,'.test-artifacts','image-annotation-visual','desktop.png'))},(await win.webContents.capturePage()).toPNG());

      const desktop=await run(()=>{const a=document.querySelector('.alignment-image-host img').getBoundingClientRect(),b=document.querySelector('.image-prompt-details').getBoundingClientRect();return b.left>=a.right});
      assert.equal(desktop,true,'Desktop prompt remains on right');
      await run(()=>document.querySelector('.overview-button').click());
      await run(()=>document.querySelectorAll('.open-image')[1].click());
      await run(()=>document.querySelector('.overview-button').click());
      await run(()=>document.querySelectorAll('.open-image')[0].click());
      assert.equal(await run(()=>document.querySelector('.alignment-description').value),'Keep this unsaved region draft');
      assert.equal(await run(()=>document.querySelectorAll('.alignment-region').length),2);
      await run(()=>document.querySelector('.overview-button').click());
      await run(()=>{const data=new DataTransfer();for(let i=0;i<2;i++)data.items.add(new File([Uint8Array.from(atob(document.querySelector('.library-card img').src.startsWith('data:') ? document.querySelector('.library-card img').src.split(',')[1] : (()=>{const c=document.createElement('canvas');c.width=40;c.height=80;return c.toDataURL('image/png').split(',')[1]})()), c=>c.charCodeAt(0))],'import-'+i+'.png',{type:'image/png'}));const e=document.querySelector('input[multiple]');e.files=data.files;e.dispatchEvent(new Event('change',{bubbles:true}))});
      await until(()=>document.querySelectorAll('.library-card').length===8);
      await run(()=>document.querySelectorAll('.select-image')[6].click());
      assert.equal(await run(()=>document.querySelector('.full-prompt').value),'');
      assert.equal(await run(()=>document.querySelectorAll('.keyword-tags span').length),0);
      win.setSize(500,900);
      await until(()=>getComputedStyle(document.querySelector('.library-layout')).gridTemplateColumns.split(' ').length===1);
      assert.equal(await run(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
      await run(()=>document.querySelectorAll('.open-image')[0].click());
      await until(()=>!!document.querySelector('.alignment-region-description'));
      await run(()=>document.querySelector('.alignment-panel').scrollIntoView());
      await wait();
      assert.equal(await run(()=>document.documentElement.scrollWidth<=window.innerWidth),true);
      await require('node:fs/promises').writeFile(${JSON.stringify(resolve(root,'.test-artifacts','image-annotation-visual','narrow.png'))},(await win.webContents.capturePage()).toPNG());
      assert.equal(await run(()=>!!document.querySelector('.image-drawing-toolbar option[value=polygon]')),false,'No polygon tool is offered');
      assert.equal(await run(()=>document.querySelector('.alignment-region-label') || document.querySelector('.alignment-region-editor select')),null,'Only the description remains');
      await edit('.alignment-controls select','freehand');
      await run(()=>document.querySelector('.image-drawing-select').click());
      assert.equal(await run(()=>document.querySelector('.stroke-surface').classList.contains('drawing')),false);
      win.setContentSize(1440,1000);
      await run(()=>document.querySelector('.alignment-clear').click());
      await until(()=>document.querySelectorAll('.alignment-region').length===0);
      await run(()=>document.querySelector('.alignment-panel').scrollIntoView({block:'start'}));
      const boxes=[[[.15,.15],[.65,.65]],[[.25,.25],[.5,.5]],[[.15,.15],[.4,.4]],[[.7,.1],[.85,.25]],[[.03,.5],[.3,.95]]];
      const notes=['Keep the window frame','Replace the inner pane','Adjust the reflected light','Preserve the upper corner','Clean up the foreground'];
      for(let i=0;i<boxes.length;i++){
        await draw(i===0?'rectangle':undefined,boxes[i]);
        await win.webContents.executeJavaScript('window.expectedCount='+String(i+1));
        await until(()=>document.querySelectorAll('.alignment-region').length===window.expectedCount);
        await edit('.alignment-region-description',notes[i]);
        if(i===2){
          await run(()=>document.querySelector('.alignment-region').click());
          await until(()=>document.querySelector('.alignment-region-description').value==='Keep the window frame');
          assert.equal(await run(()=>document.querySelector('.image-drawing-toolbar select').value),'rectangle','Inspecting a card must not disarm the drawing tool');
        }
      }
      assert.equal(await run(()=>document.querySelectorAll('.annotation-number').length),5);
      assert.deepEqual(await run(()=>[...document.querySelectorAll('.annotation-index')].map(e=>e.textContent.trim())),['1','2','3','4','5']);
      await run(()=>document.querySelector('.alignment-apply').click());
      const multi=await run(()=>JSON.parse(document.querySelector('.lab-output pre').textContent));
      assert.equal(multi.regions.length,5);assert.equal(new Set(multi.regions.map(r=>r.id)).size,5);
      assert.deepEqual(multi.regions.map(r=>r.description),notes);
      assert.ok(Math.abs(multi.regions[0].x-multi.regions[2].x)<5,'Repeated start points are supported');
      const shots=${JSON.stringify(resolve(root,'.test-artifacts/multi-annotation'))};await require('node:fs/promises').mkdir(shots,{recursive:true});
      await run(()=>document.querySelector('.alignment-panel').scrollIntoView({block:'start'}));
      await win.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
      await require('node:fs/promises').writeFile(shots+'/five-boxes.png',(await win.webContents.capturePage()).toPNG());
      await run(()=>document.querySelector('.image-drawing-select').click());
      await run(()=>document.querySelectorAll('.annotation-number')[1].click());
      await until(()=>document.querySelector('.alignment-region-description').value==='Replace the inner pane');
      assert.equal(await run(()=>document.querySelectorAll('.annotation-card.selected').length),1);
      await run(()=>document.querySelectorAll('.annotation-delete')[2].click());
      await until(()=>document.querySelectorAll('.annotation-number').length===4);
      await run(()=>document.querySelector('.alignment-apply').click());
      const afterDelete=await run(()=>JSON.parse(document.querySelector('.lab-output pre').textContent));
      assert.deepEqual(afterDelete.regions.map(r=>r.id),multi.regions.filter((_,i)=>i!==2).map(r=>r.id));
      assert.deepEqual(afterDelete.regions.map(r=>r.description),notes.filter((_,i)=>i!==2));
      console.log('IMAGE_LIBRARY_OK');app.exit(0);
    }).catch(error=>{console.error(error);app.exit(1)});
  `)
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['SystemRoot','WINDIR','PATH','Path','ComSpec','PATHEXT','DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR']) if (process.env[key] !== undefined) env[key] = process.env[key]
  for (const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TMP','TEMP','TMPDIR','XDG_CONFIG_HOME','XDG_CACHE_HOME']) env[key] = directory
  const child = spawn(desktopRequire('electron') as string, [main], { cwd: directory, env, windowsHide: true, stdio: ['ignore','pipe','pipe'] })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })
  const timer = setTimeout(() => child.kill(), 75_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child,'close')
  assert.equal(code,0,output)
  assert.match(output,/IMAGE_LIBRARY_OK/)
})
