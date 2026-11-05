import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { compileTemplate, parse } from 'vue/compiler-sfc'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))

test('MarkdownContent caches long history while preserving reactive rendering and DOM attributes', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `markdown-content-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const { descriptor } = parse(await readFile(resolve(root, 'app/src/components/ChatTab.vue'), 'utf8'))
  const streamingMarkdown = descriptor.template!.content.match(/<MarkdownContent v-if="streamContent"[^>]+\/>/)?.[0]
  assert.ok(streamingMarkdown, 'Streaming responses must use the shared Markdown renderer')
  const compiledStream = compileTemplate({ source: streamingMarkdown, filename: 'StreamingMarkdown.vue', id: 'stream-markdown' })
  assert.deepEqual(compiledStream.errors, [])
  const script = `import {createApp,h,ref,reactive,nextTick} from 'vue';
import {render as renderStream} from '/streaming-markdown.js';
import {marked} from 'marked';
import DOMPurify from 'dompurify';
import MarkdownContent from '/src/components/MarkdownContent.vue';
import MessageCopyActions from '/src/components/MessageCopyActions.vue';
import {renderAnswerHtml} from '/src/answer-html.ts';
import {computed} from 'vue';
import {captureHistoryScroll,historyRevealRow,useProgressiveHistory} from '/src/progressive-history.ts';
import YieldDecision from '/src/components/YieldDecision.vue';
import MessageHistoryRail from '/src/components/MessageHistoryRail.vue';
const check=(ok,message)=>{if(!ok)throw Error(message)};
try {
  let calls=0;
  let parentRenders=0;
  const suffix=ref('initial');
  const state=reactive({draft:'',messages:Array.from({length:100},(_,i)=>'message-'+i),className:'prose initial',title:'History',label:'history'});
  const renderContent=text=>{calls++;return '<p><strong>'+text+'</strong><em>'+suffix.value+'</em></p>'+renderAnswerHtml('<div data-md>**'+text+'**</div>')};
  const app=createApp({setup(){return ()=>{parentRenders++;return h('main',[
    h('textarea',{value:state.draft,onInput:event=>{state.draft=event.target.value}}),
    h('output',state.draft),
    ...state.messages.map((text,index)=>h(MarkdownContent,{key:index,text,renderContent,class:state.className,title:state.title,'data-message':index,'aria-label':state.label}))
  ])}}});
  app.mount('#app');
  await nextTick();
  const nodes=()=>Array.from(document.querySelectorAll('[data-message]'));
  check(nodes().length===100 && calls===100,'initial history must render exactly once per message: '+calls);
  check(nodes().every((node,index)=>node.tagName==='DIV' && node.classList.contains('prose') && node.classList.contains('initial') && node.title==='History' && node.getAttribute('aria-label')==='history' && node.querySelector('strong')?.textContent==='message-'+index),'initial HTML or attribute fallthrough incorrect');
  check(nodes()[0].querySelector('.answer-html')?.shadowRoot?.querySelector('strong')?.textContent==='message-0','answer-html directive not mounted');
  const firstParagraph=nodes()[0].querySelector('.markdown-body > p');
  check(getComputedStyle(firstParagraph).marginTop==='0px','Markdown wrapper must not reintroduce first-paragraph top spacing');
  const initialParentRenders=parentRenders;
  const textarea=document.querySelector('textarea');
  for(const value of ['a','ab','abc','abcd','long draft','']){
    textarea.value=value;textarea.dispatchEvent(new Event('input',{bubbles:true}));await nextTick();
    check(document.querySelector('output').textContent===value,'input did not update shared parent state');
    check(calls===100,'typing rerendered cached Markdown: '+calls);
  }
  check(parentRenders===initialParentRenders+6,'fixture did not rerender parent for each keystroke');
  state.messages[42]='updated-message';await nextTick();
  check(calls===101,'editing one message must render only that message: '+calls);
  check(nodes()[42].querySelector('p strong')?.textContent==='updated-message','edited HTML missing');
  check(nodes()[41].querySelector('p strong')?.textContent==='message-41','neighbor HTML changed');
  check(nodes()[42].querySelector('.answer-html')?.shadowRoot?.querySelector('strong')?.textContent==='updated-message','answer-html directive did not update');
  suffix.value='reactive-update';await nextTick();
  check(calls===201,'renderer reactive dependency must invalidate every cached result once: '+calls);
  check(nodes().every(node=>node.querySelector('em')?.textContent==='reactive-update'),'renderer dependency did not update DOM');
  state.className='prose refreshed';state.title='Updated history';state.label='updated-history';await nextTick();
  check(calls===201,'attribute-only changes must not rerender Markdown: '+calls);
  check(nodes().every(node=>node.classList.contains('prose') && node.classList.contains('refreshed') && !node.classList.contains('initial') && node.title==='Updated history' && node.getAttribute('aria-label')==='updated-history'),'attribute/class updates did not fall through');
  check(nodes()[42].querySelector('p strong')?.textContent==='updated-message','attribute update lost HTML');
  app.unmount();
  // Use the actual ChatTab streaming markup: waiting for ask must not leave raw Markdown.
  const live=reactive({streamContent:'**Regional prices**\\n\\n| Region | Cost |\\n| --- | --- |\\n| Tokyo | $11 |',renderMarkdown:text=>DOMPurify.sanitize(marked.parse(text))});
  const streamApp=createApp({components:{MarkdownContent},setup:()=>live,render:renderStream});
  streamApp.mount('#app');await nextTick();
  check(document.querySelector('#app strong')?.textContent==='Regional prices','streaming bold was rendered as plain text');
  check(document.querySelectorAll('#app table tbody tr').length===1,'streaming table missing while ask is pending');
  live.streamContent+='\\n| Singapore | $10 |';await nextTick();
  check(document.querySelectorAll('#app table tbody tr').length===2,'streaming table did not update');
  live.streamContent+='\\n\\n<script>window.unsafe=true</'+'script>';await nextTick();
  check(!document.querySelector('#app script') && !window.unsafe,'streaming Markdown bypassed sanitization');
  live.streamContent='';await nextTick();
  check(!document.querySelector('#app table'),'flushed streaming content remained mounted');
  streamApp.unmount();
  const writes=[];
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{writes.push(value)}}});
  const source=ref('first');
  let htmlCalls=0;
  const renderer=ref(text=>{htmlCalls++;return '<p>'+text+'</p>'});
  const copyApp=createApp({setup:()=>()=>h('main',[
    h(MarkdownContent,{text:source.value,renderContent:text=>'<pre><code>'+text+'&lt;tag&gt;\\n</code></pre>'}),
    h(MessageCopyActions,{text:source.value,renderContent:renderer.value})
  ])});
  copyApp.mount('#app');await nextTick();await nextTick();
  check(htmlCalls===0,'mount eagerly rendered HTML');
  const click=async selector=>{document.querySelector(selector).click();await new Promise(resolve=>setTimeout(resolve,0));await nextTick()};
  check(document.querySelectorAll('pre .code-copy button').length===1,'missing code copy action');
  check(getComputedStyle(document.querySelector('pre')).marginBottom==='0px','Markdown wrapper must not reintroduce last-block bottom spacing');
  await click('pre .code-copy button');
  check(writes.at(-1)==='first<tag>\\n','code copy must preserve raw text, not markup');
  await click('.message-copy-actions button');
  check(writes.at(-1)==='first','Markdown copy changed source');
  check(htmlCalls===0,'Markdown copy or tooltip label rendered HTML');
  await click('.message-copy-actions .copy-icon-control:last-child button');
  check(writes.at(-1)==='<p>first</p>','HTML copy did not use rendered HTML');
  check(htmlCalls===1,'HTML click must evaluate exactly once');
  source.value='second';await nextTick();await nextTick();
  check(document.querySelectorAll('pre .code-copy button').length===1,'code update duplicated copy action');
  await click('pre .code-copy button');
  check(writes.at(-1)==='second<tag>\\n','code copy stale after update');
  check(htmlCalls===1,'text change eagerly rendered HTML');
  source.value='long message '.repeat(10000);await nextTick();
  check(htmlCalls===1,'long message update eagerly rendered HTML');
  renderer.value=text=>{htmlCalls++;return '<article>'+text+'</article>'};await nextTick();
  check(htmlCalls===1,'renderer change eagerly rendered HTML');
  const htmlButton=document.querySelector('.message-copy-actions .copy-icon-control:last-child button');
  htmlButton.dispatchEvent(new PointerEvent('pointerenter',{bubbles:true,pointerType:'mouse'}));
  await new Promise(resolve=>setTimeout(resolve,200));await nextTick();
  check(htmlCalls===1,'hover rendered HTML');
  htmlButton.click();
  check(htmlCalls===2 && writes.at(-1)==='<article>'+source.value+'</article>','click must synchronously copy latest text and renderer once');
  await nextTick();
  copyApp.unmount();
  const beforeLongMount=htmlCalls;
  const longApp=createApp({setup:()=>()=>h(MessageCopyActions,{text:source.value,renderContent:renderer.value})});
  longApp.mount('#app');await nextTick();await nextTick();
  check(htmlCalls===beforeLongMount,'mounting long message rendered HTML');
  await click('.message-copy-actions .copy-icon-control:last-child button');
  check(htmlCalls===beforeLongMount+1,'long message click did not render exactly once');
  longApp.unmount();
  // Deterministic frames, real MarkdownContent and real history rail. Record
  // actual sanitizer/render calls in each DOM commit, not a timing threshold.
  const nativeMatchMedia=window.matchMedia.bind(window);
  window.matchMedia=query=>{const result=nativeMatchMedia(query);if(query.includes('prefers-reduced-motion'))Object.defineProperty(result,'matches',{value:true});return result};
  const queued=new Map();let frameId=0;let progressiveCalls=0;
  const enabled=ref(true);const context=ref('a');const container=ref();
  const rows=ref(Array.from({length:21},(_,idx)=>({idx,key:'stable-'+idx,text:'**message '+idx+'**'})));
  let progressive;
  const scheduler={request:callback=>{queued.set(++frameId,callback);return frameId},cancel:id=>queued.delete(id)};
  const step=async()=>{check(queued.size===1,'multiple batches queued in one frame');const [id,callback]=queued.entries().next().value;queued.delete(id);callback();await nextTick();await nextTick()};
  const showDecision=ref(false);
  const decision={action:'ask',question:'External decision on old anchor',options:['Proceed','Wait'],defaultOption:'Wait',status:'unknown',sources:[]};
  const decisionAfter=computed(()=>new Map([[rows.value.find(row=>row.key==='stable-0').idx,[[99,decision]]]]));
  const mounted=()=>Array.from(document.querySelectorAll('[data-history-row-key]')).map(node=>Number(node.dataset.msgIdx));
  const progressiveApp=createApp({setup(){
    progressive=useProgressiveHistory({rows:computed(()=>rows.value.map(row=>row)),key:row=>row.key,context:()=>context.value,active:()=>enabled.value,beforeBatch:()=>container.value ? captureHistoryScroll(container.value,false) : undefined,scheduler});
    const reveal=async(index,signal)=>progressive.reveal(historyRevealRow(index,rows.value,new Map(),decisionAfter.value)?.key ?? '',signal);
    const render=text=>{progressiveCalls++;return DOMPurify.sanitize(marked.parse(text))};
    return ()=>h('main',[
      h('div',{ref:container,style:'height:100px;overflow:auto'},progressive.mountedRows.value.flatMap(row=>[h(MarkdownContent,{key:row.key,'data-msg-idx':row.idx,'data-history-row-key':row.key,text:row.text,renderContent:render,style:'display:block;height:40px'}),...(showDecision.value && decisionAfter.value.has(row.idx) ? [h(YieldDecision,{key:'external-decision',decision,'data-msg-idx':99})] : [])])),
      h(MessageHistoryRail,{entries:[...rows.value.map(row=>({index:row.idx,kind:'user',label:'User',source:'User',preview:row.text,timestamp:'2026-01-01T00:00:00Z'})),...(showDecision.value ? [{index:99,kind:'decision',label:'Decision',source:'User',preview:decision.question,timestamp:'2026-01-01T00:00:00Z'}] : [])],container:container.value,active:enabled.value,reveal})
    ])
  }});
  progressiveApp.mount('#app');await nextTick();await nextTick();
  const callBatches=[progressiveCalls];
  check(JSON.stringify(mounted())==='[17,18,19,20]' && progressiveCalls===4,'initial mount did not bound actual Markdown renders');
  document.querySelector('.history-marker').click();await nextTick();
  check(!mounted().includes(0),'rail jump synchronously mounted all history');
  while(queued.size){
    const before=progressiveCalls;const anchor=document.querySelector('[data-history-row-key]');const top=anchor.getBoundingClientRect().top;
    await step();callBatches.push(progressiveCalls-before);check(progressiveCalls-before<=4,'a single frame rendered more than its batch');
    if(queued.size)check(Math.abs(anchor.getBoundingClientRect().top-top)<1,'prepend moved the retained browsing anchor');
  }
  await nextTick();
  check(JSON.stringify(callBatches)==='[4,4,4,4,4,1]','unexpected actual render batches '+JSON.stringify(callBatches));
  check(mounted().length===21 && mounted()[0]===0 && progressiveCalls===21,'history indices or render counts changed');
  await new Promise(resolve=>setTimeout(resolve,0));await nextTick();
  check(document.querySelector('.history-marker').getAttribute('aria-current')==='true','rail did not finish its asynchronous jump to old DOM');
  check(container.value.scrollTop===0,'rail did not scroll to the revealed target');
  rows.value[20].text='**live update**<img src="data:," onerror="window.unsafe=true">';await nextTick();await nextTick();
  check(progressiveCalls===22 && !document.querySelector('[onerror]') && !window.unsafe,'streaming update rerendered neighbors or bypassed sanitizer');
  container.value.scrollTop=80;
  rows.value=[{key:'older',idx:0,text:'older segment'},...rows.value.map(row=>({...row,idx:row.idx+1}))];await nextTick();await nextTick();
  check(!mounted().includes(0) && mounted()[0]===1,'older prepend renumbered or synchronously mounted the pending prefix');
  container.value.scrollTop+=27; // deliberate browsing while older loading is pending
  const retained=document.querySelector('[data-history-row-key="stable-0"]');const retainedTop=retained.getBoundingClientRect().top;
  await step();
  check(mounted()[0]===0 && Math.abs(retained.getBoundingClientRect().top-retainedTop)<1,'older loading overwrote the latest user viewport');
  showDecision.value=true;context.value='b';await nextTick();await nextTick();
  const railJumps=[];const nativeScrollTo=container.value.scrollTo.bind(container.value);
  container.value.scrollTo=options=>{railJumps.push(options.top);nativeScrollTo(options)};
  check(!document.querySelector('.yield-decision[data-msg-idx="99"]'),'external decision anchor was not initially deferred');
  document.querySelector('.history-entry:last-child .history-marker').click();await nextTick();
  check(!railJumps.length && !document.querySelector('.yield-decision'),'decision rail jump skipped progressive reveal');
  while(queued.size)await step();await new Promise(resolve=>setTimeout(resolve,0));await nextTick();
  const decisionNode=document.querySelector('.yield-decision[data-msg-idx="99"]');
  check(decisionNode && decisionNode.textContent.includes(decision.question),'real external decision did not mount at its old anchor');
  check(railJumps.length===1 && Math.abs(decisionNode.getBoundingClientRect().top-container.value.getBoundingClientRect().top)<1,'external decision rail marker did not locate the revealed card');
  context.value='c';await nextTick();await nextTick();railJumps.length=0;
  check(!document.querySelector('.yield-decision'),'second decision reveal was not deferred');
  document.querySelector('.history-entry:last-child .history-marker').click();await nextTick();
  context.value='d';await nextTick();while(queued.size)await step();
  await new Promise(resolve=>setTimeout(resolve,0));await nextTick();
  check(railJumps.length===0,'cancelled external decision navigation jumped in the replacement context');
  context.value='e';await nextTick();await nextTick();
  document.querySelector('.history-marker').click();enabled.value=false;await nextTick();await nextTick();
  check(queued.size===0 && !mounted().includes(0),'hidden pane completed a stale rail reveal');
  enabled.value=true;await nextTick();
  check(queued.size===1,'keepalive resume did not schedule remaining history');
  progressiveApp.unmount();await nextTick();
  check(queued.size===0,'unmount left a progressive batch scheduled');
  console.log('PROGRESSIVE_RENDER_BATCHES '+JSON.stringify(callBatches));
  window.result='MARKDOWN_CONTENT_OK';
} catch(error) {window.result=error.stack || String(error)}
`
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [{
      name: 'markdown-content-fixture',
      resolveId: id => id === '/markdown-content-fixture.ts' ? '\0markdown-content-fixture' : id === '/streaming-markdown.js' ? '\0streaming-markdown' : undefined,
      load: id => id === '\0markdown-content-fixture' ? script : id === '\0streaming-markdown' ? compiledStream.code : undefined,
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== '/__markdown-content') return next()
          response.setHeader('Content-Type', 'text/html')
          response.end('<!doctype html><html><body><div id="app"></div><script type="module" src="/markdown-content-fixture.ts"></script></body></html>')
        })
      },
    }, vue()],
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  t.after(() => server.close())
  const url = server.resolvedUrls!.local[0] + '__markdown-content'
  await writeFile(resolve(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.setPath('userData',require('node:path').join(__dirname,'profile'));app.whenReady().then(async()=>{try{const w=new BrowserWindow({show:false,webPreferences:{sandbox:true}});await w.loadURL(${JSON.stringify(url)});let result;for(let i=0;i<200;i++){result=await w.webContents.executeJavaScript('window.result');if(result)break;await new Promise(r=>setTimeout(r,50));}if(result!=='MARKDOWN_CONTENT_OK')throw Error(result||'fixture timed out');console.log(result);app.exit(0)}catch(e){console.error(e);app.exit(1)}});`)
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = directory
  const child = spawn(desktopRequire('electron') as string, [resolve(directory, 'main.cjs')], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })
  const timer = setTimeout(() => child.kill(), 75_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, output)
  assert.match(output, /MARKDOWN_CONTENT_OK/)
})
