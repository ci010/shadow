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
test('attachment undo receives native Ctrl+Z even when a modal stops bubbling', { timeout: 90_000 }, async t => {
  const directory = resolve(root, '.test-artifacts', `annotation-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    optimizeDeps: { noDiscovery: true, include: ['vue'] },
    plugins: [vue(), {
      name: 'annotation-fixture',
      resolveId: id => id === '/annotation-entry.ts' ? '\0annotation-entry' : undefined,
      load(id) {
        if (id !== '\0annotation-entry') return
        return `import {createApp,h,ref} from 'vue';
          import ImageViewer from '/src/components/ImageViewer.vue';
          const canvas=document.createElement('canvas');canvas.width=200;canvas.height=100;
          canvas.getContext('2d').fillRect(0,0,200,100);
          canvas.toBlob(blob=>{
            const file=new File([blob],'test.png',{type:'image/png'});
            window.updates=[];
            createApp({render:()=>h(ImageViewer,{image:{name:file.name,src:URL.createObjectURL(file),localFile:file,attachmentKey:'fixture'},editable:true,contextKey:'test',onImageContext:v=>window.updates.push(v)})}).mount('#app');
          });`
      },
      configureServer(server) { server.middlewares.use((req,res,next) => {
        if (req.url !== '/__annotation') return next()
        res.setHeader('Content-Type','text/html')
        res.end('<html><body><div id="app"></div><script type="module" src="/annotation-entry.ts"></script></body></html>')
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
      const win=new BrowserWindow({show:false,width:500,height:700,webPreferences:{contextIsolation:true,nodeIntegration:false}});
      const run=fn=>win.webContents.executeJavaScript('('+fn.toString()+')()');
      const wait=()=>new Promise(r=>setTimeout(r,100));
      await win.loadURL(${JSON.stringify(new URL('__annotation', server.resolvedUrls!.local[0]).href)});
      for(let i=0;i<100;i++){if(await run(()=>!!document.querySelector('.image-annotation-canvas')?.width))break;await wait()}
      await wait();
      const draw=async()=>{
        const point=await run(()=>{const c=document.querySelector('.image-annotation-canvas'),r=c.getBoundingClientRect();return {x:Math.round(r.left+20),y:Math.round(r.top+20)}});
        win.webContents.sendInputEvent({type:'mouseDown',...point,button:'left',clickCount:1});
        win.webContents.sendInputEvent({type:'mouseUp',...point,button:'left',clickCount:1});
        await wait();
        assert.equal(await run(()=>document.querySelector('.image-annotation-undo').disabled),false);
      };
      const undo=async()=>{
        win.webContents.sendInputEvent({type:'keyDown',keyCode:'Z',modifiers:['control']});
        win.webContents.sendInputEvent({type:'keyUp',keyCode:'Z',modifiers:['control']});
        await wait();
        assert.equal(await run(()=>document.querySelector('.image-annotation-undo').disabled),true);
        assert.equal(await run(()=>window.updates.at(-1).file===null),true);
      };
      await draw();await undo();
      await draw();
      await run(()=>document.querySelector('.image-viewer-header button').focus());
      await undo();
      // Modal keydown isolation must not prevent the annotator from seeing the shortcut.
      await run(()=>document.querySelector('dialog').addEventListener('keydown',e=>e.stopPropagation()));
      await draw();await undo();
      await run(()=>{const s=document.querySelector('.image-annotation-stage');for(let i=0;i<10;i++)s.dispatchEvent(new WheelEvent('wheel',{ctrlKey:true,deltaY:-240,bubbles:true,cancelable:true}))});
      await wait();
      for(const middle of [false,true]) {
        await run(()=>{const s=document.querySelector('.image-annotation-stage');s.scrollLeft=0;document.querySelector('canvas').focus()});
        const start=await run(()=>{const r=document.querySelector('.image-annotation-stage').getBoundingClientRect();return {x:Math.round(r.left+150),y:Math.round(r.top+40)}});
        const before=await run(()=>window.updates.length);
        if(!middle)win.webContents.sendInputEvent({type:'keyDown',keyCode:'Space'});
        win.webContents.sendInputEvent({type:'mouseDown',...start,button:middle?'middle':'left',clickCount:1});
        win.webContents.sendInputEvent({type:'mouseMove',x:start.x-60,y:start.y,modifiers:[middle?'middleButtonDown':'leftButtonDown']});
        win.webContents.sendInputEvent({type:'mouseUp',x:start.x-60,y:start.y,button:middle?'middle':'left',clickCount:1});
        if(!middle)win.webContents.sendInputEvent({type:'keyUp',keyCode:'Space'});
        await wait();
        assert.ok(await run(()=>document.querySelector('.image-annotation-stage').scrollLeft)>40,'pan should scroll the zoomed image');
        assert.equal(await run(()=>window.updates.length),before,'pan must not update the attachment');
        assert.equal(await run(()=>document.querySelector('.image-annotation-undo').disabled),true);
        assert.equal(await run(()=>document.querySelector('.is-panning')===null),true);
      }
      await run(()=>document.querySelector('.image-annotation-stage').scrollLeft=0);
      await draw();await undo();
      console.log('ANNOTATION_NATIVE_UNDO_OK');app.exit(0);
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
  assert.match(output,/ANNOTATION_NATIVE_UNDO_OK/)
})
