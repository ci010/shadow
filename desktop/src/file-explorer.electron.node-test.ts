import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import test from 'node:test'

const require = createRequire(import.meta.url)

test('real Electron reveal IPC survives history routing but rejects a new untrusted document', {
  timeout: 60_000,
  // Native reveal opens Explorer; opt in explicitly rather than doing so in every unit-test run.
  skip: process.platform !== 'win32' || process.env.SHADOW_TEST_NATIVE_REVEAL !== '1',
}, async t => {
  const directory = join(tmpdir(), `shadow-reveal-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const fixture = join(directory, '测试 fixture.txt')
  await writeFile(fixture, 'isolated reveal fixture')
  const { build } = require('esbuild') as typeof import('esbuild')
  await build({
    stdin: { resolveDir: process.cwd(), contents: `
      import {contextBridge,ipcRenderer} from 'electron';
      import {createFileExplorerApi} from './src/file-explorer-contract.ts';
      contextBridge.exposeInMainWorld('shadowDesktop',{fileExplorer:createFileExplorerApi(ipcRenderer)});
    ` }, outfile: join(directory, 'preload.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
  })
  await build({
    stdin: { resolveDir: process.cwd(), contents: `
      import assert from 'node:assert/strict';
      import {app,BrowserWindow,ipcMain,shell} from 'electron';
      import {createServer} from 'node:http';
      import {installFileExplorer} from './src/file-explorer.ts';
      import {FILE_EXPLORER_CHANNEL} from './src/file-explorer-contract.ts';
      app.setPath('userData',${JSON.stringify(join(directory, 'profile'))});
      const server=createServer((req,res)=>{res.setHeader('Content-Type','text/html');res.end('<html><body>isolated reveal fixture</body></html>')});
      (async()=>{try {
        await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
        await app.whenReady();
        const url='http://127.0.0.1:'+server.address().port+'/';
        const win=new BrowserWindow({show:false,webPreferences:{preload:${JSON.stringify(join(directory, 'preload.cjs'))},contextIsolation:true,sandbox:true}});
        let calls=0;
        installFileExplorer(ipcMain,win,{kind:'url',url,origin:new URL(url).origin},path=>{shell.showItemInFolder(path);calls++});
        await win.loadURL(url);
        assert.equal(FILE_EXPLORER_CHANNEL,'shadow:files:show-in-folder');
        await win.webContents.executeJavaScript('history.pushState({}, "", "/projects/fixture/files")');
        await new Promise(resolve=>setTimeout(resolve,100));
        await win.webContents.executeJavaScript('window.shadowDesktop.fileExplorer.showInFolder('+JSON.stringify(${JSON.stringify(fixture.replaceAll('\\', '/'))})+')');
        assert.equal(calls,1);
        await new Promise(resolve=>setTimeout(resolve,2000));
        await win.loadURL(url+'untrusted');
        await assert.rejects(win.webContents.executeJavaScript('window.shadowDesktop.fileExplorer.showInFolder('+JSON.stringify(${JSON.stringify(fixture)})+')'),/trusted Main/);
        assert.equal(calls,1);
        win.destroy();server.close();app.exit(0);
      }catch(error){console.error(error);server.close();app.exit(1)}})();
    ` }, outfile: join(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'],
  })
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron') as string, [join(directory, 'main.cjs')], { env, cwd: directory, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', value => { output += value })
  child.stderr.on('data', value => { output += value })
  t.after(() => { if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'exit')
  assert.equal(code, 0, output)
  // Check only whether Explorer selected our fixture; never print unrelated window paths.
  const selected = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `
    $shell = New-Object -ComObject Shell.Application
    for ($attempt=0; $attempt -lt 40; $attempt++) {
      foreach ($window in $shell.Windows()) {
        try { foreach ($item in $window.Document.SelectedItems()) {
          if ($item.Path -like '*\\${directory.split(/[\\/]/).pop()}\\测试 fixture.txt') { $window.Quit(); Write-Output 'selected'; exit 0 }
        } } catch {}
      }
      Start-Sleep -Milliseconds 100
    }
    Write-Output 'not-selected'
  `], { encoding: 'utf8', timeout: 15_000 })
  assert.equal(selected.trim(), 'selected', 'Explorer must actually select the isolated fixture')
})
