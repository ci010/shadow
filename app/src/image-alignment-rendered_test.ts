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
test('region alignment uses native selection, keeps original bytes, restores instructions and respects read-only mode', { timeout: 90_000 }, async t => {
  const directory = resolve(root, '.test-artifacts', `alignment-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    optimizeDeps: { noDiscovery: true, include: ['vue', '@annotorious/annotorious'] },
    plugins: [vue(), {
      name: 'alignment-fixture',
      resolveId: id => id === '/alignment-entry.ts' ? '\0alignment-entry' : undefined,
      load(id) {
        if (id !== '\0alignment-entry') return
        return `import {createApp,h,ref} from 'vue';
          import ImageViewer from '/src/components/ImageViewer.vue';
          const canvas=document.createElement('canvas');canvas.width=640;canvas.height=400;
          const context=canvas.getContext('2d'); context.fillStyle='#d4e6ea';context.fillRect(0,0,640,400);
          canvas.toBlob(blob=>{
            const file=new File([blob],'fixture.png',{type:'image/png'});
            const shown=ref(true),editable=ref(true);let saved;
            window.original=file; window.updates=[];
            window.reopen=async(readonly=false)=>{editable.value=!readonly;shown.value=true};
            window.saved=()=>saved;
            createApp({render:()=>shown.value?h(ImageViewer,{
              image:{name:file.name,src:URL.createObjectURL(file),localFile:file,attachmentKey:'fixture',alignment:saved},
              editable:editable.value,contextKey:'test',
              onImageContext:update=>{window.updates.push(update);saved=update.alignment || undefined},
              onClose:()=>shown.value=false,
            }):null}).mount('#app');
          });`
      },
      configureServer(server) { server.middlewares.use((req,res,next) => {
        if (req.url !== '/__alignment') return next()
        res.setHeader('Content-Type','text/html')
        res.end('<html><body style="margin:0"><div id="app"></div><script type="module" src="/alignment-entry.ts"></script></body></html>')
      }) },
    }], server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  })
  await server.listen()
  t.after(() => server.close())
  const main = resolve(directory, 'main.cjs')
  await writeFile(main, `
    const {app,BrowserWindow,Menu}=require('electron');
    const assert=require('node:assert/strict');
    app.setPath('userData',${JSON.stringify(directory)});
    app.whenReady().then(async()=>{
      Menu.setApplicationMenu(null);
      const win=new BrowserWindow({show:false,width:1100,height:900,webPreferences:{contextIsolation:true,nodeIntegration:false}});
      win.webContents.on('console-message',(_e,...args)=>console.log('RENDERER',...args));
      const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');
      const wait=()=>new Promise(r=>setTimeout(r,100));
      const until=async(fn)=>{for(let i=0;i<120;i++){if(await run(fn))return;await wait()}throw new Error('Timed out: '+fn)};
      await win.loadURL(${JSON.stringify(new URL('__alignment', server.resolvedUrls!.local[0]).href)});
      await until(()=>!!document.querySelector('.viewer-modes'));
      await run(()=>document.querySelectorAll('.viewer-modes button')[1].click());
      await until(()=>document.querySelector('.alignment-add')?.disabled===false);
      assert.equal(await run(()=>window.updates.length),0,'Opening alignment must not attach or send');
      const draw=async(left,top,right,bottom)=>{
        await run(()=>document.querySelector('.alignment-add').click());
        const bounds=await run(()=>{const r=document.querySelector('.alignment-image-host img').getBoundingClientRect();return {left:r.left,top:r.top,width:r.width,height:r.height}});
        const start={x:Math.round(bounds.left+bounds.width*left),y:Math.round(bounds.top+bounds.height*top)};
        const end={x:Math.round(bounds.left+bounds.width*right),y:Math.round(bounds.top+bounds.height*bottom)};
        win.webContents.sendInputEvent({type:'mouseDown',...start,button:'left',clickCount:1});
        win.webContents.sendInputEvent({type:'mouseMove',...end,modifiers:['leftButtonDown']});
        win.webContents.sendInputEvent({type:'mouseUp',...end,button:'left',clickCount:1});
        await wait();
      };
      await draw(.1,.1,.4,.4);
      await until(()=>document.querySelectorAll('.alignment-region').length===1);
      await run(()=>document.querySelector('.alignment-region').click());
      await until(()=>!!document.querySelector('.alignment-region-description'));
      assert.equal(await run(()=>document.querySelector('.alignment-apply').disabled),true,'An empty change is not actionable');
      await run(()=>{const el=document.querySelector('.alignment-region-description');el.value='把窗户改成圆形，保留自然光';el.dispatchEvent(new Event('input',{bubbles:true}))});
      await draw(.6,.55,.9,.85);
      await until(()=>document.querySelectorAll('.alignment-region').length===2);
      await run(()=>document.querySelectorAll('.alignment-region')[1].click());
      await run(()=>{const el=document.querySelector('.alignment-region-editor select');el.value='preserve';el.dispatchEvent(new Event('change',{bubbles:true}))});
      await run(()=>{const el=document.querySelector('.alignment-region-description');el.value='Keep the table unchanged';el.dispatchEvent(new Event('input',{bubbles:true}))});
      assert.equal(await run(()=>window.updates.length),0,'Drawing and typing must not attach or send');
      await run(()=>document.querySelector('.alignment-apply').click());
      await until(()=>window.updates.length===1);
      const result=await run(()=>({sameFile:window.updates[0].file===window.original,doc:window.updates[0].alignment}));
      assert.equal(result.sameFile,true,'Instructions must not burn rectangles into input pixels');
      assert.equal(result.doc.asset.width,640);assert.equal(result.doc.asset.height,400);
      assert.match(result.doc.asset.sha256,/^[a-f0-9]{64}$/);
      assert.equal(result.doc.regions.length,2);
      assert.equal(result.doc.regions[0].description,'把窗户改成圆形，保留自然光');
      assert.equal(result.doc.regions[1].intent,'preserve');
      assert.ok(Math.abs(result.doc.regions[0].x-64)<4,'Geometry must use natural pixels');
      assert.ok(Math.abs(result.doc.regions[0].width-192)<4);
      await run(()=>document.querySelector('[aria-label="Close image viewer"]').click());
      await until(()=>!document.querySelector('dialog'));
      await run(()=>window.reopen());
      await until(()=>document.querySelectorAll('.alignment-region').length===2);
      assert.equal(await run(()=>window.updates.length),1,'Restoring instructions must not resend');
      await run(()=>document.querySelector('.alignment-region').click());
      assert.equal(await run(()=>document.querySelector('.alignment-region-description').value),'把窗户改成圆形，保留自然光');
      assert.equal(await run(()=>getComputedStyle(document.querySelector('.a9s-rotation-handle-group')).display),'none','v1 does not expose unsupported rotated anchors');
      const handle=await run(()=>{const r=document.querySelector('.a9s-corner-handle-bottomright .a9s-handle-buffer').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}});
      win.webContents.sendInputEvent({type:'mouseDown',...handle,button:'left',clickCount:1});
      await wait();
      win.webContents.sendInputEvent({type:'mouseMove',x:handle.x+45,y:handle.y+20,modifiers:['leftButtonDown']});
      await wait();
      win.webContents.sendInputEvent({type:'mouseUp',x:handle.x+45,y:handle.y+20,button:'left',clickCount:1});
      await wait(); // Allow native input delivery, still below the one-second debounce.
      // Apply immediately, before Annotorious' one-second debounced geometry notification.
      await run(()=>document.querySelector('.alignment-apply').click());
      const resized=await run(()=>window.updates.at(-1).alignment);
      assert.ok(resized.regions[0].width>result.doc.regions[0].width+20,'Apply must read live geometry, not stale notification state: '+JSON.stringify({handle,before:result.doc.regions[0],after:resized.regions[0]}));
      await run(()=>document.querySelector('[aria-label="Close image viewer"]').click());
      await until(()=>!document.querySelector('dialog'));
      await run(()=>window.reopen(true));
      await until(()=>document.querySelectorAll('.alignment-region').length===2);
      assert.equal(await run(()=>document.querySelector('.alignment-add').disabled),true);
      assert.equal(await run(()=>document.querySelector('.alignment-apply').disabled),true);
      assert.equal(await run(()=>document.querySelector('.alignment-clear').disabled),true);
      console.log('IMAGE_ALIGNMENT_OK');app.exit(0);
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
  assert.match(output,/IMAGE_ALIGNMENT_OK/)
})
