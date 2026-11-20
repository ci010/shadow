import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../..', import.meta.url))
const require = createRequire(new URL('../../desktop/package.json', import.meta.url))

test('glTF outline virtualizes rows, selects objects, and reveals canvas selection without stealing focus', {
  timeout: 60000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `gltf-outline-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const server = await createServer({
    root: resolve(root, 'app'), configFile: false, envDir: false,
    cacheDir: resolve(directory, 'cache'), logLevel: 'error',
    optimizeDeps: { noDiscovery: true, include: ['vue'] },
    plugins: [vue(), {
      name: 'gltf-outline-fixture',
      resolveId: id => id === '/fixture.ts' ? '\0outline' : undefined,
      load(id) {
        if (id !== '\0outline') return
        return `import { createApp, h, ref } from 'vue';
          import Outline from '/src/components/files/GltfOutline.vue';
          import { setLocalePreference } from '/src/i18n.ts'; setLocalePreference('en');
          const group = (key, parentKey = null) => ({ key, parentKey, label: key });
          const object = (key, parentKey) => ({ ...group(key, parentKey), objectId: 'obj-' + key });
          const rows = [group('Root'), object('A', 'Root'), object('B', 'Root'), group('Nested', 'Root'),
            object('C', 'Nested'), ...Array.from({ length: 20000 }, (_, i) => object('Mesh' + i, 'Root')),
            group('Tail', 'Root'), group('Deep', 'Tail'), object('End mesh', 'Deep')];
          window.selection = []; window.emissions = 0;
          createApp({ setup() {
            const selected = ref([]);
            window.setSelection = ids => { selected.value = window.selection = ids; };
            return () => h('main', [h('button', { id: 'canvas' }, 'Canvas'), h(Outline, {
              rows, selected: selected.value, onSelect: ids => { window.emissions++; window.setSelection(ids); },
            })]);
          } }).mount('#app');`
      },
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url !== '/') return next()
          res.setHeader('Content-Type', 'text/html')
          res.end('<!doctype html><html><body><div id="app"></div><script type="module" src="/fixture.ts"></script></body></html>')
        })
      },
    }],
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  t.after(() => { server.httpServer?.closeAllConnections(); return server.close() })

  const entry = resolve(directory, 'fixture.cjs')
  await writeFile(entry, `
    const assert = require('node:assert/strict');
    const {app, BrowserWindow} = require('electron');
    const {setTimeout: delay} = require('node:timers/promises');
    app.setPath('userData', require('node:path').join(process.cwd(), 'profile'));
    (async () => {
      await app.whenReady();
      const win = new BrowserWindow({ show: false, width: 900, height: 600, webPreferences: { backgroundThrottling: false } });
      await win.loadURL(${JSON.stringify(server.resolvedUrls!.local[0])});
      const run = text => win.webContents.executeJavaScript(text);
      async function wait(text) {
        for (let i = 0; i < 120; i++) { if (await run('Boolean(' + text + ')')) return; await delay(30); }
        throw new Error('Timed out: ' + text);
      }
      const tree = 'document.querySelector("[role=tree]")';
      const row = name => 'document.querySelector(' + JSON.stringify('[role=treeitem][aria-label="' + name + '"]') + ')';
      const active = 'document.getElementById(' + tree + '.getAttribute("aria-activedescendant"))';
      const click = (name, flags = '{}') => run(row(name) + '.dispatchEvent(new MouseEvent("click",{bubbles:true,...' + flags + '}))');
      const key = (key, mods = '{}') => run(tree + '.dispatchEvent(new KeyboardEvent("keydown", {bubbles:true,cancelable:true,key:' + JSON.stringify(key) + ',...' + mods + '}))');
      const selected = () => run('window.selection');
      await wait(row('Mesh5'));
      assert.equal(await run('document.querySelectorAll("[role=treeitem]").length < 40'), true);
      assert.equal(await run(tree + '.getAttribute("aria-multiselectable")'), 'true');
      assert.equal(await run(row('Nested') + '.hasAttribute("aria-selected")'), false);
      await click('A'); assert.deepEqual(await selected(), ['obj-A']);
      await click('B', '{ctrlKey:true}'); assert.deepEqual(await selected(), ['obj-A','obj-B']);
      await click('B', '{metaKey:true}'); assert.deepEqual(await selected(), ['obj-A']);
      await click('A'); await click('C', '{shiftKey:true}'); assert.deepEqual(await selected(), ['obj-A','obj-B','obj-C']);
      await key('ArrowLeft'); assert.equal(await run(active + '.getAttribute("aria-label")'), 'Nested');
      await key('ArrowLeft'); assert.equal(await run(row('C')), null);
      assert.deepEqual(await selected(), ['obj-A','obj-B','obj-C'], 'collapse does not alter selection');
      await key('ArrowRight'); await wait(row('C'));
      await key('ArrowRight'); await key(' '); assert.deepEqual(await selected(), ['obj-A','obj-B']);
      await run(row('Nested') + '.querySelector("button").click()'); await wait('!' + row('C'));
      await run('document.getElementById("canvas").focus(); window.setSelection(["obj-C"])');
      await wait(row('C') + '?.getAttribute("aria-selected") === "true"');
      assert.equal(await run('document.activeElement.id'), 'canvas');
      await run(tree + '.focus()'); await key('End'); await wait(row('End mesh'));
      await key('ArrowLeft'); await key('ArrowLeft'); await key('ArrowLeft'); await key('ArrowLeft');
      await wait(row('Tail') + '?.getAttribute("aria-expanded") === "false"');
      await run('document.getElementById("canvas").focus(); window.setSelection(["obj-End mesh"])');
      await wait(row('End mesh') + '?.getAttribute("aria-selected") === "true"');
      assert.equal(await run(row('Deep') + '.getAttribute("aria-expanded")'), 'true');
      assert.equal(await run(row('Tail') + '.getAttribute("aria-expanded")'), 'true');
      assert.equal(await run('document.activeElement.id'), 'canvas');
      assert.equal(await run('(() => {const a=' + row('End mesh') + '.getBoundingClientRect(), b=' + tree + '.getBoundingClientRect();return a.top>=b.top && a.bottom<=b.bottom})()'), true);
      assert.equal(await run('document.querySelectorAll("[role=treeitem]").length < 40'), true);
      assert.equal(await run('window.emissions'), 6, 'external updates never emit another selection');
      await run(tree + '.focus()'); await key('Home'); await wait(row('A'));
      await key('ArrowDown'); await key('Enter');
      await key('ArrowDown', '{shiftKey:true}');
      assert.deepEqual(await selected(), ['obj-A', 'obj-B']);
      assert.equal(await run(row('B') + '.getAttribute("aria-selected")'), 'true');
      console.log('GLTF_OUTLINE_OK'); app.exit(0);
    })().catch(error => { console.error(error); app.exit(1); });
  `)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron') as string, [entry], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk })
  child.stderr.on('data', chunk => { output += chunk })
  const timer = setTimeout(() => child.kill(), 50000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, output)
  assert.match(output, /GLTF_OUTLINE_OK/)
})
