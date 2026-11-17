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
import { pdfViewerAssets } from '../pdf-viewer-assets.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))

test('rendered ChatTab file input survives native picker background, submits context once, cancels and drops revoked drafts', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `mobile-client-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', mode: 'mobile',
    cacheDir: resolve(directory, 'vite-cache'),
    optimizeDeps: { entries: [], noDiscovery: true },
    plugins: [pdfViewerAssets(), vue(), UnoCSS({ configFile: resolve(root, 'app', 'unocss.config.ts') }), {
      name: 'mobile-native-fixture',
      enforce: 'pre',
      resolveId(id, importer) {
        if (id === './App.vue' && importer?.endsWith('/mobile-bootstrap.ts')) return '\0picker-chat'
        if (id === '@capacitor/core') return '\0capacitor-core-fixture'
        if (id === '@capacitor/app') return '\0capacitor-app-fixture'
        if (id === '/mobile-fixture.ts') return '\0mobile-fixture'
      },
      load(id) {
        if (id === '\0picker-chat') return `import {defineComponent,h,onErrorCaptured,provide,ref} from 'vue'; import {ioBridgeKey,createIoBridge} from '/src/io/bridge.ts'; import ChatTab from '/src/components/ChatTab.vue'; export default defineComponent({setup:()=>{provide(ioBridgeKey,createIoBridge());onErrorCaptured(error=>{console.error(error.stack);return false});const key=ref(0);window.__mobile.resetChat=()=>key.value++;return ()=>h(ChatTab,{key:key.value,apiBase:location.origin,projectId:'default',inspection:true,managed:true})}});`
        if (id === '\0capacitor-core-fixture') return `
          export const Capacitor = {isNativePlatform: () => window.__mobile.native};
          export const registerPlugin = () => ({
            get: async () => ({value:window.__mobile.stored}),
            set: async ({value}) => {window.__mobile.stored=value},
            remove: async () => {window.__mobile.stored=null},
          });`
        if (id === '\0capacitor-app-fixture') return `
          export const App = {
            addListener:async (_event, handler) => {window.__mobile.state=handler; return {remove:async () => {}}},
            getState:async () => ({isActive:true}),
          };`
        if (id !== '\0mobile-fixture') return
        return `
          import 'uno.css'; import '/src/styles.css';
          import {startMobileClient} from '/src/mobile-bootstrap.ts';
          import {browserIoCapabilities} from '/src/io/adapters.ts';
          const fixture=window.__mobile={native:new URL(location.href).searchParams.has('native'), stored:null, calls:[], revoked:false, submits:[], uploads:[], deferResume:false};
          window.fetch=async (input, init) => {
            const request = new Request(input,init);
            fixture.calls.push({url:request.url, method:request.method, authorization:request.headers.get('authorization'), signal:request.signal});
            const path = new URL(request.url).pathname;
            if(path==='/mobile/v1/pair') return Response.json({version:2,accessToken:'synthetic-native-access-token',expiresAt:null});
            if(path==='/mobile/v1/session') { if(fixture.deferResume) await new Promise(resolve=>fixture.resume=resolve); return fixture.revoked ? new Response(null,{status:401}) : Response.json({version:2,authenticated:true,expiresAt:null}); }
            if(path==='/api/live') return new Response(new ReadableStream({start(controller){
              controller.enqueue(new TextEncoder().encode('event: realtime\\ndata: '+JSON.stringify({type:'ready',cursor:'00000000-0000-4000-8000-000000000000:0'})+'\\n\\n'));
            }}),{headers:{'content-type':'text/event-stream'}});
            if(path==='/api/chat/upload') {const data=await request.formData(); const file=data.get('file'); fixture.uploads.push({name:file.name,body:await file.text()}); return Response.json({path:'uploads/'+file.name});}
            if(path==='/api/chat/send') {const body=await request.json(); fixture.submits.push(body); return Response.json({chatId:body.chatId,requestId:'synthetic-request'});}
            if(path.endsWith('/sessions')) return Response.json([]);
            if(path==='/api/projects') return Response.json({version:1,projects:[]});
            return Response.json({});
          };
          fixture.dispose=await startMobileClient(); fixture.capabilities=browserIoCapabilities(); fixture.ready=true;
        `
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (!request.url?.startsWith('/__mobile')) return next()
          response.setHeader('Content-Type', 'text/html')
          response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body><div id="app"></div><script>window.__mobileErrors=[];const logError=console.error;console.error=(...args)=>{window.__mobileErrors.push(args.map(String).join(" "));logError(...args)};addEventListener("error",event=>window.__mobileErrors.push(event.message));addEventListener("unhandledrejection",event=>window.__mobileErrors.push(String(event.reason)));</script><script type="module" src="/mobile-fixture.ts"></script></body></html>')
        })
      },
    }],
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  t.after(() => server.close())
  const origin = server.resolvedUrls?.local[0]
  assert.ok(origin)
  await writeFile(resolve(directory, 'main.cjs'), `
    const {app,BrowserWindow}=require('electron');
    const assert=require('node:assert/strict');
    app.setPath('userData',require('node:path').join(process.cwd(),'profile'));
    app.on('window-all-closed',()=>{});
    const wait=async (win, source) => {for(let i=0;i<100;i++){if(await win.webContents.executeJavaScript(source))return;await new Promise(r=>setTimeout(r,100))}throw new Error('Timed out: '+source+' '+await win.webContents.executeJavaScript('JSON.stringify({errors:window.__mobileErrors,body:document.body.innerText})'))};
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:390,height:844,webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}});
      win.webContents.on('console-message',(_event,level,message)=>console.error(_event.message??message));
      try{
        await win.loadURL(process.env.MOBILE_FIXTURE_URL+'__mobile');
        await wait(win,'window.__mobile?.ready');
        assert.match(await win.webContents.executeJavaScript('document.body.innerText'),/Mobile client unavailable/);
        assert.equal(await win.webContents.executeJavaScript('window.__mobile.calls.length'),0);
        await win.loadURL(process.env.MOBILE_FIXTURE_URL+'__mobile?native=1');
        await wait(win,'window.__mobile?.ready');
        await wait(win,'!!document.querySelector("#phone-pairing")');
        assert(await win.webContents.executeJavaScript('window.__mobile.capabilities.filter(c=>["camera","microphone","screen"].includes(c.id)).every(c=>!c.available&&c.reason.includes("not supported"))'));
        assert(await win.webContents.executeJavaScript('window.__mobile.capabilities.filter(c=>["file","form"].includes(c.id)).every(c=>c.available)'));
        const sizes=await win.webContents.executeJavaScript('({overflow:document.documentElement.scrollWidth>innerWidth,inputs:[...document.querySelectorAll("input")].map(n=>n.getBoundingClientRect().height),button:document.querySelector("form button").getBoundingClientRect().height})');
        assert.equal(sizes.overflow,false); assert(sizes.inputs.every(h=>h>=48)); assert(sizes.button>=48);
        await win.webContents.executeJavaScript('document.querySelector("#phone-pairing").value="https://main.example abcdef-abcdef-abcdef-abcdef";document.querySelector("#phone-pairing").dispatchEvent(new Event("input"));document.querySelector("form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));');
        await wait(win,'!!document.querySelector(".chat-workspace")');
        assert(await win.webContents.executeJavaScript('window.__mobile.stored.includes("synthetic-native-access-token")'));
        assert.equal(await win.webContents.executeJavaScript('Object.values(localStorage).some(value=>value.includes("synthetic-native-access-token"))'),false);
        await wait(win,'!!document.querySelector(".composer-file-input")');
        await win.webContents.executeJavaScript(\`
          window.__originalInput=document.querySelector('.composer-file-input');
          window.__doc=document;
          window.__submitEvents=0; document.addEventListener('submit',()=>window.__submitEvents++);
          HTMLInputElement.prototype.click=function(){ if(this.type==='file') {window.__mobile.state({isActive:false});window.__mobile.state({isActive:false});} };
          [...document.querySelectorAll('button')].find(n=>n.getAttribute('aria-label')==='Add attachments or context').click();
        \`);
        await wait(win,\`[...document.querySelectorAll('button')].some(n=>n.textContent.includes('Add file'))\`);
        await win.webContents.executeJavaScript(\`[...document.querySelectorAll('button')].find(n=>n.textContent.includes('Add file')).click()\`);
        await wait(win,'document.body.innerText.includes("Connection paused")');
        assert(await win.webContents.executeJavaScript('document.querySelector(".composer-file-input")===window.__originalInput'));
        assert(await win.webContents.executeJavaScript('document.querySelector(".chat-workspace").parentElement.hidden && document.querySelector(".chat-workspace").parentElement.inert'));
        assert(await win.webContents.executeJavaScript('window.__mobile.calls.filter(c=>c.authorization).every(c=>c.signal.aborted)'));
        await win.webContents.executeJavaScript(\`(()=>{
          const data=new DataTransfer();data.items.add(new File(['synthetic context payload'],'picker-context.txt',{type:'text/plain'}));data.items.add(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII='),c=>c.charCodeAt(0))],'picker-preview.png',{type:'image/png'}));
          window.__originalInput.files=data.files;window.__originalInput.dispatchEvent(new Event('change',{bubbles:true}));
          window.__originalInput.dispatchEvent(new Event('change',{bubbles:true}));
          window.__mobile.deferResume=true;window.__mobile.state({isActive:true});window.__mobile.state({isActive:true});
        })()\`);
        await wait(win,'!!window.__mobile.resume');
        assert.equal(await win.webContents.executeJavaScript('window.__mobile.submits.length'),0);
        assert(await win.webContents.executeJavaScript('document.querySelector(".chat-workspace").parentElement.hidden'));
        await win.webContents.executeJavaScript('window.__mobile.deferResume=false;window.__mobile.resume()');
        await wait(win,'!document.querySelector(".chat-workspace").parentElement.hidden');
        assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll(".attachment-chip").length'),2);
        assert(await win.webContents.executeJavaScript('document===window.__doc && document.querySelector(".composer-file-input")===window.__originalInput'));
        await wait(win,'document.querySelector(".attachment-thumb")?.naturalWidth===1');
        assert.equal(await win.webContents.executeJavaScript('window.__submitEvents'),0);
        await win.webContents.executeJavaScript(\`document.querySelector('[aria-label="Send message"]').click()\`);
        await wait(win,'window.__mobile.submits.length===1');
        const sent=await win.webContents.executeJavaScript('({uploads:window.__mobile.uploads,submits:window.__mobile.submits})');
        assert.deepEqual(sent.uploads[0],{name:'picker-context.txt',body:'synthetic context payload'});assert.equal(sent.uploads[1].name,'picker-preview.png');
        assert.match(sent.submits[0].content,/picker-context.txt/);
        assert.equal(sent.submits.length,1);
        await wait(win,'document.querySelectorAll(".attachment-chip").length===0');
        await win.webContents.executeJavaScript('window.__mobile.resetChat()');
        await wait(win,'document.querySelector(".composer-file-input")!==window.__originalInput');
        await win.webContents.executeJavaScript('window.__originalInput=document.querySelector(".composer-file-input")');
        // Cancel retains the same input but adds/sends nothing.
        await win.webContents.executeJavaScript(\`(async()=>{
          [...document.querySelectorAll('button')].find(n=>n.getAttribute('aria-label')==='Add attachments or context').click();
          await new Promise(resolve=>setTimeout(resolve,30));
          [...document.querySelectorAll('button')].find(n=>n.textContent.includes('Add file')).click();
          window.__originalInput.dispatchEvent(new Event('cancel'));window.__mobile.state({isActive:true});
        })()\`);
        await wait(win,'!document.querySelector(".chat-workspace").parentElement.hidden');
        assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll(".attachment-chip").length'),0);
        assert.equal(await win.webContents.executeJavaScript('window.__mobile.submits.length'),1);
        // Pick again, then fail resume authentication: the retained draft is destroyed.
        await win.webContents.executeJavaScript(\`(async()=>{
          [...document.querySelectorAll('button')].find(n=>n.getAttribute('aria-label')==='Add attachments or context').click();
          await new Promise(resolve=>setTimeout(resolve,30));
          [...document.querySelectorAll('button')].find(n=>n.textContent.includes('Add file')).click();
          const revokedData=new DataTransfer();revokedData.items.add(new File(['must not send'],'revoked-draft.txt'));window.__originalInput.files=revokedData.files;window.__originalInput.dispatchEvent(new Event('change',{bubbles:true}));
          window.__mobile.revoked=true;window.__mobile.state({isActive:true});
        })()\`);
        await wait(win,'document.body.innerText.includes("Connect to Main")');
        assert.equal(await win.webContents.executeJavaScript('!!document.querySelector(".chat-workspace")'),false);
        assert.equal(await win.webContents.executeJavaScript('window.__mobile.stored'),null);
        assert.equal(await win.webContents.executeJavaScript('window.__mobile.submits.length'),1);
        console.log('MOBILE_CLIENT_SMOKE_OK');
      }finally{win.destroy();app.quit()}
    }).catch(error=>{console.error(error);app.exit(1)});
  `)
  const env: NodeJS.ProcessEnv = { MOBILE_FIXTURE_URL: origin }
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = directory
  const child = spawn(desktopRequire('electron') as string, [resolve(directory, 'main.cjs')], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })
  const timer = setTimeout(() => child.kill(), 75_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, output)
  assert.match(output, /MOBILE_CLIENT_SMOKE_OK/)
})
