import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { withTempWorkspace } from '../../src/testing/workspace.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

test('muted app completions cross the real Electron bridge into native Windows notifications and activate the right conversation', {
  timeout: 60_000, skip: process.platform !== 'win32' ? 'Windows native notification regression.' : false,
}, () => renderTaskNotifications(false))

test('web notification controls opt in explicitly and request named browser notifications with muted audio', {
  timeout: 60_000, skip: process.platform !== 'win32' ? 'Windows browser notification regression.' : false,
}, () => renderTaskNotifications(true))

async function renderTaskNotifications(web: boolean) {
  await withTempWorkspace(async directory => {
    const server = await createServer({
      configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: join(directory, 'vite-cache'),
      plugins: [vue(), {
        name: 'task-notification-fixture',
        resolveId: id => id === '/task-notification-fixture.ts' ? '\0task-notification-fixture' : undefined,
        load: id => id !== '\0task-notification-fixture' ? undefined : `
          import '/src/styles.css';
          import { createApp, h } from 'vue';
          import { createRouter, createMemoryHistory } from 'vue-router';
          import { i18n } from '/src/i18n.ts';
          import { useAppNotificationSounds } from '/src/composables/useAppNotificationSounds.ts';
          import { createProjectLiveState } from '/src/project-live-state.ts';
          import { SOUND_PREFERENCES_KEY } from '/src/notification-sounds.ts';
          import SoundSettings from '/src/components/SoundSettings.vue';
          const web = new URL(location.href).searchParams.has('web');
          const webNotices = [];
          if (web) {
            window.Notification = new Proxy(window.Notification, {
              get(target, key) {
                const value = Reflect.get(target, key, target);
                return typeof value === 'function' ? value.bind(target) : value;
              },
              construct(target, args) {
                const notice = new target(args[0], args[1]);
                webNotices.push(notice);
                return notice;
              },
            });
          }
          localStorage.setItem(SOUND_PREFERENCES_KEY, JSON.stringify({enabled:false,yield:true,idle:true,volume:0.35}));
          i18n.global.locale.value = 'zh-CN';
          const observers = new Map();
          const live = {isLive:() => true, subscribe(topic, observer) {
            const key = topic.kind === 'projects' ? 'catalog' : topic.projectId;
            observers.set(key, observer);
            queueMicrotask(() => observer.reset('subscription'));
            return {ready:async () => {},close:() => observers.delete(key)};
          }};
          const pool = {client:() => live};
          const state = createProjectLiveState(pool, {delayMs:0,request:async input => {
            const path = new URL(String(input)).pathname;
            if (path === '/api/projects') return Response.json({projects:[{id:'release',name:'Release Project',createdAt:''}]});
            if (path.endsWith('/graph')) return Response.json({sessions:[{sessionId:'web:check',mode:'session',name:'Release check'}],nodes:[]});
            if (path.endsWith('/stages')) return Response.json({stages:{'web:check':'idle'}});
            throw new Error('Unexpected fixture request: ' + path);
          }});
          let observedLease;
          const acquireProject = state.acquireProject.bind(state);
          state.acquireProject = (...args) => { observedLease = acquireProject(...args); return observedLease };
          const monitoring = () => !!observedLease?.graph.state.value && !!observedLease?.activity.state.value
            && !observedLease.graph.state.loading && !observedLease.activity.state.loading;
          const router = createRouter({history:createMemoryHistory(),routes:[
            {path:'/settings',name:'settings',component:{render:() => null}},
            {path:'/projects/:projectId/chat/:sessionId?',name:'chat',component:{render:() => null}},
          ]});
          await router.push('/settings');
          await router.isReady();
          let monitor;
          const app = createApp({setup() {
            monitor = useAppNotificationSounds(() => ({base:location.origin,allowed:true}));
            return () => h('main', [h('p', monitor.monitoringError.value || 'Task notification fixture'), h(SoundSettings)]);
          }}).provide(Symbol.for('shadow.live-client-pool'),pool)
            .provide(Symbol.for('shadow.project-live-state'),state).use(router).use(i18n);
          app.mount('#app');
          window.fixture = {
            ready:() => web ? !!monitor.browserNotifications : monitoring(),
            monitoring,
            webEnabled:() => monitor.browserNotifications?.active.value,
            webNotices,
            muted:() => !monitor.sounds.preferences.value.enabled && !monitor.sounds.ready.value,
            error:() => monitor.monitoringError.value,
            path:() => router.currentRoute.value.fullPath,
            finish(turnId) {observers.get('release').event({
              type:'event',cursor:'epoch:' + turnId,topic:{kind:'sessions',projectId:'release'},
              payload:{event:'invalidate',sessionId:'web:check',completedTurnId:turnId},
            })},
            dispose() {app.unmount();state.dispose()},
          };
        `,
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (new URL(request.url!, 'http://fixture').pathname !== '/__task-notifications') return next()
            response.setHeader('Content-Type', 'text/html')
            response.end('<!doctype html><html><body><div id="app"></div><script type="module" src="/task-notification-fixture.ts"></script></body></html>')
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
        entryPoints: [resolve(root, 'desktop', 'tests', 'fixtures', 'task-notifications-smoke.ts')],
        outfile: join(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs',
        target: 'node24', external: ['electron'], logLevel: 'silent',
      })
      await build({
        entryPoints: [resolve(root, 'desktop', 'src', 'preload.ts')],
        outfile: join(directory, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs',
        target: 'node24', external: ['electron'], logLevel: 'silent',
      })
      const env: NodeJS.ProcessEnv = { TASK_NOTIFICATION_SMOKE_URL: url }
      if (web) env.TASK_NOTIFICATION_WEB = '1'
      for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT']) {
        if (process.env[key] !== undefined) env[key] = process.env[key]
      }
      for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR']) env[key] = directory
      child = spawn(desktopRequire('electron') as string, [join(directory, 'main.cjs')], {
        cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      child.stdout!.setEncoding('utf8').on('data', chunk => { output += chunk })
      child.stderr!.setEncoding('utf8').on('data', chunk => { output += chunk })
      timer = setTimeout(() => child?.kill(), 45_000)
      const [code] = await once(child, 'close')
      assert.equal(code, 0, output)
      assert.match(output, /TASK_NOTIFICATION_SMOKE_OK/)
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
}
