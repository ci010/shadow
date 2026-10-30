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
import UnoCSS from 'unocss/vite'
import type { ServerResponse } from 'node:http'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')
test('native group navigation and resource events render received-only text without chat authoring', { timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `service-groups-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const revision = 'fixture'
  let executableMutations = 0, groupReads = 0, sequence = 0, updated = false
  const live = new Set<ServerResponse>()
  t.after(() => { for (const response of live) response.end() })
  const server = await createServer({ configFile: false, envDir: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'cache'), optimizeDeps: { entries: [], noDiscovery: true }, plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app/unocss.config.ts') }), {
    name: 'service-groups-fixture', resolveId: id => id === '/group-fixture.ts' ? '\0group-fixture' : undefined,
    load(id) { if (id === '\0group-fixture') return `import {createApp,h,computed} from 'vue'; import {createRouter,createMemoryHistory,useRoute} from 'vue-router'; import Sidebar from '/src/components/FoldersSidebar.vue'; import Chat from '/src/components/ChatWorkspace.vue'; import {useServiceGroups,projectGroupConversations} from '/src/service-groups.ts'; import {setLocalePreference} from '/src/i18n.ts'; window.fixtureLocale=setLocalePreference; import '/src/styles.css'; import 'virtual:uno.css'; const router=createRouter({history:createMemoryHistory(),routes:[{path:'/:sessionId?',name:'chat',component:{render:()=>null}},{path:'/agents',name:'agents',component:{render:()=>null}}]}); const app=createApp({setup(){const route=useRoute();const {groups}=useServiceGroups(()=>({apiBase:location.origin,projectId:'fixture',active:true}));const existing={sessionId:'bot:fixture:bot:qq:group%3Aexisting',projectId:'fixture',channelAddress:{projectId:'fixture',botInstanceId:'bot',platform:'qq',conversationId:'group:existing'},label:'Existing QQ history',title:'Existing QQ history',isDirectChat:false,isCurrent:false,parentSessionId:null,depth:0};return ()=>h('main',{style:'display:flex;height:100vh;overflow:hidden'},[h('aside',{style:'width:270px;flex-shrink:0;border-right:1px solid var(--c-border)'},h(Sidebar,{apiBase:location.origin,projectId:'fixture',projectName:'Fixture Project',grouped:true,sessionsLoading:false,sessionsError:'',bots:[{id:'bot',projectId:'fixture',platform:'qq',displayName:'QQ Service Bot'}],sessions:projectGroupConversations([existing],groups.value,'fixture'),activeSessionId:String(route.params.sessionId||''),collapsed:new Set(),stages:{},onSelect:id=>router.push({name:'chat',params:{sessionId:id}})})),route.params.sessionId?h(Chat,{key:route.params.sessionId,apiBase:location.origin,projectId:'fixture',sessionId:String(route.params.sessionId),visible:true}):h('p','Select a conversation')])}});app.use(router);router.isReady().then(()=>app.mount('#app'));` },
    configureServer(server) { server.middlewares.use((req, res, next) => {
      const url = new URL(req.url!, 'http://127.0.0.1')
      const json = (body: unknown, status = 200) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(body)) }
      if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><body><div id="app"></div><script type="module" src="/group-fixture.ts"></script></body></html>'); return }
      if (url.pathname === '/api/live') {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
        live.add(res); req.on('close', () => live.delete(res))
        res.write(`event: realtime\ndata: ${JSON.stringify({ type: 'reset', cursor: `fixture:${sequence}`, reason: 'initial' })}\n\n`)
        res.write(`event: realtime\ndata: ${JSON.stringify({ type: 'ready', cursor: `fixture:${sequence}` })}\n\n`)
        return
      }
      if (url.pathname === '/fixture/stats') { json({ groupReads, live: live.size }); return }
      if (url.pathname === '/fixture/invalidate') {
        updated = true
        const frame = { type: 'event', cursor: `fixture:${++sequence}`, topic: { kind: 'resources', projectId: 'fixture' }, payload: { event: 'invalidate', resource: 'service-groups' } }
        for (const response of live) response.write(`event: realtime\ndata: ${JSON.stringify(frame)}\n\n`)
        json({ ok: true }); return
      }
      if (url.pathname === '/api/service-groups') {
        groupReads++
        json({ revision, agents: [], groups: [
          { botInstanceId: 'bot', platform: 'qq', conversationId: 'group:00112233445566778899', botName: 'Service Bot', enabled: false, pending: false, lastSeen: 1, messages: url.searchParams.has('group') ? [{ id: 'm1', sender: 'qq:12345678901234567890', text: updated ? 'Resource event delivered' : '请帮忙确认下周发布安排。<script>untrusted text</script>', receivedAt: 1, state: 'not_enabled' }] : [] },
          { botInstanceId: 'bot', platform: 'qq', conversationId: 'group:existing', sessionId: 'bot:fixture:bot:qq:group%3Aexisting', name: 'Existing QQ history', botName: 'Service Bot', enabled: true, pending: false, lastSeen: 1, messages: [] },
        ] }); return
      }
      if (url.pathname === '/api/folders') { json({ folders: [] }); return }
      if (url.pathname.startsWith('/api/') && req.method !== 'GET') executableMutations++
      if (url.pathname.startsWith('/api/')) { json({ jobs: [], sessions: [], requests: [] }); return }
      next()
    }) },
  }], server: { host: '127.0.0.1', port: 0 } })
  await server.listen(); t.after(() => server.close())
  const url = server.resolvedUrls?.local[0]; assert(url)
  // Group setup is now local deployment guidance, not the removed select/propose/approve authoring UI.
  const script = `
const assert=require('node:assert/strict');const {app,BrowserWindow}=require('electron');const {setTimeout:delay}=require('node:timers/promises');
app.setPath('userData',require('node:path').join(process.cwd(),'profile'));app.on('window-all-closed',()=>{});
(async()=>{await app.whenReady();const win=new BrowserWindow({show:false,width:1120,height:760,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});
const run=s=>win.webContents.executeJavaScript(s);const wait=async s=>{for(let i=0;i<240;i++){if(await run('Boolean('+s+')'))return;await delay(50)}throw new Error('Timeout '+s+' '+await run('document.body.innerText'))};
await win.loadURL(${JSON.stringify(url)});
await wait('document.querySelectorAll(".session-select").length===2');
assert.equal(await run('document.querySelectorAll(".service-groups-nav").length'),0);
await run('[...document.querySelectorAll(".session-select")].find(b=>b.textContent.includes("QQ group ·")).click()');
await wait('document.querySelector(".observed-message")');
assert.equal(await run('document.querySelector(".observed-message").textContent.includes("<script>untrusted text</script>")'),true);
assert.equal(await run('document.querySelectorAll(".observed-message script").length'),0);
assert.equal(await run('document.querySelectorAll(".message-input,textarea[readonly],.group-setup").length'),0);
assert.equal(await run('document.querySelector(".observed-messages").innerText.includes("12345678901234567890")'),false);
await run('[...document.querySelectorAll("button")].find(b=>b.getAttribute("aria-label")==="Group Agent setup").click()');
await wait('document.querySelector(".group-setup")');
assert.equal(await run('document.querySelector(".group-setup").textContent.includes("BOT.md")'),true);
assert.equal(await run('document.querySelector(".group-setup a").textContent'),'Open Agent configuration');
assert.equal(await run('document.querySelectorAll(".group-setup select,.group-setup input,.group-setup textarea,.group-setup form").length'),0);
await run('document.querySelector(".composer-popover-backdrop").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true}))');
await delay(200);
const before=await run('fetch("/fixture/stats").then(r=>r.json())');assert.equal(before.live,1);
await delay(3300);
assert.equal((await run('fetch("/fixture/stats").then(r=>r.json())')).groupReads,before.groupReads,'live idle has no 3s polling');
await run('fetch("/fixture/invalidate").then(r=>r.json())');
await wait('document.querySelector(".observed-message")?.textContent==="Resource event delivered"');
assert.equal(await run('document.querySelectorAll(".message-input,textarea[readonly]").length'),0);
assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'),true);
win.setSize(390,760);await run('document.querySelector("aside").style.display="none"');await delay(200);
assert.equal(await run('document.documentElement.scrollWidth <= innerWidth'),true);
await win.close();console.log('SERVICE_GROUPS_SMOKE_OK');app.exit(0)})().catch(e=>{console.error(e);app.exit(1)});`
  await build({ stdin: { contents: script, resolveDir: root, sourcefile: 'service-groups-smoke.js' }, outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], logLevel: 'silent' })
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) if (process.env[key] !== undefined) env[key] = process.env[key]
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = directory
  const child = spawn(desktopRequire('electron') as string, [resolve(directory, 'main.cjs')], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''; child.stdout.setEncoding('utf8').on('data', chunk => { log += chunk }); child.stderr.setEncoding('utf8').on('data', chunk => { log += chunk })
  const timer = setTimeout(() => child.kill(), 75_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close'); assert.equal(code, 0, log); assert.match(log, /SERVICE_GROUPS_SMOKE_OK/); assert.equal(executableMutations, 0, 'Display-only navigation must not prepare/send/run a session')
})
