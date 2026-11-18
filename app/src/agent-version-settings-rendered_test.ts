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
import { BUILTIN_AGENT_VERSIONS } from '../../src/agent/types/versions.ts'
import { withTempWorkspace } from '../../src/testing/workspace.ts'

const appRoot = fileURLToPath(new URL('../', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))

test('rendered Agent settings show registered versions and save only the changed role', {
  timeout: 45_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async () => {
  await withTempWorkspace(async directory => {
    const server = await createServer({
      configFile: false, root: appRoot, logLevel: 'error', server: { host: '127.0.0.1', port: 0 },
      optimizeDeps: { entries: [] },
      plugins: [vue(), {
        name: 'agent-version-fixture',
        resolveId: id => id === '/version-fixture.ts' ? '\0version-fixture' : undefined,
        load: id => id !== '\0version-fixture' ? undefined : `
          import '/src/styles.css';
          import {createResourceApp} from '/src/stores/app.ts';
          import Form from '/src/components/AgentVersionDefaultsForm.vue';
          const roles = ${JSON.stringify(BUILTIN_AGENT_VERSIONS.map(role => ({ ...role, selectedVersion: role.defaultVersion })))};
          window.patches = [];
          window.fetch = async (url, init) => {
            if (new URL(url, location.href).pathname !== '/api/app/agent-version-defaults') throw Error('Wrong endpoint');
            if (init?.method === 'PATCH') {
              const patch = JSON.parse(init.body); window.patches.push(patch);
              for (const role of roles) role.selectedVersion = patch[role.role] ?? role.selectedVersion;
            }
            return Response.json({roles});
          };
          createResourceApp(Form, {apiBase:location.origin}).mount('#app');
        `,
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__version') return next()
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
            const general = await waitFor(() => document.querySelector('[role=combobox][aria-label=General]'));
            const all = [...document.querySelectorAll('[role=combobox]')].map(button => [button.textContent.trim(), button.disabled]);
            general.focus(); general.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', bubbles:true }));
            const v1 = await waitFor(() => [...document.querySelectorAll('[role=option]')].find(option => option.textContent.trim() === 'V1'));
            v1.click(); await waitFor(() => !document.querySelector('[type=submit]').disabled);
            document.querySelector('[type=submit]').click();
            await waitFor(() => document.body.textContent.includes('Agent defaults saved.'));
            return { all, general: general.textContent.trim(), patches: window.patches };
          })()\`);
          assert.deepEqual(result.all, [['V2 · Built-in default', false], ...Array(4).fill(['V1 · Built-in default', true])]);
          assert.equal(result.general, 'V1');
          assert.deepEqual(result.patches, [{general:'v1'}]);
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
