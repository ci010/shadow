import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

test('desktop and mobile language controls update real screens, retain drafts, and survive reload', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async context => {
  const directory = resolve(root, '.test-artifacts', `i18n-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  context.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const requests: string[] = []
  const server = await createServer({
    configFile: false, envFile: false, root: resolve(root, 'app'), logLevel: 'error',
    cacheDir: resolve(directory, 'vite-cache'),
    optimizeDeps: { noDiscovery: true, include: ['vue', 'vue-router', 'vue-i18n', 'marked', 'dompurify', 'katex'] },
    server: { host: '127.0.0.1', port: 0, strictPort: false, watch: null },
    plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app', 'unocss.config.ts') }), {
      name: 'localization-fixture',
      resolveId: id => id === '/localization-fixture.ts' ? '\0localization-fixture' : undefined,
      load(id) {
        if (id !== '\0localization-fixture') return
        return `import 'uno.css'; import '/src/styles.css';
          import { createApp, h, ref, nextTick } from 'vue';
          import { createRouter, createMemoryHistory } from 'vue-router';
          import { i18n, initializeI18n, t } from '/src/i18n.ts';
          import BrowserAuth from '/src/BrowserAuth.vue';
          import DesktopFrame from '/src/DesktopFrame.vue';
          import FirstRunWizard from '/src/FirstRunWizard.vue';
          import MobileConnection from '/src/MobileConnection.vue';
          import SettingsView from '/src/components/SettingsView.vue';
          import SystemPromptCard from '/src/components/SystemPromptCard.vue';
          import ToolsCard from '/src/components/ToolsCard.vue';
          import { createBrowserSession } from '/src/web-auth.ts';
          import { createMobileSession } from '/src/mobile-client.ts';
          const stop = initializeI18n(window);
          const errors = [];
          addEventListener('error', event => errors.push(event.message));
          addEventListener('unhandledrejection', event => errors.push(String(event.reason)));
          const session = createBrowserSession(location.origin, { fetch: async () =>
            Response.json({ version: 1, required: true, authenticated: false }) });
          await session.refresh();
          const mobile = createMobileSession({ get: async () => ({ value: null }), set: async () => {}, remove: async () => {} },
            async () => { throw new Error('No real mobile requests are allowed'); });
          await mobile.load();
          const router = createRouter({ history: createMemoryHistory(), routes: [
            { name: 'settings', path: '/settings/:section?', component: {} }
          ] });
          await router.push('/settings/language');
          const view = ref('auth');
          const raw = '# Original English prompt\\nRetry stays user-authored.';
          const app = createApp({ setup: () => () => {
            if (view.value === 'auth') return h(BrowserAuth, { session });
            if (view.value === 'mobile') return h(MobileConnection, { session: mobile });
            return h(DesktopFrame, null, { default: () =>
              view.value === 'settings' ? h(SettingsView, { apiBase: location.origin, status: null, error: '', checking: true, available: true }) :
              view.value === 'setup' ? h(FirstRunWizard, { api: {}, initialState: { version: 1, revision: 0, mode: null, step: 'choose-role' } }) :
              h('section', { style: 'padding:24px;display:grid;gap:20px' }, [
                h(SystemPromptCard, { prompt: raw, raw: true }), h(ToolsCard, { tools: [] })
              ])
            });
          } });
          app.use(i18n).use(router).mount('#app');
          window.__localization = { show: name => { view.value = name; return nextTick(); }, errors, t };
          addEventListener('pagehide', () => { app.unmount(); stop(); session.dispose(); mobile.dispose(); }, { once: true });`
      },
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (request.url === '/__localization') {
            response.setHeader('Content-Type', 'text/html')
            response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app" style="height:100dvh"></div><script type="module" src="/localization-fixture.ts"></script></body></html>')
          } else if (/^\/(?:api|debug|projects)\//.test(request.url ?? '')) {
            requests.push(request.url!)
            response.statusCode = 500
            response.end('Unexpected fixture request')
          } else next()
        })
      },
    }],
  })
  context.after(async () => { server.httpServer?.closeAllConnections(); await server.close() })
  await server.listen()
  const url = server.resolvedUrls?.local[0]
  assert.ok(url)
  assert.equal((await fetch(new URL('__localization', url))).status, 200)
  await build({
    entryPoints: [resolve(root, 'desktop', 'tests', 'fixtures', 'i18n-smoke.ts')],
    outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs',
    target: 'node24', external: ['electron'], logLevel: 'silent',
  })
  const env: NodeJS.ProcessEnv = { I18N_SMOKE_URL: url, I18N_SCREENSHOTS: process.env.SHADOW_I18N_SCREENSHOTS }
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = directory
  const child = spawn(desktopRequire('electron') as string, [resolve(directory, 'main.cjs')], {
    cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })
  const timeout = setTimeout(() => child.kill(), 75_000)
  context.after(() => { clearTimeout(timeout); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, output)
  assert.match(output, /I18N_RENDERED_OK/)
  assert.deepEqual(requests, [], 'Changing UI language must not send backend requests')
})
