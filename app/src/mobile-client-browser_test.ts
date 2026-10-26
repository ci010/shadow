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

test('native boot gates browser preview, pairs securely, and unmounts on background and revoked resume', {
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
      resolveId(id) {
        if (id === '@capacitor/core') return '\0capacitor-core-fixture'
        if (id === '@capacitor/app') return '\0capacitor-app-fixture'
        if (id === '/mobile-fixture.ts') return '\0mobile-fixture'
      },
      load(id) {
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
          const fixture=window.__mobile={native:new URL(location.href).searchParams.has('native'), stored:null, calls:[], revoked:false};
          window.fetch=async (input, init) => {
            const request = new Request(input,init);
            fixture.calls.push({url:request.url, method:request.method, authorization:request.headers.get('authorization'), signal:request.signal});
            const path = new URL(request.url).pathname;
            if(path==='/mobile/v1/pair') return Response.json({version:1,accessToken:'synthetic-native-access-token',expiresAt:new Date(Date.now()+3600000).toISOString()});
            if(path==='/mobile/v1/session') return fixture.revoked ? new Response(null,{status:401}) : Response.json({version:1,authenticated:true,expiresAt:new Date(Date.now()+3600000).toISOString()});
            if(path==='/api/live') return new Response(new ReadableStream({start(controller){
              controller.enqueue(new TextEncoder().encode('event: realtime\\ndata: '+JSON.stringify({type:'ready',cursor:'00000000-0000-4000-8000-000000000000:0'})+'\\n\\n'));
            }}),{headers:{'content-type':'text/event-stream'}});
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
          response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover"></head><body><div id="app"></div><script>window.__mobileErrors=[];addEventListener("error",event=>window.__mobileErrors.push(event.message));addEventListener("unhandledrejection",event=>window.__mobileErrors.push(String(event.reason)));</script><script type="module" src="/mobile-fixture.ts"></script></body></html>')
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
    const wait=async (win, source) => {for(let i=0;i<300;i++){if(await win.webContents.executeJavaScript(source))return;await new Promise(r=>setTimeout(r,100))}throw new Error('Timed out: '+source+' '+await win.webContents.executeJavaScript('JSON.stringify({errors:window.__mobileErrors,body:document.body.innerText})'))};
    app.whenReady().then(async()=>{
      const win=new BrowserWindow({show:false,width:390,height:844,webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}});
      try{
        await win.loadURL(process.env.MOBILE_FIXTURE_URL+'__mobile');
        await wait(win,'window.__mobile?.ready');
        assert.match(await win.webContents.executeJavaScript('document.body.innerText'),/Mobile client unavailable/);
        assert.equal(await win.webContents.executeJavaScript('window.__mobile.calls.length'),0);
        await win.loadURL(process.env.MOBILE_FIXTURE_URL+'__mobile?native=1');
        await wait(win,'window.__mobile?.ready');
        await wait(win,'!!document.querySelector("#main-address")');
        assert(await win.webContents.executeJavaScript('window.__mobile.capabilities.filter(c=>["camera","microphone","screen"].includes(c.id)).every(c=>!c.available&&c.reason.includes("not supported"))'));
        assert(await win.webContents.executeJavaScript('window.__mobile.capabilities.filter(c=>["file","form"].includes(c.id)).every(c=>c.available)'));
        const sizes=await win.webContents.executeJavaScript('({overflow:document.documentElement.scrollWidth>innerWidth,inputs:[...document.querySelectorAll("input")].map(n=>n.getBoundingClientRect().height),button:document.querySelector("form button").getBoundingClientRect().height})');
        assert.equal(sizes.overflow,false); assert(sizes.inputs.every(h=>h>=48)); assert(sizes.button>=48);
        await win.webContents.executeJavaScript('document.querySelector("#main-address").value="https://main.example";document.querySelector("#main-address").dispatchEvent(new Event("input"));document.querySelector("#mobile-pair-code").value="abcdef-abcdef-abcdef-abcdef";document.querySelector("#mobile-pair-code").dispatchEvent(new Event("input"));document.querySelector("form").dispatchEvent(new Event("submit",{bubbles:true,cancelable:true}));');
        await wait(win,'!!document.querySelector(".app-shell")');
        assert(await win.webContents.executeJavaScript('window.__mobile.stored.includes("synthetic-native-access-token")'));
        assert.equal(await win.webContents.executeJavaScript('Object.values(localStorage).some(value=>value.includes("synthetic-native-access-token"))'),false);
        await win.webContents.executeJavaScript('window.__mobile.state({isActive:false})');
        await wait(win,'document.body.innerText.includes("Connection paused")');
        assert.equal(await win.webContents.executeJavaScript('!!document.querySelector(".app-shell")'),false);
        assert(await win.webContents.executeJavaScript('window.__mobile.calls.filter(c=>c.authorization).every(c=>c.signal.aborted)'));
        await win.webContents.executeJavaScript('window.__mobile.revoked=true;window.__mobile.state({isActive:true})');
        await wait(win,'document.body.innerText.includes("Connect to Main")');
        assert.equal(await win.webContents.executeJavaScript('window.__mobile.stored'),null);
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
