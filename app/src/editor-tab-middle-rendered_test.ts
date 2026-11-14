import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'

const root = fileURLToPath(new URL('../..', import.meta.url))
const require = createRequire(new URL('../../desktop/package.json', import.meta.url))
test('native middle clicks close only their closable tab across split and standalone workbenches', {
  timeout: 90000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `middle-tabs-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const server = await createServer({ configFile: false, envDir: false, root: resolve(root, 'app'), cacheDir: resolve(directory, 'cache'), logLevel: 'error', optimizeDeps: { noDiscovery: true, include: ['vue'] }, plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app/unocss.config.ts') }), {
    name: 'middle-tabs-fixture', resolveId: id => id === '/fixture.ts' ? '\0fixture' : undefined,
    load(id) {
      if (id !== '\0fixture') return
      return `import {createApp,h,provide,ref} from 'vue';import Host from '/src/components/EditorGroupHost.vue';import Workbench from '/src/components/files/FileWorkbench.vue';import {createEditorGroups,EditorGroupsKey} from '/src/editor-groups.ts';import {setLocalePreference} from '/src/i18n.ts';import '/src/styles.css';import 'virtual:uno.css';setLocalePreference('en');
        const groups=createEditorGroups();window.groups=groups;
        for(const id of ['L1','L2','R1','R2','Pinned'])groups.open({id,projectId:'p',owner:id,label:id,icon:'i-lucide-file',closable:id!=='Pinned',select(){},close(){}},id.startsWith('R')?'right':'left');
        groups.activate('R1');groups.activate('L1');
        createApp({setup(){provide(EditorGroupsKey,groups);return()=>h(Host,{projectId:'p',active:true})}}).mount('#groups');
        createApp({setup(){const workbench=ref();return()=>h(Workbench,{ref:el=>{workbench.value=el;window.workbench=el},apiBase:location.origin,sessionId:'',contextKey:'standalone',active:true,explorerEnabled:false,diagnosisEnabled:true},{default:()=>h('p','Conversation body'),diagnosis:()=>h('p','Diagnosis body')})}}).mount('#standalone');`
    },
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<html><body style="margin:0"><div id="groups" style="display:flex;height:360px"></div><div id="standalone" style="display:flex;height:360px"></div><script type="module" src="/fixture.ts"></script></body></html>'); return }
      if (!req.url?.startsWith('/api/')) return next()
      res.setHeader('Content-Type', 'application/json'); res.end('{}')
    }) },
  }], server: { host: '127.0.0.1', port: 0 } })
  await server.listen()
  t.after(() => { server.httpServer?.closeAllConnections(); return server.close() })
  const script = `const assert=require('node:assert/strict');const {app,BrowserWindow}=require('electron');const {setTimeout:delay}=require('node:timers/promises');app.setPath('userData',require('node:path').join(process.cwd(),'profile'));app.on('window-all-closed',()=>{});
    (async()=>{await app.whenReady();const win=new BrowserWindow({show:false,width:1300,height:850,webPreferences:{backgroundThrottling:false}});win.webContents.on('console-message',d=>console.error('Renderer:',d.message));const run=s=>win.webContents.executeJavaScript(s);const wait=async s=>{for(let i=0;i<200;i++){if(await run('Boolean('+s+')'))return;await delay(50)}throw Error('Timeout '+s+' '+await run('document.body.innerText'))};
    await win.loadURL(${JSON.stringify(server.resolvedUrls!.local[0])});await wait('window.workbench&&document.querySelectorAll(".editor-tab").length===5');
    const tab=id=>'[...document.querySelectorAll(".editor-tab [role=tab]")].find(e=>e.textContent.trim()==='+JSON.stringify(id)+')';
    const click=async(selector,button)=>{const point=await run('(()=>{const r=('+selector+').getBoundingClientRect();return {x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)}})()');await win.webContents.sendInputEvent({type:'mouseDown',...point,button,clickCount:1});await win.webContents.sendInputEvent({type:'mouseUp',...point,button,clickCount:1});await delay(100)};
    await click(tab('L2'),'middle');await wait('!('+tab('L2')+')');
    assert.equal(await run('window.groups.state("p").selected.left'),'L1','inactive left tab closes without selecting it');
    await click(tab('R2'),'middle');await wait('!('+tab('R2')+')');
    assert.deepEqual(await run('JSON.parse(JSON.stringify(window.groups.state("p").selected))'),{left:'L1',right:'R1'});
    assert.equal(await run('window.groups.state("p").active'),'left','middle click in the other split does not activate that split');
    await click(tab('Pinned'),'middle');assert.equal(await run('!!'+tab('Pinned')),true,'unclosable tabs survive');
    await click(tab('L1'),'left');assert.equal(await run('document.querySelectorAll(".editor-tab").length'),3);
    await click(tab('R1'),'right');assert.equal(await run('document.querySelectorAll(".editor-tab").length'),3,'right click opens the menu without closing');
    await run('document.querySelector(".editor-menu-backdrop").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))');
    // Dispatching a cancelable middle mousedown also verifies autoscroll prevention.
    assert.equal(await run('(()=>{const event=new MouseEvent("mousedown",{button:1,bubbles:true,cancelable:true});('+tab('Pinned')+').dispatchEvent(event);return event.defaultPrevented})()'),true);
    await run('window.workbench.openDiagnosis()');await wait('document.querySelector(".diagnosis-tab")');
    const diagnosis='document.querySelector(".diagnosis-tab [role=tab]")';
    await click(diagnosis,'left');await click(diagnosis,'right');assert.equal(await run('!!'+diagnosis),true,'standalone left/right clicks never close diagnosis');
    await click(diagnosis,'middle');await wait('!document.querySelector(".diagnosis-tab")');
    await run('window.workbench.openDiagnosis()');await wait('document.querySelector(".diagnosis-tab [role=tab]")?.getAttribute("aria-selected")==="true"');
    await click('document.querySelector(".conversation-tab [role=tab]")','middle');assert.equal(await run('!!document.querySelector(".conversation-tab")'),true,'standalone Conversation is permanent');
    await run('document.querySelector(".conversation-tab [role=tab]").click()');await click(diagnosis,'middle');await wait('!document.querySelector(".diagnosis-tab")');
    assert.equal(await run('document.querySelector(".conversation-tab [role=tab]").getAttribute("aria-selected")'),'true','closing an inactive standalone diagnosis keeps Conversation selected');
    win.close();console.log('MIDDLE_TABS_OK');app.quit();})().catch(error=>{console.error(error);app.exit(1)});`
  const entry = resolve(directory, 'main.cjs'); await writeFile(entry, script)
  const child = spawn(require('electron') as string, [entry], { cwd: directory, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
  const timer = setTimeout(() => child.kill(), 75000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close'); assert.equal(code, 0, output); assert.match(output, /MIDDLE_TABS_OK/)
})
