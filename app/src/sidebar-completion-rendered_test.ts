import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, rm, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')
test('sidebar completion renders idle and delegated icons in expanded and rail modes', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `tool-diff-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))

  const fixture=`<template><FolderSessionList :sessions="sessions" active-session-id="web:chat-root" :collapsed="new Set()" :stages="stages" :executions-by-owner="owners" :rail="state.rail" :show-info="false" /></template>
<script setup>
import {reactive,computed} from 'vue';
import FolderSessionList from '/src/components/FolderSessionList.vue';
import {parseSessionGraph} from '/src/folders-sidebar.ts';
const state=reactive({stage:'idle',child:'completed',rail:false,completed:false});window.__activity=state;
const graph=computed(()=>parseSessionGraph({sessions:[{sessionId:'web:chat-root',mode:'session',current:'p-root',completed:state.completed},{sessionId:'web:chat-task',mode:'task',parentSessionId:'web:chat-root',executionStatus:state.child}],nodes:[{physicalId:'p-root',logicalId:'web:chat-root'}]}));
const sessions=computed(()=>graph.value.filter(s=>s.mode==='session'));
const stages=computed(()=>({'web:chat-root':state.stage}));
const owners=computed(()=>new Map([['web:chat-root',graph.value.filter(s=>s.mode==='task' && ['running','waiting','pending'].includes(s.executionStatus))]]));
</script>`
  const server=await createServer({configFile:false,root:resolve(root,'app'),logLevel:'error',cacheDir:resolve(directory,'vite-cache'),optimizeDeps:{noDiscovery:true,include:[]},plugins:[vue(),UnoCSS({configFile:resolve(root,'app/unocss.config.ts')}),{
  name:'activity-fixture',resolveId:id=>id==='/activity-entry.ts'?'\0activity-entry':id==='/activity-fixture.vue'?resolve(root,'app/activity-fixture.vue').replaceAll('\\', '/'):undefined,load:id=>id==='\0activity-entry'?`import 'uno.css';import '/src/styles.css';import {createApp} from 'vue';import Fixture from '/activity-fixture.vue';createApp(Fixture).mount('#app');`:id===resolve(root,'app/activity-fixture.vue').replaceAll('\\', '/')?fixture:undefined,
  configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url!=='/__activity')return next();res.setHeader('Content-Type','text/html');res.end('<html><body><div id="app"></div><script type="module" src="/activity-entry.ts"></script></body></html>')})}
  }],server:{host:'127.0.0.1',port:0}})
  await server.listen()
  t.after(() => server.close())
  await build({
    entryPoints: [resolve(root, 'desktop', 'tests', 'fixtures', 'sidebar-completion-smoke.ts')],
    outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs',
    target: 'node24', external: ['electron'], logLevel: 'silent',
  })
  const env: NodeJS.ProcessEnv = { ACTIVITY_SMOKE_URL: server.resolvedUrls!.local[0] }
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR', 'TOOL_DIFF_SCREENSHOTS']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = directory
  const child = spawn(desktopRequire('electron') as string, [resolve(directory, 'main.cjs')], {
    cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })
  const timer = setTimeout(() => child.kill(), 75_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, output)
  assert.match(output, /SIDEBAR_COMPLETION_OK/)
})
