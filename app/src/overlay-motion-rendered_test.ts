import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer, normalizePath } from 'vite'
import vue from '@vitejs/plugin-vue'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

test('custom tooltips and popup entry points use the shared transition', async () => {
  for (const name of ['HoverInfo', 'ComposerPopover', 'SelectionMenu', 'SlashCommandMenu', 'MessageHistoryRail',
    'FoldersSidebar', 'FolderDialog', 'SessionWorkControls', 'ConnectionStatus', 'files/FileWorkbench']) {
    const source = await readFile(resolve(root, 'app', 'src', 'components', `${name}.vue`), 'utf8')
    assert.match(source, /<OverlayTransition(?:\s[^>]*)?>[\s\S]*<\/OverlayTransition>/, name)
  }
})

test('tooltip, popup and sheet motion preserves positioning, dismissal, interruption and reduced motion', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `overlay-motion-${randomUUID()}`)
  const fixture = normalizePath(resolve(directory, 'fixture.vue'))
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    optimizeDeps: { noDiscovery: true, include: ['vue'] },
    plugins: [vue(), {
      name: 'overlay-motion-fixture',
      resolveId: id => id === '/overlay-fixture.vue' ? fixture : id === '/overlay-entry.ts' ? '\0overlay-entry' : undefined,
      load(id) {
        if (id === '\0overlay-entry') return `import '/src/styles.css';import {createApp} from 'vue';
          import Fixture from '/overlay-fixture.vue';createApp(Fixture).mount('#app');`
        if (id !== fixture) return
        return `<script setup>
          import {reactive} from 'vue';
          import HoverInfo from '/src/components/HoverInfo.vue';
          import ComposerPopover from '/src/components/ComposerPopover.vue';
          import MobileSheet from '/src/components/MobileSheet.vue';
          import OverlayTransition from '/src/components/OverlayTransition.vue';
          import ConnectionStatus from '/src/components/ConnectionStatus.vue';
          import SessionWorkControls from '/src/components/SessionWorkControls.vue';
          import MessageHistoryRail from '/src/components/MessageHistoryRail.vue';
          const state = reactive({shown:false,sheet:false,side:false,actions:0,first:true});
          window.__overlay = state;
        </script>
        <template>
          <main>
            <HoverInfo v-if="state.first" text="Tooltip evidence" v-slot="{triggerProps,open,close}">
              <button id="tooltip-trigger" v-bind="triggerProps" @click="open">Tooltip</button>
            </HoverInfo>
            <HoverInfo text="Second tooltip content" v-slot="{triggerProps}">
              <button id="tooltip-second" v-bind="triggerProps" style="position:fixed;left:24px;top:240px">Another tooltip</button>
            </HoverInfo>
            <HoverInfo interactive label="Interactive information">
              <template #default="{triggerProps}"><button id="info-trigger" v-bind="triggerProps">Information</button></template>
              <template #content="{close}"><button id="info-action" @click="state.actions++;close(true)">Use information</button></template>
            </HoverInfo>
            <HoverInfo interactive label="Second conversation">
              <template #default="{triggerProps}"><button id="info-second" v-bind="triggerProps">Second conversation</button></template>
              <template #content="{close}"><button id="info-second-action" @click="state.actions++;close(true)">Inspect conversation</button></template>
            </HoverInfo>
            <ComposerPopover label="Desktop popup">
              <template #trigger>Open popup</template>
              <template #default="{close}"><button id="popup-action" @click="state.actions++;close()">Apply</button></template>
            </ComposerPopover>
            <ComposerPopover label="Sheet popup" sheet>
              <template #trigger>Open sheet popup</template>
              <template #default="{close}"><button id="sheet-action" @click="state.actions++;close()">Apply</button></template>
            </ComposerPopover>
            <button id="outside">Outside</button>
            <OverlayTransition><div v-show="state.shown" id="persistent-popup" role="dialog"><button>Persistent action</button></div></OverlayTransition>
            <ConnectionStatus live-error="Synthetic connection notice" />
            <SessionWorkControls api-base="" session-id="" can-write :active="true"
              :subagents="[{sessionId:'worker',label:'Fixture worker',mode:'task',executionStatus:'running'}]" />
            <div style="position:fixed;right:0;top:300px;height:100px;width:42px">
              <MessageHistoryRail :entries="[0,1].map(index=>({index,kind:'user',source:'Fixture',label:'Message '+index,preview:'Preview '+index,timestamp:'2026-01-01T00:00:00Z'}))" />
            </div>
            <MobileSheet :open="state.sheet" :side="state.side" label="Standalone sheet" @update:open="state.sheet=$event">
              <button id="standalone-action">Sheet action</button>
            </MobileSheet>
          </main>
        </template>
        <style>
          main{padding:24px;display:flex;flex-wrap:wrap;gap:12px}
          #persistent-popup{position:fixed;left:24px;top:100px;padding:16px;background:var(--c-bg-card)}
        </style>`
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== '/__overlay') return next()
          response.setHeader('Content-Type', 'text/html')
          response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/overlay-entry.ts"></script></body></html>')
        })
      },
    }],
    server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
  })
  await server.listen()
  t.after(() => server.close())
  await build({
    entryPoints: [resolve(root, 'desktop', 'tests', 'fixtures', 'overlay-motion-smoke.ts')],
    outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs',
    target: 'node24', external: ['electron'], logLevel: 'silent',
  })
  const env: NodeJS.ProcessEnv = { OVERLAY_URL: new URL('__overlay', server.resolvedUrls!.local[0]).href }
  if (process.env.OVERLAY_SCREENSHOTS) env.OVERLAY_SCREENSHOTS = process.env.OVERLAY_SCREENSHOTS
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = directory
  const child = spawn(desktopRequire('electron') as string, [resolve(directory, 'main.cjs')], {
    cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })
  const timer = setTimeout(() => child.kill(), 75_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, output)
  assert.match(output, /OVERLAY_MOTION_OK/)
})
