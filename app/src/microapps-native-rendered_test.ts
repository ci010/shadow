import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Hono } from 'hono'
import { createServer, type ViteDevServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { MicroApps } from '../../src/microapps/service.ts'
import { microAppsPlugin } from '../../src/microapps/routes.ts'
import { reserveAppPort } from '../../src/microapps/ports.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

test('native Apps use a branded isolated window and Windows tasks launch warm and cold without credentials', {
  timeout: 120_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `microapp-native-ui-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  // Windows resolves Recent via USERPROFILE, not just APPDATA, when creating a Jump List.
  for (const name of ['AutomaticDestinations', 'CustomDestinations']) {
    await mkdir(resolve(directory, 'AppData', 'Roaming', 'Microsoft', 'Windows', 'Recent', name), { recursive: true })
  }
  await mkdir(resolve(directory, 'AppData', 'Local'), { recursive: true })
  let calls = 0
  const service = new MicroApps('p', directory, () => ({
    name: 'fixture', listModels: () => ['fixture'],
    chat: async (_messages, tools) => { assert.equal(tools.length, 0); return { content: `Result ${++calls}`, toolCalls: [] } },
  }), () => 'fixture')
  const host = new Hono()
  microAppsPlugin(service, req => req.headers.get('authorization') === 'Bearer synthetic-owner')(host)
  let server: ViteDevServer | undefined, child: ReturnType<typeof spawn> | undefined
  t.after(async () => {
    if (child?.exitCode === null) { child.kill(); await once(child, 'close') }
    await server?.close(); await service.shutdown()
    await rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 })
  })
  await service.init()
  const source = resolve(directory, 'source'); await mkdir(source)
  await writeFile(resolve(source, 'icon.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNQiT74HwAEJwJAst2PdAAAAABJRU5ErkJggg==', 'base64'))
  await writeFile(resolve(source, 'index.html'), `<!doctype html><html><head><title>Untrusted page title</title></head><body>
    <h1>Native app fixture</h1><button id="run">Run model</button><output></output><script type="module">
    import {generate} from '/_shadow/sdk.js';document.querySelector('#run').onclick=async()=>{
    document.querySelector('output').textContent=(await generate({messages:[{role:'user',content:'Synthetic input'}]})).text;
    };</script></body></html>`)
  const record = await service.publish(source, { version: 1, name: 'Branded native app', description: 'Synthetic native-window fixture',
    entry: 'index.html', icon: 'icon.png', files: ['index.html', 'icon.png'], llm: { maxCalls: 2, maxOutputTokens: 32 } },
  'web:author', AbortSignal.timeout(5000))
  server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'), optimizeDeps: { entries: [] },
    plugins: [vue(), {
      name: 'native-microapp-fixture',
      resolveId: id => id === '/native-fixture.ts' ? '\0native-fixture' : undefined,
      load: id => id !== '\0native-fixture' ? undefined : `
        import '/src/styles.css';import {createApp,h} from 'vue';
        import {createRouter,createMemoryHistory} from 'vue-router';
        import ProjectMicroApps from '/src/components/ProjectMicroApps.vue';
        const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',component:{render:()=>null}}]});
        await router.push({path:'/',query:{microApp:${JSON.stringify(record.id)}}});await router.isReady();
        createApp({render:()=>h(ProjectMicroApps,{apiBase:location.origin+'/projects/p',active:true,canWrite:true,style:'height:100vh'})}).use(router).mount('#app');`,
      configureServer(vite) {
        vite.middlewares.use(async (req, res, next) => {
          try {
            const url = new URL(req.url!, 'http://127.0.0.1')
            if (url.pathname === '/__hang') {
              res.setHeader('Content-Type', 'text/html')
              res.write('<!doctype html><html><head>')
              return
            }
            if (url.pathname === '/__native') {
              res.setHeader('Content-Type', 'text/html')
              return res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/native-fixture.ts"></script></body></html>')
            }
            if (url.pathname === '/api/projects') {
              if (req.headers.authorization !== 'Bearer synthetic-owner') { res.statusCode = 401; return res.end() }
              res.setHeader('Content-Type', 'application/json'); return res.end(JSON.stringify({ projects: [{ id: 'p' }] }))
            }
            if (!url.pathname.startsWith('/projects/p/api/microapps')) return next()
            let body = ''; for await (const part of req) body += part
            const response = await host.request(url.pathname.slice('/projects/p'.length) + url.search, {
              method: req.method, headers: { 'Content-Type': 'application/json', authorization: String(req.headers.authorization ?? '') },
              ...(body ? { body } : {}),
            })
            res.statusCode = response.status
            response.headers.forEach((value, key) => res.setHeader(key, value))
            res.end(Buffer.from(await response.arrayBuffer()))
          } catch (error) { next(error) }
        })
      },
    }],
    server: { host: '127.0.0.1', port: await reserveAppPort(), strictPort: true },
  })
  await server.listen()
  const url = server.resolvedUrls?.local[0]; assert.ok(url)
  await Promise.all([
    build({ entryPoints: [resolve(root, 'desktop', 'tests', 'fixtures', 'microapps-native-smoke.ts')],
      outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], logLevel: 'silent' }),
    build({ entryPoints: [resolve(root, 'desktop', 'src', 'preload.ts')],
      outfile: resolve(directory, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], logLevel: 'silent' }),
  ])
  const env: NodeJS.ProcessEnv = { MICROAPPS_NATIVE_URL: url, MICROAPPS_NATIVE_OUTPUT: directory }
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XAUTHORITY', 'MICROAPPS_SCREENSHOTS']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  for (const key of ['HOME', 'USERPROFILE', 'TMP', 'TEMP', 'TMPDIR']) env[key] = directory
  env.APPDATA = resolve(directory, 'AppData', 'Roaming')
  env.LOCALAPPDATA = resolve(directory, 'AppData', 'Local')
  const run = async (cold: boolean) => {
    child = spawn(desktopRequire('electron') as string, [resolve(directory, 'main.cjs'),
      ...(cold ? [`--shadow-micro-app=p:${record.id}`] : [])], {
      cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout!.setEncoding('utf8').on('data', chunk => { output += chunk })
    child.stderr!.setEncoding('utf8').on('data', chunk => { output += chunk })
    const timer = setTimeout(() => child?.kill(), 50_000)
    const [code] = await once(child, 'close'); clearTimeout(timer)
    assert.equal(code, 0, output)
    assert.match(output, cold ? /NATIVE_COLD_OK/ : /NATIVE_APPS_OK/)
  }
  await run(false)
  assert.ok(service.get(record.id).approval)
  assert.equal(service.get(record.id).status, 'stopped')
  await run(true)
  assert.equal(calls, 2)
  assert.equal(service.get(record.id).status, 'stopped')
  const proof = JSON.parse(await readFile(resolve(directory, 'native-proof.json'), 'utf8'))
  assert.equal(proof.independentWindow, true)
  assert.equal(proof.noIframe, true)
  assert.equal(proof.customIcon, true)
  if (process.platform === 'win32') assert.equal(proof.realWindowsTasks, true)
  if (process.env.MICROAPPS_SCREENSHOTS) {
    await writeFile(resolve(process.env.MICROAPPS_SCREENSHOTS, 'native-proof.json'), JSON.stringify({ ...proof, coldLaunch: true, modelCalls: calls }, null, 2))
  }
})
