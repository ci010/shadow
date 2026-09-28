import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import fs from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire, syncBuiltinESMExports } from 'node:module'
import { resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { Hono } from 'hono'
import { createServer, type ViteDevServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { MicroApps } from '../../src/microapps/service.ts'
import { microAppsPlugin } from '../../src/microapps/routes.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')
test('Apps owner review, isolated live SDK page, repeat calls, stop and reopen render in the workbench', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `microapp-ui-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  let calls = 0, failCleanup = true
  const service = new MicroApps('p', directory, () => ({
    name: 'fixture', listModels: () => ['fixture'],
    chat: async (_messages, tools) => {
      assert.equal(tools.length, 0)
      return { content: `Result ${++calls}`, toolCalls: [] }
    },
  }), () => 'fixture')
  const host = new Hono()
  microAppsPlugin(service, req => req.headers.get('x-owner') === 'yes')(host)
  let server: ViteDevServer | undefined, child: ReturnType<typeof spawn> | undefined
  t.after(async () => {
    if (child?.exitCode === null) { child.kill(); await once(child, 'close') }
    await server?.close()
    failCleanup = false
    await service.shutdown()
    await rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 })
  })
  await service.init()
  const source = resolve(directory, 'source'); await mkdir(source)
  await writeFile(resolve(source, 'index.html'), `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1">
    <style>body{font:16px system-ui;padding:24px}button{padding:10px}output{display:block;padding-top:20px}</style></head>
    <body><h1>Text helper</h1><button id="run">Run model</button><output></output><script type="module">
    import {generate} from '/_shadow/sdk.js';
    document.querySelector('#run').onclick = async () => {
      try {document.querySelector('output').textContent=(await generate({messages:[{role:'user',content:'Synthetic text'}]})).text}
      catch(e) {document.querySelector('output').textContent=e.message}
    };</script></body></html>`)
  const published = await service.publish(source, { version: 1, name: 'Text helper', description: 'A reusable synthetic text tool for checking app integration.',
    entry: 'index.html', files: ['index.html'], llm: { maxCalls: 2, maxOutputTokens: 32 } }, 'web:author', AbortSignal.timeout(5000))
  const originalRemove = fs.promises.rm
  const runPrefix = resolve(service.store.root, published.id, 'runs') + sep
  const remove = t.mock.method(fs.promises, 'rm', async (...[path, options]: Parameters<typeof originalRemove>) => {
    if (failCleanup && String(path).startsWith(runPrefix)) {
      failCleanup = false
      throw Object.assign(new Error('Synthetic busy app run'), { code: 'EBUSY' })
    }
    return originalRemove(path, options)
  })
  syncBuiltinESMExports()
  t.after(() => { remove.mock.restore(); syncBuiltinESMExports() })
  server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'), optimizeDeps: { entries: [] },
    plugins: [vue(), {
      name: 'microapps-rendered-fixture',
      resolveId: id => id === '/microapp-fixture.ts' ? '\0microapp-fixture' : undefined,
      load: id => id !== '\0microapp-fixture' ? undefined : `
        import '/src/styles.css';
        import { createApp, h, reactive } from 'vue';
        import { createRouter, createMemoryHistory } from 'vue-router';
        import ProjectWorkbench from '/src/components/ProjectWorkbench.vue';
        import { createProjectLiveState } from '/src/project-live-state.ts';
        import { createInstallationContextProvider } from '/src/composables/useInstallationContext.ts';
        import { createLocalMainAdminContext } from '/src/installation-context.ts';
        const state=reactive({draft:'Preserved draft'});
        const installation=reactive(createLocalMainAdminContext(location.origin));
        window.setAdmin=value=>{installation.uiScopes=value ? createLocalMainAdminContext(location.origin).uiScopes : ['chat:read'];};
        const live=createProjectLiveState({client:()=>({subscribe:()=>({ready:async()=>{},close:()=>{}})})});
        const router=createRouter({history:createMemoryHistory(),routes:[{path:'/',component:{render:()=>null}}]});
        await router.push('/');await router.isReady();
        const app=createApp({render:()=>h(ProjectWorkbench,{
          apiBase:location.origin+'/projects/p',projectId:'p',projectName:'App workspace',visible:true,style:'height:100vh',
          onCompose:text=>{state.draft+='\\n'+text},
        },{default:()=>h('textarea',{value:state.draft})})});
        app.provide(Symbol.for('shadow.project-live-state'),live);
        app.use(router);app.use(createInstallationContextProvider(installation));app.mount('#app');`,
      configureServer(server) {
        server.middlewares.use(async (req, res, next) => {
          try {
            const path = new URL(req.url!, 'http://127.0.0.1').pathname
            const json = (value: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(value)) }
            if (path === '/__microapps') {
              res.setHeader('Content-Type', 'text/html')
              res.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/microapp-fixture.ts"></script></body></html>')
            } else if (path.startsWith('/projects/p/api/microapps')) {
              let body = ''; for await (const part of req) body += part
              const result = await host.request(path.slice('/projects/p'.length), {
                method: req.method, headers: { 'Content-Type': 'application/json',
                  'x-owner': req.headers.authorization === 'Bearer synthetic-host-token' ? 'yes' : 'no' },
                ...(body ? { body } : {}),
              })
              res.statusCode = result.status
              result.headers.forEach((value, key) => res.setHeader(key, value))
              res.end(await result.text())
            } else if (path.endsWith('/api/work')) json({ items: [], sessions: [], requests: [], effects: [] })
            else if (path.endsWith('/api/sessions/graph')) json({ sessions: [], nodes: [] })
            else if (path.endsWith('/api/sessions/stages')) json({ stages: {} })
            else next()
          } catch (error) { next(error) }
        })
      },
    }], server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  const url = server.resolvedUrls?.local[0]; assert.ok(url)
  await build({ entryPoints: [resolve(root, 'desktop', 'tests', 'fixtures', 'microapps-smoke.ts')],
    outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs',
    target: 'node24', external: ['electron'], logLevel: 'silent' })
  const env: NodeJS.ProcessEnv = { MICROAPPS_SMOKE_URL: url }
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'XAUTHORITY', 'MICROAPPS_SCREENSHOTS']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = directory
  child = spawn(desktopRequire('electron') as string, [resolve(directory, 'main.cjs')], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout!.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr!.setEncoding('utf8').on('data', chunk => { output += chunk })
  const timer = setTimeout(() => child?.kill(), 75_000)
  const [code] = await once(child, 'close'); clearTimeout(timer)
  assert.equal(code, 0, output)
  assert.match(output, /MICROAPPS_SMOKE_OK/)
  assert.equal(calls, 2)
  assert.equal(failCleanup, false)
  assert.equal(service.list()[0].status, 'awaiting_approval')
})
