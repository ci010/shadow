import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
const root = fileURLToPath(new URL('../..', import.meta.url))
const require = createRequire(new URL('../../desktop/package.json', import.meta.url))
test('shared Knowledge pane follows focused groups, opens real leaf tabs and retains file views', { timeout: 90000, skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY }, async t => {
  const directory = resolve(root, '.test-artifacts', `knowledge-explorer-${randomUUID()}`)
  await mkdir(directory, { recursive: true }); t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const requests: string[] = []
  const historyId = 'memory/sessions/cron_legacy.files.jsonl'
  const entry = (project: string) => ({ id: 'memory/topics/guide.md', path: 'memory/topics/guide.md', title: project + ' guide', kind: 'wiki', source: 'project', revision: 'r1', deletable: true })
  const server = await createServer({ configFile: false, envDir: false, root: resolve(root, 'app'), cacheDir: resolve(directory, 'cache'), logLevel: 'error', optimizeDeps: { noDiscovery: true, include: ['vue', 'vue-router', 'pinia', 'vue-i18n'] }, plugins: [vue(), {
    name: 'knowledge-fixture', resolveId: id => id === '/fixture.ts' ? '\0fixture' : undefined,
    load(id) { if (id !== '\0fixture') return; return `
      import {createResourceApp} from '/src/stores/app.ts';import {h,provide,ref,nextTick} from 'vue';
      import {createRouter,createMemoryHistory} from 'vue-router';import {provideMobileChrome} from '/src/composables/useMobileChrome.ts';
      import Host from '/src/components/EditorGroupHost.vue';import Workbench from '/src/components/files/FileWorkbench.vue';
      import {createEditorGroups,EditorGroupsKey} from '/src/editor-groups.ts';import {setLocalePreference} from '/src/i18n.ts';import '/src/styles.css';setLocalePreference('en');
      const router=createRouter({history:createMemoryHistory(),routes:[{path:'/projects/:projectId',name:'chat',component:{render:()=>null}}]});await router.push('/projects/p');
      const groups=createEditorGroups(), project=ref('p'), request=ref();window.fixture={groups,project,request};
      createResourceApp({setup(){provideMobileChrome();provide(EditorGroupsKey,groups);return()=>h('div',{style:'display:flex;height:100vh'},['p','q'].map(p=>h('section',{key:p,style:'display:'+ (project.value===p?'flex':'none')+';flex:1;min-width:0'},[
        h(Host,{projectId:p,apiBase:location.origin+'/projects/'+p,active:project.value===p}),
        h(Workbench,{projectId:p,apiBase:location.origin+'/projects/'+p,sessionId:'web:'+p,folderId:p+'-folder',contextKey:p,active:project.value===p,knowledgeEnabled:true,knowledgeRequest:project.value===p?request.value:undefined,conversationTitle:p+' chat'},()=>h('textarea',{class:'draft'},'untouched draft'))
      ])))} }).use(router).mount('#app');
    ` },
    configureServer(server) { server.middlewares.use((req, res, next) => {
      const url = new URL(req.url!, 'http://fixture')
      if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<div id="app"></div><script>window.addEventListener("error",e=>console.error(e.message));window.addEventListener("unhandledrejection",e=>console.error(String(e.reason)))</script><script type="module" src="/fixture.ts"></script>'); return }
      if (!url.pathname.includes('/api/')) return next()
      requests.push(url.pathname + url.search); res.setHeader('Content-Type', 'application/json')
      const project = url.pathname.split('/')[2]!
      if (url.pathname.endsWith('/knowledge')) res.end(JSON.stringify({ entries: [entry(project), { ...entry(project), id: historyId, path: historyId, title: 'cron_legacy.files.jsonl', kind: 'memory' }], links: [{ source: entry(project).id, target: 'outside', label: 'external reference' }, { source: entry(project).id, target: historyId, label: 'legacy ledger' }] }))
      else if (url.pathname.endsWith('/knowledge/entry')) res.end(JSON.stringify({ entry: entry(project), content: '# Synthetic ' + project }))
      else if (url.pathname.endsWith('/folders')) res.end(JSON.stringify({ folders: [{ id: project + '-folder', name: project + ' files', path: '/synthetic/' + project, createdAt: '2026-01-01' }] }))
      else if (url.pathname.endsWith('/picker/devices')) res.end(JSON.stringify({ devices: [] }))
      else if (url.pathname.endsWith('/files')) res.end(JSON.stringify({ path: '', entries: [{ name: 'same.md', type: 'file', ext: '.md', size: 12, mtime: null }] }))
      else if (url.pathname.endsWith('/preview')) res.end(JSON.stringify({ binary: false, size: 12, content: '# Synthetic file' }))
      else if (url.pathname.endsWith('/git/status')) res.end(JSON.stringify({ available: true, entries: [] }))
      else { res.statusCode = 404; res.end('{}') }
    }) },
  }], server: { host: '127.0.0.1', port: 0 } })
  await server.listen(); t.after(() => { server.httpServer?.closeAllConnections(); return server.close() })
  const script = `const assert=require('node:assert/strict');const {app,BrowserWindow}=require('electron');const {setTimeout:delay}=require('node:timers/promises');app.setPath('userData',require('node:path').join(process.cwd(),'profile'));app.on('window-all-closed',()=>{});(async()=>{await app.whenReady();const win=new BrowserWindow({show:false,width:1300,height:800,webPreferences:{backgroundThrottling:false}});win.webContents.on('console-message',event=>console.log(event.message));const run=s=>win.webContents.executeJavaScript(s);const wait=async s=>{for(let i=0;i<600;i++){if(await run('Boolean('+s+')'))return;await delay(50)}throw Error('Timeout '+s+' '+await run('document.body.innerText'))};await win.loadURL(${JSON.stringify(server.resolvedUrls!.local[0])});
    await wait('window.fixture?.groups.active("p")');
    const toggle = '[...document.querySelectorAll(".project-explorer-toggle")].find(button=>button.getBoundingClientRect().width)';
    const filesVisible = '[...document.querySelectorAll(".project-file-explorer")].some(pane=>pane.getBoundingClientRect().width>0)';
    const selectProject = async project => {
      await run('window.fixture.project.value='+JSON.stringify(project)+';void 0');
      await wait('window.fixture.groups.active('+JSON.stringify(project)+')?.conversation && '+toggle);
    };
    await run(toggle+'.click()');
    await wait(filesVisible);
    await selectProject('q');
    assert.equal(await run(filesVisible),true,'an open file pane stays open when switching Projects');
    await run(toggle+'.click()');
    await wait('!('+filesVisible+')');
    await selectProject('p');
    assert.equal(await run(filesVisible),false,'switching back does not restore a stale open file pane');
    await run(toggle+'.click()');
    await wait('document.querySelector(".root-toggle")');
    await run('document.querySelector(".root-toggle").click()');
    await wait('document.querySelector(".tree-row[data-path]")');
    await run('document.querySelector(".tree-row[data-path]").click()');
    await wait('document.querySelector(".file-markdown")');
    await run('window.fileNode=document.querySelector(".file-markdown");window.fileId=window.fixture.groups.active("p").id;'+toggle+'.click();window.fixture.request.value={};void 0');
    await wait('window.fixture.groups.active("p")?.explorer');
    assert.equal(await run('!!document.querySelector(".knowledge-explorer-pane")'),false,'entering Knowledge keeps the closed pane closed');
    await run(toggle+'.click()');
    const tree = 'document.querySelector(".knowledge-explorer-pane nav")';
    const branch = pane => pane+'.querySelectorAll("button[aria-expanded]")';
    const leaf = pane => pane+'.querySelector("button.tree-select:not([aria-expanded])")';
    const expandWiki = async pane => {
      await run(branch(pane)+'[0].click()');
      await run(branch(pane)+'[1].click()');
    };
    await wait(tree+'?.querySelector("button.tree-select:not([aria-expanded])")');
    assert.equal(await run('document.querySelector(".project-file-explorer").getBoundingClientRect().width'),0);
    assert.equal(await run('document.querySelector(".knowledge-explorer-pane").closest(".editor-group-content")===null'),true);
    assert.equal(await run('document.querySelector(".knowledge-document .knowledge-navigation")===null'),true);
    assert.equal(await run('document.querySelector(".knowledge-explorer-pane").textContent.includes("outside")'),false);
    await expandWiki(tree);
    await run('window.homeId=window.fixture.groups.active("p").id;'+leaf(tree)+'.click()');
    await wait('window.fixture.groups.active("p")?.explorer?.entryId');
    await wait('document.querySelector(".knowledge-preview")?.textContent.includes("Synthetic p")');
    await run('window.leafId=window.fixture.groups.active("p").id;window.fixture.groups.move(window.leafId,"right");'+toggle+'.click();window.fixture.groups.activate(window.fileId);void 0');
    await wait('!document.querySelector(".knowledge-explorer-pane")');
    assert.equal(await run('window.fileNode===document.querySelector(".file-markdown")'),true,'same file DOM survives knowledge');
    assert.equal(await run(filesVisible),false,'leaving Knowledge does not reopen the file pane');
    await run(toggle+'.click()');
    await wait(filesVisible);
    await run('window.fixture.groups.focus("p","right");void 0');
    await wait('document.querySelector(".knowledge-explorer-pane")');
    assert.equal(await run('document.querySelector(".project-explorer-toggle").getAttribute("aria-label")'),'Toggle Knowledge navigation');
    assert.equal(await run(tree+'.querySelectorAll("button[aria-expanded=true]").length'),0,'all branches start collapsed');
    assert.equal(await run(tree+'.querySelectorAll(".tree-select .tree-icon .i-lucide-library").length'),1);
    await run('window.search=document.querySelector(".knowledge-explorer-pane input");search.value="p guide";search.dispatchEvent(new Event("input"));void 0');
    await wait(tree+'.querySelector("button .i-material-icon-theme-markdown")?.getClientRects().length && '+tree+'.querySelectorAll("button[aria-expanded=true]").length === 2');
    await run('search.value="";search.dispatchEvent(new Event("input"));void 0');
    await wait('!'+tree+'.querySelector("button[aria-expanded=true]")');
    await expandWiki(tree);
    assert.equal(await run(branch(tree)+'[1].querySelector(".i-material-icon-theme-folder-base-open") !== null'),true,'expanded folder uses the file tree icon');
    assert.equal(await run(leaf(tree)+'.getBoundingClientRect().width > 0'),true,'expanded folder reveals its document row');
    await run(leaf(tree)+'.click()');await delay(100);
    assert.equal(await run('[...window.fixture.groups.descriptors.values()].filter(d=>d.projectId==="p"&&d.explorer?.entryId).length'),1,'leaf tab reused');
    await run('window.fixture.project.value="q";window.fixture.request.value={};void 0');
    await wait('[...document.querySelectorAll(".knowledge-explorer-pane")].some(p=>p.textContent.includes("q guide"))');
    assert.equal(await run('[...document.querySelectorAll(".knowledge-explorer-pane")].filter(p=>p.getBoundingClientRect().width).every(p=>!p.textContent.includes("p guide"))'),true,'catalog project isolated');
    await run('window.fixture.project.value="p";window.fixture.groups.activate(window.leafId);void 0');
    await wait('document.querySelector(".knowledge-explorer-pane")?.textContent.includes("p guide")');
    await run('document.querySelector(".project-explorer-toggle").focus()');await win.webContents.sendInputEvent({type:'keyDown',keyCode:'E',modifiers:['control','shift']});await win.webContents.sendInputEvent({type:'keyUp',keyCode:'E',modifiers:['control','shift']});
    await wait('!document.querySelector(".knowledge-explorer-pane")');
    await run('document.querySelector(".project-explorer-toggle").click()');await wait(tree+'?.querySelector("button.tree-select:not([aria-expanded])")');
    assert.equal(await run(tree+'.querySelectorAll("button[aria-expanded=true]").length'),0,'reopened explorer starts collapsed');
    await expandWiki(tree);
    await run(leaf(tree)+'.focus()');await win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});await win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await delay(100);
    assert.equal(await run('document.activeElement.classList.contains("project-explorer-toggle")'),true);
    assert.equal(await run('window.fileNode===document.querySelector(".file-markdown")'),true);
    win.setSize(500,800);await delay(150);await run('window.fixture.groups.setExplorerOpen("p",true);void 0');
    const mobileTree = 'document.querySelector(".mobile-explorer-target .knowledge-explorer-pane nav")';
    await wait(mobileTree+'?.querySelector("button.tree-select:not([aria-expanded])")');
    await expandWiki(mobileTree);
    assert.equal(await run('document.querySelector(".mobile-explorer-target .knowledge-explorer-pane").getBoundingClientRect().width<=500'),true);
    await run(leaf(mobileTree)+'.click()');
    await wait('!window.fixture.groups.explorerOpen("p")');
    assert.equal(await run('window.fileNode===document.querySelector(".file-markdown")'),true,'mobile teleport retains file view');
    await run('window.fixture.request.value={entryId:"memory/sessions/cron_legacy.files.jsonl"};void 0');
    await wait('[...document.querySelectorAll(".knowledge-document")].some(el=>el.textContent.includes("Not a knowledge document."))');
    assert.equal(await run('[...document.querySelectorAll(".knowledge-document")].filter(el=>el.textContent.includes("Not a knowledge document.")).every(el=>!el.querySelector(".source")&&!el.textContent.includes("cron_legacy.files.jsonl"))'),true);
    await run('window.fixture.groups.setExplorerOpen("p",true);void 0');
    await wait('document.querySelector(".knowledge-explorer-pane")');
    assert.equal(await run('document.querySelector(".knowledge-explorer-pane").textContent.includes("cron_legacy")'),false);
    win.close();console.log('KNOWLEDGE_EXPLORER_OK');app.quit();})().catch(e=>{console.error(e);app.exit(1)});`
  const main = resolve(directory, 'main.cjs'); await writeFile(main, script)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron') as string, [main], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
  const timer = setTimeout(() => child.kill(), 75000); t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close'); assert.equal(code, 0, output); assert.match(output, /KNOWLEDGE_EXPLORER_OK/)
  assert(!requests.some(url => url.includes('/knowledge/entry') && decodeURIComponent(url).includes(historyId)), 'old history tabs never fetch the ledger body')
  assert(requests.includes('/projects/p/api/knowledge')); assert(requests.includes('/projects/q/api/knowledge'))
})
