import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Hono } from 'hono'
import { registerGatewayRoutes, serveGateway } from '../../src/gateway/server.ts'
import { FrontendLog, registerFrontendLogRoutes } from '../../src/runtime/frontend-log.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

test('real cross-port renderer sends frontend logs with native auth and noncredentialed CORS', {
  timeout: 60_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `frontend-log-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const renderer = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.end('<!doctype html><title>Frontend log CORS regression</title>')
  }).listen(0, '127.0.0.1')
  await once(renderer, 'listening')
  t.after(() => new Promise<void>((resolve, reject) => renderer.close(error => error ? reject(error) : resolve())))
  const address = renderer.address()
  assert.ok(address && typeof address !== 'string')
  const rendererOrigin = `http://127.0.0.1:${address.port}`
  const credential = 'synthetic-frontend-log-credential'
  const log = new FrontendLog('development')
  const gateway = new Hono()
  const responses: Array<{ method: string; origin: string | undefined; allowOrigin: string | null; allowCredentials: string | null; cookie: string | undefined; status: number }> = []
  gateway.use('*', async (c, next) => {
    await next()
    responses.push({ method: c.req.method, origin: c.req.header('Origin'), allowOrigin: c.res.headers.get('Access-Control-Allow-Origin'),
      allowCredentials: c.res.headers.get('Access-Control-Allow-Credentials'), cookie: c.req.header('Cookie'), status: c.res.status })
  })
  registerGatewayRoutes(gateway, [app => {
    const project = new Hono()
    registerFrontendLogRoutes(project, log, request => request.headers.get('Authorization') === `Bearer ${credential}`)
    app.route('/projects/fixture', project)
  }], { allowedOrigins: [rendererOrigin], launchCredential: credential })
  const server = serveGateway(gateway, { host: '127.0.0.1', port: 0 })
  await server.ready
  t.after(() => server.shutdown())
  const apiBase = `http://127.0.0.1:${server.addr.port}`
  const endpoint = `${apiBase}/projects/fixture/api/runtime/frontend-logs`
  assert.notEqual(apiBase, rendererOrigin)
  assert.equal((await fetch(endpoint)).status, 401, 'The real gateway still requires authentication')
  const forbidden = await fetch(endpoint, { headers: { Origin: 'https://untrusted.example', Authorization: `Bearer ${credential}` } })
  assert.equal(forbidden.status, 403)
  assert.equal(forbidden.headers.get('Access-Control-Allow-Origin'), null)
  const bundle = await build({ stdin: {
    contents: `import { startFrontendLog } from './app/src/frontend-log.ts';
      window.runCollector = async () => {
        // This is the original failing mode: a real browser must reject a 200
        // response without Allow-Credentials when credentials is include.
        let blocked = false;
        try { await fetch(${JSON.stringify(endpoint)}, {credentials:'include'}); } catch { blocked = true; }
        if (!blocked) throw Error('credentialed CORS unexpectedly allowed');
        const stop = startFrontendLog(${JSON.stringify(`${apiBase}/projects/fixture`)}, new AbortController().signal);
        console.warn('synthetic frontend transport regression');
        await new Promise(resolve => setTimeout(resolve, 2200)); stop();
      };`, resolveDir: root, loader: 'ts',
  }, bundle: true, write: false, platform: 'browser', format: 'iife', logLevel: 'silent' })
  const source = resolve(directory, 'main.ts')
  await writeFile(source, `import { app, BrowserWindow, session } from 'electron';
    import { installRuntimeRequestAuthorization } from ${JSON.stringify(resolve(root, 'desktop/src/runtime-authorization.ts'))};
    app.setPath('userData', ${JSON.stringify(resolve(directory, 'profile'))});
    app.on('window-all-closed', () => {});
    app.whenReady().then(async () => {
      const win = new BrowserWindow({show:false, webPreferences:{contextIsolation:true, nodeIntegration:false}});
      const update = installRuntimeRequestAuthorization(session.defaultSession, details => details.webContentsId === win.webContents.id);
      update({apiBase:${JSON.stringify(apiBase)}, launchToken:${JSON.stringify(credential)}});
      try {
        await session.defaultSession.cookies.set({url:${JSON.stringify(apiBase)},name:'synthetic_cookie',value:'must-not-cross-ports'});
        await win.loadURL(${JSON.stringify(rendererOrigin)});
        await win.webContents.executeJavaScript(${JSON.stringify(bundle.outputFiles[0]!.text)});
        await win.webContents.executeJavaScript('window.runCollector()');
        console.log('FRONTEND_LOG_CORS_OK'); app.exit(0);
      } catch(error) { console.error(error); app.exit(1); }
    });`)
  await build({ entryPoints: [source], outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'], logLevel: 'silent' })
  const env: NodeJS.ProcessEnv = {}
  for (const name of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
    if (process.env[name] !== undefined) env[name] = process.env[name]
  }
  for (const name of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[name] = directory
  const child = spawn(desktopRequire('electron') as string, [resolve(directory, 'main.cjs')], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
  const timeout = setTimeout(() => child.kill(), 40_000)
  t.after(() => { clearTimeout(timeout); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, output)
  assert.match(output, /FRONTEND_LOG_CORS_OK/)
  assert.match(log.read(), /synthetic frontend transport regression/)
  const cors = responses.filter(response => response.origin === rendererOrigin)
  assert.ok(cors.some(response => response.method === 'OPTIONS' && response.status === 204), 'Real JSON POST preflight')
  assert.ok(cors.some(response => response.method === 'GET' && response.status === 200))
  assert.ok(cors.some(response => response.method === 'POST' && response.status === 200))
  for (const response of cors) {
    assert.equal(response.allowOrigin, rendererOrigin)
    assert.equal(response.allowCredentials, null, 'No gateway cross-origin cookie permission was added')
    if (response.method === 'POST') assert.equal(response.cookie, undefined, 'Collector must not send cross-origin cookies')
  }
})
