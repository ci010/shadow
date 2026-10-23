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

test('App web search renders accessible responsive fields and saves only deliberate key edits', {
  timeout: 60_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async () => {
  await withTempWorkspace(async directory => {
    const server = await createServer({
      configFile: false, root: resolve(root, 'app'), logLevel: 'error',
      plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app', 'unocss.config.ts') }), {
        name: 'web-search-fixture',
        resolveId: id => id === '/search-fixture.ts' ? '\0search-fixture' : undefined,
        load: id => id !== '\0search-fixture' ? undefined : `
          import 'uno.css'; import '/src/styles.css';
          import { createApp, h } from 'vue';
          import { createRouter, createMemoryHistory, RouterView } from 'vue-router';
          import Settings from '/src/components/SettingsView.vue';
          const state = { provider:'auto', effectiveProvider:'firecrawl', ready:true,
            keys:{firecrawl:true,brave:false,exa:false,tavily:false} };
          window.fixture = { state, patches:[], fail:false };
          window.fetch = async (url, init) => {
            if (new URL(url, location.href).pathname !== '/api/app/web-search') throw new Error('Unexpected request');
            if (init?.method === 'PATCH') {
              const patch = JSON.parse(init.body); window.fixture.patches.push(patch);
              if (window.fixture.fail) return Response.json({error:'synthetic-private-error'}, {status:500});
              if (patch.provider !== undefined) state.provider = patch.provider;
              for (const [key,value] of Object.entries(patch.apiKeys ?? {})) state.keys[key] = value !== null;
              state.effectiveProvider = state.provider === 'auto'
                ? ['firecrawl','brave','exa','tavily'].find(key => state.keys[key]) ?? 'firecrawl' : state.provider;
              state.ready = state.effectiveProvider === 'firecrawl' || state.keys[state.effectiveProvider];
            }
            return Response.json(state);
          };
          const router = createRouter({history:createMemoryHistory(), routes:[
            {path:'/settings/:section?',name:'settings',component:Settings},
          ]});
          await router.push('/settings/web-search'); await router.isReady();
          createApp({render:() => h(RouterView, {apiBase:location.origin,available:true,status:null,error:'',checking:false})})
            .use(router).mount('#app');
        `,
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__search') return next()
            response.setHeader('Content-Type', 'text/html')
            response.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/search-fixture.ts"></script></body></html>')
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
        entryPoints: [resolve(root, 'desktop', 'tests', 'fixtures', 'web-search-settings-smoke.ts')],
        outfile: join(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs',
        target: 'node24', external: ['electron'], logLevel: 'silent',
      })
      const env: NodeJS.ProcessEnv = { WEB_SEARCH_SMOKE_URL: url }
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
      assert.match(output, /WEB_SEARCH_SMOKE_OK/)
    } finally {
      if (timer) clearTimeout(timer)
      if (child && child.exitCode === null) {
        const closed = once(child, 'close')
        child.kill()
        await closed
      }
      await server.close()
      // Chromium may hold its profile briefly after reporting process exit.
      await rm(join(directory, 'profile'), { recursive: true, force: true, maxRetries: 12, retryDelay: 250 })
    }
  })
})
