import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { mkdir, rm, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
const root = fileURLToPath(new URL('../..', import.meta.url))
const require = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = require('esbuild') as typeof import('esbuild')
test('rendered actions CRUD, explicit run confirmation, stop, import and search overlay geometry', { timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display.' : false }, async t => {
  const directory = resolve(root, '.test-artifacts', `quick-actions-${randomUUID()}`)
  await mkdir(directory, { recursive: true }); t.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  let actions = [{ id: 'a', name: 'Build', command: 'npm run build', folderId: 'folder', pinned: false }]
  let runs: Record<string, unknown>[] = []
  const server = await createServer({ configFile: false, root: resolve(root, 'app'), logLevel: 'error', optimizeDeps: { noDiscovery: true, include: ['vue'] }, cacheDir: resolve(directory, 'cache'), plugins: [vue(), {
    name: 'actions-fixture', resolveId: id => id === '/actions-fixture.ts' ? '\0actions-fixture' : undefined,
    load(id) { if (id !== '\0actions-fixture') return; return `import '/src/styles.css'; import {createApp,h,ref} from 'vue'; import QuickActions from '/src/components/QuickActions.vue'; import ConversationSearch from '/src/components/ConversationSearch.vue';
      const search=ref(), open=ref(false), history=ref(); window.fixture={pinned:false}; window.addEventListener('shadow:quick-actions-changed',()=>{window.fixture.pinned=true});
      createApp({render:()=>h('main',{style:'position:relative;display:flex;flex-direction:column;height:700px'},[
        h('div',[h('button',{id:'search-trigger',onClick:()=>{open.value=false;search.value.show()}},'Search'),h('button',{onClick:()=>{search.value.close();open.value=true}},'Actions')]),
        h(ConversationSearch,{ref:search,active:true,keyboardActive:true,contextKey:'p',container:history.value,loadEntries:async()=>[],revealMatch:async()=>{}}),
        open.value?h('div',{class:'actions-overlay',style:'position:absolute;top:44px;left:0;right:0;max-height:620px;overflow:auto;background:var(--c-bg)'},[h(QuickActions,{apiBase:location.origin+'/projects/p/',projectId:'p',active:true,canWrite:true,onClose:()=>open.value=false})]):null,
        h('div',{id:'history',ref:history,tabindex:-1,style:'flex:1;min-height:0'},'Messages'),h('button',{id:'outside'},'Outside')
      ])}).mount('#app');` },
    configureServer(server) { server.middlewares.use(async (req,res,next) => {
      const url = new URL(req.url!, 'http://fixture'), path=url.pathname
      const json=(data:unknown)=>{res.setHeader('Content-Type','application/json');res.end(JSON.stringify(data))}
      if(path==='/__actions'){res.setHeader('Content-Type','text/html');res.end('<div id="app"></div><script type="module" src="/actions-fixture.ts"></script>');return}
      if(!path.startsWith('/projects/p/api/')) {next();return}
      let body='';for await(const chunk of req)body+=chunk
      const data=body?JSON.parse(body):{}
      if(path.endsWith('/api/folders'))json({folders:[{id:'folder',name:'Code',path:'C:/synthetic',kind:'local'}]})
      else if(path.endsWith('/scripts'))json({packageManager:'npm',scripts:[{name:'test',command:'npm run test'}],unsupportedScripts:['unsafe name']})
      else if(path.endsWith('/stop')){runs[0]={...runs[0],state:'stopped',finishedAt:new Date().toISOString()};json({run:runs[0]})}
      else if(path.endsWith('/run')){runs=[{...actions[0],id:'r',actionId:'a',state:'running',startedAt:new Date().toISOString(),stdout:'build output',stderr:''}];json({run:runs[0]})}
      else if(path.endsWith('/runs'))json({runs})
      else if(req.method==='PATCH'){actions[0]={...actions[0],...data};json({action:actions[0]})}
      else if(req.method==='DELETE'){const id=path.split('/').at(-1)!;actions=actions.filter(a=>a.id!==id);json({deletedActionId:id})}
      else if(req.method==='POST'){const action={id:String(actions.length+1),pinned:false,...data};actions.push(action);json({action})}
      else json({actions})
    }) }
  }], server:{host:'127.0.0.1',port:0} })
  await server.listen();t.after(()=>server.close());const url=server.resolvedUrls!.local[0]!
  await build({stdin:{contents:await readFile(resolve(root,'app/src/quick-actions-smoke.fixture.txt'),'utf8'),loader:'ts',resolveDir:resolve(root,'app/src')},outfile:resolve(directory,'main.cjs'),bundle:true,platform:'node',format:'cjs',target:'node24',external:['electron'],logLevel:'silent'})
  const env: NodeJS.ProcessEnv={QUICK_ACTIONS_URL:url}; for (const key of ['SystemRoot','WINDIR','PATH','Path','ComSpec','PATHEXT','DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR']) { if(process.env[key] !== undefined) env[key]=process.env[key] }
  for (const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TMP','TEMP','TMPDIR','XDG_CONFIG_HOME','XDG_CACHE_HOME']) env[key]=directory
  const child=spawn(require('electron') as string,[resolve(directory,'main.cjs')],{cwd:directory,env,windowsHide:true,stdio:['ignore','pipe','pipe']})
  let output='';child.stdout.on('data',chunk=>output+=chunk);child.stderr.on('data',chunk=>output+=chunk)
  const timer=setTimeout(()=>child.kill(),75000);t.after(()=>{clearTimeout(timer);if(child.exitCode===null)child.kill()})
  const [code]=await once(child,'close');assert.equal(code,0,output);assert.match(output,/QUICK_ACTIONS_OK/)
})
