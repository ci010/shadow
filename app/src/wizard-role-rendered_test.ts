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

test('setup wizard defaults to Main and gates completion on live provider readiness, with resumable advanced setup', {
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
        import { createLocalMainAdminContext } from '/src/installation-context.ts';
        const fresh = () => ({version:1,revision:0,mode:null,step:'choose-role'});
        const missing = () => ({provider:'copilot',model:'gpt-4.1',authMode:'copilot',host:'github.com',ready:false,hasApiKey:false,reason:'missing_credentials'});
        const connected = () => ({provider:'openai',model:'gpt-4.1',authMode:'api-key',ready:true,hasApiKey:true});
        const defaults = () => ({ state:fresh(), events:[], calls:[], launches:[], preparations:[], commits:[], paths:[], requests:[],
          completed:false, pickerCalls:0, directoryLoads:0, initializations:0,
          failInitialize:false, loseInitializeReply:false, failPrepare:false, failLaunch:false, failStatus:false,
          holdSave:false, saveReady:true, liveReadyAfterSave:true, status:missing() });
        const f = window.fixture = defaults();
        let mounted;
        // Only the transport is fake: the production ProviderSetup, client, validation and events all run.
        // Never forward a request to a provider, real Main, credentials store or user directory.
        window.fetch = async (input, init={}) => {
          const url = new URL(String(input), location.href);
          const method = init.method ?? 'GET';
          const body = init.body ? JSON.parse(init.body) : undefined;
          f.requests.push({path:url.pathname+url.search,method,...(body ? {body} : {})});
          f.calls.push(method+' '+url.pathname+url.search);
          if (url.origin !== location.origin) throw new Error('Unexpected external request: '+url.origin);
          if (url.pathname === '/api/provider/setup') {
            if (method === 'GET') {
              if (f.failStatus) return Response.json({error:'synthetic service failure'},{status:503});
              return Response.json(f.status);
            }
            if (method === 'POST') {
              if (f.holdSave) await new Promise(resolve=>{ f.releaseSave=resolve });
              if (f.saveReady && f.liveReadyAfterSave) f.status=connected();
              return Response.json(f.saveReady ? connected() : {...missing(),reason:'invalid_credentials'});
            }
          }
          if (url.pathname === '/api/auth/login' && method === 'POST') {
            f.loginId=body.attemptId;
            return Response.json({loginId:f.loginId,state:'pending',host:'github.com',userCode:'FAKE-CODE',
              verificationUri:'https://github.com/login/device',expiresAt:Date.now()+300000,intervalMs:60000});
          }
          if (url.pathname === '/api/auth/login/'+f.loginId && method === 'DELETE') return Response.json({});
          throw new Error('Unexpected fixture request: '+method+' '+url.pathname);
        };
        const selection = {selectionId:'recommended-folder',displayName:'Main data',displayPath:'C:/fixture-only/Main'};
        const prepareProvider = async options => {
          f.calls.push('prepareProvider');f.preparations.push(options);
          return f.failPrepare ? {ok:false,code:'runtime-unavailable'} : {ok:true,context:createLocalMainAdminContext(location.origin)};
        };
        const api = {
          getMainDirectorySelection: async()=>{f.calls.push('getMainDirectorySelection');f.directoryLoads++;return selection},
          selectDirectory:async()=>{f.pickerCalls++;return {selectionId:'picked-folder',displayName:'Custom data',displayPath:'C:/fixture-only/custom'}},
          selectMainDirectoryPath:async path=>{f.paths.push(path);return {...selection,selectionId:path===selection.displayPath ? selection.selectionId : 'custom-folder',displayPath:path}},
          bootstrap:{
            load:async()=>f.state,
            dispatch: async event => { f.calls.push(event.type);f.events.push(event); f.state=transitionWizard(f.state,event); return f.state; },
            commitMainDirectory:async id=>{f.calls.push('commitMainDirectory');f.commits.push(id);f.state=transitionWizard(f.state,{type:'data-directory-selected'});return {ok:true,state:f.state}},
            initializeMain:async()=>{f.calls.push('initializeMain');f.initializations++;
              if(f.failInitialize)return {ok:false,code:'initialize-failed',state:f.state};
              f.state=transitionWizard(f.state,{type:'main-initialized'});
              if(f.loseInitializeReply){f.loseInitializeReply=false;throw new Error('Synthetic lost IPC reply')}
              return {ok:true,state:f.state}},
            prepareProvider,
            launchMain:async options=>{f.calls.push('launchMain');f.launches.push(options);if(f.failLaunch)return {ok:false,code:'launch-failed',state:f.state};
              f.state=transitionWizard(f.state,{type:'sidecar-ready'});return {ok:true,state:f.state}},
            childSetup:async()=>({endpoint:'',dataDir:'C:/fixture-only/child',workdir:'C:/fixture-only/work',displayName:'Child',allowInsecureLocalTransport:false,saved:false}),
          }};
        f.mount=async(state=f.state)=>{ mounted?.unmount(); f.state=parseWizardState(JSON.parse(JSON.stringify(state)));
          mounted=createApp(Wizard,{api,initialState:f.state,onComplete:()=>{f.completed=true}});mounted.mount('#app');await nextTick(); };
        f.reset=async(options={})=>{mounted?.unmount();mounted=undefined;Object.assign(f,defaults(),options);api.bootstrap.prepareProvider=options.oldDesktop ? undefined : prepareProvider;await f.mount(f.state)};
        f.ready=connected;
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
    if (process.env.WIZARD_ROLE_SCREENSHOTS === '1') env.WIZARD_ROLE_SCREENSHOT_DIR = resolve(repository, '.tmp')
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
