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

test('Child wizard validates consent and retries; local shell is honest offline and stays bounded', {
  timeout: 60_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server' : false,
}, async () => {
  const directory = resolve(repository, '.test-child-rendered', randomUUID())
  await mkdir(directory, { recursive: true })
  const server = await createServer({
    configFile: false, root: resolve(repository, 'app'), logLevel: 'error',
    plugins: [vue(), UnoCSS({ configFile: resolve(repository, 'app', 'unocss.config.ts') }), {
      name: 'child-desktop-fixture',
      resolveId: id => id === '/child-fixture.ts' ? '\0child-fixture' : undefined,
      load: id => id !== '\0child-fixture' ? undefined : `
        import 'uno.css'; import '/src/styles.css';
        import { createApp, h } from 'vue';
        import Wizard from '/src/FirstRunWizard.vue';
        import Child from '/src/ChildDesktop.vue';
        import Recovery from '/src/RuntimeRecovery.vue';
        import DesktopFrame from '/src/DesktopFrame.vue';
        import RoleSettings from '/src/components/DesktopRoleSettings.vue';
        import { createInstallationContextProvider } from '/src/composables/useInstallationContext.ts';
        const f = window.fixture = { requests: [], pairs: [], fail: true, completed: false, connection: 'offline', statusFailure: false, role:'child', switches:[], switchFails:false };
        const info = { endpoint:'http://192.168.1.5:43125',dataDir:'C:\\\\Child-home',workdir:'C:\\\\Work',
          displayName:'Child laptop',allowInsecureLocalTransport:true,saved:false };
        const api = window.shadowDesktop = { folders:{selectDirectory:async()=>null}, bootstrap:{
          load: async()=>({version:1,revision:1,mode:f.role,step:'complete'}),
          switchRole: async(role,executionConsent)=>{f.switches.push({role,executionConsent});if(f.switchFails)throw new Error('synthetic failure');return {restart:true}},
          dispatch: async event => ({version:1,revision:1,mode:event.mode,step:'enter-pairing-offer'}),
          childSetup: async()=>info,
          pairChild: async input => { f.pairs.push(input); if(f.fail) throw new Error('Pairing failed. Check Main and retry.');
            return {ok:true,state:{version:1,revision:2,mode:'child',step:'complete'}}; }
        }};
        let mounted = createApp(Wizard, { api,initialState:{version:1,revision:0,mode:null,step:'choose-role'},onComplete:()=>{f.completed=true} });
        mounted.mount('#app');
        window.fetch = async url => {
          f.requests.push(String(url));
          if (String(url).endsWith('/local/v1/child')) {
            if(f.statusFailure) throw new Error('offline');
            return Response.json({version:1,nodeId:'child-1',mainEndpoint:info.endpoint,connection:f.connection,
              error:f.connection === 'offline' ? 'Main has not authorized this device.' : null,fingerprint:'sha256:1234567890abcdef',
              dataDir:info.dataDir,workdirs:[{capabilityId:'desktop-workdir',rootPath:info.workdir,displayName:'Shared work folder'}],
              allowInsecureLocalTransport:true});
          }
          if (String(url).endsWith('/local/v1/nodes')) return Response.json({version:1,nodes:[{nodeId:'child-1',displayName:'Child laptop',role:'child',
            connection:f.connection === 'connected' ? 'connected':'offline',capabilities:[{capabilityId:'desktop-workdir',kind:'workdir',displayName:'Shared work folder',displayPath:info.workdir,online:true}]}]});
          throw new Error('Unexpected Main API request: '+url);
        };
        f.openRecovery = () => { f.role='child'; mounted.unmount(); mounted=createApp({render:()=>h(DesktopFrame,null,{default:()=>h(Recovery,{canReset:false,role:'child',code:'spawn-error',retry:async()=>{}})})});mounted.mount('#app'); };
        f.openRoleSettings = role => { f.role=role; mounted.unmount(); mounted=createApp(RoleSettings);mounted.mount('#app'); };
        f.openChild = () => { mounted.unmount(); mounted = createApp(Child,{apiBase:location.origin})
          .use(createInstallationContextProvider({version:1,mode:'child',localNodeId:'child-1',mainConnection:'connecting',mainLatencyMs:null,uiScopes:[],apiBase:location.origin}));
          mounted.mount('#app'); };
      `,
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== '/__child') return next()
          response.setHeader('Content-Type', 'text/html')
          response.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/child-fixture.ts"></script></body></html>')
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
    await build({ entryPoints: [resolve(repository, 'desktop', 'tests', 'fixtures', 'child-desktop-smoke.ts')],
      outfile: join(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
    const env: NodeJS.ProcessEnv = { CHILD_SMOKE_URL: server.resolvedUrls.local[0] }
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
    assert.match(output, /CHILD_SMOKE_OK/)
  } finally {
    clearTimeout(timer)
    if (child && child.exitCode === null) { const stopped = once(child, 'close'); child.kill(); await stopped }
    await server.close()
    await rm(directory, { recursive: true, force: true })
  }
})
