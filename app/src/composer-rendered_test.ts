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

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

test('rendered composer distinguishes queue actions and routes custom question answers with attachments', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts', `composer-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const server = await createServer({
    configFile: false, root: resolve(root, 'app'), logLevel: 'error', cacheDir: resolve(directory, 'vite-cache'),
    optimizeDeps: { noDiscovery: true, include: [] },
    plugins: [{
      name: 'synthetic-composer', enforce: 'pre',
      resolveId: id => id === '/composer-fixture.ts' ? '\0composer-fixture' : undefined,
      load(id) {
        if (id.replaceAll('\\', '/').endsWith('/components/files/FileWorkbench.vue')) {
          return `<template><main style="display:flex;flex:1;min-height:0;flex-direction:column"><slot/><slot name="composer"/></main></template>
            <script setup>defineExpose({showConversation(){},openLinkedFile(){}})</script>`
        }
        if (id.replaceAll('\\', '/').includes('/components/') && id.endsWith('.vue')
          && !['ChatTab', 'YieldQuestion', 'ComposerPopover', 'OverlayTransition', 'SlashCommandMenu', 'MessageAttachments', 'ModelSelector', 'ReasoningControls', 'MobileSheet'].some(name => id.endsWith(`/${name}.vue`))) {
          return '<template><span/></template><script setup>defineExpose({dismiss(){},show(){},rename(){},showDetails(){}})</script>'
        }
        if (id !== '\0composer-fixture') return
        return `import 'uno.css'; import '/src/styles.css';
          import { createApp, h, ref } from 'vue';
          import { createRouter, createMemoryHistory } from 'vue-router';
          import { provideMobileChrome } from '/src/composables/useMobileChrome.ts';
          import { provideModelSelection } from '/src/model-selection.ts';
          import ChatTab from '/src/components/ChatTab.vue';
          import YieldQuestion from '/src/components/YieldQuestion.vue';
          const sessionId = 'web:chat-composer-fixture';
          const qqId = 'bot:fixture:bot:qq:group%3Afixture';
          const channelIds = [qqId, 'bot:fixture:bot:discord:fixture', 'bot:fixture:bot:feishu:fixture', 'discord:legacy', 'feishu:legacy'];
          const selectedSession = ref(sessionId);
          const view = ref();
          const dedicated = ref(false);
          const fixture = {sent:[], answers:[], uploads:[], patches:[], configs:{}, question:null, reject:false, rejectSettings:false, sequence:0,
            get config() {return this.configs[selectedSession.value] ??= {};},
            state:() => view.value.$.setupState,
            showDedicated:() => {dedicated.value=true;},
            showQQ:() => {fixture.question=null; selectedSession.value=qqId;},
            showChannel:id => {fixture.question=null; selectedSession.value=id;},
            showWeb:() => {selectedSession.value=sessionId;},
            reset() {const state=this.state(); state.requestControls.clear(); state.streaming=false; state.sessionStages={[sessionId]:'idle'}; state.currentWorkdir={kind:'local',displayPath:'C:\\\\fixture',available:true};},
            ask(kind='decision') {
              this.reset();
              this.question={id:'question-' + (++this.sequence),sessionId,question:'Which approach should I use?',
                recipient:{kind:'user',sessionId},createdAt:new Date().toISOString(),deadline:null,
                ...(kind === 'input' ? {kind,origin:{physicalId:'fixture-0',toolCallId:'ask'}}
                  : {options:['Minimal change','Full refactor'],defaultOption:'Minimal change'})};
              this.state().sessionStages={[sessionId]:'waiting'};
            }};
          const nativeFetch=window.fetch.bind(window);
          window.fetch=async (input, init={}) => {
            const url=new URL(String(input),location.origin);
            if (!url.pathname.includes('/api/')) return nativeFetch(input,init);
            const json=(data,status=200) => Promise.resolve(Response.json(data,{status}));
            if (url.pathname.endsWith('/graph')) return json({nodes:[],sessions:[
              {sessionId,mode:'session',segmentIndex:0,label:'Composer fixture'},
              ...channelIds.map(id=>({sessionId:id,mode:'session',segmentIndex:0,label:'Channel fixture',config:fixture.configs[id] ?? {},
                inferenceDefaults:{model:'gpt-agent@fixture',thinking:{type:'enabled'},reasoningEffort:'low'}})),
            ]});
            if (url.pathname.endsWith('/config') && init.method === 'PATCH') {
              const key=decodeURIComponent(url.pathname.split('/').at(-2));
              const patch=JSON.parse(init.body);fixture.patches.push({key,patch});
              if (fixture.rejectSettings) return json({error:'Synthetic settings conflict'},409);
              const config=fixture.configs[key] ??= {};
              for (const [name,value] of Object.entries(patch)) {if(value===null) delete config[name];else config[name]=value;}
              return json({key,config});
            }
            if (url.pathname.endsWith('/stages')) return json({stages:{[sessionId]:fixture.question?'waiting':'idle'}});
            if (url.pathname.endsWith('/ask')) {
              if (init.method === 'POST') {
                const body=JSON.parse(init.body); fixture.answers.push(body);
                if (fixture.reject) return json({message:'Synthetic answer conflict'},409);
                const answer={requestId:body.requestId,answeredBy:'user',answeredAt:new Date().toISOString(),
                  ...(body.text !== undefined ? {text:body.text} : {option:body.customText ?? body.option,...(body.customText !== undefined ? {custom:true}: {})}),
                  ...(body.media ? {media:body.media}: {})};
                fixture.question=null;
                return json({answer});
              }
              return json({request:fixture.question});
            }
            if (url.pathname.endsWith('/upload')) {
              const file=init.body.get('file'); fixture.uploads.push(file.name);
              return json({path:'C:\\\\fixture\\\\uploads\\\\' + file.name});
            }
            if (url.pathname.endsWith('/send')) {
              const body=JSON.parse(init.body); fixture.sent.push(body);
              return json({chatId:body.chatId,requestId:'turn-' + fixture.sent.length});
            }
            if (url.pathname.endsWith('/chat/session')) return json({history:[],decisionRecords:[],commandResults:[],systemPrompt:'',tools:[]});
            return json({sessionId,segmentIndex:0,messages:[],decisionRecords:[],commandResults:[],workdir:{kind:'local',displayPath:'C:\\\\fixture',available:true}});
          };
          const router=createRouter({history:createMemoryHistory(),routes:[{path:'/chat/:projectId/:sessionId?',name:'chat',component:{render:() => null}}]});
          await router.push('/chat/fixture/' + sessionId);
          const app=createApp({setup() {
            provideMobileChrome();
            provideModelSelection({current:ref('gpt-project@fixture'),defaultReasoning:ref({reasoningEffort:'medium'}),
              options:ref(['gpt-agent@fixture','gpt-override@fixture']),disabled:ref(false),loading:ref(false),error:ref(''),
              select:async()=>{throw new Error('Conversation controls must not change project defaults');}});
            return () => dedicated.value
              ? h(YieldQuestion,{sessionId,apiBase:location.origin + '/projects/fixture',active:true,stage:'waiting',canAnswer:true})
              : h(ChatTab,{key:selectedSession.value,ref:view,managed:true,projectId:'fixture',sessionId:selectedSession.value,apiBase:location.origin + '/projects/fixture'});
          }});
          app.provide(Symbol.for('shadow.live-client-pool'),{client:() => ({subscribe:() => ({ready:async()=>{},close(){}})}),dispose(){}});
          app.use(router).mount('#app');
          window.__composerFixture=fixture;`
      },
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.url !== '/__composer') return next()
          response.setHeader('Content-Type', 'text/html')
          response.end('<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1"></head><body><div id="app" style="height:100dvh;display:flex"></div><script type="module" src="/composer-fixture.ts"></script></body></html>')
        })
      },
    }, vue(), UnoCSS({ configFile: resolve(root, 'app', 'unocss.config.ts') })],
    server: { host: '127.0.0.1', port: 0 },
  })
  await server.listen()
  t.after(() => server.close())
  await build({
    entryPoints: [resolve(root, 'desktop', 'tests', 'fixtures', 'composer-smoke.ts')],
    outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs',
    target: 'node24', external: ['electron'], logLevel: 'silent',
  })
  const env: NodeJS.ProcessEnv = { COMPOSER_SMOKE_URL: server.resolvedUrls!.local[0], COMPOSER_SCREENSHOTS: process.env.COMPOSER_SCREENSHOTS }
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
  assert.match(output, /COMPOSER_SMOKE_OK/)
})
