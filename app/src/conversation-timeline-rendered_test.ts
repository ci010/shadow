import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, rm } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import UnoCSS from 'unocss/vite'
import { pdfViewerAssets } from '../pdf-viewer-assets.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

test('continuous ChatTab prepends, preserves boundaries and handles live rollover while reading', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `persistence-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  let rejectSend = false
  let rollover = false
  let extraLive = false
  const initial = Array.from({length:30}, (_, i) => ({role:'assistant', content:'Current message '+i+'. '.repeat(40)}))
  initial.push({role:'assistant',content:'',tool_calls:[{id:'current-tool-one',type:'function',function:{name:'exec',arguments:'{"script":"first tool"}'}}]} as never,
    {role:'tool',tool_call_id:'current-tool-one',content:'First tool result'} as never,
    {role:'assistant',content:'',reasoning_content:'Unique-current-tool-search-result',tool_calls:[{id:'current-tool-two',type:'function',function:{name:'exec',arguments:'{"script":"second tool"}'}}]} as never,
    {role:'tool',tool_call_id:'current-tool-two',content:'Second tool result'} as never,
    {role:'user',content:'<event type="session-handoff" source="fixture" event-id="handoff-fixture" title="Recorded handoff transition" />\nActual recorded handoff context.'})
  const old = (prefix: string) => Array.from({length:20}, (_, i) => ({role:'assistant',content:prefix+' message '+i+'. '.repeat(40)}))
  const html = '<!doctype html><html><body style="margin:0">Synthetic HTML preview</body></html>'
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    optimizeDeps: { noDiscovery:true, exclude:['emf-converter', '@napi-rs/canvas'], include:['vue', 'vue-router', 'marked', 'dompurify', 'zod', 'katex', '@open-file-viewer/core', '@monaco-editor/loader'] },
    plugins: [pdfViewerAssets(), vue(), UnoCSS({ configFile: resolve(root, 'app', 'unocss.config.ts') }), {
      name: 'conversation-persistence',
      resolveId: id => id === '/persistence.ts' ? '\0persistence' : undefined,
      load(id) {
        if (id !== '\0persistence') return
        return `import 'uno.css'; import '/src/styles.css';
          import { createApp, h, ref, watch } from 'vue';
          import { createRouter, createWebHistory } from 'vue-router';
          import Chat from '/src/components/ChatTab.vue';
          const router = createRouter({history:createWebHistory(),routes:[
            {name:'chat',path:'/projects/:projectId/chat/:sessionId?',component:{}},
            {name:'project-settings',path:'/projects/:projectId/settings/:section?',component:{}},
            {name:'agents',path:'/projects/:projectId/agents',component:{}},
            {name:'settings',path:'/settings/:section?',component:{}}
          ]});
          const app = createApp({setup() {
            const sessionId = ref('');
            watch(router.currentRoute, route => {
              if (route.name === 'chat') sessionId.value = route.params.sessionId || '';
            }, {immediate:true});
            return () => { const route = router.currentRoute.value;
              return h(Chat, {key:sessionId.value || 'draft', managed:true, projectId:route.params.projectId,
                sessionId:sessionId.value, apiBase:location.origin + '/projects/' + route.params.projectId,
                visible:true, style:'height:100vh',
                knowledgeRequest:route.query.panel === 'knowledge' ? {entryId:route.query.entry} : undefined,
                onPrepared:sessionId => router.replace({name:'chat',params:{projectId:route.params.projectId,sessionId}}),
                onKnowledgeNavigation:(active, entry) => {
                  if (active) router.replace({query:{...route.query,panel:'knowledge',entry,diagnosis:undefined}});
                  else if (route.query.panel === 'knowledge') router.replace({query:{...route.query,panel:undefined,entry:undefined}});
                },
              });
            };
          }});
          app.provide(Symbol.for('shadow.live-client-pool'), {onDispose:()=>()=>{},observeHost:(_base, callback) => { callback({phase:'live'}); return () => {}; },client:() => ({
            subscribe:(scope, handlers) => { if(scope.kind === 'chat') window.__chatLive = handlers; return {close(){},ready:async()=>{}} }
          })});
          app.use(router); await router.isReady(); app.mount('#app');
          window.__navigate = url => router.push(url);`
      },
      configureServer(server) {
        server.middlewares.use(async (request, response, next) => {
          const url = new URL(request.url!, 'http://127.0.0.1')
          const path = url.pathname
          const json = (value: unknown, status = 200) => {
            response.statusCode = status
            response.setHeader('Content-Type', 'application/json')
            response.end(JSON.stringify(value))
          }
          if (/^\/projects\/[^/]+\/chat(?:\/[^/]+)?$/.test(path)) {
            response.setHeader('Content-Type', 'text/html')
            response.end('<!doctype html><html><body style="margin:0"><div id="app"></div><script type="module" src="/persistence.ts"></script></body></html>')
          } else if (path === '/fixture-reject') { rejectSend = url.searchParams.get('value') === 'true'; json({ ok: true }) }
          else if (path.endsWith('/api/sessions/graph')) json({ sessions: ['web:chat-one', 'web:chat-two'].map(sessionId => ({ sessionId, mode: 'session' })), nodes: [] })
          else if (path.endsWith('/api/sessions/stages')) json({ stages: {}, activeRequestIds: {}, recoveries: {} })
          else if (path === '/fixture-append') { extraLive = true; json({ok:true}) }
          else if (path === '/fixture-rollover') { rollover = true; json({ok:true}) }
          else if (path.endsWith('/api/chat/session')) json({revision:(rollover?'b':'a').repeat(64),data:{ history: rollover ? [{role:'user',name:'__compaction_summary__',content:'New actual compaction summary'}, {role:'assistant',content:'New live answer'}, ...(extraLive ? old('Latest live') : [])] : initial, previousPhysicalId:rollover?'closed-current':'old-one', currentPhysicalId:rollover?'live-new':'closed-current', systemPrompt:'Synthetic prompt', tools:[] }})
          else if (path.endsWith('/static/layout.html')) {
            response.setHeader('Content-Type', 'text/html')
            response.end(html)
          }
          else if (path.endsWith('/preview')) json({ content: html, size: Buffer.byteLength(html), sourcePath: 'layout.html', binary: false })
          else if (path.endsWith('/publication-requests')) json({ request: null, requests: [] })
          else if (path.endsWith('/probe-requests')) json({ requests: [] })
          else if (path.endsWith('/background-tasks')) json({ sessionId: 'web:chat-one', total: 0, tasks: [] })
          else if (path.endsWith('/api/chat/send')) {
            const chunks: Buffer[] = []
            for await (const chunk of request) chunks.push(Buffer.from(chunk))
            const body = JSON.parse(Buffer.concat(chunks).toString())
            json(rejectSend ? { error: 'synthetic send failure' } : { chatId: body.chatId, requestId: 'request-fixture' }, rejectSend ? 503 : 200)
          } else if (path.endsWith('/details')) {
            const sessionId = decodeURIComponent(path.split('/').at(-2)!)
            json({ sessionId, name: null, workdir: { kind: 'local', displayPath: '/synthetic' }, usage: null,
              usageScope: 'session', context: { usedTokens: null, windowTokens: null } })
          } else if (path.endsWith('/files')) json({ path: '', entries: [] })
          else if (path.endsWith('/api/projects')) json({ projects: [{ id: 'a', name: 'Project A', createdAt: '2026-01-01T00:00:00Z' }] })
          else if (path.endsWith('/api/config')) json({ agent: { model: 'synthetic', workspace: '/synthetic', temperature: 0.7 } })
          else if (path.endsWith('/git/status')) json({ available: false, reason: 'not_repository' })
          else if (path.endsWith('/v1/query/session-spans')) json({ sessionId: url.searchParams.get('sessionId'), physicalSessionId: 'segment', hasMore: false, entries: [] })
          else if (/\/api\/sessions\/[^/]+$/.test(path)) {
            const id = decodeURIComponent(path.split('/').at(-1)!)
            if (id === 'old-zero') await new Promise(resolve => setTimeout(resolve, 350))
            json({currentPhysicalId:id,previousPhysicalId:id==='old-one'?'old-zero':null,messages:id==='old-one'?[{role:'user',name:'__compaction_summary__',content:'Older actual summary'},...old('Old one')]:old('Old zero')})
          }
          else if (path.endsWith('/api/slash-commands')) json({ commands: [] })
          else if (path.startsWith('/projects/') && path.includes('/api/')) json({})
          else next()
        })
      },
    }],
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  t.after(() => server.close())
  const url = server.resolvedUrls?.local[0]
  assert.ok(url)
  await build({ stdin: { contents: smoke, resolveDir:root, sourcefile:'timeline-smoke.ts' },
    outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], logLevel: 'silent' })
  const env: NodeJS.ProcessEnv = { PERSISTENCE_URL: url }
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = directory
  const child = spawn(desktopRequire('electron') as string, [resolve(directory, 'main.cjs')], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let log = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { log += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { log += chunk })
  const timer = setTimeout(() => child.kill(), 75_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, log)
  assert.match(log, /TIMELINE_SMOKE_OK/)
})

const smoke = `
import assert from 'node:assert/strict';
import {join} from 'node:path';
import {setTimeout as delay} from 'node:timers/promises';
import {app, BrowserWindow} from 'electron';
app.setPath('userData', join(process.cwd(),'profile'));
app.on('window-all-closed',()=>{});
async function main(){
 await app.whenReady();
 const win=new BrowserWindow({show:false,width:1000,height:800,webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}});
 win.webContents.on('console-message',d=>console.log(d.level,d.message));
 const run=s=>win.webContents.executeJavaScript(s);
 const wait=async s=>{for(let i=0;i<350;i++){if(await run(s)) return;await delay(50)} throw Error('Timeout '+s+' '+await run('document.body.innerText'))};
 try {
 await win.loadURL(new URL('projects/a/chat/web:chat-one',process.env.PERSISTENCE_URL).href);
 await wait("document.body.innerText.includes('Current message 29') && !document.querySelector('.chat-history').getAttribute('aria-busy').includes('true')");
 await run("window.anchor=document.querySelectorAll('.chat-message-entry')[24]; window.anchorKey=anchor.dataset.timelineKey; const c=document.querySelector('.chat-messages'); c.scrollTop=60; window.anchorY=anchor.getBoundingClientRect().top; c.dispatchEvent(new Event('scroll'))");
 await wait("document.body.innerText.includes('Old one message 19') && document.querySelector('.chat-history').getAttribute('aria-busy')==='false'");
 assert.equal(await run("document.body.innerText.includes('Current message 29')"),true);
 assert.ok(Math.abs(await run("anchor.getBoundingClientRect().top-anchorY"))<2);
 assert.deepEqual(await run("[...document.querySelectorAll('[data-history-boundary]')].map(x=>x.dataset.historyBoundary)"),['old-zero','old-one']);
 // Search reasoning inside a collapsed current tool group after lazy prepend.
 await run("document.querySelector('textarea').dispatchEvent(new KeyboardEvent('keydown',{key:'f',ctrlKey:true,bubbles:true,cancelable:true}))");
 await wait("!!document.querySelector('.conversation-search input')");
 await run("const input=document.querySelector('.conversation-search input'); input.value='Unique-current-tool-search-result'; input.dispatchEvent(new Event('input',{bubbles:true}))");
 await wait("document.querySelector('.search-count')?.textContent==='1 / 1' && CSS.highlights.get('shadow-conversation-active')?.size>0");
 assert.equal(await run("document.querySelector('.tool-entry.reasoning-item')?.open"),true);
 assert.equal(await run("[...document.querySelectorAll('.tool-entry')].find(x=>x.textContent.includes('first tool'))?.open"),false);
 await run("document.querySelector('.conversation-search input').dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true,cancelable:true}))");
 await wait("!document.querySelector('.conversation-search')");
 await run("const scroller=document.querySelector('.chat-messages'); scroller.scrollTop=60; scroller.dispatchEvent(new Event('scroll'))");
 // Move during the pending prepend, and invalidate live history before it resolves.
 await run("document.querySelector('.chat-messages').scrollTop-=30; window.anchorY=anchor.getBoundingClientRect().top; fetch('/fixture-rollover').then(()=>window.__chatLive.event({requestId:'roll',payload:{event:'turn_finished',done:true,status:'completed',turnId:'roll'}}))");
 await wait("document.body.innerText.includes('New live answer') && document.body.innerText.includes('Old zero message 19')");
 assert.equal(await run("document.body.innerText.includes('Current message 29')"),true);
 assert.equal(await run("anchor.dataset.timelineKey===anchorKey && anchor.isConnected"),true);
 assert.ok(Math.abs(await run("anchor.getBoundingClientRect().top-anchorY"))<2);
 assert.deepEqual(await run("[...document.querySelectorAll('[data-history-boundary]')].map(x=>x.dataset.historyBoundary)"),['old-zero','old-one','closed-current']);
 assert.equal(await run("document.querySelectorAll('.compaction-summary').length"),2);
 assert.deepEqual(await run("[...document.querySelectorAll('.compaction-summary-title')].map(x=>x.textContent)"),['Previous Conversation Summary','Previous Conversation Summary']);
 assert.equal(await run("document.querySelector('[data-event-id=handoff-fixture] strong')?.textContent"),'Recorded handoff transition');
 assert.equal(await run("!!document.querySelector('.timeline-latest')"),true);
 assert.equal(await run("document.querySelector('textarea').readOnly || document.querySelector('textarea').disabled"),false);
 await run("document.querySelector('.timeline-latest').click()");
 await wait("!document.querySelector('.timeline-latest')");
 assert.ok(await run("(()=>{const c=document.querySelector('.chat-messages');return c.scrollHeight-c.scrollTop-c.clientHeight<2})()"));
 await run("fetch('/fixture-append').then(()=>window.__chatLive.event({requestId:'append',payload:{event:'turn_finished',done:true,status:'completed',turnId:'append'}}))");
 await wait("document.body.innerText.includes('Latest live message 19')");
 await delay(80);
 assert.ok(await run("(()=>{const c=document.querySelector('.chat-messages');return c.scrollHeight-c.scrollTop-c.clientHeight<2})()"));
 assert.equal(await run("document.querySelectorAll('[data-history-boundary]').length"),3);
 // Targeted navigation remains read-only and does not keep unrelated timeline prefixes.
 await run("document.querySelector('[data-history-boundary] summary').click();document.querySelector('[data-history-boundary] button').click()");
 await wait("document.body.innerText.includes('Viewing previous session')");
 assert.equal(await run("document.body.innerText.includes('New live answer')"),false);
 console.log('TIMELINE_SMOKE_OK');
 }finally{win.destroy()}
}
main().then(()=>app.exit(0),e=>{console.error(e);app.exit(1)});
`;
