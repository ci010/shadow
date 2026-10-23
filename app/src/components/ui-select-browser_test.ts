import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import vue from '@vitejs/plugin-vue'
import { createServer } from 'vite'
import { withTempWorkspace } from '../../../src/testing/workspace.ts'

const root = fileURLToPath(new URL('../../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../../desktop/package.json', import.meta.url))

test('UiSelect browser: keyboard, live options, real change targets, forms, nested overlays, viewport and teardown', {
  timeout: 60_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async () => {
  await withTempWorkspace(async directory => {
    const server = await createServer({
      configFile: false, root: resolve(root, 'app'), logLevel: 'error', optimizeDeps: { noDiscovery: true, include: ['vue'], entries: [] }, plugins: [vue(), {
        name: 'ui-select-fixture',
        resolveId: id => ['/ui-select-fixture.ts', '/ui-select-fixture.vue'].includes(id) ? id : undefined,
        load(id) {
          if (id === '/ui-select-fixture.ts') return `import '/src/styles.css'; import {createApp} from 'vue'; import Fixture from '/ui-select-fixture.vue'; createApp(Fixture).mount('#app');`
          if (id !== '/ui-select-fixture.vue') return
          return `<script setup>
            import {reactive,nextTick} from 'vue';
            window.flush=async()=>{await nextTick();await nextTick();await nextTick();};
            import UiSelect from '/src/components/UiSelect.vue';
            import {isSelectPopupEventInside} from '/src/select-control.ts';
            const state = window.fixture = reactive({model:2, controlled:'a', disabled:false, mounted:true, changes:[], outside:0,
              options:[{value:1,label:'Apple'},{value:2,label:'Apricot'},{value:3,label:'Banana',disabled:true},{value:4,label:'Blueberry'}]});
            function change(event) {state.changes.push({value:event.target.value,native:event.target instanceof HTMLSelectElement,model:state.model});}
            document.addEventListener('pointerdown',event=>{const parent=document.querySelector('#parent'); if(parent && !event.composedPath().includes(parent) && !isSelectPopupEventInside(event,parent))state.outside++;},true);
          </script>
          <template><main><div id="parent" style="width:240px;overflow:hidden">
            <form id="form"><label for="fruit">Fruit</label>
              <UiSelect v-if="state.mounted" id="fruit" v-model.number="state.model" name="fruit" required :disabled="state.disabled" title="Choose fruit" class="custom-field" style="width:220px" @change="change">
                <option value="" disabled>Choose fruit</option><option v-for="option in state.options" :key="option.value" :value="option.value" :disabled="option.disabled" lang="en">{{option.label}}</option>
              </UiSelect><button id="after" type="button">After</button><button id="reset" type="reset">Reset</button>
            </form>
            <UiSelect id="controlled" :value="state.controlled" aria-label="Controlled" @change="state.controlled=$event.target.value"><option value="a">Alpha</option><option value="b">Beta</option></UiSelect>
            <UiSelect id="string-number" v-model.number="state.numeric" aria-label="Numeric strings"><option value="10">Ten</option><option value="20">Twenty</option></UiSelect>
            <UiSelect id="uncontrolled" aria-label="Uncontrolled"><option>First</option><optgroup label="Disabled group" disabled><option>Blocked</option></optgroup><option selected>Last</option></UiSelect>
            <UiSelect id="all-disabled" aria-label="All disabled"><option disabled>Disabled</option></UiSelect>
          </div><button id="outside" type="button">Outside</button></main></template>
          <style scoped>.custom-field {border-width:2px;padding:4px 8px;min-height:32px} @media(max-width:700px){.custom-field{min-height:44px}}</style>`
        },
        configureServer(server) {
          server.middlewares.use((request, response, next) => {
            if (request.url !== '/__select') return next()
            response.setHeader('Content-Type', 'text/html')
            response.end('<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width,initial-scale=1"></head><body><div id="app" style="padding:16px"></div><script type="module" src="/ui-select-fixture.ts"></script></body></html>')
          })
        },
      }], server: { host: '127.0.0.1', port: 0 },
    })
    let child: ReturnType<typeof spawn> | undefined
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      await server.listen()
      const url = server.resolvedUrls?.local[0]
      assert.ok(url)
      await mkdir(join(directory, 'profile'))
      await writeFile(join(directory, 'main.cjs'), `
        const assert=require('node:assert/strict'); const {join}=require('node:path');
        const {setTimeout:delay}=require('node:timers/promises'); const {app,BrowserWindow}=require('electron');
        app.setPath('userData',join(process.cwd(),'profile')); app.on('window-all-closed',()=>{});
        async function main(){
          await app.whenReady(); const window=new BrowserWindow({show:false,width:1000,height:800,webPreferences:{contextIsolation:true,sandbox:true,nodeIntegration:false,backgroundThrottling:false}});
          window.webContents.on('console-message',(_event,level,message)=>console.log('RENDERER',level,message)); window.webContents.on('render-process-gone',(_event,details)=>console.log('RENDER_GONE',details)); setTimeout(()=>{console.error('HARD_DEADLINE');app.exit(2)},20000);
          const execute=async code=>{console.log('SELECT_STEP',code);try{return await Promise.race([window.webContents.executeJavaScript(code),delay(10000).then(()=>{throw new Error('Renderer deadline exceeded')})]);}catch(error){throw new Error(code+'\\n'+error);}};
          const wait=async code=>{const deadline=Date.now()+10000;while(Date.now()<deadline){if(await execute(code))return;await delay(30);}throw new Error('Timed out: '+code+'\\n'+await execute('document.body.innerText'));};
          const flush=()=>execute('window.flush()');
          const key=async(key,id='fruit')=>{await execute('document.getElementById('+JSON.stringify(id)+').dispatchEvent(new KeyboardEvent("keydown",{key:'+JSON.stringify(key)+',bubbles:true,cancelable:true}))');await flush();};
          const click=async selector=>{await execute('document.querySelector('+JSON.stringify(selector)+').click()');await flush();};
          try {
            await window.loadURL(new URL('__select',process.env.SELECT_UI_URL).href);
            await wait('document.querySelector("#fruit")?.textContent.includes("Apricot")');
            assert.equal(await execute('document.querySelector("#fruit").tagName'),'BUTTON');
            assert.equal(await execute('document.querySelector("#fruit").labels.length'),1);
            assert.ok(await execute('parseFloat(getComputedStyle(document.querySelector(".custom-field")).borderTopWidth)')>1,'Parent scoped styles reach the single root');
            assert.equal(await execute('document.querySelector("#fruit").title'),'Choose fruit');
            assert.equal(await execute('document.querySelector("#uncontrolled").textContent.trim()'),'Last');
            assert.equal(await execute('new FormData(document.querySelector("form")).get("fruit")'),'2');
            assert.equal(await execute('document.querySelector(".ui-select-native").tabIndex'),-1);
            assert.equal(await execute('getComputedStyle(document.querySelector(".ui-select-native")).pointerEvents'),'none');
            await key('ArrowDown');
            assert.equal(await execute('document.querySelector("#fruit").getAttribute("aria-expanded")'),'true');
            assert.equal(await execute('document.activeElement.id'),'fruit');
            assert.equal(await execute('document.querySelector(".ui-select-popup").parentElement===document.body'),true);
            assert.equal(await execute('document.querySelector(".ui-select-popup").getAttribute("aria-label")'),'Fruit');
            assert.equal(await execute('document.querySelector(".is-selected .ui-select-check")!==null'),true);
            await key('ArrowDown');
            assert.equal(await execute('document.querySelector(".is-active").textContent.trim()'),'Blueberry');
            await key('Enter');
            assert.equal(await execute('window.fixture.model'),4);
            assert.deepEqual(await execute('JSON.parse(JSON.stringify(window.fixture.changes[0]))'),{value:'4',native:true,model:4});
            assert.equal(await execute('document.querySelector(".ui-select-popup")'),null);
            await key('Home'); await key('End'); await key('Escape');
            assert.equal(await execute('window.fixture.model'),4,'Escape cancels navigation');
            await key('a');
            assert.equal(await execute('window.fixture.model'),1);
            await key('a');
            assert.equal(await execute('window.fixture.model'),2,'Repeated typeahead cycles');
            await execute('window.fixture.options[1].label="Apricot translated"'); await flush();
            assert.equal(await execute('document.querySelector("#fruit").textContent.trim()'),'Apricot translated');
            await key('ArrowDown');
            assert.equal(await execute('document.querySelector(".is-selected").lang'),'en');
            await execute('document.querySelector(".ui-select-option:last-child").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,composed:true,pointerType:"mouse",cancelable:true}))');
            assert.equal(await execute('window.fixture.outside'),0,'Ancestor capture handler recognizes teleported child');
            await click('.ui-select-option:last-child');
            assert.equal(await execute('window.fixture.model'),4);
            await key('ArrowDown'); await key('Tab');
            assert.equal(await execute('document.querySelector(".ui-select-popup")'),null,'Tab dismisses without trapping');
            await key('ArrowDown');
            await execute('document.querySelector("#outside").dispatchEvent(new PointerEvent("pointerdown",{bubbles:true,composed:true}))'); await flush();
            assert.equal(await execute('document.querySelector(".ui-select-popup")'),null);
            await click('#reset');
            assert.equal(await execute('window.fixture.model'),2,'Reset restores initial model and native selected value');
            await execute('window.fixture.model=""'); await flush();
            assert.equal(await execute('document.querySelector("#form").reportValidity()'),false);
            assert.equal(await execute('document.activeElement.id'),'fruit');
            await flush();
            assert.equal(await execute('document.querySelector("#fruit").getAttribute("aria-invalid")'),'true');
            await key('ArrowDown'); await key('Home'); await key('Enter');
            assert.equal(await execute('document.querySelector("#form").checkValidity()'),true);
            await key('ArrowDown','controlled'); await key('End','controlled'); await key('Enter','controlled');
            assert.equal(await execute('window.fixture.controlled'),'b',':value/@change retains real string target');
            await key('End','string-number'); await key('Enter','string-number');
            assert.equal(await execute('window.fixture.numeric'),20,'v-model.number converts string options');
            await key('Home','uncontrolled'); await key('ArrowDown','uncontrolled');
            assert.equal(await execute('document.querySelector(".is-active").textContent.trim()'),'Last','Disabled optgroup skipped');
            await key('Escape','uncontrolled');
            await key('ArrowDown','all-disabled'); await key('ArrowDown','all-disabled'); await key('Enter','all-disabled'); await key('Escape','all-disabled');
            await execute('window.fixture.disabled=true'); await flush(); await click('#fruit');
            assert.equal(await execute('document.querySelector(".ui-select-popup")'),null);
            assert.equal(await execute('new FormData(document.querySelector("#form")).has("fruit")'),false);
            await execute('window.fixture.disabled=false;window.fixture.options=Array.from({length:40},(_,i)=>({value:i+1,label:"Option "+(i+1)}));window.fixture.model=2;document.querySelector("#parent").style.cssText="position:fixed;bottom:8px;right:8px;width:240px;overflow:hidden"'); await flush();
            await key('ArrowDown');
            assert.equal(await execute('document.querySelector(".ui-select-popup").dataset.placement'),'top');
            await key('End');
            assert.ok(await execute('document.querySelector(".ui-select-popup").scrollTop')>0);
            assert.equal(await execute('window.scrollY'),0,'Option navigation does not move the page');
            for(const width of [390,1000]){
              window.setContentSize(width,800); await delay(40); await execute('window.dispatchEvent(new Event("resize"))'); await flush();
              assert.equal(await execute('(()=>{const r=document.querySelector(".ui-select-popup").getBoundingClientRect();return r.left>=0&&r.right<=innerWidth&&r.top>=0&&r.bottom<=innerHeight})()'),true,'Popup stays in viewport');
              if(width===390)assert.ok(await execute('document.querySelector(".ui-select").getBoundingClientRect().height')>=44);
            }
            await execute('window.fixture.options=[]'); await flush();
            assert.equal(await execute('document.querySelector("#fruit").getAttribute("aria-activedescendant")'),null);
            await execute('window.fixture.mounted=false'); await flush();
            assert.equal(await execute('document.querySelector(".ui-select-popup")'),null);
            await execute('window.dispatchEvent(new Event("resize"));window.dispatchEvent(new Event("scroll"))');
            console.log('UI_SELECT_BROWSER_OK');
          }finally{window.destroy();}
        }
        main().then(()=>app.exit(0),error=>{console.error(error);app.exit(1)});
      `)
      const env: NodeJS.ProcessEnv = { SELECT_UI_URL: url }
      for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) if (process.env[key] !== undefined) env[key] = process.env[key]
      for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = directory
      child = spawn(desktopRequire('electron') as string, [join(directory, 'main.cjs')], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
      let output = ''
      child.stdout!.setEncoding('utf8').on('data', chunk => { output += chunk; process.stdout.write(chunk) })
      child.stderr!.setEncoding('utf8').on('data', chunk => { output += chunk; process.stderr.write(chunk) })
      timer = setTimeout(() => child?.kill(), 45_000)
      const [code] = await once(child, 'close')
      assert.equal(code, 0, output)
      assert.match(output, /UI_SELECT_BROWSER_OK/)
    } finally {
      if (timer) clearTimeout(timer)
      if (child && child.exitCode === null) { const closed = once(child, 'close'); child.kill(); await closed }
      await server.close()
      await rm(join(directory, 'profile'), { recursive: true, force: true, maxRetries: 12, retryDelay: 250 })
    }
  })
})
