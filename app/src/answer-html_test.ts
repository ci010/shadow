import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { readFileSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import test from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { compileStyle, parse } from 'vue/compiler-sfc'

const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
test('answer fragments are strict and render natively across themes and widths', { timeout: 90_000 }, async t => {
  const directory = await mkdtemp(resolve(tmpdir(), 'shadow-answer-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  const appRoot = resolve('app')
  const { descriptor } = parse(readFileSync(resolve(appRoot, 'src/components/ChatTab.vue'), 'utf8'))
  const style = compileStyle({ source: descriptor.styles[0]!.content, filename: 'ChatTab.vue', id: 'data-v-answer', scoped: true }).code
  const fixture = readFileSync(resolve(appRoot, 'src/fixtures/answer-architecture.md'), 'utf8')
  const themeCss = readFileSync(resolve(appRoot, 'src/styles.css'), 'utf8')
  const script = `import { Marked } from '/node_modules/marked/lib/marked.esm.js';
import DOMPurify from '/node_modules/dompurify/dist/purify.es.mjs';
import { renderAnswerHtml, answerHtmlExtension, sanitizeAnswerHtmlRoots, mountAnswerHtml, vAnswerHtml, sanitizeAnswerCss } from '/src/answer-html.ts';
import { createApp, h, withDirectives, ref, nextTick } from 'vue';
const check = (ok, message) => { if (!ok) throw new Error(message) };
try {
const theme = document.createElement('style'); theme.textContent = ${JSON.stringify(themeCss)}; document.head.append(theme);
for (const dark of [false, true]) {
  document.documentElement.classList.toggle('dark', dark);
  const computed = getComputedStyle(document.documentElement);
  for (const [alias, original] of Object.entries({ 'surface':'c-bg-card', 'border':'c-border', 'text':'c-text', 'warning':'c-warn', 'radius':'radius-surface', 'font':'font-sans', 'font-mono':'font-mono' })) {
    check(computed.getPropertyValue('--answer-' + alias).trim() === computed.getPropertyValue('--' + original).trim(), 'theme alias mismatch: ' + alias);
  }
  check(computed.getPropertyValue('--answer-surface').trim() === (dark ? '#202020' : '#ffffff'), 'theme did not switch');
  check(computed.getPropertyValue('--answer-radius').trim() === '0px', 'square theme lost');
}
document.documentElement.classList.remove('dark');
const marked = new Marked({breaks:true}); marked.use(answerHtmlExtension());
const render = s => DOMPurify.sanitize(sanitizeAnswerHtmlRoots(marked.parse(s)));
const hostile = renderAnswerHtml('<style>@import "https://example.com/a.css"; @font-face{font-family:evil;src:url(https://example.com/f)} *{background-image:url(https://example.com/x)} body{display:none} :host{position:fixed!important;inset:0!important} .evil{position:fixed;inset:0;background:red;animation:bad 1s infinite}</style><div class="answer-card composer-send evil" id="bad" style="color:red" onclick="alert(1)"><script>alert(1)</script><iframe src="https://example.com"></iframe><img src="https://example.com/x"><svg><image href="https://example.com"/></svg><form><input></form><a href="javascript:alert(1)">bad</a><a href="https://example.com" target="_blank">good</a><div data-md>**Bold** ![image](https://example.com/x)</div></div>');
const box = document.createElement('div'); box.innerHTML=hostile; document.body.append(box); mountAnswerHtml(box);
const shadow = box.firstElementChild.shadowRoot;
check(!shadow.querySelector('script,iframe,img,svg,form,input,[style],[onclick],[id],[data-md]'), 'hostile fragment escaped boundary');
check(!shadow.querySelector('style').textContent.includes('https://'), 'network CSS survived');
check(shadow.querySelector('strong')?.textContent === 'Bold', 'Markdown missing');
check(!shadow.querySelector('a')?.hasAttribute('href'), 'unsafe href');
check(shadow.querySelectorAll('a')[1].rel === 'noopener noreferrer', 'link rel');
shadow.querySelectorAll('a')[1].click();
const range=document.createRange(); range.selectNodeContents(shadow.querySelector('strong')); const selection=window.getSelection(); selection.removeAllRanges(); selection.addRange(range); check(selection.toString()==='Bold','native shadow text selection failed'); selection.removeAllRanges();
check(getComputedStyle(box.firstElementChild).position === 'relative', 'host selector escape');
check(getComputedStyle(shadow.querySelector('.evil')).animationName === 'none', 'animation survived');
box.firstElementChild.style.height='100px'; box.firstElementChild.style.width='200px';
const bounds=box.firstElementChild.getBoundingClientRect();
check(document.elementFromPoint(bounds.right+5,bounds.top+5)!==box.firstElementChild, 'fixed child painted outside host');
check(['content','strict'].includes(getComputedStyle(box.firstElementChild).contain) || getComputedStyle(box.firstElementChild).contain.includes('paint'), 'paint containment missing');
box.remove();
check(render('~~~js\\nconst x = "<b>code</b>"\\n~~~').includes('language-js'), 'ordinary fence lost');
check(render('**normal**').includes('<strong>normal</strong>'), 'normal Markdown lost');
const answer = document.querySelector('#answer');
answer.innerHTML = render('~~~answer-html\\n<style>.custom{color:var(--answer-text);display:grid;border:3px solid var(--answer-border)}</style><div class="custom" data-md>**stream**');
mountAnswerHtml(answer);
const old = answer.firstElementChild;
check(old.shadowRoot.querySelector('strong')?.textContent === 'stream', 'streaming fragment missing');
check(parseFloat(getComputedStyle(old.shadowRoot.querySelector('.custom')).borderTopWidth) >= 2, 'author CSS missing: '+old.shadowRoot.innerHTML+' computed '+getComputedStyle(old.shadowRoot.querySelector('.custom')).borderTopWidth);
answer.innerHTML = render(${JSON.stringify(fixture)}); mountAnswerHtml(answer);
check(!old.isConnected, 'stream root not detached');
check(!answer.querySelector('strong'), 'shadow content leaked into app DOM');
check(getComputedStyle(document.body).display !== 'none', 'outer style pollution');
check(!sanitizeAnswerCss('.x{background:u\\\\72l(https://example.com/escaped);animation:x 1s} :host(.x){display:none} ::slotted(*){color:red}').includes('example.com'), 'escaped resource survived');
const vueBox = document.createElement('div'); document.body.append(vueBox);
const content = ref(render('~~~answer-html\\n<style>@media(min-width:0px){.custom{display:flex}}</style><div class="custom">history</div>\\n~~~'));
const app = createApp({setup:()=>()=>withDirectives(h('div',{innerHTML:content.value}),[[vAnswerHtml]])}); app.mount(vueBox);
const first = vueBox.querySelector('.answer-html');
check(getComputedStyle(first.shadowRoot.querySelector('.custom')).display === 'flex', 'Vue mount/media CSS failed');
content.value = render('~~~answer-html\\n<div data-md>**updated**</div>\\n~~~'); await nextTick();
check(!first.isConnected && vueBox.querySelector('.answer-html').shadowRoot.querySelector('strong').textContent === 'updated', 'Vue streaming update failed');
app.unmount(); check(!vueBox.querySelector('.answer-html'), 'Vue teardown failed'); vueBox.remove();
// Production component + production directive, including real Vue Flow store lifecycles.
const { useVueFlow } = await import('@vue-flow/core');
const flowBox = document.createElement('div'); document.body.append(flowBox);
const diagram = {version:1,title:'Native architecture',summary:'Searchable relation',direction:'TB',groups:[{id:'backend',label:'Backend boundary'}],nodes:[{id:'a',label:'<img src=x onerror=window.executed=true>{{ window.executed=true }}',detail:'<script>window.executed=true</script>',group:'backend',status:'implemented'},{id:'b',label:'Consumer',status:'proposed'}],edges:[{source:'a',target:'b',label:'delivers',status:'unverified'}]};
const fence = v => '~~~answer-flow\\n'+JSON.stringify(v)+'\\n~~~';
const flowContent = ref(render(fence(diagram)+'\\n'+fence({...diagram,direction:'LR'})));
const unrelated = ref(0);
const flowApp = createApp({setup:()=>()=>withDirectives(h('div',{innerHTML:flowContent.value,'data-tick':unrelated.value}),[[vAnswerHtml]])});flowApp.mount(flowBox);await nextTick();await new Promise(r=>setTimeout(r,200));
const hosts = [...flowBox.querySelectorAll('[data-answer-flow-instance]')];
check(hosts.length===2 && hosts[0].dataset.answerFlowInstance!==hosts[1].dataset.answerFlowInstance,'stores share identity');
const stores = hosts.map(host => useVueFlow({id:host.dataset.answerFlowInstance}));
check(stores.every(s=>s.getNodes.value.length===3 && s.getEdges.value.length===1),'native nodes/edges missing');
check(stores[0].getEdges.value[0].source==='n:a' && stores[0].getEdges.value[0].target==='n:b','edge relationship lost');
check(hosts[0].querySelector('.vue-flow__edge-path') && hosts[0].querySelector('.vue-flow__node-boundary'),'native path/group boundary missing');
check(flowBox.textContent.includes('delivers') && flowBox.textContent.includes('unverified'),'edge evidence label missing');
check(!flowBox.querySelector('img,script,iframe') && !window.executed,'HTML/Vue code executed');
check(stores.every(s=>s.zoomOnScroll.value && !s.panOnScroll.value && s.preventScrolling.value),'wheel configuration missing');
check(stores.every(s=>!s.nodesDraggable.value && !s.nodesConnectable.value && s.deleteKeyCode.value===null),'read-only config missing');
check(stores[0].findNode('n:b').position.y>stores[0].findNode('n:a').position.y,'TB layout incorrect');
check(stores[1].findNode('n:b').position.x>stores[1].findNode('n:a').position.x,'LR layout incorrect');
const originalZoom = stores[1].viewport.value.zoom; await stores[0].zoomTo(1.2);check(stores[1].viewport.value.zoom===originalZoom,'viewport leaked between diagrams');
hosts[0].querySelector('.vue-flow__node-answer').click();await nextTick();check(hosts[0].querySelector('.answer-flow-detail') && !hosts[1].querySelector('.answer-flow-detail'),'selection/details leaked');
unrelated.value++;await nextTick();check(hosts[0].querySelector('.vue-flow'),'unrelated update disposed native diagram');
let destroyed=0; for(const store of stores){const destroy=store.$destroy;store.$destroy=()=>{destroyed++;destroy();};}
flowContent.value=render('~~~answer-flow\\n{"version":1,');await nextTick();check(destroyed===2 && !hosts[0].isConnected,'stream replacement failed to dispose stores');
check(flowBox.textContent.includes('incomplete or invalid') && flowBox.querySelector('pre').textContent.includes('version'),'partial JSON placeholder/source missing');
for (const bad of [{...diagram,template:'<script>window.executed=true</script>'},{...diagram,edges:[{source:'missing',target:'b'}]}]) {flowContent.value=render(fence(bad));await nextTick();check(flowBox.textContent.includes('unavailable')&&!flowBox.querySelector('script,.vue-flow'),'invalid schema executed or rendered');}
flowContent.value=render('~~~answer-flow\\n'+ 'x'.repeat(65537));await nextTick();check(flowBox.textContent.includes('exceeds 64 KiB'),'oversized stream not bounded');
flowContent.value=render('~~~answer-flow\\n'+String.fromCharCode(0xd800));await nextTick();check(flowBox.textContent.includes('unavailable'),'invalid Unicode stream threw');
flowContent.value=render(fence(diagram));await nextTick();await new Promise(r=>setTimeout(r,100));
const lastHost=flowBox.querySelector('[data-answer-flow-instance]');const lastStore=useVueFlow({id:lastHost.dataset.answerFlowInstance});const lastDestroy=lastStore.$destroy;lastStore.$destroy=()=>{destroyed++;lastDestroy();};
flowApp.unmount();check(destroyed===3 && !flowBox.querySelector('.vue-flow'),'unmount store disposal failed');flowBox.remove();
// Keep a diagram available for desktop/mobile and light/dark computed layout checks.
const persistent=document.createElement('div');persistent.id='persistent-flow';document.body.append(persistent);persistent.innerHTML=render(fence({...diagram,layout:{mode:'relative'},nodes:diagram.nodes.map((n,i)=>({...n,placement:{row:i*20,column:i*20}}))}));mountAnswerHtml(persistent);
window.answerReady = true;
} catch(e) { window.answerError = e.stack; }
`
  const server = await createServer({ root: appRoot, configFile: false, optimizeDeps: { noDiscovery: true, include: ['marked', 'dompurify', 'vue', '@vue-flow/core'] }, plugins: [vue(), { name: 'answer-test', resolveId(id) { if (id === '/answer-test.js') return '\0answer-test' }, load(id) { if (id === '\0answer-test') return script }, configureServer(server) { server.middlewares.use((req, res, next) => {
    if (req.url !== '/answer-test') return next()
    res.setHeader('Content-Type', 'text/html'); res.end(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><style>${style} body{margin:0;padding:16px;--c-text:#17202a;--c-bg-card:#fff;--c-border:#ccc;--c-blue:#2563eb;--c-bg-muted:#eee;--radius-surface:12px;--radius-control:8px} body.dark{--c-text:#eee;--c-bg-card:#252525;--c-border:#555;background:#111} </style><div data-v-answer class="prose" id="answer"></div><script type="module" src="/answer-test.js"></script>`)
  }) } }], server: { host: '127.0.0.1', port: 19140 } })
  await server.listen(); t.after(() => server.close())
  const main = `const {app,BrowserWindow}=require('electron'); app.whenReady().then(async()=>{try{
let externalRequests=[];require('electron').session.defaultSession.webRequest.onBeforeRequest((details,callback)=>{if(/^https?:/.test(details.url)&&!details.url.startsWith('http://127.0.0.1:'))externalRequests.push(details.url);callback({cancel:externalRequests.includes(details.url)});});
const w=new BrowserWindow({show:false,width:1100,height:850,webPreferences:{sandbox:true}});
let opened=[];w.webContents.setWindowOpenHandler(({url})=>{opened.push(url);return {action:'deny'};});
await w.loadURL(${JSON.stringify(server.resolvedUrls!.local[0] + 'answer-test')});
for(let i=0;i<100;i++){const state=await w.webContents.executeJavaScript('({ready:window.answerReady,error:window.answerError})');if(state.error)throw Error(state.error);if(state.ready)break;await new Promise(r=>setTimeout(r,50));}
w.show();w.focus();
for(const width of [1100,390]){w.setContentSize(width,850);
await new Promise(r=>setTimeout(r,800));
await w.webContents.executeJavaScript(\`document.querySelector('#persistent-flow [aria-label="Diagram viewport"] button:last-of-type').click()\`);
await new Promise(r=>setTimeout(r,150));
const fits=await w.webContents.executeJavaScript(\`(()=>{const c=document.querySelector('#persistent-flow .answer-flow-canvas').getBoundingClientRect();return [...document.querySelectorAll('#persistent-flow .vue-flow__node')].every(n=>{const b=n.getBoundingClientRect();return b.left>=c.left-1&&b.right<=c.right+1&&b.top>=c.top-1&&b.bottom<=c.bottom+1});})()\`);
if(!fits)throw Error('whole relative graph does not fit at width '+width+' '+await w.webContents.executeJavaScript(\`JSON.stringify([...document.querySelectorAll('#persistent-flow .answer-flow-canvas,#persistent-flow .vue-flow__node')].map(n=>({cls:n.className,rect:n.getBoundingClientRect().toJSON()})))\`));
for(const dark of [false,true]){const result=await w.webContents.executeJavaScript(\`new Promise(resolve=>{document.documentElement.classList.toggle('dark',\${dark});requestAnimationFrame(()=>requestAnimationFrame(()=>{const host=document.querySelector('.answer-html');const root=host.shadowRoot;const d=root.querySelector('details');d.querySelector('summary').click();resolve({ready:window.answerReady,overflow:document.documentElement.scrollWidth>innerWidth,grid:getComputedStyle(root.querySelector('.answer-grid')).display,strong:!!root.querySelector('strong'),open:d.open,iframe:!!root.querySelector('iframe'),color:getComputedStyle(host).color,flowColor:getComputedStyle(document.querySelector('.native-answer-flow')).color,flowWidth:document.querySelector('.answer-flow-canvas').getBoundingClientRect().width,flowHeight:document.querySelector('.answer-flow-canvas').getBoundingClientRect().height,flowEdges:document.querySelectorAll('#persistent-flow .vue-flow__edge-path').length});d.open=false;}));})\`);if(!result.ready||result.overflow||result.grid!=='grid'||!result.strong||!result.open||result.iframe)throw Error(JSON.stringify(result));if(dark&&result.color!=='rgb(231, 231, 231)')throw Error('dark theme not inherited');if(result.flowColor!==result.color||result.flowWidth>width||result.flowHeight!==400||result.flowEdges!==1)throw Error('native flow theme/mobile layout '+JSON.stringify(result));}}
// Native Chromium wheel input over the production component, not a store API call.
w.show();w.focus();
await w.webContents.executeJavaScript(\`document.querySelector('#persistent-flow').scrollIntoView();window.scrollBy(0,-80);\`);
await new Promise(r=>setTimeout(r,150));
const before=await w.webContents.executeJavaScript(\`(()=>{const c=document.querySelector('#persistent-flow .answer-flow-canvas').getBoundingClientRect();const v=document.querySelector('#persistent-flow .vue-flow__transformationpane');return {x:Math.round(c.left+c.width/2),y:Math.round(c.top+Math.min(c.height/2,100)),transform:v.style.transform,scroll:scrollY};})()\`);
w.webContents.sendInputEvent({type:'mouseMove',x:before.x,y:before.y});
w.webContents.sendInputEvent({type:'mouseWheel',x:before.x,y:before.y,deltaY:120,deltaX:0,canScroll:true});
await new Promise(r=>setTimeout(r,350));
const after=await w.webContents.executeJavaScript(\`({transform:document.querySelector('#persistent-flow .vue-flow__transformationpane').style.transform,scroll:scrollY})\`);
if(after.transform===before.transform||after.scroll!==before.scroll)throw Error('hover wheel failed '+JSON.stringify({before,after}));
w.webContents.sendInputEvent({type:'mouseMove',x:4,y:200});w.webContents.sendInputEvent({type:'mouseWheel',x:4,y:200,deltaY:120,deltaX:0,canScroll:true});await new Promise(r=>setTimeout(r,350));
if(await w.webContents.executeJavaScript('scrollY')===after.scroll)throw Error('outside canvas wheel did not scroll page');
if(!opened.includes('https://example.com/'))throw Error('safe shadow external link failed');if(externalRequests.length)throw Error('external loads '+externalRequests.join(','));console.log('ANSWER_HTML_OK');app.exit(0);}catch(e){console.error(e);app.exit(1);}});`
  await writeFile(resolve(directory, 'main.cjs'), main)
  const env = { ...process.env }; delete env.ELECTRON_RUN_AS_NODE
  const child = spawn(desktopRequire('electron'), [resolve(directory, 'main.cjs')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''; child.stdout.on('data', c => { output += c }); child.stderr.on('data', c => { output += c })
  const timer = setTimeout(() => child.kill(), 75_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, output); assert.match(output, /ANSWER_HTML_OK/)
})
