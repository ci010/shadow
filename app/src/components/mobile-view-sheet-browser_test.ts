import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { createServer } from 'vite'
import UnoCSS from 'unocss/vite'
import { withTempWorkspace } from '../../../src/testing/workspace.ts'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../../desktop/package.json', import.meta.url))

test('open view sheets fill each row and align independent close targets at narrow widths', {
  timeout: 60_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async () => {
  await withTempWorkspace(async directory => {
    const server = await createServer({
      optimizeDeps: { noDiscovery: true, include: [] }, configFile: false, root: resolve(root, 'app'), logLevel: 'error',
      plugins: [vue(), UnoCSS({ configFile: resolve(root, 'app', 'unocss.config.ts') }), {
        name: 'view-sheet-fixture',
        resolveId: id => id === '/view-entry.ts' ? '\0view-entry' : id === '/view-fixture.vue' ? resolve(root, 'app/view-fixture.vue') : undefined,
        async load(id) {
          if (id === '\0view-entry') return `import 'uno.css';import '/src/styles.css';import {createApp} from 'vue';import Fixture from '/view-fixture.vue';createApp(Fixture).mount('#app');`
          if (id !== resolve(root, 'app/view-fixture.vue')) return
          // Render the actual two production sheet templates and their scoped
          // styles, without starting unrelated file/knowledge/network services.
          const components = await Promise.all(['files/FileWorkbench.vue', 'MobileEditorChrome.vue'].map(async path => {
            const source = await readFile(resolve(root, 'app/src/components', path), 'utf8')
            const begin = source.indexOf('<MobileSheet ')
            const template = source.slice(begin, source.indexOf('</MobileSheet>', begin) + '</MobileSheet>'.length)
            const style = source.match(/<style scoped>([\s\S]*?)<\/style>/)?.[1] ?? ''
            return { template, style }
          }))
          const setup = `
            import {reactive,toRefs} from 'vue';
            import MobileSheet from '/src/components/MobileSheet.vue';
            import HoverInfo from '/src/components/HoverInfo.vue';
            const t = value => value;
            const long = 'VeryLongUnbrokenFileName'.repeat(12);
            const entry = {id:'draft',label:'New conversation',closable:true};
            const state = window.fixture = reactive({mode:0, viewsOpen:true, activated:[],closed:[],
              mobileLayout:true,mobileTitleButton:undefined,
              otherEditors:[entry], entries:[entry,{id:'chat',label:'Current conversation',closable:true},{id:'long',label:long,closable:true},{id:'diagnosis',label:'Diagnosis',closable:false},{id:'knowledge',label:'Knowledge',closable:false}],current:{id:'chat'},
              tabs:{selected:'',knowledge:true,knowledgeEntries:['long-entry'],projectTabs:['settings'],files:[{path:long,entry:{name:long}}]},
              primaryIcon:'i-lucide-messages-square',primaryLabel:'Current conversation',conversationTitle:'',diagnosisEnabled:true,knowledgeEnabled:true});
            const groups = {activate:id=>state.activated.push(id),close:id=>state.closed.push(id)};
            const chooseMobileView = id => {state.activated.push(id);state.viewsOpen=false};
            const chooseMobileKnowledge = () => chooseMobileView('knowledge');
            const openDiagnosis = () => chooseMobileView('diagnosis');
            const closeFile = id => state.closed.push(id);
            const knowledgeLabel = () => long;
            const knowledgeEntryTabKey = id => id;
            const projectTabKey = id => id;
            const projectTabLabel = () => 'Project settings';
            const projectTabIcon = () => 'i-lucide-settings';
            const fileTabKey = file => file.path;
            const fileIcon = () => 'i-lucide-file';
            const KNOWLEDGE_TAB_KEY='knowledge',DIAGNOSIS_TAB_KEY='diagnosis';
          `
          return `<script setup>${setup}const {${['mode','viewsOpen','mobileLayout','mobileTitleButton','otherEditors','entries','current','tabs','primaryIcon','primaryLabel','conversationTitle','diagnosisEnabled','knowledgeEnabled'].join(',')}}=toRefs(state);</script>
            <template><div>${components.map((c,i) => `<template v-if="mode===${i}">${c.template}</template>`).join('')}</div></template>
            <style scoped>${components.map(c=>c.style).join('\n')}</style>`
        },
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__views') return next()
            response.setHeader('Content-Type', 'text/html')
            response.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><main id="app" style="padding:16px"></main><script type="module" src="/view-entry.ts"></script></body></html>')
          })
        },
      }],
      server: { host: '127.0.0.1', port: 0 },
    })
    let child: ReturnType<typeof spawn> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await server.listen()
      const url = server.resolvedUrls?.local[0]
      assert.ok(url)
      await mkdir(join(directory, 'profile'))
      await writeFile(join(directory, 'main.cjs'), `
        const assert = require('node:assert/strict');
        const {join} = require('node:path');
                const {setTimeout:delay} = require('node:timers/promises');
        const {app,BrowserWindow} = require('electron');
        app.setPath('userData',join(process.cwd(),'profile'));
        app.on('window-all-closed',()=>{});
        async function main() {
          await app.whenReady();
          const window = new BrowserWindow({show:false,width:1200,height:1000,
            webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});
          const execute = code => window.webContents.executeJavaScript(code);
          const wait = async code => {
            const deadline=Date.now()+10000;
            while(Date.now()<deadline) {if(await execute(code)) return;await delay(40);}
            throw new Error('Timed out: '+code+'\\n'+await execute('document.body.innerText'));
          };
          const click = label => execute('Array.from(document.querySelectorAll("button")).find(b=>b.textContent.trim()==='+JSON.stringify(label)+').click()');
          try {
            await window.loadURL(new URL('__views',process.env.VIEW_SHEET_SMOKE_URL).href);
            await wait('!!document.querySelector(".mobile-view-row")');
            for(const mode of [0,1]) for(const dir of ['ltr','rtl']) for(const width of [320,390,700]) {
              window.setContentSize(width,1000);
              await execute('window.fixture.mode='+mode+';window.fixture.viewsOpen=true;document.documentElement.dir='+JSON.stringify(dir));
              await delay(250);
              const geometry = await execute(\`(() => {
                const content=document.querySelector('.mobile-sheet-content'), box=content.getBoundingClientRect(), css=getComputedStyle(content);
                const left=box.left+parseFloat(css.paddingLeft), right=box.right-parseFloat(css.paddingRight);
                return Array.from(content.querySelectorAll('.mobile-view-row')).map(row=>{
                  const r=row.getBoundingClientRect(),main=row.querySelector('button'),m=main.getBoundingClientRect(),close=row.querySelector('.mobile-view-close'),c=close?.getBoundingClientRect();
                  return {left:r.left,right:r.right,expectedLeft:left,expectedRight:right,mainLeft:m.left,mainRight:m.right,height:m.height,scroll:main.scrollWidth,client:main.clientWidth,
                    close:c?{left:c.left,right:c.right,width:c.width,height:c.height}:null,
                    selected:main.getAttribute('aria-current')==='page', background:getComputedStyle(row).backgroundColor,
                    nested:!!row.querySelector('button button')};
                });
              })()\`);
              assert.equal(geometry.length,mode===0?7:5);
              for(const row of geometry) {
                assert.ok(Math.abs(row.left-row.expectedLeft)<1,JSON.stringify(row));
                assert.ok(Math.abs(row.right-row.expectedRight)<1,JSON.stringify(row));
                assert.ok(row.height>=44);assert.equal(row.nested,false);
                assert.ok(row.scroll<=row.client+1,JSON.stringify(row));
                if(row.selected) assert.notEqual(row.background,'rgba(0, 0, 0, 0)');
                if(row.close) {
                  assert.equal(row.close.width,44);assert.ok(row.close.height>=44);
                  assert.ok(Math.abs(dir==='ltr'?row.mainRight-row.close.left:row.mainLeft-row.close.right)<1,JSON.stringify(row));
                  assert.ok(Math.abs(dir==='ltr'?row.close.right-row.right:row.close.left-row.left)<1,JSON.stringify(row));
                } else {
                  assert.ok(Math.abs(row.mainLeft-row.left)<1 && Math.abs(row.mainRight-row.right)<1,JSON.stringify(row));
                }
              }
              assert.equal(await execute('document.documentElement.scrollWidth<=innerWidth'),true);
            }
            for(const mode of [0,1]) {
              await execute('window.fixture.mode='+mode+';window.fixture.viewsOpen=true;window.fixture.closed=[];window.fixture.activated=[]');
              await delay(100);
              await execute('document.querySelector(".mobile-view-close").focus()');
              assert.equal(await execute('document.activeElement.getAttribute("aria-label").length>0'),true);
              await execute('document.activeElement.click()');
              assert.deepEqual(await execute('Array.from(window.fixture.closed)'),['draft']);
              assert.deepEqual(await execute('Array.from(window.fixture.activated)'),[]);
              assert.equal(await execute('window.fixture.viewsOpen'),true);
              await execute('document.querySelector(".mobile-view-row button").focus();document.querySelector(".mobile-view-row button").click()');
              assert.deepEqual(await execute('Array.from(window.fixture.activated)'),['draft']);
              assert.equal(await execute('window.fixture.viewsOpen'),false);
            }
            console.log('VIEW_SHEET_SMOKE_OK');
          } finally {window.destroy();}
        }
        main().then(()=>app.exit(0),error=>{console.error(error);app.exit(1)});
      `)
      const env: NodeJS.ProcessEnv = { VIEW_SHEET_SMOKE_URL: url }
      for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) {
        if (process.env[key] !== undefined) env[key] = process.env[key]
      }
      for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = directory
      child = spawn(desktopRequire('electron') as string, [join(directory, 'main.cjs')], {
        cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
      })
      let output = ''
      child.stdout!.setEncoding('utf8').on('data', chunk => { output += chunk })
      child.stderr!.setEncoding('utf8').on('data', chunk => { output += chunk })
      timer = setTimeout(() => child?.kill(), 45_000)
      const [code] = await once(child, 'close')
      assert.equal(code, 0, output)
      assert.match(output, /VIEW_SHEET_SMOKE_OK/)
    } finally {
      if (timer) clearTimeout(timer)
      if (child && child.exitCode === null) {
        const closed = once(child, 'close')
        child.kill()
        await closed
      }
      await server.close()
      await rm(join(directory, 'profile'), { recursive: true, force: true, maxRetries: 12, retryDelay: 250 })
    }
  })
})
