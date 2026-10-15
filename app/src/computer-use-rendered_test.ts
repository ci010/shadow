import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { withTempWorkspace } from '../../src/testing/workspace.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

test('computer controls render safe defaults, exact-action review and independent Stop at desktop/mobile widths', {
  timeout: 60_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async () => withTempWorkspace(async directory => {
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error',
    cacheDir: resolve(directory, 'vite-cache'), optimizeDeps: { entries: [] },
    plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app', 'unocss.config.ts') }), {
      name: 'computer-fixture',
      resolveId: id => id === '/computer-fixture.ts' ? '\0computer-fixture' : undefined,
      load: id => id !== '\0computer-fixture' ? undefined : `
        import 'uno.css'; import '/src/styles.css';
        import { createApp, h } from 'vue';
        import { setLocalePreference } from '/src/i18n.ts';
        import ComputerControl from '/src/components/ComputerControl.vue';
        const id = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
        const target = {id,title:'Synthetic <img src=x onerror=alert(1)> window',app:'fixture',pid:42,bounds:{x:0,y:0,width:400,height:300}};
        const state = {projectId:'fixture',sessionId:'web:fixture',available:true,busy:false,grant:null,pending:null,executing:false,lastAction:null};
        const canvas = document.createElement('canvas'); canvas.width=400; canvas.height=300;
        const context=canvas.getContext('2d'); context.fillStyle='#fff'; context.fillRect(0,0,400,300);
        context.fillStyle='#17202b'; context.font='18px sans-serif'; context.fillText('Synthetic review only',20,35);
        context.strokeRect(60,50,80,50); context.strokeRect(270,200,60,60);
        const png=Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]),c=>c.charCodeAt(0));
        window.fixture = {state,requests:[],decisions:[],shares:[],stops:0,frameMode:'ok',setLocalePreference};
        window.fetch = async (url, init) => {
          const path = new URL(url, location.href).pathname; window.fixture.requests.push({path,method:init?.method||'GET'});
          if(path.endsWith('/windows')) return Response.json({windows:[{id,title:target.title,app:'fixture',pid:42}],excluded:0});
          if(path.endsWith('/share')) {
            const body=JSON.parse(init.body); window.fixture.shares.push(body);
            state.grant = {target,expiresAt:new Date(Date.now()+600000).toISOString(),foregroundInput:body.foregroundInput};
          }
          if(path.endsWith('/frame')) return window.fixture.frameMode==='ok'
            ? new Response(png,{headers:{'content-type':'image/png'}}) : new Response('Synthetic failure',{status:503});
          if(path.includes('/decisions/')) {
            window.fixture.decisions.push(JSON.parse(init.body)); const requestId=state.pending.id; state.pending=null;
            return Response.json({requestId,accepted:true});
          }
          if(path.endsWith('/stop')) {window.fixture.stops++;state.grant=null;state.pending=null;return Response.json({stopped:true});}
          return Response.json(state);
        };
        createApp({render:() => h(ComputerControl,{apiBase:location.origin,projectId:'fixture',sessionId:'web:fixture',active:true,canSubmit:true,stage:'tool'})}).mount('#app');
      `,
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== '/__computer') return next()
          response.setHeader('Content-Type', 'text/html')
          response.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/computer-fixture.ts"></script></body></html>')
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
    await build({
      entryPoints: [resolve(root, 'desktop', 'tests', 'fixtures', 'computer-use-smoke.ts')],
      outfile: join(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs',
      target: 'node24', external: ['electron'], logLevel: 'silent',
    })
    const env: NodeJS.ProcessEnv = { COMPUTER_SMOKE_URL: url }
    for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
      if (process.env[key] !== undefined) env[key] = process.env[key]
    }
    for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = directory
    await mkdir(join(directory, 'profile'))
    child = spawn(desktopRequire('electron') as string, [join(directory, 'main.cjs')], {
      cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout!.setEncoding('utf8').on('data', chunk => { output += chunk })
    child.stderr!.setEncoding('utf8').on('data', chunk => { output += chunk })
    timer = setTimeout(() => child?.kill(), 45_000)
    const [code] = await once(child, 'close')
    assert.equal(code, 0, output)
    assert.match(output, /COMPUTER_SMOKE_OK/)
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
}))
