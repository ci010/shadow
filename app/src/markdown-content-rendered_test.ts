import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
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
  const script = `import {createApp,h,ref,reactive,nextTick} from 'vue';
import MarkdownContent from '/src/components/MarkdownContent.vue';
import MessageCopyActions from '/src/components/MessageCopyActions.vue';
import {renderAnswerHtml} from '/src/answer-html.ts';
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
  const writes=[];
  Object.defineProperty(navigator,'clipboard',{configurable:true,value:{writeText:async value=>{writes.push(value)}}});
  const source=ref('first');
  const copyApp=createApp({setup:()=>()=>h('main',[
    h(MarkdownContent,{text:source.value,renderContent:text=>'<pre><code>'+text+'&lt;tag&gt;\\n</code></pre>'}),
    h(MessageCopyActions,{text:source.value,renderContent:text=>'<p>'+text+'</p>'})
  ])});
  copyApp.mount('#app');await nextTick();await nextTick();
  const click=async selector=>{document.querySelector(selector).click();await new Promise(resolve=>setTimeout(resolve,0));await nextTick()};
  check(document.querySelectorAll('pre .code-copy button').length===1,'missing code copy action');
  await click('pre .code-copy button');
  check(writes.at(-1)==='first<tag>\\n','code copy must preserve raw text, not markup');
  await click('.message-copy-actions button');
  check(writes.at(-1)==='first','Markdown copy changed source');
  await click('.message-copy-actions .copy-icon-control:last-child button');
  check(writes.at(-1)==='<p>first</p>','HTML copy did not use rendered HTML');
  source.value='second';await nextTick();await nextTick();
  check(document.querySelectorAll('pre .code-copy button').length===1,'code update duplicated copy action');
  await click('pre .code-copy button');
  check(writes.at(-1)==='second<tag>\\n','code copy stale after update');
  copyApp.unmount();
  window.result='MARKDOWN_CONTENT_OK';
} catch(error) {window.result=error.stack || String(error)}
`
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [{
      name: 'markdown-content-fixture',
      resolveId: id => id === '/markdown-content-fixture.ts' ? '\0markdown-content-fixture' : undefined,
      load: id => id === '\0markdown-content-fixture' ? script : undefined,
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
  await writeFile(resolve(directory, 'main.cjs'), `const {app,BrowserWindow}=require('electron');app.whenReady().then(async()=>{try{const w=new BrowserWindow({show:false,webPreferences:{sandbox:true}});await w.loadURL(${JSON.stringify(url)});let result;for(let i=0;i<200;i++){result=await w.webContents.executeJavaScript('window.result');if(result)break;await new Promise(r=>setTimeout(r,50));}if(result!=='MARKDOWN_CONTENT_OK')throw Error(result||'fixture timed out');console.log(result);app.exit(0)}catch(e){console.error(e);app.exit(1)}});`)
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
