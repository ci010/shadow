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
import { Hono } from 'hono'
import { Bus } from '../../src/bus/bus.ts'
import { WebChannel } from '../../src/channels/web.ts'
import { workflowReferenceResolver } from '../../src/workflows/references.ts'
import type { WorkflowRuntime } from '../../src/workflows/runtime.ts'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

test('real ChatTab drag/drop preserves draft history identity and sends once', {
  timeout: 120_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `conversation-drag-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const requests: { path: string; method: string }[] = []
  const sentBodies: Record<string, unknown>[] = []
  const frozenHistory: string[] = []
  const fixtureDefinition = { id: 'schedule:a', name: 'Workflow a', revision: 1, enabled: true, source: { kind: 'schedule', id: 'a' }, nodes: [{ kind: 'schedule-action', action: 'session', job: { schedule: 'every 1h', session: 'fresh', task: 'Reminder a' } }] }
  const referenceState = { projectId: 'a', definitions: [fixtureDefinition], runs: [{ id: 'run:a', workflow: 'schedule:a', definition: structuredClone(fixtureDefinition), status: 'completed', cursor: 1 }] }
  const bus = new Bus()
  const channel = new WebChannel(bus, { authorize: () => true, resolveInputReferences: workflowReferenceResolver('a', { inspect: () => referenceState as ReturnType<WorkflowRuntime['inspect']> }) })
  channel.setReceiver(async message => {
    frozenHistory.push(message.content)
    bus.emit('message.outbound', { event: 'response', channel: 'web', chatId: message.chatId, replyTo: message.messageId, done: true, content: 'ok' })
    return { status: 'accepted', sessionId: `web:${message.chatId}`, inputId: message.messageId }
  })
  const admission = new Hono(); await channel.start(admission); t.after(() => channel.stop())
  const projects = ['a', 'b'].map(id => ({ id, name: `Project ${id.toUpperCase()}`, createdAt: '2026-01-01' }))
  const server = await createServer({ configFile: false, envDir: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'cache'), optimizeDeps: { noDiscovery: true, include: ['vue', 'vue-router', '@vue-flow/core'] }, plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app/unocss.config.ts') }), {
    name: 'secondary-editor-fixture',
    resolveId: id => id === '/fixture.ts' ? '\0secondary-editor-fixture' : undefined,
    load(id) {
      if (id !== '\0secondary-editor-fixture') return
      return `import {createApp,h} from 'vue'; import {createRouter,createMemoryHistory} from 'vue-router'; import Workspace from '/src/components/ProjectsWorkspace.vue'; import {setLocalePreference} from '/src/i18n.ts'; import '/src/styles.css'; import 'virtual:uno.css'; setLocalePreference('en'); document.documentElement.classList.add('dark');
        const router=createRouter({history:createMemoryHistory(),routes:[{path:'/projects/:projectId/dashboard',name:'project-dashboard',component:{render:()=>null}},{path:'/projects/:projectId/chat/:sessionId?',name:'chat',component:{render:()=>null}},{path:'/projects/:projectId/workflows',name:'project-workflows',component:{render:()=>null}},{path:'/projects/:projectId/settings/:section?',name:'project-settings',component:{render:()=>null}},{path:'/projects/:projectId/agents',name:'agents',component:{render:()=>null}},{path:'/settings/:section?',name:'settings',component:{render:()=>null}}]});
        window.fixture={router,chatObservers:[]};
        const nativeFetch=window.fetch;window.fetch=async(...args)=>{const response=await nativeFetch(...args);if(String(args[0]).includes('/api/chat/send'))window.fixture.lastAdmission=await response.clone().json();return response};
        const app=createApp({render:()=>h(Workspace,{apiBase:location.origin,visible:true})});app.provide(Symbol.for('shadow.live-client-pool'),{onDispose:()=>()=>{},observeHost:(_base,callback)=>{callback({phase:'live'});return()=>{}},client:()=>({subscribe:(topic,observer)=>{if(topic.kind==='chat')window.fixture.chatObservers.push(observer);return {close(){},ready:async()=>{}}}})});app.use(router);router.push(new URLSearchParams(location.search).get('fixtureRoute') || {name:'project-workflows',params:{projectId:'a'},query:{workflow:'schedule:a',run:'run:a'}});router.isReady().then(()=>app.mount('#app'));`
    },
    configureServer(server) { server.middlewares.use((req, res, next) => {
      const path = new URL(req.url!, 'http://127.0.0.1').pathname
      const json = (body: unknown) => { res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify(path.endsWith('/api/workflows') ? { version: 1, kind: 'full', cursor: 'fixture-v1', snapshot: body } : body)) }
      if (path === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<!doctype html><html><body><div id="app"></div><script type="module" src="/fixture.ts"></script></body></html>'); return }
      if (!/^\/(?:projects\/[^/]+\/)?(?:api|debug)\//.test(path)) { next(); return }
      requests.push({ path, method: req.method! })
      const projectId = path.split('/')[2]
      if (path === '/api/projects') { json({ projects }); return }
      if (path.endsWith('/api/chat/session')) {
        const revision = (frozenHistory.length ? 'b' : 'a').repeat(64)
        json({ revision, historyRevision: revision, metadataVersions: Object.fromEntries(['systemPrompt', 'tools', 'commandResults', 'decisionRecords'].map(field => [field, 'c'.repeat(64)])),
          data: { chatId: new URL(req.url!, 'http://fixture').searchParams.get('chatId'), currentPhysicalId: 'physical-ordinary', previousPhysicalId: null, segmentIndex: 0,
            history: [{ role: 'assistant', content: 'Ordinary conversation retained\n\n' + 'Retained history scroll fixture.\n\n'.repeat(70) }, ...frozenHistory.map(content => ({ role: 'user', content }))], systemPrompt: 'Fixture system prompt', tools: [], commandResults: [], decisionRecords: [] } }); return
      }
      if (path.endsWith('/api/chat/send')) {
        let body = ''
        req.on('data', chunk => { body += chunk })
        req.on('end', () => { void (async () => {
          sentBodies.push(JSON.parse(body))
          const response = await admission.request('/api/chat/send', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body })
          // Later catalog changes cannot rewrite already admitted user history.
          referenceState.definitions[0] = { ...fixtureDefinition, revision: 2, name: 'Changed after admission' }
          res.statusCode = response.status
          json(await response.json())
        })().catch(error => { res.statusCode = 500; json({ error: String(error) }) }) })
        return
      }
      if (path.endsWith('/api/workflows')) {
        const definition = { id: `schedule:${projectId}`, name: `Workflow ${projectId}`, revision: 1, enabled: true, source: { kind: 'schedule', id: projectId }, nodes: [{ kind: 'schedule-action', action: 'session', job: { schedule: 'every 1h', session: 'fresh', task: `Reminder ${projectId}` } }] }
        json({ projectId, bots: { connections: [{ id: 'isolated-one', displayName: 'First isolated', platform: 'qq', purpose: 'service', enabled: false, health: 'disabled' }, { id: 'isolated-two', displayName: 'Second isolated', platform: 'qq', purpose: 'service', enabled: false, health: 'disabled' }, { id: 'qq-shared', displayName: 'Shared QQ', platform: 'qq', purpose: 'service', enabled: true, health: 'disconnected' }], deployments: [{ id: 'isolated-two', state: 'valid', mode: 'service' }, { id: 'sales', state: 'valid', mode: 'service', agent: 'BOT:sales' }, { id: 'support', state: 'valid', mode: 'service', agent: 'BOT:support' }], bindings: [{ id: 'one', deploymentId: 'sales', connectionId: 'qq-shared', platform: 'qq', topic: 'group:one', enabled: true, subscribed: true, listener: true, kind: 'message', sessionIds: [] }, { id: 'two', deploymentId: 'support', connectionId: 'qq-shared', platform: 'qq', topic: 'group:two', enabled: false, subscribed: true, listener: false, kind: 'message', sessionIds: ['web:chat-ordinary'] }], warnings: [], routing: 'not-probed', processingSuccess: 'unknown' }, definitions: [definition], runs: [{ id: `run:${projectId}`, workflow: definition.id, definition, timestamp: '2026-11-12T10:00:00Z', status: 'completed', cursor: 1, attempts: 1, nextAt: 0, started: true, output: { sessionId: 'web:chat-ordinary' } }] }); return
      }
      if (path.endsWith('/api/channels')) { json({ channels: (projectId === 'a' ? ['isolated-one', 'isolated-two'] : ['other']).map(id => ({ id, projectId, displayName: id, platform: 'qq', label: 'QQ', purpose: 'service', enabled: false, configured: true, state: 'disabled', config: { appId: 'fixture' }, secrets: { secret: true } })) }); return }
      if (path.endsWith('/api/automations')) { json({ automations: [{ id: 'system:session-cleanup', name: 'Session cleanup', source: 'system', session: 'fresh', enabled: true, schedule: 'every 1h', workflow: { id: `schedule:${projectId}`, pending: 0, blocked: 0 } }] }); return }
      if (path.endsWith('/runs')) { json({ runs: [{ id: 'cleanup-run', sessionId: 'web:chat-ordinary', startedAt: '2026-11-12T10:00:00Z', status: 'completed' }], total: 1, offset: 0 }); return }
      if (/\/status$/.test(path)) { json({ state: 'ready' }); return }
      if (path.endsWith('/api/work')) { json({ items: [], sessions: [], requests: [], effects: [] }); return }
      if (path.endsWith('/api/config')) { json({ agent: { model: 'fixture', workspace: '/synthetic/home', temperature: 0.5 } }); return }
      if (path.endsWith('/api/models')) { json({ models: ['fixture'], providers: [] }); return }
      if (path.endsWith('/api/service-groups')) { json({ revision: 'r1', agents: [], groups: [] }); return }
      if (path.endsWith('/preview')) { json({ binary: false, size: 31, content: '# Shared file editor fixture\n', sourcePath: 'note.md' }); return }
      if (path.endsWith('/api/knowledge')) { json({ entries: [], links: [] }); return }
      if (path.endsWith('/api/folders')) { json({ folders: [] }); return }
      if (/\/api\/sessions\/web%3Aordinary$/.test(path)) { json({ messages: [{ role: 'user', content: 'Ordinary conversation retained' }] }); return }
      json({ projects, sessions: [], nodes: [], activity: {}, jobs: [], requests: [], messages: [], tools: [], providers: [] })
    }) },
  }], server: { host: '127.0.0.1', port: 0 } })
  await server.listen(); t.after(() => { server.httpServer?.closeAllConnections(); return server.close() })
  const url = server.resolvedUrls?.local[0]; assert(url)
  const script = `const assert=require('node:assert/strict');const {app,BrowserWindow}=require('electron');const {setTimeout:delay}=require('node:timers/promises');app.setPath('userData',require('node:path').join(process.cwd(),'profile'));app.on('window-all-closed',()=>{});
    (async()=>{await app.whenReady();const win=new BrowserWindow({show:false,width:1600,height:950,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});win.webContents.on('console-message',d=>console.error('Renderer:',d.message));const run=async s=>{try{return await win.webContents.executeJavaScript(s)}catch(e){throw new Error(s+' '+e)}};const wait=async s=>{for(let i=0;i<240;i++){if(await run('Boolean('+s+')'))return;await delay(50)}throw new Error('Timeout '+s+' '+await run('document.body.innerText'))};
    const visible=s=>'[...document.querySelectorAll('+JSON.stringify(s)+')].find(e=>e.getBoundingClientRect().width&&e.getBoundingClientRect().height)';
    const route=()=>run('JSON.parse(JSON.stringify(window.fixture.router.currentRoute.value))');
    const primary=async()=>{const s=visible('.conversation-tab button');await wait(s);await run(s+'.click()')};
    const tab=label=>'[...document.querySelectorAll(".document-tab button[role=tab]")].find(e=>e.textContent.trim()==='+JSON.stringify(label)+' && e.getBoundingClientRect().width)';
    const clickTab=async label=>{await wait(tab(label));await run(tab(label)+'.click()')};
    const open=async(project,query={})=>{await run('window.fixture.router.push('+JSON.stringify({name:'project-workflows',params:{projectId:project},query})+')');await wait(visible('.workflow-manager'));await wait(visible('.graph-group'))};
    const sidebar=async project=>{const s='document.querySelector('+JSON.stringify('[data-project-id="'+project+'"] .automation-entry')+')';await wait(s);await run(s+'.click()');await wait('window.fixture.router.currentRoute.value.name==="project-workflows" && window.fixture.router.currentRoute.value.params.projectId==='+JSON.stringify(project));await wait(visible('.workflow-manager'));await wait(visible('.graph-group'))};
    await win.loadURL(${JSON.stringify(url)});
    await wait(visible('.workflow-inspector'));
    await run('window.fixture.router.push({name:"chat",params:{projectId:"a",sessionId:"web:chat-ordinary"}})');
    await wait(visible('.reference-composer'));
    const ordinary='[...document.querySelectorAll(".editor-tab [role=tab]")].find(e=>e.id.includes("chat-ordinary")&&e.textContent.includes("Conversation"))';
    await wait(ordinary);
    await run('window.fixture.chatInput=('+visible('.reference-composer')+');window.fixture.chatInput.textContent="Right unsent draft";window.fixture.chatInput.dispatchEvent(new Event("input",{bubbles:true}))');
    await wait('('+visible('.editor-group-content .chat-messages')+').textContent.includes("Retained history scroll fixture")');await delay(250);
    await run('window.fixture.historyNode=('+visible('.editor-group-content .chat-messages')+');window.fixture.historyNode.scrollTop=120');
    assert.equal(await run('window.fixture.historyNode.scrollTop'),120);
    const drop=async(selector,side)=>{
      const before=await run('(()=>{const r=('+selector+').getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()');
      await run('window.fixture.transfer=new DataTransfer();('+selector+').dispatchEvent(new DragEvent("dragstart",{bubbles:true,dataTransfer:window.fixture.transfer}))');
      await wait('document.querySelectorAll(".drag-target").length===2');
      assert.deepEqual(await run('(()=>{const r=('+selector+').getBoundingClientRect();return [r.x,r.y,r.width,r.height]})()'),before,'Starting drag must not move or resize its source');
      await run('window.dispatchEvent(new Event("blur"))');
      assert.equal(await run('document.querySelectorAll(".drag-target").length'),2,'OS blur is not drag termination');
      const target='document.querySelector("[data-editor-header-group='+side+'] .editor-tabs")';
      await run('(()=>{const r=('+target+').getBoundingClientRect();const e=document.elementFromPoint(r.left+r.width/2,r.top+r.height/2);if(!e)throw Error("No rendered drop target");e.dispatchEvent(new DragEvent("dragover",{bubbles:true,cancelable:true,dataTransfer:window.fixture.transfer}));e.dispatchEvent(new DragEvent("drop",{bubbles:true,cancelable:true,dataTransfer:window.fixture.transfer}))})()');
      await wait('('+selector+').closest("[data-editor-header-group]").dataset.editorHeaderGroup==='+JSON.stringify(side));
    };
    const assertChat=async side=>{
      await wait(visible('[data-editor-group="'+side+'"] .reference-composer'));
      assert.equal(await run('document.querySelector("[data-editor-group='+side+'] .editor-view[data-editor-id*=chat-ordinary] .reference-composer")===window.fixture.chatInput'),true);
      assert.equal(await run('document.querySelectorAll(".editor-view[data-editor-id*=chat-ordinary] .reference-composer").length'),1);
      assert.equal(await run('document.querySelector("[data-editor-group='+side+'] .editor-view[data-editor-id*=chat-ordinary] .chat-messages")===window.fixture.historyNode'),true);
      assert.equal(await run('window.fixture.chatInput.textContent'),'Right unsent draft');
      assert.equal(await run('window.fixture.historyNode.scrollTop'),120);
      assert.equal(await run('window.fixture.historyNode.textContent.includes("Retained history scroll fixture")'),true);
    };
    await drop(ordinary,'right');await assertChat('right');
    await drop(ordinary,'left');await assertChat('left');
    await run('window.fixture.router.push({name:"project-settings",params:{projectId:"a",section:"general"}})');
    const settings='[...document.querySelectorAll(".editor-tab [role=tab]")].find(e=>e.textContent.trim()==="Project settings")';
    await wait(settings);await wait('document.querySelector(".project-settings-view input")?.value==="Project A"');
    await run('window.fixture.settingsInput=document.querySelector(".project-settings-view input");window.fixture.settingsInput.value="Unsaved name";window.fixture.settingsInput.dispatchEvent(new Event("input",{bubbles:true}))');
    await drop(settings,'right');
    assert.equal(await run('document.querySelector("[data-editor-group=right] .project-settings-view input")===window.fixture.settingsInput'),true);
    await drop(settings,'left');
    assert.equal(await run('document.querySelector("[data-editor-group=left] .project-settings-view input")===window.fixture.settingsInput'),true);
    assert.equal(await run('window.fixture.settingsInput.value'),'Unsaved name');
    await run('('+ordinary+').click()');await assertChat('left');
    await wait('!document.querySelector('+JSON.stringify('[data-editor-group=left] .editor-view[data-editor-id*=chat-ordinary] [aria-label="Send message"]')+').disabled');
    await run('document.querySelector('+JSON.stringify('[data-editor-group=left] .editor-view[data-editor-id*=chat-ordinary] [aria-label="Send message"]')+').click()');
    await wait('window.fixture.chatInput.textContent===""');await wait('!!window.fixture.lastAdmission');await delay(500);
    if(process.env.EDITOR_GROUP_SCREENSHOT) require('node:fs').writeFileSync(process.env.EDITOR_GROUP_SCREENSHOT,(await win.webContents.capturePage()).toPNG());
    await win.close();console.log('WORKFLOW_WORKBENCH_OK');app.quit();})().catch(error=>{console.error(error);app.exit(1)});`
  const entry = resolve(directory, 'main.cjs')
  await build({ stdin: { contents: script, resolveDir: directory, sourcefile: 'fixture-run.cjs' }, outfile: entry, bundle: true, platform: 'node', format: 'cjs', external: ['electron'] })
  const child = spawn(desktopRequire('electron') as string, [entry], { cwd: directory, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
  const timer = setTimeout(() => child.kill(), 80_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close'); if (code !== 0) console.error(output); assert.equal(code, 0, output); assert.match(output, /WORKFLOW_WORKBENCH_OK/)
  assert.deepEqual(requests.filter(request => request.method !== 'GET'), [{ path: '/projects/a/api/chat/send', method: 'POST' }], 'Only the explicit send submits; editor movement never forks, prepares or submits')
  assert.equal(sentBodies.length, 1, 'Moving and restoring the same composer produces exactly one explicit send')
  assert.equal(sentBodies[0]!.content, 'Right unsent draft')
  assert.equal(frozenHistory.length, 1)
})
