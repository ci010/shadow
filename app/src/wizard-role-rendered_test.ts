import assert from 'node:assert/strict'
import test from 'node:test'
import { randomUUID } from 'node:crypto'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'

const repository = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

test('Main execution choice lives on the role page, persists and skips the removed step', {
  timeout: 60_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server' : false,
}, async () => {
  const directory = resolve(repository, '.test-wizard-role-rendered', randomUUID())
  await mkdir(directory, { recursive: true })
  const server = await createServer({
    configFile: false, root: resolve(repository, 'app'), logLevel: 'error',
    cacheDir: resolve(directory, 'vite-cache'),
    optimizeDeps: { noDiscovery: true, include: ['vue'], entries: [] },
    plugins: [vue(), UnoCSS({ configFile: resolve(repository, 'app', 'unocss.config.ts') }), {
      name: 'wizard-role-fixture',
      resolveId: id => id === '/wizard-role-fixture.ts' ? '\0wizard-role-fixture' : undefined,
      load: id => id !== '\0wizard-role-fixture' ? undefined : `
        import 'uno.css'; import '/src/styles.css';
        import { createApp, nextTick } from 'vue';
        import Wizard from '/src/FirstRunWizard.vue';
        import { setLocalePreference } from '/src/i18n.ts';
        import { transitionWizard, parseWizardState } from '/@fs/${repository.replaceAll('\\', '/')}/desktop/src/wizard/state-machine.ts';
        const fresh = () => ({version:1,revision:0,mode:null,step:'choose-role'});
        const f = window.fixture = { state:fresh(), events:[], launches:[], completed:false, failLaunch:true };
        let mounted;
        const api = { getMainDirectorySelection: async()=>({selectionId:'folder',displayName:'Main data',displayPath:'C:\\\\Main'}), bootstrap:{
          dispatch: async event => { f.events.push(event); f.state=transitionWizard(f.state,event); return f.state; },
          commitMainDirectory:async()=>{f.state=transitionWizard(f.state,{type:'data-directory-selected'});return {ok:true,state:f.state}},
          initializeMain:async()=>{f.state=transitionWizard(f.state,{type:'main-initialized'});return {ok:true,state:f.state}},
          launchMain:async options=>{f.launches.push(options);if(f.failLaunch)return {ok:false,code:'launch-failed',state:f.state};
            f.state=transitionWizard(f.state,{type:'sidecar-ready'});return {ok:true,state:f.state}},
          childSetup:async()=>({endpoint:'',dataDir:'',workdir:'',displayName:'Child',allowInsecureLocalTransport:false,saved:false}),
        }};
        f.mount=async(state=f.state)=>{ mounted?.unmount(); f.state=parseWizardState(JSON.parse(JSON.stringify(state)));
          mounted=createApp(Wizard,{api,initialState:f.state,onComplete:()=>{f.completed=true}});mounted.mount('#app');await nextTick(); };
        f.reset=async()=>{ f.events=[];f.launches=[];f.completed=false;f.failLaunch=true;await f.mount(fresh()); };
        f.tick=nextTick;
        f.locale=setLocalePreference;
        f.mount();
      `,
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== '/__wizard-role') return next()
          response.setHeader('Content-Type', 'text/html')
          response.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/wizard-role-fixture.ts"></script></body></html>')
        })
      },
    }],
    server: { host: '127.0.0.1', port: 0 },
  })
  let child: ReturnType<typeof spawn> | undefined
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    await server.listen()
    assert.ok(server.resolvedUrls?.local[0])
    await build({ entryPoints: [resolve(repository, 'desktop', 'tests', 'fixtures', 'wizard-role-smoke.ts')],
      outfile: join(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
    const env: NodeJS.ProcessEnv = { WIZARD_ROLE_SMOKE_URL: server.resolvedUrls.local[0] }
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
    assert.match(output, /WIZARD_ROLE_SMOKE_OK/)
  } finally {
    clearTimeout(timer)
    if (child && child.exitCode === null) { const stopped = once(child, 'close'); child.kill(); await stopped }
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
})
