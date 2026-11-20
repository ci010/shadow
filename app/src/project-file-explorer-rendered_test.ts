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
test('Project explorer roots stay left, expand independently and show the current session and bound workspace sources', { timeout: 90000, skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY }, async t => {
  const directory = resolve(root, '.test-artifacts', `project-explorer-${randomUUID()}`)
  await mkdir(directory, { recursive: true }); t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const requests: string[] = []
  const server = await createServer({ configFile: false, envDir: false, root: resolve(root, 'app'), cacheDir: resolve(directory, 'cache'), logLevel: 'error', optimizeDeps: { noDiscovery: true, include: ['vue'] }, plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app/unocss.config.ts') }), {
    name: 'explorer-fixture', resolveId: id => id === '/fixture.ts' ? '\0fixture' : undefined,
    load(id) { if (id !== '\0fixture') return; return `import {createResourceApp as createApp} from '/src/stores/app.ts'; import {h, provide, ref} from 'vue';import Host from '/src/components/EditorGroupHost.vue';import View from '/src/components/EditorViewHost.vue';import {createEditorGroups,EditorGroupsKey} from '/src/editor-groups.ts';import {setLocalePreference} from '/src/i18n.ts';import '/src/styles.css';import 'virtual:uno.css';setLocalePreference('en');
      const groups=createEditorGroups();window.groups=groups; const project=ref('p');window.switchProject=id=>project.value=id;
      const descriptors=['A','B'].map(label=>({id:label,projectId:'p',owner:label,label,icon:'i-lucide-message-square',closable:true,conversation:{sessionId:'web:'+label,editable:true,folderId:label==='A'?'one':'two'},select(){},close(){}}));
      createApp({setup(){provide(EditorGroupsKey,groups);return()=>h('div',{style:'display:flex;height:100vh'},[h(Host,{projectId:'p',apiBase:location.origin+'/projects/p',active:project.value==='p',style:{display:project.value==='p'?undefined:'none'}}),h(Host,{projectId:'other',active:project.value==='other',style:{display:project.value==='other'?undefined:'none'}}),...descriptors.map(descriptor=>h(View,{descriptor},()=>h('div',{class:'chat-fixture'},[h('button',{class:'chat-right-action',style:'float:right'},'Chat action')])))]);}}).mount('#app');` },
    configureServer(server) { server.middlewares.use((req, res, next) => {
      const url = new URL(req.url!, 'http://fixture')
      if (url.pathname === '/') { res.setHeader('Content-Type', 'text/html'); res.end('<html><body style="margin:0"><div id="app"></div><script type="module" src="/fixture.ts"></script></body></html>'); return }
      if (!url.pathname.startsWith('/projects/p/api/')) return next()
      requests.push(url.pathname + url.search); res.setHeader('Content-Type', 'application/json')
      if (url.pathname.endsWith('/folders')) res.end(JSON.stringify({ folders: [{ id: 'unrelated', name: 'Unrelated project root', path: '/synthetic/unrelated', createdAt: '2026-01-01' }, { id: 'one', name: 'shadow with a very long folder name that must never wrap', path: '/synthetic/shadow', createdAt: '2026-01-01' }, ...['two', 'two-alias'].map(id => ({ id, name: 'shadow with a very long folder name that must never wrap', path: 'C:\\synthetic\\shadow', createdAt: '2026-01-01', kind: 'remote', workdir: { version: 2, nodeId: 'windows-node', workdirId: 'registered-' + id }, identity: { version: 1, rootId: 'a'.repeat(64), ancestorIds: [] } }))] }))
      else if (url.pathname.endsWith('/picker/devices')) res.end(JSON.stringify({devices:[{nodeId:'windows-node',name:'CI010',role:'child',online:true,supported:true}]}))
      else if (url.pathname.endsWith('/files')) res.end(JSON.stringify({ path: '', entries: [{ name: 'same.md', type: 'file', ext: '.md', size: 12, mtime: null }, ...['00-first.otio', '01-second.otio'].map(name => ({ name, type: 'file', ext: '.otio', size: 12, mtime: null })), ...Array.from({ length: 60 }, (_, i) => ({ name: `file-${i}.md`, type: 'file', ext: '.md', size: 12, mtime: null }))] }))
      else if (url.pathname.endsWith('/raw') && url.searchParams.get('path')?.endsWith('.otio')) {
        const name = url.searchParams.get('path') === '00-first.otio' ? 'First assembly' : 'Second assembly'
        const time = (value: number) => ({ OTIO_SCHEMA: 'RationalTime.1', value, rate: 24 })
        res.end(JSON.stringify({ OTIO_SCHEMA: 'Timeline.1', name, tracks: { OTIO_SCHEMA: 'Stack.1', children: [
          { OTIO_SCHEMA: 'Track.1', name: 'Picture track', kind: 'Video', children: [
            { OTIO_SCHEMA: 'Clip.1', name: 'Intro shot', source_range: { OTIO_SCHEMA: 'TimeRange.1', start_time: time(0), duration: time(48) } },
          ] },
        ] } }))
      }
      else if (url.pathname.endsWith('/preview')) res.end(JSON.stringify({ binary: false, size: 12, content: '# ' + url.pathname }))
      else if (url.pathname.endsWith('/git/diff')) res.end(JSON.stringify({ path: 'same.md', status: 'modified', base: 'HEAD', binary: false, truncated: false, hunks: [], notice: url.pathname }))
      else if (url.pathname.endsWith('/git/status')) res.end(JSON.stringify({ available: true, entries: [{ path: 'same.md', status: 'modified' }] }))
      else { res.statusCode = 404; res.end('{}') }
    }) },
  }], server: { host: '127.0.0.1', port: 0 } })
  await server.listen(); t.after(() => { server.httpServer?.closeAllConnections(); return server.close() })
  const url = server.resolvedUrls!.local[0]
  const script = String.raw`const assert=require('node:assert/strict');const {app,BrowserWindow}=require('electron');const {setTimeout:delay}=require('node:timers/promises');app.setPath('userData',require('node:path').join(process.cwd(),'profile'));app.on('window-all-closed',()=>{});(async()=>{await app.whenReady();const win=new BrowserWindow({show:false,width:1300,height:800,webPreferences:{backgroundThrottling:false}});const run=async s=>{try{return await win.webContents.executeJavaScript(s)}catch(e){throw Error(s+": "+e.message)}};const wait=async s=>{for(let i=0;i<200;i++){if(await run('Boolean('+s+')'))return;await delay(50)}throw Error('Timeout '+s+' '+await run('document.body.innerText'))};await win.loadURL(${JSON.stringify(url)});
    await wait('document.querySelectorAll(".explorer-root").length===3');
    const paneWidth = 'document.querySelector(".project-file-explorer").getBoundingClientRect().width';
    assert.equal(await run(paneWidth),0,'opening conversations starts with the file pane closed');
    await run('[...document.querySelectorAll(".editor-tab [role=tab]")].find(tab=>tab.textContent==="A").click()');
    await wait('window.groups.active("p")?.id==="A"');
    assert.equal(await run(paneWidth),0,'switching conversation tabs keeps the file pane closed');
    await run('document.querySelector(".project-explorer-toggle").click()');
    const divider = 'document.querySelector(".file-explorer-resizer")';
    await wait(divider);
    const initialWidth = await run(paneWidth);
    const hit = await run('(()=>{const divider='+divider+', r=divider.getBoundingClientRect();const x=Math.floor(r.right-3),y=Math.floor(r.top+r.height/2);return {x,y,target:document.elementFromPoint(x,y)===divider}})()');
    assert.equal(hit.target,true,'the divider is hittable over the file tree');
    // Scripted pointer events cannot create native pointer capture. Stub only
    // capture on this divider; the hit test above still checks the real layout.
    await run('(()=>{const el='+divider+';let captured=false;el.setPointerCapture=()=>{captured=true};el.hasPointerCapture=()=>captured;el.releasePointerCapture=()=>{captured=false};const send=(type,x)=>el.dispatchEvent(new PointerEvent(type,{bubbles:true,pointerId:1,isPrimary:true,button:0,clientX:x}));send("pointerdown",'+hit.x+');send("pointermove",'+(hit.x+56)+');send("pointerup",'+(hit.x+56)+');})()');
    const draggedWidth = initialWidth+56;
    await wait(paneWidth+'==='+draggedWidth);
    await wait('!document.documentElement.classList.contains("sidebar-pointer-resizing")');
    await run(divider+'.focus()');win.webContents.sendInputEvent({type:'keyDown',keyCode:'Right'});win.webContents.sendInputEvent({type:'keyUp',keyCode:'Right'});
    await wait(paneWidth+'==='+ (draggedWidth+24));
    await run('document.querySelector(".project-explorer-toggle").click()');
    assert.equal(await run(paneWidth),0,'toolbar click still collapses the explorer');
    assert.equal(await run('!'+divider),true,'collapsed explorer has no resize control');
    await run('document.querySelector(".project-explorer-toggle").click()');
    assert.equal(await run(paneWidth),draggedWidth+24,'reopening restores the adjusted width');
    await run(divider+'.focus()');
    win.setContentSize(710,800);
    await wait('Math.abs(Number('+divider+'?.getAttribute("aria-valuemax"))-350)<=2');
    const limitedWidth = await run('Number('+divider+'.getAttribute("aria-valuemax"))');
    win.webContents.sendInputEvent({type:'keyDown',keyCode:'End'});
    win.webContents.sendInputEvent({type:'keyUp',keyCode:'End'});
    await wait('Math.abs('+paneWidth+'-'+limitedWidth+')<1');
    win.setSize(1300,800);
    await wait(divider+'?.getAttribute("aria-valuemax")==="400"');
    const expanded = id => run('document.querySelector('+JSON.stringify('[data-root-id="'+id+'"] .root-toggle')+').getAttribute("aria-expanded")');
    assert.equal(await run('document.querySelectorAll(\'[data-root-id^="session:"]\').length'),1,'only the current session is an explorer root');
    await run('window.groups.move("B","right");window.groups.focus("p","right")');await delay(80);
    assert.equal(await run('document.querySelectorAll(".explorer-root").length'),3,'split focus replaces the session root without adding a second one');
    assert.equal(await expanded('session:web:B'),'true');
    await run('window.groups.move("B","left")');await delay(80);
    for(const id of ['folder:one','folder:two']){const root='document.querySelector('+JSON.stringify('[data-root-id="'+id+'"]')+')';if(await expanded(id)==='false')await run(root+'.querySelector(".root-toggle").click()');await wait(root+'.textContent.includes("same.md")');}
    await run('window.groups.toggleExplorer("p");window.groups.activate("A");window.groups.toggleExplorer("p")');await delay(80);
    assert.equal(await expanded('folder:one'),'true','manual folder expansion survives reopen');
    assert.equal(await run('document.querySelectorAll(".root-toggle[aria-expanded=true]").length'),3);
    // Real layout/scroll regression: every dynamic resource heading stays visible,
    // not just the first sticky row. Exercise both desktop and narrow panes.
    for (const width of [1300, 500]) {
      win.setSize(width,800);await delay(100);
      if(width===500) assert.equal(await run('!'+divider+' || '+divider+'.getBoundingClientRect().width===0'),true,'narrow layout does not expose a drag handle');
      assert.equal(await run("(()=>{         const pane=document.querySelector('.project-file-explorer'), bounds=pane.getBoundingClientRect();         const roots=[...pane.querySelectorAll('.explorer-root')];         const before=roots.map(root=>root.querySelector('.root-toggle').getBoundingClientRect());         const bodies=roots.map(root=>root.querySelector('.file-tree-body'));         const rows=bodies.map(body=>body.querySelector('.tree-row').getBoundingClientRect().top);         bodies.forEach(body=>{body.scrollTop=400;body.scrollLeft=100});         const after=roots.map(root=>root.querySelector('.root-toggle').getBoundingClientRect());         return after.every((r,i)=>r.height>0&&r.top>=bounds.top&&r.bottom<=bounds.bottom&&r.left>=bounds.left&&r.right<=bounds.right&&r.top===before[i].top&&(!i||r.top>=after[i-1].bottom))           &&bodies.every((body,i)=>body.scrollTop>0&&body.querySelector('.tree-row').getBoundingClientRect().top<rows[i])           &&pane.scrollTop===0;       })()"),true,'all resource headings stay in bounds while each file list scrolls');
      if(process.env.PROJECT_EXPLORER_SCROLL_SCREENSHOT) require('node:fs').writeFileSync(process.env.PROJECT_EXPLORER_SCROLL_SCREENSHOT+'-'+width+'.png',(await win.webContents.capturePage()).toPNG());
      await run('document.querySelectorAll(".file-tree-body").forEach(body=>body.scrollTop=0)');
    }
    win.setSize(1300,800);await delay(100);
    for(const id of ['folder:one','folder:two']){const selector=JSON.stringify('[data-root-id="'+id+'"] .tree-row[data-path="same.md"]');await run('document.querySelector('+selector+').click()');await delay(150);}
    await wait('document.querySelectorAll(".file-markdown").length===2');
    for(const id of ['folder:one','folder:two']){const root='document.querySelector('+JSON.stringify('[data-root-id="'+id+'"]')+')';await run(root+'.querySelectorAll(".file-tree-modes button")[1].click()');await wait(root+'.querySelector(".tree-row[data-path]")');await run(root+'.querySelector(".tree-row[data-path]").click()');await delay(150);}
    await wait('document.querySelectorAll(".file-diff").length===2');
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
    await run('window.groups.move("A","right")');await delay(100);assert.equal(await run(sameRow),true,'split groups keep the same header row');
    await run('window.groups.move("A","left")');await delay(100);
    await run('document.querySelector(\'[data-root-id="folder:one"] .root-toggle\').click()');assert.equal(await run('document.querySelector(\'[data-root-id="folder:two"] .root-toggle\').getAttribute("aria-expanded")'),'true');
    assert.equal(await run('!!document.querySelector(\'[data-root-id="folder:unrelated"]\')'),false,'catalog roots unrelated to open conversations stay hidden');
    await run('window.groups.descriptors.set("A",{...window.groups.descriptors.get("A"),conversation:{sessionId:"web:A",editable:true,folderId:"two-alias"}});void 0');
    await wait('document.querySelectorAll(\'[data-root-id^="folder:"]\').length===1');
    assert.equal(await run('!!document.querySelector(\'[data-root-id="folder:two"]\')'),true,'two bound aliases of the same node/root deduplicate');
    await run('window.groups.descriptors.set("A",{...window.groups.descriptors.get("A"),conversation:{sessionId:"web:A",editable:true,folderId:"two"}});void 0');
    await wait('!document.querySelector(\'[data-root-id="folder:one"]\')');
    await run('window.groups.close("B");window.groups.activate("A")');await wait('!document.querySelector(\'[data-root-id="session:web:B"]\')');
    assert.equal(await run('!!document.querySelector(\'[data-root-id="folder:two"]\')'),true,'another open binding retains the shared root');
    await run('window.groups.descriptors.set("A",{...window.groups.descriptors.get("A"),conversation:{sessionId:"web:A",editable:true,folderId:"two-alias"}});void 0');
    await wait('!!document.querySelector(\'[data-root-id="folder:two-alias"]\')&&!document.querySelector(\'[data-root-id="folder:two"]\')');
    await run('window.groups.descriptors.set("A",{...window.groups.descriptors.get("A"),conversation:{sessionId:"web:A",editable:true}});void 0');
    await wait('!document.querySelector(\'[data-root-id^="folder:"]\')');
    await wait('document.querySelector(\'[data-root-id="session:web:A"]\')?.textContent.includes("same.md")');
    assert.equal(await run('!!document.querySelector(".catalog-empty")'),false,'a from-scratch session does not get the choose-workspace prompt');
    await run('document.querySelector(\'[data-root-id="session:web:A"] .tree-row[data-path="same.md"]\').click()');
    await wait('document.body.innerText.includes("/sessions/web%3AA/workspace/preview")');
    assert.equal(await expanded('session:web:A'),'true','the session tree stays available while previewing its file');
    await run('window.groups.open({id:"project-only",projectId:"p",owner:"project",label:"Settings",icon:"i-lucide-settings",closable:true,select(){},close(){}});void 0');
    assert.equal(await run('document.querySelectorAll(\'[data-root-id^="folder:"]\').length'),0,'project-only tabs never expose the catalog');
    await run('window.groups.close("project-only");window.groups.descriptors.set("A",{...window.groups.descriptors.get("A"),conversation:{sessionId:"web:A",editable:true,folderId:"one"}});void 0');
    await wait('!!document.querySelector(\'[data-root-id="folder:one"]\')');
    const openTimeline = async name => {
      const selector = 'document.querySelector('+JSON.stringify('[data-root-id="session:web:A"] .tree-row[data-path="'+name+'.otio"]')+')';
      await wait(selector); await run(selector+'.click()');
    };
    const hosted = 'document.querySelector(".project-file-explorer .explorer-outline")';
    const visibleOutlines = '[...document.querySelectorAll(".outline")].filter(e=>e.getClientRects().length)';
    await openTimeline('00-first');
    await wait(hosted+'?.textContent.includes("First assembly")');
    assert.equal(await run(visibleOutlines+'.length'),1);
    assert.equal(await run('!!document.querySelector(".otio .outline")'),false,'no second tree inside the viewer');
    assert.equal(await run('document.querySelector(".bench").classList.contains("with-inline-outline")'),false,'no reserved outline column');
    assert.equal(await run('document.querySelector(".project-file-explorer").lastElementChild.contains('+hosted+')'),true,'outline follows all file roots');
    const nativeKey = async keyCode => { await win.webContents.sendInputEvent({type:'keyDown',keyCode});await win.webContents.sendInputEvent({type:'keyUp',keyCode}); };
    await run(hosted+'.querySelector(".outline-toggle").focus()');await nativeKey('Space');
    await wait(hosted+'.querySelector(".outline-toggle").getAttribute("aria-expanded")==="false"');
    assert.equal(await run(hosted+'.querySelector(".viewport").getClientRects().length'),0);
    await nativeKey('Space');await wait(hosted+'.querySelector(".viewport").getClientRects().length');
    await run(hosted+'.querySelector(\'[aria-label="Collapse Picture track"]\').focus()');await nativeKey('Space');
    await wait('!'+hosted+'.textContent.includes("Intro shot")');
    await nativeKey('Space');await wait(hosted+'.textContent.includes("Intro shot")');
    await run('[...'+hosted+'.querySelectorAll(".row")].find(e=>e.textContent.includes("Intro shot")).focus()');await nativeKey('Space');
    await wait('document.querySelector(".otio .inspector h4").textContent==="Intro shot"');
    await run('[...document.querySelectorAll(".viewer-modes button")].find(e=>e.textContent==="Storyboard").click()');
    await wait('document.querySelector(".storyboard-pane")?.getClientRects().length');
    assert.equal(await run(visibleOutlines+'.length'),1,'storyboard keeps the same explorer outline');
    assert.equal(await run("(()=>{ const bench=document.querySelector('.otio .bench'), board=bench.querySelector('.storyboard-pane'), toolbar=board.querySelector('.board-toolbar'), inspector=bench.querySelector('.inspector'); const grid=bench.getBoundingClientRect(), main=board.getBoundingClientRect(), details=inspector.getBoundingClientRect(); return !!toolbar.querySelector('.board-primary .viewer-modes') && toolbar.scrollWidth<=toolbar.clientWidth+1 && Math.abs(grid.left-main.left)<1 && Math.abs(main.right-details.left)<1 && Math.abs(details.right-grid.right)<1; })()"),true,'combined storyboard toolbar and inspector fill the viewer without an outline column');
    await openTimeline('01-second');await wait(hosted+'?.textContent.includes("Second assembly")');
    assert.equal(await run(visibleOutlines+'.length'),1);
    await run('window.switchProject("other")');await wait('!'+hosted);
    assert.equal(await run(visibleOutlines+'.length'),0,'another project never shows this project’s outline');
    await run('window.switchProject("p")');await wait(hosted+'?.textContent.includes("Second assembly")');
    await run('window.groups.move(window.groups.active("p").id,"right")');
    await run('[...document.querySelectorAll(".editor-tab [role=tab]")].find(tab=>tab.textContent==="00-first.otio").click()');
    await wait(hosted+'?.textContent.includes("First assembly")');
    assert.equal(await run(visibleOutlines+'.length'),1,'a visible background split never duplicates the outline');
    await run('window.groups.move(window.groups.state("p").selected.right,"left")');
    await wait(hosted+'?.textContent.includes("Second assembly")');
    await run('window.groups.activate("A")');await wait('!'+hosted);
    assert.equal(await run(visibleOutlines+'.length'),0,'switching to a conversation removes the outline');
    await run('[...document.querySelectorAll(".editor-tab [role=tab]")].find(tab=>tab.textContent==="00-first.otio").click()');
    await wait(hosted+'?.querySelector("[aria-current=true]")?.textContent.includes("Intro shot")');
    await run('[...document.querySelectorAll(".storyboard-pane .viewer-modes button")].find(e=>e.textContent==="Monitor").click()');
    await run('document.querySelector(".project-explorer-toggle").click()');
    await wait('!'+hosted+' && '+visibleOutlines+'.length===1 && !!document.querySelector(".otio .outline")');
    await run('document.querySelector(".project-explorer-toggle").click()');await wait(hosted+'?.textContent.includes("First assembly")');
    await run('document.querySelector(\'[aria-label="Close 00-first.otio"]\').click()');
    await wait('!'+hosted+'?.textContent.includes("First assembly")');
    assert.equal(await run(visibleOutlines+'.length<=1'),true);
    await run('window.groups.activate("A")');await wait('!'+hosted);
    if(process.env.PROJECT_EXPLORER_SCREENSHOT) require('node:fs').writeFileSync(process.env.PROJECT_EXPLORER_SCREENSHOT,(await win.webContents.capturePage()).toPNG());
    win.setSize(500,800);await delay(100);assert.equal(await run(sameRow),true,'narrow header stays inline');
    const wasOpen=await run('document.querySelector(".project-explorer-toggle").getAttribute("aria-expanded")');await run('document.querySelector(".project-explorer-toggle").focus()');await win.webContents.sendInputEvent({type:'keyDown',keyCode:'E',modifiers:['control','shift']});await win.webContents.sendInputEvent({type:'keyUp',keyCode:'E',modifiers:['control','shift']});await delay(100);assert.notEqual(await run('document.querySelector(".project-explorer-toggle").getAttribute("aria-expanded")'),wasOpen,'keyboard shortcut toggles');
    await run('window.groups.setExplorerOpen("p",true);void 0');await delay(50);await run('document.querySelector(".root-toggle").focus()');await win.webContents.sendInputEvent({type:'keyDown',keyCode:'Escape'});await win.webContents.sendInputEvent({type:'keyUp',keyCode:'Escape'});await delay(50);assert.equal(await run('document.activeElement.classList.contains("project-explorer-toggle")'),true,'Escape returns focus to header toggle');
    await run('for(const id of [...window.groups.descriptors.keys()])window.groups.close(id)');await delay(100);assert.equal(await run('document.querySelectorAll(".editor-tab").length'),0);assert.equal(await run('document.querySelector(".project-explorer-toggle").getBoundingClientRect().width>0'),true);await win.close();console.log('PROJECT_EXPLORER_OK');app.quit();})().catch(e=>{console.error(e);app.exit(1)});`
  const entry = resolve(directory, 'main.cjs'); await writeFile(entry, script)
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(require('electron') as string, [entry], { cwd: directory, env, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
  const timer = setTimeout(() => child.kill(), 75000); t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close'); assert.equal(code, 0, output); assert.match(output, /PROJECT_EXPLORER_OK/)
  assert(requests.some(path => path.startsWith('/projects/p/api/sessions/web%3AA/workspace/files')), 'lists the session data directory, not the effective workspace')
  for (const source of ['folders/one', 'folders/two']) {
    assert(requests.some(path => path.startsWith('/projects/p/api/' + source + '/preview')), source + ' preview stays source scoped')
    assert(requests.some(path => path.startsWith('/projects/p/api/' + source + '/git/status')), source + ' Git stays source scoped')
    assert(requests.some(path => path.startsWith('/projects/p/api/' + source + '/git/diff')), source + ' diff stays source scoped')
  }
})
