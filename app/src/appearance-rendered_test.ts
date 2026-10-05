import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { compileStyle, parse } from 'vue/compiler-sfc'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))

test('rendered scrollbars follow radius tokens and composer hints yield to controls in narrow panes', {
  timeout: 30_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `appearance-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const styles = await readFile(new URL('./styles.css', import.meta.url), 'utf8')
  const { descriptor } = parse(await readFile(new URL('./components/ChatTab.vue', import.meta.url), 'utf8'))
  const composer = compileStyle({ source: descriptor.styles.map(style => style.content).join('\n'), filename: 'ChatTab.vue', id: 'data-v-fixture', scoped: true })
  assert.deepEqual(composer.errors, [])
  const hints = [...descriptor.template!.content.matchAll(/'(Enter to send[^']*)'/g)].map(match => match[1])
  assert.equal(hints.length, 2, 'Exercise the actual idle and busy shortcut descriptions')
  await writeFile(resolve(directory, 'index.html'), `<!doctype html><html><head><style>${styles}\n${composer.code}</style></head>
    <body><div id="scroller" style="width:200px;height:200px;overflow:scroll"><div style="width:400px;height:400px"></div></div>
    <div class="composer-toolbar" data-v-fixture>
      <div class="composer-controls" data-v-fixture style="width:360px;height:32px">Model and attachment controls</div>
      <div class="composer-submit" data-v-fixture><span class="composer-hint" data-v-fixture role="status"></span><button class="composer-send" data-v-fixture aria-label="Send message"></button></div>
    </div></body></html>`)
  await writeFile(resolve(directory, 'main.cjs'), `
    const assert = require('node:assert/strict');
    const { join } = require('node:path');
    const { app, BrowserWindow } = require('electron');
    app.setPath('userData', join(process.cwd(), 'profile'));
    app.whenReady().then(async () => {
      const window = new BrowserWindow({ show:false, webPreferences:{sandbox:true, contextIsolation:true, nodeIntegration:false} });
      await window.loadFile(join(process.cwd(), 'index.html'));
      for (const dark of [false, true]) {
        for (const radius of [null, '3px', null]) {
          const result = await window.webContents.executeJavaScript(\`(() => {
            document.documentElement.classList.toggle('dark', \${dark});
            const radius = \${JSON.stringify(radius)};
            if (radius === null) document.documentElement.style.removeProperty('--radius-sm');
            else document.documentElement.style.setProperty('--radius-sm', radius);
            const scroller = document.querySelector('#scroller');
            const style = getComputedStyle(scroller);
            const thumb = getComputedStyle(scroller, '::-webkit-scrollbar-thumb');
            scroller.scrollTop = 20;
            scroller.scrollLeft = 20;
            return { nativeWidth:style.scrollbarWidth, nativeColor:style.scrollbarColor,
              radius:thumb.borderRadius, color:thumb.backgroundColor,
              width:scroller.offsetWidth - scroller.clientWidth,
              height:scroller.offsetHeight - scroller.clientHeight,
              top:scroller.scrollTop, left:scroller.scrollLeft };
          })()\`);
          assert.equal(result.nativeWidth, 'auto', 'Native sizing must not override custom scrollbar styling');
          assert.equal(result.nativeColor, 'auto', 'Native colors must not override custom scrollbar styling');
          assert.equal(result.radius, radius ?? '0px', 'Thumb follows the global radius token');
          assert.equal(result.color, dark ? 'rgb(128, 128, 128)' : 'rgb(133, 133, 133)');
          assert.equal(result.width, 6, 'Rendered vertical scrollbar is the custom six-pixel scrollbar');
          assert.equal(result.height, 6, 'Rendered horizontal scrollbar is the custom six-pixel scrollbar');
          assert.equal(result.top, 20);
          assert.equal(result.left, 20);
        }
      }
      for (const hint of ${JSON.stringify(hints)}) {
        for (const [width, controlsWidth, hidden] of [[760, 360, false], [689, 360, false], [688, 360, true], [600, 360, true], [420, 360, true], [760, 500, true], [760, 360, false]]) {
          const result = await window.webContents.executeJavaScript(\`(() => {
            const toolbar = document.querySelector('.composer-toolbar');
            const controls = document.querySelector('.composer-controls');
            const hint = document.querySelector('.composer-hint');
            const button = document.querySelector('.composer-send');
            toolbar.style.width = '\${width}px';
            controls.style.width = '\${controlsWidth}px';
            hint.textContent = \${JSON.stringify(hint)};
            const rect = toolbar.getBoundingClientRect();
            const send = button.getBoundingClientRect();
            const control = controls.getBoundingClientRect();
            const style = getComputedStyle(hint);
            return { height:rect.height, top:send.top - rect.top, controlTop:control.top - rect.top,
              right:rect.right - send.right, buttonWidth:send.width,
              clipped:style.clipPath === 'inset(50%)', nowrap:style.whiteSpace === 'nowrap',
              textFits:hint.scrollWidth <= hint.clientWidth, role:hint.getAttribute('role') };
          })()\`);
          assert.equal(result.height, 32, 'Shortcut text never adds a second toolbar row');
          assert.equal(result.top, 0, 'Send/stop button stays on the first row');
          assert.equal(result.controlTop, 0);
          assert.equal(result.right, 0, 'Action remains at the right edge');
          assert.equal(result.buttonWidth, 32, 'Action never shrinks to accommodate the hint');
          assert.equal(result.clipped, hidden, 'Hint visibility follows remaining space, including model label changes');
          assert.equal(result.nowrap, true);
          if (!hidden) assert.equal(result.textFits, true, 'Visible hints are complete, not truncated');
          assert.equal(result.role, 'status', 'Hidden status remains available to assistive technology');
        }
      }
      window.destroy();
      console.log('APPEARANCE_OK');
      app.exit(0);
    }).catch(error => { console.error(error); app.exit(1); });
  `)
  const env: NodeJS.ProcessEnv = {}
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
  const timer = setTimeout(() => child.kill(), 20_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, output)
  assert.match(output, /APPEARANCE_OK/)
})
