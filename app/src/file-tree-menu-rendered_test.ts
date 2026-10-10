import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))

test('rendered file menus copy paths, gate native reveal, report failures and restore focus', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `file-menu-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error',
    cacheDir: resolve(directory, 'vite-cache'), optimizeDeps: { noDiscovery: true },
    plugins: [vue(), {
      name: 'file-menu-fixture',
      resolveId: id => id === '/file-menu.ts' ? '\0file-menu' : undefined,
      load(id) {
        if (id !== '\0file-menu') return
        return `import '/src/styles.css';
          import {createApp,h,ref,shallowRef} from 'vue';
          import Node from '/src/components/files/FileTreeNode.vue';
          import Menu from '/src/components/files/FileTreeContextMenu.vue';
          const request=shallowRef(), workdir=ref({kind:'local',displayPath:'C:\\\\project'});
          window.fixture={workdir,opened:0};
          Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async text=>{
            if(window.fixture.failCopy) throw new Error('denied'); window.fixture.copied=text;
          }}});
          createApp({setup:()=>()=>[
            h(Node,{apiBase:location.origin,sessionId:'fixture',dir:'src',depth:0,
              entry:{name:'a.ts',type:'file',ext:'.ts',size:1,mtime:null},
              onOpen:()=>window.fixture.opened++,onContextMenu:value=>request.value=value}),
            request.value ? h(Menu,{request:request.value,workdir:workdir.value,onClose:()=>request.value=undefined}) : null
          ]}).mount('#app');`
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== '/__file-menu') return next()
          response.setHeader('Content-Type', 'text/html')
          response.end('<html><body><div id="app"></div><script type="module" src="/file-menu.ts"></script></body></html>')
        })
      },
    }],
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  t.after(() => server.close())
  const url = new URL('__file-menu', server.resolvedUrls!.local[0]).href
  const { build } = desktopRequire('esbuild') as typeof import('esbuild')
  await build({
    stdin: { contents: `
      const assert=require('node:assert/strict');
      const {app,BrowserWindow}=require('electron');
      const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
      app.setPath('userData',require('node:path').join(process.cwd(),'profile'));
      app.on('window-all-closed',()=>{});
      (async()=>{
        await app.whenReady();
        const win=new BrowserWindow({show:false,width:600,height:400,webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}});
        const run=code=>win.webContents.executeJavaScript(code);
        const wait=async code=>{
          for(let i=0;i<200;i++){if(await run(code))return;await delay(50)}
          throw new Error('Timed out: '+code+'\\n'+await run('document.body.innerText'));
        };
        const open=()=>run("document.querySelector('.tree-row').dispatchEvent(new MouseEvent('contextmenu',{bubbles:true,cancelable:true,clientX:innerWidth-2,clientY:innerHeight-2}))");
        const escape=()=>run("document.querySelector('.file-menu').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))");
        try {
          await win.loadURL(${JSON.stringify(url)});
          await wait("!!document.querySelector('.tree-row')");
          await open(); await wait("!!document.querySelector('.file-menu')");
          assert.deepEqual(await run("Array.from(document.querySelectorAll('.file-menu button'),b=>b.textContent)"),['Copy full path','Copy relative path']);
          assert.equal(await run("(()=>{const r=document.querySelector('.file-menu').getBoundingClientRect();return r.right<=innerWidth&&r.bottom<=innerHeight})()"),true);
          await run("document.querySelector('.file-menu button').click()");
          await wait("!document.querySelector('.file-menu')");
          assert.equal(await run("fixture.copied"),${JSON.stringify('C:\\project\\src\\a.ts')});
          assert.equal(await run("document.activeElement.dataset.path"),'src/a.ts');
          await run("document.activeElement.dispatchEvent(new KeyboardEvent('keydown',{key:'F10',shiftKey:true,bubbles:true,cancelable:true}))");
          await wait("!!document.querySelector('.file-menu')");
          await run("document.querySelector('.file-menu').dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowDown',bubbles:true}));document.activeElement.click()");
          await wait("!document.querySelector('.file-menu')");
          assert.equal(await run("fixture.copied"),'src/a.ts');
          await run("fixture.failCopy=true");
          await open(); await wait("!!document.querySelector('.file-menu')");
          await run("document.querySelector('.file-menu button').click()");
          await wait("!!document.querySelector('.file-menu [role=alert]')");
          await escape(); await wait("!document.querySelector('.file-menu')");
          await run("fixture.failCopy=false;window.shadowDesktop={fileExplorer:{showInFolder:async path=>{if(fixture.failReveal)throw new Error('missing');fixture.revealed=path}}};void 0");
          await open(); await wait("document.querySelectorAll('.file-menu button').length===3");
          await run("document.querySelectorAll('.file-menu button')[2].click()");
          await wait("!document.querySelector('.file-menu')");
          assert.equal(await run("fixture.revealed"),${JSON.stringify('C:\\project\\src\\a.ts')});
          await run("fixture.failReveal=true");
          await open(); await wait("document.querySelectorAll('.file-menu button').length===3");
          await run("document.querySelectorAll('.file-menu button')[2].click()");
          await wait("!!document.querySelector('.file-menu [role=alert]')");
          await escape(); await wait("!document.querySelector('.file-menu')");
          await run("fixture.workdir.value.kind='remote'");
          await open(); await wait("document.querySelectorAll('.file-menu button').length===2");
          await run("document.querySelector('.file-menu-backdrop').dispatchEvent(new PointerEvent('pointerdown',{bubbles:true}))");
          await wait("!document.querySelector('.file-menu')");
          assert.equal(await run("fixture.opened"),0);
          await run("document.querySelector('.tree-row').click()");
          assert.equal(await run("fixture.opened"),1);
          console.log('FILE_MENU_OK');
        } finally {win.destroy()}
      })().then(()=>app.exit(0),error=>{console.error(error);app.exit(1)});
    ` },
    outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs',
    external: ['electron'], logLevel: 'silent',
  })
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = directory
  const child = spawn(desktopRequire('electron') as string, [resolve(directory, 'main.cjs')],
    { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { log += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { log += chunk })
  const timer = setTimeout(() => child.kill(), 75_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, log)
  assert.match(log, /FILE_MENU_OK/)
})
