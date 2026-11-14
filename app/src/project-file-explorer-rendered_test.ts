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
import UnoCSS from 'unocss/vite'
const root = fileURLToPath(new URL('../..', import.meta.url))
const require = createRequire(new URL('../../desktop/package.json', import.meta.url))
test('Project explorer roots stay left, expand independently and preserve session/folder source', { timeout: 90000, skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY }, async t => {
  const directory = resolve(root, '.test-artifacts', `project-explorer-${randomUUID()}`)
  await mkdir(directory, { recursive: true }); t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const requests: string[] = []
  const server = await createServer({ configFile: false, envDir: false, root: resolve(root, 'app'), cacheDir: resolve(directory, 'cache'), logLevel: 'error', optimizeDeps: { noDiscovery: true, include: ['vue'] }, plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app/unocss.config.ts') }), {
    name: 'explorer-fixture', resolveId: id => id === '/fixture.ts' ? '\0fixture' : undefined,
    load(id) { if (id !== '\0fixture') return; return `import {createApp,h,provide} from 'vue';import Host from '/src/components/EditorGroupHost.vue';import View from '/src/components/EditorViewHost.vue';import {createEditorGroups,EditorGroupsKey} from '/src/editor-groups.ts';import {setLocalePreference} from '/src/i18n.ts';import '/src/styles.css';import 'virtual:uno.css';setLocalePreference('en');
      const groups=createEditorGroups();window.groups=groups;
      const descriptors=['A','B'].map(label=>({id:label,projectId:'p',owner:label,label,icon:'i-lucide-message-square',closable:true,conversation:{sessionId:'web:'+label,editable:true,folderId:label==='A'?'one':'two'},select(){},close(){}}));
      createApp({setup(){provide(EditorGroupsKey,groups);return()=>h('div',{style:'display:flex;height:100vh'},[h(Host,{projectId:'p',apiBase:location.origin+'/projects/p',active:true}),...descriptors.map(descriptor=>h(View,{descriptor},()=>h('div',{class:'chat-fixture'},[h('button',{class:'chat-right-action',style:'float:right'},'Chat action')])))]);}}).mount('#app');` },
    configureServer(server) { server.middlewares.use((req, res, next) => {
      const url = new URL(req.url!, 'http://fixture')
      if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<html><body style="margin:0"><div id="app"></div><script type="module" src="/fixture.ts"></script></body></html>'); return }
      if (!url.pathname.startsWith('/projects/p/api/')) return next()
      requests.push(url.pathname + url.search); res.setHeader('Content-Type', 'application/json')
      if (url.pathname.endsWith('/folders')) res.end(JSON.stringify({ folders: [{ id: 'unrelated', name: 'Unrelated project root', path: '/synthetic/unrelated', createdAt: '2026-01-01' }, { id: 'one', name: 'shadow with a very long folder name that must never wrap', path: '/synthetic/shadow', createdAt: '2026-01-01' }, ...['two', 'two-alias'].map(id => ({ id, name: 'shadow with a very long folder name that must never wrap', path: 'C:\\synthetic\\shadow', createdAt: '2026-01-01', kind: 'remote', workdir: { version: 2, nodeId: 'windows-node', workdirId: 'registered-' + id }, identity: { version: 1, rootId: 'a'.repeat(64), ancestorIds: [] } }))] }))
      else if (url.pathname.endsWith('/picker/devices')) res.end(JSON.stringify({devices:[{nodeId:'windows-node',name:'CI010',role:'child',online:true,supported:true}]}))
      else if (url.pathname.endsWith('/files')) res.end(JSON.stringify({ path: '', entries: [{ name: 'same.md', type: 'file', ext: '.md', size: 12, mtime: null }, ...Array.from({ length: 60 }, (_, i) => ({ name: `file-${i}.md`, type: 'file', ext: '.md', size: 12, mtime: null }))] }))
      else if (url.pathname.endsWith('/preview')) res.end(JSON.stringify({ binary: false, size: 12, content: '# ' + url.pathname }))
      else if (url.pathname.endsWith('/git/diff')) res.end(JSON.stringify({ path: 'same.md', status: 'modified', base: 'HEAD', binary: false, truncated: false, hunks: [], notice: url.pathname }))
      else if (url.pathname.endsWith('/git/status')) res.end(JSON.stringify({ available: true, entries: [{ path: 'same.md', status: 'modified' }] }))
      else { res.statusCode = 404; res.end('{}') }
    }) },
  }], server: { host: '127.0.0.1', port: 0 } })
  await server.listen(); t.after(() => { server.httpServer?.closeAllConnections(); return server.close() })
  const url = server.resolvedUrls!.local[0]
  const script = String.raw`const assert=require('node:assert/strict');const {app,BrowserWindow}=require('electron');const {setTimeout:delay}=require('node:timers/promises');app.setPath('userData',require('node:path').join(process.cwd(),'profile'));app.on('window-all-closed',()=>{});(async()=>{await app.whenReady();const win=new BrowserWindow({show:false,width:1300,height:800,webPreferences:{backgroundThrottling:false}});const run=s=>win.webContents.executeJavaScript(s);const wait=async s=>{for(let i=0;i<200;i++){if(await run('Boolean('+s+')'))return;await delay(50)}throw Error('Timeout '+s+' '+await run('document.body.innerText'))};await win.loadURL(${JSON.stringify(url)});
    await wait('document.querySelectorAll(".explorer-root").length===4');await run('document.querySelector(".project-explorer-toggle").click()');
    const expanded = id => run('document.querySelector('+JSON.stringify('[data-root-id="'+id+'"] .root-toggle')+').getAttribute("aria-expanded")');
    assert.equal(await expanded('session:web:A'),'true','opening explorer reveals main A');
    assert.equal(await expanded('session:web:B'),'false');
    assert.equal(await expanded('folder:one'),'false','bound folder is not auto-expanded');
    await run('window.groups.move("B","right");window.groups.focus("p","right")');await delay(80);
    assert.equal(await expanded('session:web:B'),'false','right focus never reveals B');
    await run('window.groups.move("B","left")');await delay(80);
    assert.equal(await expanded('session:web:B'),'true','main selection follows B');
    assert.equal(await expanded('session:web:A'),'true','previous expansion is retained');
    await run('document.querySelector(\'[data-root-id="folder:one"] .root-toggle\').click();document.querySelector(\'[data-root-id="session:web:B"] .root-toggle\').click()');
    assert.equal(await expanded('session:web:B'),'false','manual collapse remains possible');
    await run('window.groups.toggleExplorer("p");window.groups.activate("A")');await delay(50);
    await run('window.groups.activate("B");window.groups.toggleExplorer("p")');await delay(80);
    assert.equal(await expanded('session:web:B'),'true','reopening restores main root');
    assert.equal(await expanded('folder:one'),'true','manual folder expansion survives reopen');
    // Non-conversation documents share A ownership but must not fall back to A.
    await run('window.groups.open({id:"workflow-test",projectId:"p",owner:"A",label:"Workflow",icon:"",closable:true,select(){},close(){}});document.querySelector(\'[data-root-id="session:web:A"] .root-toggle\').click();window.groups.toggleExplorer("p")');await delay(50);
    await run('window.groups.toggleExplorer("p")');await delay(80);
    assert.equal(await expanded('session:web:A'),'false','workflow never reveals hidden owner conversation');
    await run('window.groups.open({id:"other-project",projectId:"q",owner:"A",label:"A",conversation:{sessionId:"web:A",editable:true},icon:"",closable:true,select(){},close(){}})');await delay(80);
    assert.equal(await expanded('session:web:A'),'false','other Project selection cannot reveal this root');
    await run('window.groups.unregister("other-project");window.groups.close("workflow-test");window.groups.activate("A")');await delay(80);
    assert.equal(await expanded('session:web:A'),'true');
    for(const id of ['session:web:A','session:web:B','folder:one','folder:two']){const root='document.querySelector('+JSON.stringify('[data-root-id="'+id+'"]')+')';if(await expanded(id)==='false')await run(root+'.querySelector(".root-toggle").click()');await wait(root+'.textContent.includes("same.md")');}
    assert.equal(await run('document.querySelectorAll(".root-toggle[aria-expanded=true]").length'),4);
    // Real layout/scroll regression: every dynamic resource heading stays visible,
    // not just the first sticky row. Exercise both desktop and narrow panes.
    for (const width of [1300, 500]) {
      win.setSize(width,800);await delay(100);
      assert.equal(await run("(()=>{         const pane=document.querySelector('.project-file-explorer'), bounds=pane.getBoundingClientRect();         const roots=[...pane.querySelectorAll('.explorer-root')];         const before=roots.map(root=>root.querySelector('.root-toggle').getBoundingClientRect());         const bodies=roots.map(root=>root.querySelector('.file-tree-body'));         const rows=bodies.map(body=>body.querySelector('.tree-row').getBoundingClientRect().top);         bodies.forEach(body=>{body.scrollTop=400;body.scrollLeft=100});         const after=roots.map(root=>root.querySelector('.root-toggle').getBoundingClientRect());         return after.every((r,i)=>r.height>0&&r.top>=bounds.top&&r.bottom<=bounds.bottom&&r.left>=bounds.left&&r.right<=bounds.right&&r.top===before[i].top&&(!i||r.top>=after[i-1].bottom))           &&bodies.every((body,i)=>body.scrollTop>0&&body.querySelector('.tree-row').getBoundingClientRect().top<rows[i])           &&pane.scrollTop===0;       })()"),true,'all resource headings stay in bounds while each file list scrolls');
      if(process.env.PROJECT_EXPLORER_SCROLL_SCREENSHOT) require('node:fs').writeFileSync(process.env.PROJECT_EXPLORER_SCROLL_SCREENSHOT+'-'+width+'.png',(await win.webContents.capturePage()).toPNG());
      await run('document.querySelectorAll(".file-tree-body").forEach(body=>body.scrollTop=0)');
    }
    win.setSize(1300,800);await delay(100);
    for(const id of ['session:web:A','session:web:B','folder:one','folder:two']){const selector=JSON.stringify('[data-root-id="'+id+'"] .tree-row[data-path="same.md"]');await run('document.querySelector('+selector+').click()');await delay(150);}
    await wait('document.querySelectorAll(".file-markdown").length===4');
    for(const id of ['session:web:A','session:web:B','folder:one','folder:two']){const root='document.querySelector('+JSON.stringify('[data-root-id="'+id+'"]')+')';await run(root+'.querySelectorAll(".file-tree-modes button")[1].click()');await wait(root+'.querySelector(".tree-row[data-path]")');await run(root+'.querySelector(".tree-row[data-path]").click()');await delay(150);}
    await wait('document.querySelectorAll(".file-diff").length===4');
    assert.equal(await run('document.querySelectorAll(".view-explorer-toggle").length'),0);
    assert.equal(await run('document.querySelector(".project-file-explorer").closest(".editor-group-content")===null'),true);
    const sameRow = '(()=>{const b=document.querySelector(".project-explorer-toggle").getBoundingClientRect();const tabs=[...document.querySelectorAll(".editor-tab")].map(e=>e.getBoundingClientRect()).filter(r=>r.width);return tabs.length>0&&tabs.every(r=>Math.abs(r.top-b.top)<2&&b.right<=r.left)})()';
    assert.equal(await run(sameRow),true,'toggle shares the tab row and precedes every tab');
    assert.equal(await run('document.querySelector(".editor-workspace-header").getBoundingClientRect().height <= document.querySelector(".editor-tabs").getBoundingClientRect().height+1'),true,'no extra toolbar row');
    await run('document.querySelector(\'[role="tab"]\').focus()');await win.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'});await win.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'});assert.equal(await run('document.activeElement.getAttribute("role")'),'tab');
    assert.equal(await run('document.querySelectorAll(\'[data-root-id="folder:two-alias"]\').length'),0,'same physical resource is deduplicated');
    assert.equal(await run('document.querySelector(\'[data-root-id="folder:one"] .root-source\').textContent'),'Main');
    assert.equal(await run('document.querySelector(\'[data-root-id="folder:two"] .root-source\').textContent'),'CI010');
    assert.equal(await run('[...document.querySelectorAll(".root-toggle")].every(e=>e.getBoundingClientRect().height<=32)'),true,'all roots remain single compact rows');
    assert.equal(await run('[...document.querySelectorAll(".root-name")].every(e=>getComputedStyle(e).whiteSpace==="nowrap"&&getComputedStyle(e).textOverflow==="ellipsis")'),true);
    assert.equal(await run('document.querySelector(\'[data-root-id="folder:one"] .root-toggle\').textContent.includes("/synthetic")'),false,'paths are not persistent row text');
    win.webContents.focus();await win.webContents.sendInputEvent({type:'keyDown',keyCode:'Tab'});await win.webContents.sendInputEvent({type:'keyUp',keyCode:'Tab'});
    await run('document.querySelector(\'[data-root-id="folder:two"] .root-toggle\').focus()');
    await wait('document.querySelector(".shared-hover-info")?.textContent.includes("windows-node")');
    assert.match(await run('document.querySelector(".shared-hover-info").textContent'),/C:/,'keyboard hint exposes full source path');
    await run('document.querySelector(\'[data-root-id="session:web:A"] .root-toggle\').focus()');
    await wait('document.querySelector(".shared-hover-info")?.textContent.includes("Session files: A")');
    await run('window.groups.move("A","right")');await delay(100);assert.equal(await run(sameRow),true,'split groups keep the same header row');
    await run('window.groups.move("A","left")');await delay(100);
    await run('document.querySelector(\'[data-root-id="folder:one"] .root-toggle\').click()');assert.equal(await run('document.querySelector(\'[data-root-id="folder:two"] .root-toggle\').getAttribute("aria-expanded")'),'true');
    assert.equal(await run('!!document.querySelector(\'[data-root-id="folder:unrelated"]\')'),false,'catalog roots unrelated to open conversations stay hidden');
    await run('window.groups.descriptors.set("A",{...window.groups.descriptors.get("A"),conversation:{sessionId:"web:A",editable:true,folderId:"two-alias"}});void 0');
    await wait('document.querySelectorAll(\'[data-root-id^="folder:"]\').length===1');
    assert.equal(await run('!!document.querySelector(\'[data-root-id="folder:two"]\')'),true,'two bound aliases of the same node/root deduplicate');
    await run('window.groups.descriptors.set("A",{...window.groups.descriptors.get("A"),conversation:{sessionId:"web:A",editable:true,folderId:"two"}});void 0');
    await wait('!document.querySelector(\'[data-root-id="folder:one"]\')');
    await run('window.groups.close("B")');await wait('!document.querySelector(\'[data-root-id="session:web:B"]\')');
    assert.equal(await run('!!document.querySelector(\'[data-root-id="folder:two"]\')'),true,'another open binding retains the shared root');
    await run('window.groups.descriptors.set("A",{...window.groups.descriptors.get("A"),conversation:{sessionId:"web:A",editable:true,folderId:"two-alias"}});void 0');
    await wait('!!document.querySelector(\'[data-root-id="folder:two-alias"]\')&&!document.querySelector(\'[data-root-id="folder:two"]\')');
    await run('window.groups.descriptors.set("A",{...window.groups.descriptors.get("A"),conversation:{sessionId:"web:A",editable:true}});void 0');
    await wait('!document.querySelector(\'[data-root-id^="folder:"]\')');
    assert.equal(await run('!!document.querySelector(\'[data-root-id="session:web:A"]\')'),true,'unbound session keeps only session data');
    await run('window.groups.open({id:"project-only",projectId:"p",owner:"project",label:"Settings",icon:"i-lucide-settings",closable:true,select(){},close(){}});void 0');
    assert.equal(await run('document.querySelectorAll(\'[data-root-id^="folder:"]\').length'),0,'project-only tabs never expose the catalog');
    await run('window.groups.close("project-only");window.groups.descriptors.set("A",{...window.groups.descriptors.get("A"),conversation:{sessionId:"web:A",editable:true,folderId:"one"}});void 0');
    await wait('!!document.querySelector(\'[data-root-id="folder:one"]\')');
    if(process.env.PROJECT_EXPLORER_SCREENSHOT) require('node:fs').writeFileSync(process.env.PROJECT_EXPLORER_SCREENSHOT,(await win.webContents.capturePage()).toPNG());
    win.setSize(500,800);await delay(100);assert.equal(await run(sameRow),true,'narrow header stays inline');
    const wasOpen=await run('document.querySelector(".project-explorer-toggle").getAttribute("aria-expanded")');await run('document.querySelector(".project-explorer-toggle").focus()');await win.webContents.sendInputEvent({type:'keyDown',keyCode:'E',modifiers:['control','shift']});await win.webContents.sendInputEvent({type:'keyUp',keyCode:'E',modifiers:['control','shift']});await delay(100);assert.notEqual(await run('document.querySelector(".project-explorer-toggle").getAttribute("aria-expanded")'),wasOpen,'keyboard shortcut toggles');
    await run('window.groups.explorers.add("p");void 0');await delay(50);await run('document.querySelector(".root-toggle").focus()');await win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});await win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await delay(50);assert.equal(await run('document.activeElement.classList.contains("project-explorer-toggle")'),true,'Escape returns focus to header toggle');
    await run('window.groups.explorers.add("p");window.groups.descriptors.set("A",{...window.groups.descriptors.get("A"),label:"A full long conversation title ".repeat(8)});void 0');
    await run('document.querySelector(\'[data-root-id="session:web:A"] .root-toggle\').focus()');
    await wait('document.querySelector(".shared-hover-info")?.textContent.includes("A full long conversation title")');
    assert.equal(await run('document.querySelector(\'[data-root-id="session:web:A"] .root-toggle\').getBoundingClientRect().height<=32'),true,'long session title also stays single-line');
    await run('for(const id of [...window.groups.descriptors.keys()])window.groups.close(id)');await delay(100);assert.equal(await run('document.querySelectorAll(".editor-tab").length'),0);assert.equal(await run('document.querySelector(".project-explorer-toggle").getBoundingClientRect().width>0'),true);await win.close();console.log('PROJECT_EXPLORER_OK');app.quit();})().catch(e=>{console.error(e);app.exit(1)});`
  const entry = resolve(directory, 'main.cjs'); await writeFile(entry, script)
  const child = spawn(require('electron') as string, [entry], { cwd: directory, env: { ...process.env, ELECTRON_RUN_AS_NODE: '' }, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
  const timer = setTimeout(() => child.kill(), 75000); t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close'); assert.equal(code, 0, output); assert.match(output, /PROJECT_EXPLORER_OK/)
  for (const source of ['sessions/web%3AA/workspace', 'sessions/web%3AB/workspace', 'folders/one', 'folders/two']) {
    assert(requests.some(path => path.startsWith('/projects/p/api/' + source + '/preview')), source + ' preview stays source scoped')
    assert(requests.some(path => path.startsWith('/projects/p/api/' + source + '/git/status')), source + ' Git stays source scoped')
    assert(requests.some(path => path.startsWith('/projects/p/api/' + source + '/git/diff')), source + ' diff stays source scoped')
  }
})
