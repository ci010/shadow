import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
// Component integration fixture: open/onQuote and the textarea are test-owned.
// This does not exercise ProjectsWorkspace -> ProjectConversation -> ChatTab composer routing.
test('prompt components render revision-bound tabs, source metadata and selection quote events', { timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY }, async t => {
  const directory = resolve(root, '.test-artifacts', `prompt-documents-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const requests: string[] = []
  const server = await createServer({ configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'cache'), optimizeDeps: { noDiscovery: true },
    plugins: [vue(), { name: 'prompt-fixture', enforce: 'pre',
      resolveId: id => id === '/prompt-fixture.ts' ? '\0prompt-fixture' : undefined,
      load(id) { if (id !== '\0prompt-fixture') return; return `
        import '/src/styles.css';
        import {createApp,h,ref,provide,nextTick} from 'vue';
        import EditorGroupHost from '/src/components/EditorGroupHost.vue';
        import EditorViewHost from '/src/components/EditorViewHost.vue';
        import {createEditorGroups,EditorGroupsKey} from '/src/editor-groups.ts';
        import BotWorkflowInspector from '/src/components/BotWorkflowInspector.vue';
        import PromptDocument from '/src/components/PromptDocument.vue';
        import SessionDiagnosis from '/src/components/SessionDiagnosis.vue';
        import AgentsTab from '/src/components/AgentsTab.vue';
        import {createRouter,createMemoryHistory} from 'vue-router';
        const router=createRouter({history:createMemoryHistory(),routes:[{path:'/projects/:projectId/settings/:section',name:'project-settings',component:{render:()=>null}}]});
        await router.push('/projects/project-a/settings/agents');
        import {PromptDocumentsKey} from '/src/prompt-documents.ts';
        const document = ref(), quote = ref(''), groups=createEditorGroups(); window.fixture={document,quote,groups};
        const descriptor={id:'project-a:prompt',projectId:'project-a',owner:'project-a',label:'fixture / BOT.md',icon:'',closable:true,select(){},close(){document.value=undefined}};
        const conversation={id:'project-a:chat',projectId:'project-a',owner:'chat',label:'Conversation',icon:'',closable:false,conversation:{sessionId:'web:fixture',editable:true},select(){},close(){}};
        const entry={definition:{id:'bot-deployment:fixture',name:'Fixture',enabled:true},graph:[{id:'deployment:fixture',nodeType:'deployment',label:'BOT.md',config:{deployment:{id:'fixture',revision:'rev-1',state:'valid',mode:'personal'}}}]};
        createApp({setup(){provide(EditorGroupsKey,groups);provide(PromptDocumentsKey,{open(projectId,value){if(projectId!=='project-a')throw Error('wrong project');document.value=value;nextTick(()=>groups.activate(descriptor.id))}});return()=>h('main',{style:'height:100vh;display:flex;flex-direction:column'},[
          h(BotWorkflowInspector,{entry,apiBase:location.origin,projectId:'project-a',selectedNode:'deployment:fixture'}),
          h(EditorGroupHost,{projectId:'project-a',active:true}),
          h(SessionDiagnosis,{apiBase:location.origin,projectId:'project-a',sessionId:'web:fixture',physicalId:null,active:true,canReadTrace:false,working:false,systemPrompt:'Old snapshot without provenance',compactionSummary:'',tools:[],section:'prompt'}),
          h(EditorViewHost,{descriptor:conversation,selected:!document.value,active:true},()=>h('textarea',{id:'draft',value:quote.value})),
          document.value ? h(EditorViewHost,{descriptor,active:true},()=>h(PromptDocument,{document:document.value,active:groups.focused(descriptor.id),canQuote:!!groups.referenceTarget('project-a'),onQuote:text=>{if(groups.referenceTarget('project-a')?.id!==conversation.id)throw Error('wrong composer');quote.value=text;groups.activate(conversation.id)}})):null,
          h('div',{style:'display:none'},[h(AgentsTab,{apiBase:location.origin})]),
        ])}}).use(router).mount('#app');
      ` },
      configureServer(server) { server.middlewares.use((request, response, next) => {
        if (request.url === '/fixture') { response.setHeader('Content-Type', 'text/html'); response.end('<div id="app"></div><script type="module" src="/prompt-fixture.ts"></script>'); return }
        if (request.url === '/api/agent-types') {
          response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify([{name:'general',description:'Fixture role',source:'builtin',defaultMode:'session',prompt:'Definition body'}])); return
        }
        if (request.url?.startsWith('/api/agent-types/general/context')) {
          response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({systemPrompt:'Role preview',tools:[]})); return
        }
        if (request.url === '/api/sessions/web%3Afixture/context') {
          requests.push(request.url); response.setHeader('Content-Type', 'application/json');
          response.end(JSON.stringify({ systemPrompt: 'Actual runtime prompt', source: 'active-history', sections: [{ name: 'runtime-source', content: 'Actual runtime prompt', characters: 21 }] })); return
        }
        if (request.url?.startsWith('/api/')) { requests.push(request.url); response.setHeader('Content-Type', 'application/json'); response.end(JSON.stringify({id:'fixture',revision:'rev-1',prompt:'# BOT instructions\n\nFrozen deployment text\n\n<script>window.unsafe = true</script>'})); return }
        next()
      }) },
    }], server: { host: '127.0.0.1', port: 0 } })
  await server.listen(); t.after(() => server.close())
  const main = resolve(directory, 'main.cjs')
  await writeFile(main, `const {app,BrowserWindow}=require('electron');
    app.setPath('userData',require('node:path').join(process.cwd(),'profile'));
    app.on('window-all-closed',()=>{});
    app.whenReady().then(async()=>{try{
      const win=new BrowserWindow({show:false,width:1000,height:900,webPreferences:{sandbox:true,offscreen:true,backgroundThrottling:false,contextIsolation:true,nodeIntegration:false}});
      win.webContents.on('console-message',(event)=>console.log(event.message));
      await win.loadURL(${JSON.stringify(server.resolvedUrls!.local[0] + 'fixture')});
      const result=await win.webContents.executeJavaScript(\`(async()=>{
        const wait=async(fn)=>{for(let i=0;i<200;i++){if(fn())return;await new Promise(r=>setTimeout(r,25))}throw Error('fixture timeout: '+fn.toString()+' / '+document.body.innerText)};
        await wait(()=>[...document.querySelectorAll('button')].some(b=>b.textContent.includes('Open deployed BOT.md')));
        [...document.querySelectorAll('button')].find(b=>b.textContent.includes('Open deployed BOT.md')).click();
        await wait(()=>document.querySelector('.prompt-document .prompt-section'));
        if(window.fixture.document.value.source!=='BOT.md / fixture / deployed revision rev-1')throw Error('source identity lost');
        if(window.unsafe)throw Error('prompt executed');
        if(![...document.querySelectorAll('[role=tab]')].some(tab=>tab.textContent.includes('fixture / BOT.md')))throw Error('missing workbench tab');
        window.fixture.groups.move('project-a:prompt','right');
        await wait(()=>document.querySelector('[data-editor-group=right] .prompt-document'));
        await new Promise(resolve=>setTimeout(resolve,250));
        if(window.fixture.groups.referenceTarget('other-project'))throw Error('cross-project quote target');
        const target=[...document.querySelectorAll('.prompt-document .system-prompt-content p')].find(p=>p.textContent==='Frozen deployment text');
        target.scrollIntoView(); const range=document.createRange();range.selectNodeContents(target);const selection=getSelection();selection.removeAllRanges();selection.addRange(range);document.dispatchEvent(new Event('selectionchange'));
        await wait(()=>document.querySelector('.selection-menu button'));
        if(document.querySelector('.selection-menu button').disabled)throw Error('quote disabled: '+JSON.stringify(window.fixture.groups.state('project-a')));
        document.querySelector('.selection-menu button').click();
        await wait(()=>window.fixture.quote.value);
        if(window.fixture.quote.value!==['> BOT.md / fixture / deployed revision rev-1','>','> Frozen deployment text','',''].join(String.fromCharCode(10)))throw Error('wrong quote: '+window.fixture.quote.value);
        if(document.querySelector('#draft').value!==window.fixture.quote.value)throw Error('draft not updated');
        window.fixture.groups.activate('project-a:prompt');
        [...document.querySelectorAll('.prompt-document button')].find(b=>b.textContent==='Raw').click();
        await wait(()=>document.querySelector('.system-prompt-raw'));
        if(document.querySelector('.system-prompt-raw').textContent!==window.fixture.document.value.prompt)throw Error('raw text changed');
        await wait(()=>document.querySelector('.session-diagnosis .prompt-section')?.textContent.includes('Actual runtime prompt'));
        if(!document.querySelector('.session-diagnosis').textContent.includes('Current in-memory system message'))throw Error('missing runtime boundary');
        if(document.querySelector('.session-diagnosis').textContent.includes('Old snapshot without provenance'))throw Error('stale direct snapshot');
        const agentButton=[...document.querySelectorAll('.agent-overview button')].find(button=>button.textContent==='Open AGENT.md in workspace');
        if(!agentButton)throw Error('missing AGENT.md entry');
        agentButton.click();
        await wait(()=>window.fixture.document.value.prompt==='Definition body');
        if(window.fixture.document.value.source!=='builtin / general / AGENT.md (definition prompt)')throw Error('wrong role source');
        return 'PROMPT_DOCUMENTS_OK';
      })()\`);
      console.log(result); app.exit(0);
    }catch(error){console.error(error);app.exit(1)}});
  `)
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['SystemRoot','WINDIR','PATH','Path','ComSpec','PATHEXT','DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR']) if (process.env[key] !== undefined) env[key] = process.env[key]
  for (const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TMP','TEMP','TMPDIR','XDG_CONFIG_HOME','XDG_CACHE_HOME']) env[key] = directory
  const child = spawn(desktopRequire('electron') as string, [main], { cwd: directory, env, windowsHide: true, stdio: ['ignore','pipe','pipe'] })
  let output = ''; child.stdout.on('data', chunk => { output += chunk }); child.stderr.on('data', chunk => { output += chunk })
  const timer = setTimeout(() => child.kill(), 75_000); t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close'); assert.equal(code, 0, output); assert.match(output, /PROMPT_DOCUMENTS_OK/)
  assert.deepEqual(requests.sort(), ['/api/bot-package/fixture/prompt?revision=rev-1', '/api/sessions/web%3Afixture/context'])
})
