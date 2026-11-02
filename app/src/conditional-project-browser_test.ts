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
import { conditionalSessionJson } from '../../src/sessions/conditional-json.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

test('real Electron conditional Project reads survive 304 with CDP cache enabled and disabled', {
  timeout: 60_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `conditional-project-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const renderer = createServer((_req, res) => {
    res.setHeader('Content-Type', 'text/html')
    res.end('<!doctype html><title>Conditional Project regression</title>')
  }).listen(0, '127.0.0.1')
  await once(renderer, 'listening')
  t.after(() => new Promise<void>((resolve, reject) => renderer.close(error => error ? reject(error) : resolve())))
  const address = renderer.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const credential = 'synthetic-conditional-credential'
  const responses: Array<{ method: string; url: string; status: number; validator?: string; origin?: string; allowOrigin: string | null; cache: string | null }> = []
  const gateway = new Hono()
  gateway.use('*', async (c, next) => {
    await next()
    responses.push({ method: c.req.method, url: c.req.url, status: c.res.status, validator: c.req.header('If-None-Match'), origin: c.req.header('Origin'), allowOrigin: c.res.headers.get('Access-Control-Allow-Origin'), cache: c.res.headers.get('Cache-Control') })
  })
  registerGatewayRoutes(gateway, [app => {
    // Query parameters isolate the two CDP modes and representation changes.
    const versions = new Map<string, number>()
    app.get('/projects/fixture/api/sessions/stages', c => {
      const mode = c.req.query('mode') ?? ''
      const count = (versions.get(mode) ?? 0) + 1
      versions.set(mode, count)
      return conditionalSessionJson(c, 'fixture', { version: count < 3 ? 1 : 2 })
    })
  }], { allowedOrigins: [origin], launchCredential: credential })
  const server = serveGateway(gateway, { host: '127.0.0.1', port: 0 })
  await server.ready
  t.after(() => server.shutdown())
  const apiBase = `http://127.0.0.1:${server.addr.port}`
  const endpoint = `${apiBase}/projects/fixture/api/sessions/stages`
  assert.equal((await fetch(endpoint)).status, 401)
  const forbidden = await fetch(endpoint, { headers: { Origin: 'https://untrusted.example', Authorization: `Bearer ${credential}` } })
  assert.equal(forbidden.status, 403)
  assert.equal(forbidden.headers.get('Access-Control-Allow-Origin'), null)
  const bundle = await build({ stdin: {
    contents: `import { createConditionalProjectJson } from './app/src/projects.ts';
      window.runConditional = async mode => {
        let parses = 0;
        const statuses = [];
        const reader = createConditionalProjectJson(${JSON.stringify(`${apiBase}/projects/fixture`)}, '/api/sessions/stages?mode=' + mode,
          value => { parses++; return value; }, async (url, init) => {
            if (init.cache !== 'no-store') throw Error('missing no-store');
            const response = await fetch(url, init); statuses.push(response.status); return response;
          });
        const signal = new AbortController().signal;
        const first = await reader.load(signal);
        const second = await reader.load(signal);
        const third = await reader.load(signal);
        if (first !== second || third === second || first.version !== 1 || third.version !== 2 || parses !== 2)
          throw Error('conditional snapshot identity/validation failed');
        if (JSON.stringify(statuses) !== '[200,304,200]') throw Error('unexpected statuses: ' + statuses);
        return { mode, statuses, parses, reused: first === second };
      };`, resolveDir: root, loader: 'ts',
  }, bundle: true, write: false, platform: 'browser', format: 'iife', define: { 'import.meta.env.DEV': 'false' }, logLevel: 'silent' })
  const source = resolve(directory, 'main.ts')
  await writeFile(source, `import { app, BrowserWindow, session } from 'electron';
    import { installRuntimeRequestAuthorization } from ${JSON.stringify(resolve(root, 'desktop/src/runtime-authorization.ts'))};
    app.setPath('userData', ${JSON.stringify(resolve(directory, 'profile'))});
    app.on('window-all-closed', () => {});
    app.whenReady().then(async () => {
      const win = new BrowserWindow({ show:false, webPreferences:{contextIsolation:true,nodeIntegration:false} });
      const update = installRuntimeRequestAuthorization(session.defaultSession, details => details.webContentsId === win.webContents.id);
      update({apiBase:${JSON.stringify(apiBase)}, launchToken:${JSON.stringify(credential)}});
      const events = [];
      await win.loadURL(${JSON.stringify(origin)});
      win.webContents.debugger.attach('1.3');
      win.webContents.debugger.on('message', (_event, method, params) => {
        if (['Network.requestWillBeSent','Network.responseReceived','Network.loadingFailed','Network.loadingFinished'].includes(method))
          events.push({method, ...params});
      });
      try {
        await win.webContents.debugger.sendCommand('Network.enable');
        await win.webContents.executeJavaScript(${JSON.stringify(bundle.outputFiles[0]!.text)});
        const results = [];
        for (const disabled of [false, true]) {
          await win.webContents.debugger.sendCommand('Network.setCacheDisabled', {cacheDisabled:disabled});
          results.push(await win.webContents.executeJavaScript('window.runConditional(' + JSON.stringify(String(disabled)) + ')'));
        }
        // Allow terminal CDP events to arrive after the final JS resolution.
        await new Promise(resolve => setTimeout(resolve, 200));
        console.log('CONDITIONAL_EVIDENCE:' + JSON.stringify({electron:process.versions.electron,chrome:process.versions.chrome,results,events}));
        app.exit(0);
      } catch(error) { console.error(error); console.log('CONDITIONAL_FAILURE_EVENTS:' + JSON.stringify(events)); app.exit(1); }
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
  const line = output.split(/\r?\n/).find(line => line.startsWith('CONDITIONAL_EVIDENCE:'))
  assert.ok(line, output)
  const evidence = JSON.parse(line.slice('CONDITIONAL_EVIDENCE:'.length))
  const requests = evidence.events.filter((event: any) => event.method === 'Network.requestWillBeSent' && event.request.method === 'GET' && event.request.url.startsWith(endpoint))
  const correlated = requests.map((request: any) => ({
    mode: new URL(request.request.url).searchParams.get('mode'), requestId: request.requestId,
    response: evidence.events.find((event: any) => event.method === 'Network.responseReceived' && event.requestId === request.requestId)?.response.status,
    failure: evidence.events.find((event: any) => event.method === 'Network.loadingFailed' && event.requestId === request.requestId)?.errorText ?? null,
  }))
  for (const mode of ['false', 'true']) {
    const reads = responses.filter(response => response.method === 'GET' && response.origin === origin && new URL(response.url).searchParams.get('mode') === mode)
    assert.deepEqual(reads.map(read => read.status), [200, 304, 200])
    assert.equal(reads[0].validator, undefined)
    assert.ok(reads[1].validator)
    assert.equal(reads[2].validator, reads[1].validator)
    for (const read of reads) { assert.equal(read.allowOrigin, origin); assert.equal(read.cache, 'no-store') }
  }
  assert.equal(requests.length, 6)
  const preflights = responses.filter(response => response.method === 'OPTIONS')
  assert.ok(preflights.length > 0, 'Real browser conditional header preflight')
  assert.ok(preflights.every(response => response.status === 204 && response.allowOrigin === origin))
  t.diagnostic(JSON.stringify({ electron: evidence.electron, chrome: evidence.chrome, javascript: evidence.results, preflights: preflights.length, preflightsByMode: Object.fromEntries(['false', 'true'].map(mode => [mode, preflights.filter(response => new URL(response.url).searchParams.get('mode') === mode).length])), correlated }))
})
