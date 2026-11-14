import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { createServer } from 'vite'
import UnoCSS from 'unocss/vite'
import { withTempWorkspace } from '../../../src/testing/workspace.ts'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../../desktop/package.json', import.meta.url))

test('phone settings browser verifies opt-in, pairing, revocation and narrow layout', {
  timeout: 60_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async () => {
  await withTempWorkspace(async directory => {
    const server = await createServer({
      optimizeDeps: { noDiscovery: true, include: [] }, configFile: false, root: resolve(root, 'app'), logLevel: 'error',
      plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app', 'unocss.config.ts') }), {
        name: 'device-administration-fixture',
        resolveId: id => id === '/device-fixture.ts' ? '\0device-fixture' : undefined,
        load: id => id !== '\0device-fixture' ? undefined : `
          import 'uno.css'; import '/src/styles.css';
          import { createApp } from 'vue';
          import MobileAdministration from '/src/components/MobileAdministration.vue';
          const state = window.fixture = { mutations: [], network: {enabled:false,port:3125,allowLanHttp:false,managedByEnvironment:false,state:'disabled',endpoint:null,error:null,sessions:[]} };
          Object.defineProperty(navigator,'clipboard',{value:{writeText:async text=>{state.copied=text;}}});
          window.fetch = async (input,init) => {
            const path = new URL(input,location.href).pathname;
            if(init?.method && init.method!=='GET') state.mutations.push({path,body:init.body?JSON.parse(init.body):null});
            if(path.endsWith('/settings')) {
              if(init?.method==='PUT') {
                Object.assign(state.network,JSON.parse(init.body));
                state.network.state=state.network.enabled?'listening':'disabled';
                state.network.endpoint=state.network.enabled?'http://192.168.20.12:3125':null;
              }
              return Response.json(state.network);
            }
            if(path.endsWith('/pairing')) return Response.json({url:state.network.endpoint,code:'ABCD-ABCD-ABCD-ABCD-ABCD-ABCD',expiresAt:new Date(Date.now()+300000).toISOString()});
            if(init?.method==='DELETE') {state.network.sessions=[];return Response.json(state.network);}
            throw new Error('Unexpected request '+path);
          };
          createApp(MobileAdministration,{apiBase:location.origin}).mount('#app');
        `,
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__devices') return next()
            response.setHeader('Content-Type', 'text/html')
            response.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main id="app" style="padding:16px"></main><script type="module" src="/device-fixture.ts"></script></body></html>')
          })
        },
      }],
      server: { host: '127.0.0.1', port: 0 },
    })
    let child: ReturnType<typeof spawn> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await server.listen()
      const url = server.resolvedUrls?.local[0]
      assert.ok(url)
      await mkdir(join(directory, 'profile'))
      await writeFile(join(directory, 'main.cjs'), `
        const assert = require('node:assert/strict');
        const {join} = require('node:path');
        const {mkdir,writeFile} = require('node:fs/promises');
        const {setTimeout:delay} = require('node:timers/promises');
        const {app,BrowserWindow} = require('electron');
        app.setPath('userData',join(process.cwd(),'profile'));
        app.on('window-all-closed',()=>{});
        async function main() {
          await app.whenReady();
          const window = new BrowserWindow({show:false,width:1200,height:1000,
            webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});
          const execute = code => window.webContents.executeJavaScript(code);
          const wait = async code => {
            const deadline=Date.now()+10000;
            while(Date.now()<deadline) {if(await execute(code)) return;await delay(40);}
            throw new Error('Timed out: '+code+'\\n'+await execute('document.body.innerText'));
          };
          const click = label => execute('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==='+JSON.stringify(label)+').click()');
          try {
            await window.loadURL(new URL('__devices',process.env.DEVICE_UI_SMOKE_URL).href);
            await wait('!!document.querySelector("form")');
            assert.equal(await execute('document.querySelector("form button").disabled'),true);
            assert.equal(await execute('window.fixture.mutations.length'),0);
            for(const dark of [false,true]) for(const width of [1200,390]) {
              window.setContentSize(width,1000);
              await execute('document.documentElement.classList.toggle("dark",'+dark+')');
              await execute('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
              assert.equal(await execute('document.documentElement.scrollWidth <= innerWidth'),true);
              if(width===390) assert.equal(await execute('Array.from(document.querySelectorAll("button")).every(el=>el.getBoundingClientRect().height>=44)'),true);
            }
            await execute('document.querySelector("input[type=checkbox]").click()');
            await click('Enable / retry phone access');
            await wait('document.body.innerText.includes("Phone listener is on")');
            assert.deepEqual(await execute('window.fixture.mutations[0].body'),{enabled:true,port:3125,allowLanHttp:true});
            await click('Create phone pairing code');
            await wait('!!document.querySelector("textarea")');
            await click('Copy phone pairing details');
            assert.match(await execute('window.fixture.copied'),/192.168.20.12:3125/);
            await execute('window.fixture.network.sessions=[{id:"phone-1",expiresAt:new Date(Date.now()+10000).toISOString()}]');
            await click('Refresh phone access');
            await wait('document.body.innerText.includes("phone-1")');
            await click('Disconnect phone');
            await wait('!document.body.innerText.includes("phone-1")');
            await click('Turn off phone access');
            await wait('document.body.innerText.includes("Phone listener is off")');
            assert.equal(await execute('!!document.querySelector("textarea")'),false);
            console.log('DEVICE_UI_SMOKE_OK');
          } finally {window.destroy();}
        }
        main().then(()=>app.exit(0),error=>{console.error(error);app.exit(1)});
      `)
      const env: NodeJS.ProcessEnv = { DEVICE_UI_SMOKE_URL: url }
      if (process.env.DEVICE_UI_SCREENSHOT_DIR) env.DEVICE_UI_SCREENSHOT_DIR = resolve(root, process.env.DEVICE_UI_SCREENSHOT_DIR)
      for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
        if (process.env[key] !== undefined) env[key] = process.env[key]
      }
      for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = directory
      child = spawn(desktopRequire('electron') as string, [join(directory, 'main.cjs')], {
        cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      child.stdout!.setEncoding('utf8').on('data', chunk => { output += chunk })
      child.stderr!.setEncoding('utf8').on('data', chunk => { output += chunk })
      timer = setTimeout(() => child?.kill(), 45_000)
      const [code] = await once(child, 'close')
      assert.equal(code, 0, output)
      assert.match(output, /DEVICE_UI_SMOKE_OK/)
    } finally {
      if (timer) clearTimeout(timer)
      if (child && child.exitCode === null) {
        const closed = once(child, 'close')
        child.kill()
        await closed
      }
      await server.close()
      await rm(join(directory, 'profile'), { recursive: true, force: true, maxRetries: 12, retryDelay: 250 })
    }
  })
})
