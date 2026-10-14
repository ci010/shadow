import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { runInNewContext } from 'node:vm'
import { test } from 'node:test'
import { buildDesktop } from './desktop-build.ts'

test('Electron main bundle loads without startup and sandbox preload stays standalone CJS', { timeout: 120_000 }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'shadow-electron-bundle-'))
  try {
    await writeFile(join(root, 'package.json'), '{"type":"module"}')
    const out = join(root, 'dist')
    await buildDesktop(fileURLToPath(new URL('..', import.meta.url)), out)
    const main = await readFile(join(out, 'main.js'), 'utf8')
    const preload = await readFile(join(out, 'preload.cjs'), 'utf8')
    assert.ok(main.length > 0)
    assert.doesNotMatch(preload, /require\(["'](?:\.\/|\.\.\/)/)
    const names = ['app', 'BrowserWindow', 'clipboard', 'desktopCapturer', 'dialog', 'ipcMain', 'Menu',
      'nativeImage', 'Notification', 'session', 'shell', 'Tray', 'utilityProcess']
    const electron = pathToFileURL(join(root, 'electron-mock.js')).href
    await writeFile(join(root, 'electron-mock.js'), names.map(name => `export const ${name} = {};`).join('\n'))
    execFileSync(process.execPath, ['--input-type=module', '-e', `
      import { registerHooks } from 'node:module';
      registerHooks({ resolve(specifier, context, next) {
        return specifier === 'electron' ? {url:${JSON.stringify(electron)},shortCircuit:true} : next(specifier, context);
      }});
      const main = await import(${JSON.stringify(pathToFileURL(join(out, 'main.js')).href)});
      if (typeof main.secureWebPreferences !== 'function') throw Error('main export missing');
    `], { cwd: root, stdio: 'pipe', env: { ...process.env, SHADOW_DESKTOP_DISABLE_AUTO_START: '1' } })
    let exposed: any
    const ipcRenderer = { on() {}, removeListener() {}, invoke() { return Promise.resolve() } }
    runInNewContext(preload, {
      require(name: string) {
        assert.equal(name, 'electron')
        return { ipcRenderer, contextBridge: { exposeInMainWorld(name: string, api: unknown) {
          assert.equal(name, 'shadowDesktop'); exposed = api
        } } }
      },
      window: { addEventListener() {}, removeEventListener() {} },
      navigator: { userActivation: { isActive: false } },
    })
    assert.equal(typeof exposed.bootstrap.ensureRuntime, 'function')
    assert.equal(typeof exposed.windowControls.minimize, 'function')
  } finally { await rm(root, { recursive: true, force: true }) }
})
