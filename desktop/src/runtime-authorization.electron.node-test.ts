import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import test from 'node:test'

const require = createRequire(import.meta.url)
test('real Electron file and Vite-like main-frame fetch receives Child admission; iframe does not', {
  timeout: 60_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY,
}, async t => {
  const directory = resolve('.tmp', `electron-child-admission-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  await writeFile(join(directory, 'index.html'), '<!doctype html><title>isolated Child admission</title>')
  const { build } = require('esbuild') as typeof import('esbuild')
  await build({ stdin: { resolveDir: process.cwd(), contents: `
    import assert from 'node:assert/strict';
    import {app,BrowserWindow,session} from 'electron';
    import {createServer} from 'node:http';
    import {ChildLocalControlService} from './src/runtime/child-local-control.ts';
    import {installRuntimeRequestAuthorization} from './desktop/src/runtime-authorization.ts';
    app.setPath('userData',${JSON.stringify(join(directory, 'profile'))});
    const page=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Vite-like fixture</title>')});
    let child; let win;
    (async()=>{try {
      await new Promise(resolve=>page.listen(0,'127.0.0.1',resolve));
      const pageBase='http://127.0.0.1:'+page.address().port;
      process.env.VITE_DEV_URL=pageBase;
      child=new ChildLocalControlService({port:0,launchCredential:'synthetic-isolated-token',requestShutdown(){},workspace:app=>app.get('/api/projects',c=>c.json({projects:[]}))});
      await child.start(new AbortController().signal);
      const apiBase='http://127.0.0.1:'+child.address.port;
      await app.whenReady();
      win=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,sandbox:true}});
      const update=installRuntimeRequestAuthorization(session.defaultSession,d=>d.webContentsId===win.webContents.id);
      update({apiBase,launchToken:'synthetic-isolated-token'});
      for(const source of ['file','http']) {
        if(source==='file')await win.loadFile(${JSON.stringify(join(directory, 'index.html'))});else await win.loadURL(pageBase);
        const result=await win.webContents.executeJavaScript('fetch('+JSON.stringify(apiBase+'/api/projects')+').then(async r=>({status:r.status,body:await r.json()}))');
        assert.equal(result.status,200,source+' main frame');
        assert.deepEqual(result.body,{projects:[]});
        const denied=await win.webContents.executeJavaScript('new Promise(resolve=>{const f=document.createElement("iframe");window.addEventListener("message",e=>resolve(e.data),{once:true});f.srcdoc='+JSON.stringify('<script>fetch('+JSON.stringify(apiBase+'/api/projects')+').then(r=>parent.postMessage(r.status,"*")).catch(()=>parent.postMessage("blocked","*"))<\\/script>')+';document.body.append(f)})');
        assert.ok(denied===401||denied==='blocked',source+' iframe must not inherit launch credential: '+denied);
        console.log('Child admission verified: '+source+' main-frame=200 iframe='+denied);
      }
      win.destroy();await child.shutdown();page.close();app.exit(0);
    }catch(error){console.error(error);win?.destroy();await child?.shutdown();page.close();app.exit(1)}})();
  ` }, outfile: join(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  // The fixture never inherits real gateway credentials/configuration.
  delete env.GATEWAY_LAUNCH_CREDENTIAL
  delete env.WINDOWS_USE_LAUNCH_TOKEN
  delete env.GATEWAY_ALLOWED_ORIGINS
  const child = spawn(require('electron') as string, [join(directory, 'main.cjs')], { env, cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', value => { output += value })
  child.stderr.on('data', value => { output += value })
  t.after(() => { if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'exit')
  assert.equal(code, 0, output)
})
