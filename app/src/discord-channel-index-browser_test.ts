import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

test('browser searches posts and opens exact old/passive history choices', { timeout: 60_000 }, async t => {
  let electron = process.env.SHADOW_TEST_ELECTRON
  if (!electron) {
    try { electron = createRequire(new URL('../../desktop/package.json', import.meta.url))('electron') }
    catch { t.skip('Electron dependency unavailable'); return }
  }
  const dir = await mkdtemp(resolve('.test-artifacts-discord-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  const history = (sessionId: string, id: string, name: string) => ({ sessionId, projectId: 'p', label: name, lastActivityAt: '2026-11-01T12:00:00Z', channelAddress: { projectId: 'p', botInstanceId: 'b', platform: 'discord', conversationId: id }, discordChannel: { id, type: 11, guildId: '2', parentId: '1', parentName: 'Forum', name } })
  const histories = [history('bot:old-original', '3', 'Install issue'), history('channel-inbox:passive-original', '3', 'Install issue'), history('bot:other-original', '4', 'Java question')]
  const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, logLevel: 'error', optimizeDeps: { noDiscovery: true }, plugins: [vue(), {
    name: 'discord-fixture', resolveId: id => id === '/discord-fixture.ts' ? '\0discord-fixture' : undefined,
    load: id => id === '\0discord-fixture' ? `import {createApp,h} from 'vue';import Index from '/src/components/DiscordChannelIndex.vue';import {setLocalePreference} from '/src/i18n.ts';import '/src/styles.css';document.documentElement.classList.add('dark');setLocalePreference('en');window.opened=[];const app=createApp({render:()=>h(Index,{apiBase:'',projectId:'p',channelKey:{projectId:'p',botInstanceId:'b',guildId:'2',channelId:'1'},active:true,onOpen:id=>window.opened.push(id)})});app.provide(Symbol.for('shadow.project-live-state'),{acquireProject:()=>({graph:{state:{value:${JSON.stringify(histories)},loading:false,error:''},read:async()=>{}},release(){}})});app.mount('#app');` : undefined,
    configureServer(server) { server.middlewares.use((req, res, next) => { if (req.url !== '/__discord') return next(); res.setHeader('Content-Type', 'text/html'); res.end('<div id="app"></div><script type="module" src="/discord-fixture.ts"></script>') }) },
  }], server: { host: '127.0.0.1', port: 0 } })
  await server.listen(); t.after(() => server.close())
  const runner = resolve(dir, 'runner.cjs')
  await writeFile(runner, `const assert=require('node:assert/strict');const {app,BrowserWindow}=require('electron');app.setPath('userData',require('node:path').join(__dirname,'profile'));(async()=>{await app.whenReady();const win=new BrowserWindow({show:false,width:900,height:700});await win.loadURL(${JSON.stringify(new URL('/__discord', server.resolvedUrls!.local[0]).href)});const run=code=>win.webContents.executeJavaScript(code);const wait=async code=>{for(let i=0;i<100;i++){if(await run(code))return;await new Promise(r=>setTimeout(r,50))}throw Error('Timed out '+code)};await wait('document.querySelectorAll(".post").length===2');if(process.env.SHADOW_DISCORD_SCREENSHOT_DIR){for(const width of [900,390]){win.setSize(width,700);await new Promise(r=>setTimeout(r,150));const image=await win.webContents.capturePage();require('node:fs').writeFileSync(require('node:path').join(process.env.SHADOW_DISCORD_SCREENSHOT_DIR,'.tmp-discord-index-'+width+'.png'),image.toPNG())}}assert.equal(await run('document.body.innerText.includes("old-original")'),false);await run('document.querySelector("input").value="Install";document.querySelector("input").dispatchEvent(new Event("input",{bubbles:true}))');await wait('document.querySelectorAll(".post").length===1');await run('[...document.querySelectorAll(".history-choice")].find(b=>b.textContent==="Original history").click()');await run('[...document.querySelectorAll(".history-choice")].find(b=>b.textContent==="Passive inbox").click()');assert.deepEqual(await run('window.opened'),['bot:old-original','channel-inbox:passive-original']);await run('document.querySelector("input").value="Java";document.querySelector("input").dispatchEvent(new Event("input",{bubbles:true}))');await wait('!!document.querySelector(".post-open")');await run('document.querySelector(".post-open").click()');assert.equal(await run('window.opened.at(-1)'),'bot:other-original');await run('document.querySelector("input").value="missing";document.querySelector("input").dispatchEvent(new Event("input",{bubbles:true}))');await wait('document.querySelectorAll(".post").length===0');assert.equal(await run('!!document.querySelector("textarea,.session-delete")'),false);app.exit(0)})().catch(e=>{console.error(e);app.exit(1)})`)
  const result = await new Promise<{ code: number | null; output: string }>((done, reject) => {
    const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
    const child = spawn(electron!, [runner], { env }); let output = ''
    child.stdout.on('data', data => output += data); child.stderr.on('data', data => output += data)
    child.on('error', reject); child.on('close', code => done({ code, output }))
  })
  assert.equal(result.code, 0, result.output)
})
