import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { withTempWorkspace } from '../../src/testing/workspace.ts'

const appRoot = fileURLToPath(new URL('../', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))

test('rendered Agent settings show one selector, persist a prompt version, and lock an environment override', {
  timeout: 45_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async () => {
  await withTempWorkspace(async directory => {
    const server = await createServer({
      configFile: false, root: appRoot, cacheDir: join(directory, 'vite-cache'), logLevel: 'error', server: { host: '127.0.0.1', port: 0 },
      optimizeDeps: { entries: [] },
      plugins: [vue(), {
        name: 'agent-version-fixture',
        resolveId: id => id === '/version-fixture.ts' ? '\0version-fixture' : undefined,
        load: id => id !== '\0version-fixture' ? undefined : `
          import '/src/styles.css';
          import {createResourceApp} from '/src/stores/app.ts';
          import Form from '/src/components/AgentVersionDefaultsForm.vue';
          let state = { version: 'v2', source: 'builtin' };
          if (location.search) state = { version: 'v1', source: 'environment' };
          window.patches = [];
          window.fetch = async (url, init) => {
            if (new URL(url, location.href).pathname !== '/api/app/agent-version-defaults') throw Error('Wrong endpoint');
            if (init?.method === 'PATCH') {
              const patch = JSON.parse(init.body); window.patches.push(patch);
              state = { version: patch.version, source: 'app' };
            }
            return Response.json(state);
          };
          createResourceApp(Form, {apiBase:location.origin}).mount('#app');
        `,
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url?.split('?')[0] !== '/__version') return next()
            response.setHeader('Content-Type', 'text/html')
            response.end('<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><div id="app"></div><script type="module" src="/version-fixture.ts"></script>')
          })
        },
      }],
    })
    let child: ReturnType<typeof spawn> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await server.listen()
      const url = server.resolvedUrls?.local[0]
      assert(url)
      await writeFile(join(directory, 'main.cjs'), `
        const assert = require('node:assert/strict');
        const { app, BrowserWindow } = require('electron');
        app.setPath('userData', require('node:path').join(process.cwd(), 'profile'));
        app.whenReady().then(async () => {
          const win = new BrowserWindow({ show: false, width: 380, height: 720 });
          await win.loadURL(${JSON.stringify(new URL('/__version', url).href)});
          const result = await win.webContents.executeJavaScript(\`(async () => {
            const waitFor = async (read) => { for (let i=0; i<150; i++) { const value=read(); if(value) return value; await new Promise(resolve=>setTimeout(resolve,20)); } throw Error(document.body.textContent); };
            const general = await waitFor(() => document.querySelector('[role=combobox][aria-label="Built-in prompt version"]'));
            const all = [...document.querySelectorAll('[role=combobox]')].map(button => [button.textContent.trim(), button.disabled]);
            general.focus(); general.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', bubbles:true }));
            const v1 = await waitFor(() => [...document.querySelectorAll('[role=option]')].find(option => option.textContent.trim() === 'V1'));
            v1.click(); await waitFor(() => !document.querySelector('[type=submit]').disabled);
            document.querySelector('[type=submit]').click();
            await waitFor(() => document.body.textContent.includes('Agent defaults saved.'));
            return { all, general: general.textContent.trim(), patches: window.patches };
          })()\`);
          assert.deepEqual(result.all, [['V2', false]]);
          assert.equal(result.general, 'V1');
          assert.deepEqual(result.patches, [{version:'v1'}]);
          await win.loadURL(${JSON.stringify(new URL('/__version?managed', url).href)});
          const locked = await win.webContents.executeJavaScript(\`(async () => {
            for (let i=0; i<150; i++) {
              const control = document.querySelector('[role=combobox]');
              if (control) return [control.textContent.trim(), control.disabled, document.body.textContent.includes('Controlled by SHADOW_BUILTIN_PROMPT_VERSION.')];
              await new Promise(resolve=>setTimeout(resolve,20));
            }
          })()\`);
          assert.deepEqual(locked, ['V1', true, true]);
          app.exit(0);
        }).catch(error => { console.error(error); app.exit(1); });
      `)
      const env: NodeJS.ProcessEnv = {}
      for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
        if (process.env[key] !== undefined) env[key] = process.env[key]
      }
      for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = directory
      child = spawn(desktopRequire('electron') as string, [join(directory, 'main.cjs')], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout!.setEncoding('utf8').on('data', chunk => { output += chunk })
      child.stderr!.setEncoding('utf8').on('data', chunk => { output += chunk })
      timer = setTimeout(() => child?.kill(), 30_000)
      const [code] = await once(child, 'close')
      assert.equal(code, 0, output)
    } finally {
      if (timer) clearTimeout(timer)
      if (child && child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close')
        child.kill()
        await closed
      }
      await server.close()
    }
  })
})
