import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'
import { highlightingDeps } from '../highlighting-deps.ts'
import { summarizeFrontendArgs } from './frontend-log.ts'
import { FrontendLog } from '../../src/runtime/frontend-log.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const require = createRequire(new URL('../../desktop/package.json', import.meta.url))

test('module identity survives renderer and backend redaction without URL secrets', () => {
  const log = new FrontendLog('development')
  log.append('test', [{ level: 'error', message: summarizeFrontendArgs([new Error('Failed to fetch dynamically imported module: http://localhost:5273/node_modules/.vite/deps/shiki_core.js?v=secret&token=hidden#private')]) }])
  assert.match(log.read(), /local module.*shiki_core\.js/)
  assert.doesNotMatch(log.read(), /secret|hidden|private|5273/)
  for (const url of ['https://remote.example/node_modules/.vite/deps/shiki_core.js', 'http://user:pass@localhost/node_modules/.vite/deps/shiki_core.js', 'http://localhost/private/file.js']) {
    assert.doesNotMatch(summarizeFrontendArgs([url]), /local module|user:pass|remote.example|private\/file/)
  }
  assert.match(summarizeFrontendArgs(['Authorization: Bearer abc']), /redacted sensitive/)
})

test('real Vite browser lazy Shiki imports stay valid across language loads and reload', {
  timeout: 120_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `highlighting-vite-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  // Never share the running dev server's optimizer cache. This test uses the real
  // app config and source graph, but all generated optimizer files are disposable.
  const liveMetadata = resolve(root, 'app/node_modules/.vite/deps/_metadata.json')
  const before = await readFile(liveMetadata, 'utf8').catch(() => undefined)
  const server = await createServer({ root: resolve(root, 'app'), configFile: resolve(root, 'app/vite.config.ts'),
    cacheDir: resolve(directory, 'vite-cache'), server: { host: '127.0.0.1', port: 0, strictPort: false, open: false } })
  t.after(() => server.close())
  await server.listen()
  const address = server.httpServer!.address()
  assert.ok(address && typeof address !== 'string')
  const origin = `http://127.0.0.1:${address.port}`
  const source = await readFile(resolve(root, 'app/src/file-highlighting.ts'), 'utf8')
  const entries = [...source.matchAll(/import\('(shiki\/[^']+)'\)/g)].map(match => match[1])
  assert.deepEqual(new Set(highlightingDeps), new Set(entries), 'Every lazy entry must be optimized initially')
  const main = resolve(directory, 'main.cjs')
  const browserScript = `(async()=>{
    const {highlightFile}=await import('/src/file-highlighting.ts');
    for(const [path,source] of ${JSON.stringify([['payload.json', '{"ok":true}'], ['file.ts', 'const value: number = 1'], ['file.md', '# title\n\n~~~python\nprint(1)\n~~~']])}){
      const tokens=await highlightFile(source,path);
      if(tokens.map(t=>t.text).join('')!==source||!tokens.some(t=>t.light&&t.dark))throw Error('Missing highlighting: '+path);
    }
  })()`
  await writeFile(main, `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',${JSON.stringify(resolve(directory, 'profile'))});
    app.whenReady().then(async()=>{try{
      const win=new BrowserWindow({show:false,webPreferences:{contextIsolation:true,nodeIntegration:false}});
      win.webContents.on('console-message',event=>console.log(event.message));
      const failures=[];
      win.webContents.session.webRequest.onCompleted(d=>{if(d.url.includes('/node_modules/')&&d.statusCode>=400)failures.push(d.statusCode+' '+d.url)});
      for(let pass=0;pass<2;pass++){
        await win.loadURL(${JSON.stringify(origin + '/@vite/client')});
        await win.webContents.executeJavaScript(${JSON.stringify(browserScript)});
      }
      if(failures.length)throw Error(failures.join('\\n'));
      console.log('SHIKI_VITE_OK');app.exit(0);
    }catch(e){console.error(e);app.exit(1)}});`)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron') as string, [main], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => { output += chunk })
  const timer = setTimeout(() => child.kill(), 90_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, output)
  assert.match(output, /SHIKI_VITE_OK/)
  assert.equal(await readFile(liveMetadata, 'utf8').catch(() => undefined), before, 'Integration must not overwrite the running development optimizer cache')
})
