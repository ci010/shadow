import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, rm } from 'node:fs/promises'
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

test('App proxy settings render detected routes, persist toggles and keep disabled state during detection', {
  timeout: 60_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async () => {
  await withTempWorkspace(async directory => {
    const server = await createServer({
      configFile: false, root: resolve(root, 'app'), logLevel: 'error',
      cacheDir: resolve(directory, 'vite-cache'), optimizeDeps: { entries: [] },
      plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app', 'unocss.config.ts') }), {
        name: 'proxy-fixture',
        resolveId: id => id === '/proxy-fixture.ts' ? '\0search-fixture' : undefined,
        load: id => id !== '\0search-fixture' ? undefined : `
          import 'uno.css'; import '/src/styles.css';
          import { createApp, h } from 'vue';
          import { createRouter, createMemoryHistory, RouterView } from 'vue-router';
          import Settings from '/src/components/SettingsView.vue';
          const state = { enabled:true, detected:true, detectionFailed:false, source:'environment', http:'http://proxy.example:8080/', https:'http://proxy.example:8443/' };
          window.fixture = { state, patches:[], detections:0, fail:false };
          window.fetch = async (url, init) => {
            const path = new URL(url, location.href).pathname;
            if (!path.startsWith('/api/app/proxy')) throw new Error('Unexpected request');
            if (init?.method === 'PATCH') {
              const patch = JSON.parse(init.body); window.fixture.patches.push(patch);
              if (window.fixture.fail) return Response.json({error:'synthetic-private-error'}, {status:500});
              state.enabled = patch.enabled;
            }
            if (init?.method === 'POST') window.fixture.detections++;
            return Response.json(state);
          };
          const router = createRouter({history:createMemoryHistory(), routes:[
            {path:'/settings/:section?',name:'settings',component:Settings},
          ]});
          await router.push('/settings/proxy'); await router.isReady();
          createApp({render:() => h(RouterView, {apiBase:location.origin,available:true,status:null,error:'',checking:false})})
            .use(router).mount('#app');
        `,
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__proxy') return next()
            response.setHeader('Content-Type', 'text/html')
            response.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/proxy-fixture.ts"></script></body></html>')
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
      const smoke = await readFile(resolve(root, 'desktop', 'tests', 'fixtures', 'proxy-settings-smoke.ts'), 'utf8')
      const macAssertions = `
        await execute("Object.assign(window.fixture.state, {source:'macos-static',detected:true,http:'http://mac-proxy.example:8080/',https:''}); document.querySelector('.proxy-settings button').click()")
        await wait("document.body.innerText.includes('macOS static proxy')")
        assert.deepEqual(await execute("Array.from(document.querySelectorAll('.proxy-settings input[readonly]'), input => input.value)"), ['http://mac-proxy.example:8080/'])
        await execute("Object.assign(window.fixture.state, {source:'macos-auto',http:'',effective:{source:'macos-auto',enabled:true,blocked:true}}); document.querySelector('.proxy-settings button').click()")
        await wait("document.body.innerText.includes('macOS automatic proxy (PAC / auto-discovery) is not supported')")
        assert.equal(await execute("document.querySelectorAll('.proxy-settings input[readonly]').length"), 0)
        await execute("Object.assign(window.fixture.state, {source:'unknown',detected:false,detectionFailed:true,effective:{source:'unavailable',enabled:true,blocked:true}}); document.querySelector('.proxy-settings button').click()")
        await wait("document.body.innerText.includes('Proxy detection failed.')")
        assert.equal(await execute("!!document.querySelector('.proxy-settings [role=alert]')"), false)
        assert.equal(await execute("document.querySelector('.proxy-settings button').textContent.trim()"), 'Detect again')
        await execute("Object.assign(window.fixture.state, {source:'macos-static',detected:true,detectionFailed:false}); document.querySelector('.proxy-settings button').click()")
        await wait("document.body.innerText.includes('macOS static proxy') && !document.body.innerText.includes('Proxy detection failed.')")
      `
      assert.ok(smoke.includes("console.log('PROXY_SMOKE_OK')"))
      await build({
        stdin: { contents: smoke.replace("console.log('PROXY_SMOKE_OK')", macAssertions + "\nconsole.log('PROXY_SMOKE_OK')"), resolveDir: resolve(root, 'desktop', 'tests', 'fixtures'), sourcefile: 'proxy-settings-smoke.ts', loader: 'ts' },
        outfile: join(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs',
        target: 'node24', external: ['electron'], logLevel: 'silent',
      })
      const env: NodeJS.ProcessEnv = { PROXY_SMOKE_URL: url }
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
      assert.match(output, /PROXY_SMOKE_OK/)
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
