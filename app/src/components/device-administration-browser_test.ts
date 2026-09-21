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

test('device administration browser verifies desktop/mobile layout, native consent controls and connection states', {
  timeout: 60_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async () => {
  await withTempWorkspace(async directory => {
    const server = await createServer({
      configFile: false, root: resolve(root, 'app'), logLevel: 'error',
      plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app', 'unocss.config.ts') }), {
        name: 'device-administration-fixture',
        resolveId: id => id === '/device-fixture.ts' ? '\0device-fixture' : undefined,
        load: id => id !== '\0device-fixture' ? undefined : `
          import 'uno.css'; import '/src/styles.css';
          import { createApp } from 'vue';
          import Nodes from '/src/components/NodesView.vue';
          Object.defineProperty(document, 'hidden', { value: false });
          const fingerprint = '0123456789abcdef'.repeat(4);
          const state = window.fixture = {
            mutations: [], connected: false, pending: [],
            network: { version:1, enabled:false, host:'127.0.0.1', port:3124,
              allowInsecureLocalTransport:false, state:'disabled', endpoint:null, error:null,
              addresses:[{name:'Loopback',address:'127.0.0.1'},{name:'Trusted VPN adapter',address:'192.168.20.12'}] }
          };
          window.fetch = async (input, init) => {
            const path = new URL(input, location.href).pathname;
            if (init?.method === 'PUT' || init?.method === 'POST') state.mutations.push({path, body:init.body ? JSON.parse(init.body) : null});
            if (path === '/nodes/v1/network') {
              if (init?.method === 'PUT') {
                Object.assign(state.network, JSON.parse(init.body));
                state.network.state = state.network.enabled ? 'listening' : 'disabled';
                state.network.endpoint = state.network.enabled ? 'http://192.168.20.12:3124' : null;
              }
              return Response.json(state.network);
            }
            if (path === '/nodes/v1/pending') return Response.json({version:1,pending:state.pending});
            if (path === '/pair/v1/offers') {
              state.pending = [{version:1,pendingId:'pending-1',deviceId:'device-1',nodeId:'node-1',credentialId:'credential-1',
                deviceIdentityFingerprint:fingerprint,displayName:'Workshop Child with a long recognizable device name',requestedAt:new Date().toISOString()}];
              return Response.json({version:1,offerId:'invitation-0123456789-abcdefghijklmnopqrstuv',pin:'000012',expiresAt:new Date(Date.now()+300000).toISOString()});
            }
            if (path === '/nodes/v1/pending/pending-1/approve') {
              state.pending = [];
              return Response.json({version:1,deviceId:'device-1',nodeId:'node-1',credentialId:'credential-1'});
            }
            if (path === '/nodes/v1') return Response.json({version:1,nodes:[{
              nodeId:'node-1',displayName:'Workshop Child',role:'child',
              connection:state.connected?'connected':'offline',capabilities:[],
            }]});
            throw new Error('Unexpected request '+path);
          };
          createApp(Nodes, {apiBase:location.origin}).mount('#app');
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
            await wait('!!document.querySelector("#device-host")');
            assert.equal(await execute('document.querySelector(".network-setup button").disabled'),true);
            assert.equal(await execute('document.querySelector(".network-setup input[type=checkbox]").checked'),false);
            assert.equal(await execute('window.fixture.mutations.length'),0);
            for(const width of [1200,390]) {
              window.setContentSize(width,1000);
              await execute('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
              assert.equal(await execute('document.documentElement.scrollWidth <= innerWidth'),true,'No network setup overflow');
              assert.equal(await execute('document.querySelector("#device-host").labels.length'),1);
              assert.equal(await execute('document.querySelector("#device-host").getBoundingClientRect().right <= innerWidth'),true);
            }
            await execute('document.querySelector(".network-setup input[type=checkbox]").click()');
            await wait('!document.querySelector(".network-setup button").disabled');
            await click('Enable device connection');
            await wait('document.body.innerText.includes("Device listener is on")');
            assert.deepEqual(await execute('window.fixture.mutations[0].body'),
              {version:1,enabled:true,host:'192.168.20.12',port:3124,allowInsecureLocalTransport:true});
            await click('Create invitation');
            await wait('!!document.querySelector(".pending-device")');
            for(const dark of [false,true]) {
              await execute('document.documentElement.classList.toggle("dark",'+dark+')');
              for(const width of [1200,390]) {
                window.setContentSize(width,1600);
                await execute('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
                assert.equal(await execute('document.documentElement.scrollWidth <= innerWidth'),true,'No invitation/identity overflow');
                assert.equal(await execute('Array.from(document.querySelectorAll(".pending-device input")).every(el=>el.labels.length===1 && !el.checked)'),true);
                assert.equal(await execute('document.querySelector(".fingerprint").getBoundingClientRect().right <= innerWidth'),true);
                assert.equal(await execute('getComputedStyle(document.querySelector(".device-administration")).backgroundColor'),dark?'rgb(32, 32, 32)':'rgb(255, 255, 255)');
                if(width===390) assert.equal(await execute('Array.from(document.querySelectorAll(".device-button")).every(el=>el.getBoundingClientRect().height>=44)'),true);
                const image=await window.webContents.capturePage();
                assert.equal(image.isEmpty(),false);
                if(process.env.DEVICE_UI_SCREENSHOT_DIR) {
                  await mkdir(process.env.DEVICE_UI_SCREENSHOT_DIR,{recursive:true});
                  await writeFile(join(process.env.DEVICE_UI_SCREENSHOT_DIR,(dark?'dark':'light')+'-'+width+'.png'),image.toPNG());
                }
              }
            }
            assert.equal(await execute('document.querySelector(".pending-device button").disabled'),true);
            await execute('document.querySelectorAll(".pending-device input")[0].click()');
            await delay(20);
            assert.equal(await execute('document.querySelector(".pending-device button").disabled'),true);
            await execute('document.querySelectorAll(".pending-device input")[1].click()');
            await wait('!document.querySelector(".pending-device button").disabled');
            await click('Approve device');
            await wait('document.body.innerText.includes("approved, but not connected")');
            assert.equal(await execute('document.body.innerText.includes("is connected. Its available")'),false);
            await execute('window.fixture.connected=true');
            await click('Refresh');
            await wait('document.body.innerText.includes("is connected. Its available")');
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
