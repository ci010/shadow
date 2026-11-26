import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const require = createRequire(import.meta.url)
const repository = fileURLToPath(new URL('../..', import.meta.url))
test('real Electron uses Main HTTP/WS directly and preserves sandboxed previews through a prefix-only proxy', {
  timeout: 60_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY,
}, async t => {
  const directory = resolve(repository, '.tmp', `electron-direct-child-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  await writeFile(join(directory, 'index.html'), '<!doctype html><title>Packaged Child fixture</title><body>Local renderer</body>')
  const { build } = require('esbuild') as typeof import('esbuild')
  await build({ stdin: { resolveDir: repository, contents: `
    import {desktopChildChannel,ChildDesktopControl} from './src/runtime/child-desktop-ipc.ts';
    const channel=desktopChildChannel(); if(!channel) throw new Error('inherited child channel missing');
    const control=new ChildDesktopControl(channel,{ endpoint:'https://device-fixture.test', status:()=>({version:1,nodeId:'fixture'}),
      inventory:()=>({version:1,nodes:[]}), grant:async()=>null, stop:async()=>{await control.shutdown();process.exit(0)} });
    control.start().then(()=>control.markReady());
  ` }, outfile: join(directory, 'utility.cjs'), bundle: true, platform: 'node', format: 'cjs', logLevel: 'silent' })
  await build({ stdin: { resolveDir: repository, contents: `
    import assert from 'node:assert/strict';
    import {app,BrowserWindow,session,utilityProcess} from 'electron';
    import {createServer} from 'node:http';
    import {RealtimeHub,registerRealtimeRoute,REALTIME_SOCKET_PATH} from './src/realtime/hub.ts';
    import {registerGatewayRoutes,serveGateway} from './src/gateway/server.ts';
    import {directDeviceUiPath} from './src/cluster/direct-device-ui.ts';
    import {Hono} from 'hono';
    import {NodeSidecarSupervisor} from './desktop/src/sidecar/supervisor.ts';
    import {createUtilityProcessSpawn} from './desktop/src/sidecar/utility-process.ts';
    import {installRuntimeRequestAuthorization} from './desktop/src/runtime-authorization.ts';
    app.setPath('userData',${JSON.stringify(join(directory, 'profile'))});
    const page=createServer((req,res)=>{
      assert.equal(req.headers.authorization,undefined,'Main grant must not leak to Vite');
      res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Vite-like fixture</title><body>Dev renderer</body>');
    });
    let win; let main;
    const hub=new RealtimeHub();
    (async()=>{try {
      await app.whenReady();
      const sidecar=new NodeSidecarSupervisor({spawn:createUtilityProcessSpawn((entry,args,opts)=>utilityProcess.fork(entry,args,opts)),
        isPortOccupied:async()=>assert.fail('Child cannot probe a port'),readinessProbe:async()=>assert.fail('Child cannot read HTTP readiness'),
        authenticatedShutdownRequest:async()=>assert.fail('Child cannot send HTTP shutdown')});
      const status=await sidecar.start({role:'child',port:0,launchToken:'',executablePath:process.execPath,configPath:'synthetic.json',
        entryPath:${JSON.stringify(join(directory, 'utility.cjs'))}});
      assert.deepEqual(status,{phase:'ready',role:'child',apiBase:'https://device-fixture.test'});
      assert.deepEqual(await sidecar.requestChildControl('status'),{version:1,nodeId:'fixture'});
      assert.deepEqual(await sidecar.requestChildControl('inventory'),{version:1,nodes:[]});
      await sidecar.stop();
      assert.equal(sidecar.status.phase,'stopped');
      console.log('CHILD_UTILITY_IPC_OK');
      await new Promise(resolve=>page.listen(0,'127.0.0.1',resolve));
      const vite='http://127.0.0.1:'+page.address().port;
      const token='z'.repeat(43), lease=new AbortController();
      const api=new Hono();
      const authorize=r=>directDeviceUiPath(new URL(r.url).pathname,r.method)&&r.headers.get('authorization')==='ShadowDevice '+token;
      registerGatewayRoutes(api,[],{launchCredential:'synthetic-main-only',allowedOrigins:[],localLiveSocketPath:REALTIME_SOCKET_PATH,
        launchCredentialExemptions:[{method:'GET',path:REALTIME_SOCKET_PATH}],authorizeClient:authorize,
        delegatedViewer:{authorize,hasCredential:r=>r.headers.get('authorization')?.startsWith('ShadowDevice '),
          ownerSignal:r=>authorize(r)?lease.signal:undefined,allowsCrossOrigin:directDeviceUiPath}});
      registerRealtimeRoute(api,hub,authorize,{authorize,ownerSignal:()=>lease.signal,authorizeTopic:()=>true});
      api.get('/api/projects',c=>c.json({projects:[{id:'direct'}]}));
      main=serveGateway(api,{host:'127.0.0.1',port:0}); await main.ready;
      const apiBase='http://127.0.0.1:'+main.addr.port;
      assert.equal((await fetch(apiBase+'/api/projects')).status,401,'network peer cannot use loopback as identity');
      win=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,sandbox:true}});
      const update=installRuntimeRequestAuthorization(session.defaultSession,d=>d.webContentsId===win.webContents.id);
      update({apiBase,launchToken:'',deviceGrant:async()=>token});
      for(const source of ['file','vite']) {
        if(source==='file') await win.loadFile(${JSON.stringify(join(directory, 'index.html'))}); else await win.loadURL(vite);
        const projects=await win.webContents.executeJavaScript('fetch('+JSON.stringify(apiBase+'/api/projects')+').then(async r=>({status:r.status,body:await r.json()}))');
        assert.deepEqual(projects,{status:200,body:{projects:[{id:'direct'}]}},source);
        const liveUrl=apiBase+REALTIME_SOCKET_PATH;
        const live=await win.webContents.executeJavaScript('fetch('+JSON.stringify(liveUrl)+',{method:"POST",credentials:"same-origin"}).then(async r=>{if(!r.ok)throw new Error("ticket denied "+r.status);const {protocol,proof}=await r.json();return new Promise((resolve,reject)=>{const s=new WebSocket('+JSON.stringify(liveUrl.replace('http:','ws:'))+',[protocol,proof]);s.onopen=()=>s.send(JSON.stringify({type:"subscribe",id:1,subscriptions:[{topic:{kind:"projects"}}]}));s.onmessage=e=>{s.close();resolve(JSON.parse(e.data))};s.onerror=()=>reject(new Error("live upgrade failed"));setTimeout(()=>reject(new Error("live upgrade timed out")),3000)})})');
        assert.equal(live.type,'subscribed',source+' main frame live authorization');
        const iframe=await win.webContents.executeJavaScript('new Promise(resolve=>{const f=document.createElement("iframe");window.addEventListener("message",e=>resolve(e.data),{once:true});f.srcdoc='+JSON.stringify('<script>fetch('+JSON.stringify(liveUrl)+',{method:"POST"}).then(r=>parent.postMessage(r.status,"*")).catch(()=>parent.postMessage("blocked","*"))<\/script>')+';document.body.append(f)})');
        assert.ok(iframe===401||iframe==='blocked',source+' iframe cannot mint a ticket');
        console.log('DIRECT_CHILD_RENDERER_OK '+source);
      }
      win.destroy();hub.close();await main.shutdown();page.close();app.exit(0);
    }catch(error){console.error(error);win?.destroy();hub.close();await main?.shutdown();page.close();app.exit(1)}})();
  ` }, outfile: join(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  delete env.GATEWAY_LAUNCH_CREDENTIAL
  delete env.WINDOWS_USE_LAUNCH_TOKEN
  delete env.GATEWAY_ALLOWED_ORIGINS
  const child = spawn(require('electron') as string, [join(directory, 'main.cjs')], { env, cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', value => { output += value })
  child.stderr.on('data', value => { output += value })
  t.after(() => { if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, output)
  assert.match(output, /CHILD_UTILITY_IPC_OK/)
  assert.match(output, /DIRECT_CHILD_RENDERER_OK file/)
  assert.match(output, /DIRECT_CHILD_RENDERER_OK vite/)
})
