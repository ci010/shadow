import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
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

test('notification sounds render local controls and schedule distinct, bounded, muted Web Audio cues', {
  timeout: 60_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async () => {
  await withTempWorkspace(async directory => {
    const server = await createServer({
      configFile: false, root: resolve(root, 'app'), logLevel: 'error',
      plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app', 'unocss.config.ts') }), {
        name: 'notification-sounds-fixture',
        resolveId: id => id === '/sounds-fixture.ts' ? '\0sounds-fixture' : undefined,
        load: id => id !== '\0sounds-fixture' ? undefined : `
          import 'uno.css'; import '/src/styles.css';
          import { createApp, h, onUnmounted } from 'vue';
          import { createRouter, createMemoryHistory, RouterView } from 'vue-router';
          import Settings from '/src/components/SettingsView.vue';
          import { createNotificationSounds, notificationSoundsKey } from '/src/notification-sounds.ts';
          const fixture = window.fixture = { tones:[], peaks:[], contexts:[], failAudio:false };
          const sounds = fixture.sounds = createNotificationSounds({storage:localStorage, audio:() => {
            if (fixture.failAudio) throw new Error('Synthetic audio failure');
            const context = new AudioContext();
            fixture.contexts.push(context);
            const oscillator = context.createOscillator.bind(context);
            context.createOscillator = () => {
              const node = oscillator();
              const frequency = node.frequency.setValueAtTime.bind(node.frequency);
              node.frequency.setValueAtTime = (value, time) => { fixture.tones.push(value); return frequency(value, time) };
              return node;
            };
            const gain = context.createGain.bind(context);
            context.createGain = () => {
              const node = gain();
              const ramp = node.gain.linearRampToValueAtTime.bind(node.gain);
              node.gain.linearRampToValueAtTime = (value, time) => { fixture.peaks.push(value); return ramp(value, time) };
              return node;
            };
            return context;
          }});
          const router = createRouter({history:createMemoryHistory(), routes:[
            {path:'/settings/:section?',name:'settings',component:Settings},
          ]});
          await router.push('/settings/sounds'); await router.isReady();
          fixture.app = createApp({setup() { onUnmounted(sounds.dispose); return () =>
            h(RouterView, {apiBase:location.origin,available:true,status:null,error:'',checking:false}) }})
            .provide(notificationSoundsKey, sounds).use(router);
          fixture.app.mount('#app');
        `,
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__sounds') return next()
            response.setHeader('Content-Type', 'text/html')
            response.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app"></div><script type="module" src="/sounds-fixture.ts"></script></body></html>')
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
        entryPoints: [resolve(root, 'desktop', 'tests', 'fixtures', 'notification-sounds-smoke.ts')],
        outfile: join(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs',
        target: 'node24', external: ['electron'], logLevel: 'silent',
      })
      const env: NodeJS.ProcessEnv = { SOUND_SMOKE_URL: url }
      for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
        if (process.env[key] !== undefined) env[key] = process.env[key]
      }
      for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = directory
      child = spawn(desktopRequire('electron') as string, [join(directory, 'main.cjs')], {
        cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      child.stdout!.setEncoding('utf8').on('data', chunk => { output += chunk })
      child.stderr!.setEncoding('utf8').on('data', chunk => { output += chunk })
      timer = setTimeout(() => child?.kill(), 45_000)
      const [code] = await once(child, 'close')
      assert.equal(code, 0, output)
      assert.match(output, /SOUND_SMOKE_OK/)
    } finally {
      clearTimeout(timer)
      if (child && child.exitCode === null) {
        const closed = once(child, 'close')
        child.kill()
        await closed
      }
      await server.close()
    }
  })
})
