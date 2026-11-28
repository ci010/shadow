import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

test('shared player renders custom accessible controls and drives media events at narrow widths', { timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `media-player-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const server = await createServer({ configFile: false, envDir: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'cache'), optimizeDeps: { noDiscovery: true, include: ['vue'] }, plugins: [vue(), {
    name: 'media-player-fixture',
    resolveId: id => id === '/fixture.ts' ? '\0media-player-fixture' : undefined,
    load(id) {
      if (id !== '\0media-player-fixture') return
      return `import {createApp,h} from 'vue'; import Player from '/src/components/MediaPlayer.vue'; import Attachments from '/src/components/MessageAttachments.vue'; import {setLocalePreference} from '/src/i18n.ts'; setLocalePreference('en'); createApp({render:()=>h('main',[h(Player,{kind:'video',label:'Video fixture'}),h(Player,{kind:'audio',label:'Audio fixture'}),h(Attachments,{paths:['/fixture.wav'],apiBase:location.origin,sessionId:'web:fixture'})])}).mount('#app');`
    },
    configureServer(server) { server.middlewares.use((req, res, next) => {
      if (req.url !== '/') { next(); return }
      res.setHeader('Content-Type', 'text/html'); res.end('<html><body style="margin:0"><div id="app"></div><script type="module" src="/fixture.ts"></script></body></html>')
    }) },
  }], server: { host: '127.0.0.1', port: 0 } })
  await server.listen(); t.after(() => server.close())
  const url = server.resolvedUrls?.local[0]; assert(url)
  const script = `const assert=require('node:assert/strict'); const {app,BrowserWindow}=require('electron'); const {setTimeout:delay}=require('node:timers/promises'); app.setPath('userData',require('node:path').join(process.cwd(),'profile')); app.on('window-all-closed',()=>{});
    (async()=>{await app.whenReady();const win=new BrowserWindow({show:false,width:320,height:800,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false}}); const run=s=>win.webContents.executeJavaScript(s); await win.loadURL(${JSON.stringify(url)});
    for(let i=0;i<200;i++){if(await run('!!document.querySelector(".media-toolbar")'))break;await delay(50)}
    assert.equal(await run('document.querySelectorAll("video[controls],audio[controls]").length'),0);
    assert.equal(await run('document.querySelectorAll(".media-player").length'),3);
    assert.equal(await run('getComputedStyle(document.querySelector(".attachment-details")).marginTop'),'12px');
    assert.equal(await run('[...document.querySelectorAll(".media-button")].every(e=>e.getBoundingClientRect().height>=44&&e.getBoundingClientRect().width>=44)'),true);
    assert.equal(await run('document.documentElement.scrollWidth<=innerWidth'),true);
    assert.equal(await run('getComputedStyle(document.querySelector(".media-player-video .media-controls")).position'),'absolute');
    assert.equal(await run('getComputedStyle(document.querySelector(".media-player-audio .media-controls")).position'),'relative');
    await run(\`window.m=document.querySelector('video');window.p=m.parentElement;window.playing=false;Object.defineProperties(m,{paused:{get:()=>!window.playing},duration:{get:()=>120}});m.play=async()=>{window.playing=true;m.dispatchEvent(new Event('play'))};m.pause=()=>{window.playing=false;m.dispatchEvent(new Event('pause'))};m.dispatchEvent(new Event('loadedmetadata'));\`);
    await run('p.querySelector(".media-toolbar button").click()');assert.equal(await run('p.querySelector(".media-toolbar button").getAttribute("aria-label")'),'Pause');
    await run(\`window.seek=p.querySelector('.media-seek');seek.value='35';seek.dispatchEvent(new Event('input',{bubbles:true}));\`);assert.equal(await run('m.currentTime'),35);assert.match(await run('p.querySelector(".media-time").textContent'),/0:35 \\/ 2:00/);
    await run(\`window.vol=p.querySelector('.media-volume');vol.value='0.3';vol.dispatchEvent(new Event('input',{bubbles:true}));\`);assert.equal(await run('m.volume'),0.3);
    await run('p.querySelectorAll(".media-toolbar button")[1].click()');assert.equal(await run('m.muted'),true);
    await run('p.querySelector(".media-toolbar button").click()');assert.equal(await run('window.playing'),false);
    win.show(); win.focus(); win.webContents.focus(); await run(\`p.querySelector('.media-seek').focus()\`);await win.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'});await win.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'});await delay(100);assert.equal(await run('m.currentTime>35'),true);
    await run('document.querySelector("audio").dispatchEvent(new Event("error"))'); assert.match(await run('document.querySelector(".media-player-audio [role=alert]").textContent'),/Could not play media/);
    await win.close();console.log('MEDIA_PLAYER_OK');app.exit(0)})().catch(e=>{console.error(e);app.exit(1)});`
  await build({ stdin: { contents: script, resolveDir: root, sourcefile: 'media-player.cjs', loader: 'js' }, outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(desktopRequire('electron') as string, [resolve(directory, 'main.cjs')], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''; child.stdout.setEncoding('utf8').on('data', chunk => { log += chunk }); child.stderr.setEncoding('utf8').on('data', chunk => { log += chunk })
  const timer = setTimeout(() => child.kill(), 75_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close'); assert.equal(code, 0, log); assert.match(log, /MEDIA_PLAYER_OK/)
})
