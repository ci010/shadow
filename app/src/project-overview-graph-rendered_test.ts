import test from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { createSSRApp } from 'vue'
import { renderToString } from 'vue/server-renderer'
import { fileURLToPath } from 'node:url'
import { projectWorkOverviewSchema } from '../../src/projects/work-overview.ts'
test('rendered native overview contains one graph, focus controls, authority, time and relation legend', async () => {
  const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, optimizeDeps: { noDiscovery: true, include: [] }, plugins: [vue()], server: { middlewareMode: true }, appType: 'custom' })
  try {
    const component = (await server.ssrLoadModule('/src/components/ProjectOverviewGraph.vue')).default
    const data = projectWorkOverviewSchema.parse({ items: [{ key: 'goal', title: 'Release context', revision: 1, sequence: 1, status: 'done', parentKey: null, dependencies: [], blockedReason: null, manager: null, assignee: null, paused: false, adopted: false, proposals: 0, interpretationReview: false, changedAt: '2026-10-10T00:00:00Z', origin: 'human', notes: { kind: 'goal', summary: 'Reported outcome' } }], sessions: [], requests: [], effects: [] })
    const html = await renderToString(createSSRApp(component, { data, apiBase: '/fixture', query: '' }))
    assert.equal((html.match(/<svg/g) ?? []).length, 1)
    assert(html.includes('Release context')); assert(!html.includes('Reported outcome')); assert(html.includes('aria-expanded="false"')); assert(html.includes('Expand children')); assert(html.includes('2026'))
    assert(html.includes('precedence')); assert(html.includes('causal')); assert(html.includes('focus-groups'))
    assert(!html.includes('ProjectContextCanvas')); assert(!html.includes('<details'))
  } finally { await server.close() }
})


test('browser graph toggles independent nested branches while selecting detail', { timeout: 90_000, skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY }, async t => {
  const { createRequire } = await import('node:module')
  const { spawn } = await import('node:child_process')
  const { mkdir, writeFile, rm } = await import('node:fs/promises')
  const { randomUUID } = await import('node:crypto')
  const { resolve } = await import('node:path')
  const requireDesktop = createRequire(new URL('../../desktop/package.json', import.meta.url))
  const directory = resolve('.test-artifacts', `overview-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const base = { title: 'Root', revision: 1, sequence: 1, status: 'pending', parentKey: null, dependencies: [], blockedReason: null, manager: null, assignee: null, paused: false, adopted: false, proposals: 0, interpretationReview: false, changedAt: '2026-10-10T00:00:00Z', notes: {} }
  const data = projectWorkOverviewSchema.parse({ items: [{ ...base, key: 'root' }, { ...base, key: 'other', title: 'Other' }, { ...base, key: 'child', title: 'Child', parentKey: 'root' }, { ...base, key: 'leaf', title: 'Leaf', parentKey: 'child' }, { ...base, key: 'leaf2', title: 'Leaf 2', parentKey: 'child' }, { ...base, key: 'sibling', title: 'Sibling', parentKey: 'root' }], sessions: [], requests: [], effects: [] })
  const server = await createServer({ root: fileURLToPath(new URL('..', import.meta.url)), configFile: false, logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'), optimizeDeps: { noDiscovery: true }, plugins: [vue(), {
    name: 'overview-fixture', resolveId: id => id === '/overview-fixture.ts' ? '\0overview-fixture' : undefined,
    load: id => id === '\0overview-fixture' ? `import {createApp} from 'vue'; import Graph from '/src/components/ProjectOverviewGraph.vue'; import {setLocalePreference} from '/src/i18n.ts'; setLocalePreference('en'); createApp(Graph, {data:${JSON.stringify(data)},apiBase:'/fixture',query:''}).mount('#app');` : undefined,
    configureServer(server) { server.middlewares.use((request, response, next) => { if (request.url !== '/__overview') return next(); response.setHeader('Content-Type', 'text/html'); response.end('<div id="app"></div><script type="module" src="/overview-fixture.ts"></script>') }) },
  }], server: { host: '127.0.0.1', port: 0 } })
  await server.listen(); t.after(() => server.close())
  const url = new URL('__overview', server.resolvedUrls!.local[0]).href
  const runner = resolve(directory, 'runner.cjs')
  await writeFile(runner, `const assert=require('node:assert/strict'); const {app,BrowserWindow}=require('electron'); app.setPath('userData',require('node:path').join(__dirname,'profile')); (async()=>{ await app.whenReady(); const win=new BrowserWindow({show:false,webPreferences:{backgroundThrottling:false}}); const run=code=>win.webContents.executeJavaScript(code); const wait=async code=>{for(let i=0;i<200;i++){if(await run(code))return;await new Promise(r=>setTimeout(r,50))}throw new Error(code)}; try{await win.loadURL(${JSON.stringify(url)});await wait("document.querySelectorAll('.node').length===2"); const ids=()=>run("Array.from(document.querySelectorAll('.node'),n=>n.dataset.nodeId)"); const click=id=>run("document.querySelector('[data-node-id=\\\""+id+"\\\"]').click()"); assert.deepEqual(await ids(),['root','other']); await click('root');await wait("document.querySelectorAll('.node').length===4");assert.equal(await run("document.querySelector('[data-node-id=root]').getAttribute('aria-expanded')"),'true');assert.equal(await run("document.querySelector('.context h3').textContent"),'Root'); await click('child'); await wait("document.querySelectorAll('.node').length===6"); await click('root');await wait("document.querySelectorAll('.node').length===2");await click('root');await wait("document.querySelectorAll('.node').length===6");assert.deepEqual(await ids(),['root','child','leaf','leaf2','sibling','other']);assert.equal(await run("(()=>{const a=document.querySelector('[data-node-id=root]').getBoundingClientRect(), b=document.querySelector('[data-node-id=other]').getBoundingClientRect(), c=document.querySelector('[data-node-id=child]').getBoundingClientRect(); return a.top===b.top && b.left>a.right && c.top>a.bottom && c.left<a.left && document.querySelector('[data-node-id=sibling]').getBoundingClientRect().top===c.top && document.querySelector('[data-node-id=sibling]').getBoundingClientRect().left>document.querySelector('[data-node-id=leaf2]').getBoundingClientRect().right && document.querySelector('[data-node-id=leaf]').getBoundingClientRect().top===document.querySelector('[data-node-id=leaf2]').getBoundingClientRect().top})()"),true);app.exit(0)}catch(error){console.error(error);app.exit(1)}})();`)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(requireDesktop('electron'), [runner], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] })
  t.after(() => { if (child.exitCode === null) child.kill() })
  let output = ''; child.stdout.on('data', chunk => output += chunk); child.stderr.on('data', chunk => output += chunk)
  const code = await new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('exit', resolve) })
  assert.equal(code, 0, output)
})
