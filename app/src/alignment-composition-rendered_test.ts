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
test('components compose without a page ancestor across host widths and shared or isolated state', { timeout: 90_000 }, async t => {
  const directory = resolve(root, '.test-artifacts', `image-library-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'cache'),
    optimizeDeps: { noDiscovery: true, include: ['vue', '@annotorious/annotorious'] },
    plugins: [vue(), { name: 'image-library-fixture', resolveId: id => id === '/image-library-entry.ts' ? '\0image-library-entry' : undefined, load(id) { if(id === '\0image-library-entry') return `import '/src/styles.css';import {createApp} from 'vue';import Lab from '/src/components/alignment/AlignmentCompositionLab.vue';import Workspace from '/src/components/alignment/AlignmentLab.vue';import Images from '/src/components/alignment/ImageAlignmentLab.vue';Object.defineProperty(crypto,'subtle',{value:undefined,configurable:true});Object.defineProperty(crypto,'randomUUID',{value:undefined,configurable:true});createApp(location.pathname==='/__workspace'?Workspace:location.pathname==='/__library'?Images:Lab).mount('#app')` }, configureServer(server) {
      server.middlewares.use((req,res,next) => {
        if (!['/__images','/__workspace','/__library'].includes(req.url?.split('?')[0] ?? '')) return next()
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
      await until(()=>document.querySelector('.alignment-source img')?.naturalWidth===960 && !document.querySelector('.image-drawing-select').disabled);
      const edit=async(selector,value)=>win.webContents.executeJavaScript('(()=>{const e=document.querySelector('+JSON.stringify(selector)+');e.value='+JSON.stringify(value)+';e.dispatchEvent(new Event("input",{bubbles:true}));e.dispatchEvent(new Event("change",{bubbles:true}))})()');
      assert.equal(await run(()=>!!document.querySelector('.alignment-workbench')),false,'No page ancestor is required');
      assert.equal(await run(()=>getComputedStyle(document.querySelector('.image-prompt-details')).borderTopWidth),'0px','Only the panel owns the border');
      await edit('[data-composition] .keyword-input','sky, green');
      await until(()=>document.querySelector('.shared-prompt .keyword-input').value==='sky, green');
      assert.equal(await run(()=>document.querySelector('.independent-prompt .keyword-input').value),'reference');
      const long='Long prompt '.repeat(200);
      await edit('[data-composition] .full-prompt',long);
      await until(()=>document.querySelector('.shared-prompt .full-prompt').value.length>1000);
      await edit('.alignment-description','Preserve the window');
      await edit('.composition-mode','narrow');
      await until(()=>document.querySelector('[data-composition]').classList.contains('narrow'));
      assert.ok(await run(()=>document.querySelector('[data-composition] .alignment-surface').getBoundingClientRect().width<=321));
      assert.equal(await run(()=>document.querySelector('.alignment-description').value),'Preserve the window');
      assert.equal(await run(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true);
      await edit('.composition-mode','stack');
      await until(()=>document.querySelector('[data-composition]').classList.contains('stack'));
      assert.equal(await run(()=>document.querySelector('[data-composition] .keyword-input').value),'sky, green');
      await edit('.composition-mode','side');
      await until(()=>document.querySelector('[data-composition]').classList.contains('side'));
      assert.ok(await run(()=>document.querySelector('[data-composition] .alignment-surface').getBoundingClientRect().width>500));
      await run(()=>document.querySelector('.zoom-plus').click());
      await until(()=>document.querySelector('.alignment-zoom output').textContent.includes('52'));
      assert.equal(await run(()=>document.querySelector('.clip').style.width),'208px');
      await run(()=>{const el=document.querySelector('.clip-body');el.focus();el.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true}))});
      await until(()=>document.querySelector('.clip-body strong').textContent==='The window');
      assert.equal(await run(()=>document.querySelectorAll('.alignment-surface .alignment-surface').length),0);
      await run(()=>document.querySelector('.timeline-composition').scrollIntoView({block:'start'}));
      const ruler=await run(()=>{const r=document.querySelector('.ruler').getBoundingClientRect();return {x:Math.round(r.left+104),y:Math.round(r.top+10)}});
      win.webContents.sendInputEvent({type:'mouseDown',...ruler,button:'left',clickCount:1});
      win.webContents.sendInputEvent({type:'mouseUp',...ruler,button:'left',clickCount:1});
      await until(()=>document.querySelector('.timeline-composition .alignment-toolbar > output').textContent==='2.00 s');
      const screenshots=${JSON.stringify(resolve(root,'.test-artifacts/composable-ui'))};require('node:fs').mkdirSync(screenshots,{recursive:true});
      await win.webContents.executeJavaScript('window.scrollTo(0,0)');
      require('node:fs').writeFileSync(screenshots+'/compositions-desktop.png',(await win.webContents.capturePage()).toPNG());
      await edit('.composition-mode','narrow');
      require('node:fs').writeFileSync(screenshots+'/narrow-container-desktop.png',(await win.webContents.capturePage()).toPNG());
      win.setContentSize(430,940);
      await until(()=>window.innerWidth===430);
      assert.equal(await run(()=>document.documentElement.scrollWidth<=window.innerWidth+1),true,'No page overflow on narrow host');
      require('node:fs').writeFileSync(screenshots+'/compositions-mobile.png',(await win.webContents.capturePage()).toPNG());
      win.setContentSize(1440,900);
      await win.loadURL(${JSON.stringify(new URL('__workspace?view=storyboard', server.resolvedUrls!.local[0]).href)});
      await until(()=>document.querySelectorAll('.clip').length===4 && document.querySelector('.editor')?.getAttribute('aria-busy')==='false');
      require('node:fs').writeFileSync(screenshots+'/editor.png',(await win.webContents.capturePage()).toPNG());
      assert.equal(await run(()=>!!document.querySelector('[data-view=spatial]')),false);
      await win.loadURL(${JSON.stringify(new URL('__library', server.resolvedUrls!.local[0]).href)});
      await until(()=>document.querySelectorAll('.library-card').length===6);
      await run(()=>document.querySelector('.open-image').click());
      await until(()=>document.querySelector('.alignment-source img')?.naturalWidth===960 && !document.querySelector('.image-drawing-select').disabled);
      require('node:fs').writeFileSync(screenshots+'/image.png',(await win.webContents.capturePage()).toPNG());
      const button=await run(()=>{const e=document.querySelector('.image-drawing-select'),r=e.getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),background:getComputedStyle(e).backgroundColor,duration:getComputedStyle(e).transitionDuration}});
      assert.notEqual(button.duration,'0s','Controls have authored transitions');
      win.webContents.debugger.attach('1.3');
      await win.webContents.debugger.sendCommand('DOM.enable');await win.webContents.debugger.sendCommand('CSS.enable');
      const dom=await win.webContents.debugger.sendCommand('DOM.getDocument');
      const {nodeId}=await win.webContents.debugger.sendCommand('DOM.querySelector',{nodeId:dom.root.nodeId,selector:'.image-drawing-select'});
      await win.webContents.debugger.sendCommand('CSS.forcePseudoState',{nodeId,forcedPseudoClasses:['hover']});
      await until(()=>getComputedStyle(document.querySelector('.image-drawing-select')).backgroundColor!=='rgb(255, 255, 255)');
      const hover=await run(()=>getComputedStyle(document.querySelector('.image-drawing-select')).backgroundColor);
      await win.webContents.debugger.sendCommand('CSS.forcePseudoState',{nodeId,forcedPseudoClasses:['active']});
      await until(()=>getComputedStyle(document.querySelector('.image-drawing-select')).color==='rgb(36, 91, 193)');
      await win.webContents.debugger.sendCommand('CSS.forcePseudoState',{nodeId,forcedPseudoClasses:[]});
      await run(()=>document.querySelector('.image-drawing-select').click());
      await until(()=>document.querySelector('.image-drawing-select').getAttribute('aria-pressed')==='true');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});
      assert.equal(await run(()=>getComputedStyle(document.querySelector('.image-drawing-select')).transitionDuration),'0s','Reduced motion is respected');
      await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});win.webContents.debugger.detach();
      console.log('INTERACTION_STATES_OK',hover);

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
