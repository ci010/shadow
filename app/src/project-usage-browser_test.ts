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

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))
const { build } = desktopRequire('esbuild') as typeof import('esbuild')

test('usage theme, fixed plots and responsive panel layout render in an isolated browser', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async context => {
  const directory = resolve(root, '.test-artifacts', `usage-${randomUUID()}`)
  await mkdir(directory, { recursive: true })
  context.after(() => rm(directory, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const server = await createServer({
    configFile: false, envFile: false, root: resolve(root, 'app'), logLevel: 'error',
    cacheDir: resolve(directory, 'vite-cache'),
    optimizeDeps: { noDiscovery: true, include: ['vue', 'vue-i18n'] },
    server: { host: '127.0.0.1', port: 43180, strictPort: false, watch: null },
    plugins: [vue(), {
      name: 'usage-fixture',
      resolveId: id => id === '/usage-fixture.ts' ? '\0usage-fixture' : undefined,
      load(id) {
        if (id !== '\0usage-fixture') return
        return `import '/src/styles.css';
          import { createApp, h } from 'vue';
          import Usage from '/src/components/ProjectUsage.vue';
          import { i18n, setLocalePreference } from '/src/i18n.ts';
          const metrics = { calls: 120, tokens: 1234567, unknownTokenCalls: 0, costs: [{currency:'USD',amount:12.34}], unknownCostCalls:0, durationMs:293000, unknownDurationCalls:0 };
          const data = { projectId:'fixture', asOf:'2026-10-01T12:00:00Z', timeZone:'UTC', total:metrics, today:metrics, past7Days:metrics, month:metrics,
            daily: Array.from({length:31}, (_,i) => ({date:new Date(Date.UTC(2026,9,1-i)).toISOString().slice(0,10), usage:{...metrics,tokens:10000*(i+1)}})),
            scanLimitReached:false, untrackedSessions:0, undatedCalls:0 };
          window.fetch = async url => {
            if (String(url).endsWith('/api/project/usage')) return Response.json(data);
            if (String(url).includes('/api/project/usage/daily')) return Response.json({projectId:'fixture',asOf:data.asOf,page:1,pageSize:10,total:31,hasMore:true,daily:data.daily.slice(0,10)});
            throw new Error('Unexpected fixture request: '+url);
          };
          window.usageLocale = setLocalePreference;
          createApp({render:()=>h(Usage,{apiBase:location.origin+'/projects/fixture',projectId:'fixture',active:true})}).use(i18n).mount('#app');`
      },
      configureServer(vite) {
        vite.middlewares.use((request, response, next) => {
          if (request.url !== '/__usage') return next()
          response.setHeader('Content-Type', 'text/html')
          response.end('<!doctype html><html><body style="margin:0"><div id="app" style="width:1180px;height:900px;display:flex"></div><script type="module" src="/usage-fixture.ts"></script></body></html>')
        })
      },
    }],
  })
  context.after(async () => { server.httpServer?.closeAllConnections(); await server.close() })
  await server.listen()
  const url = new URL('__usage', server.resolvedUrls!.local[0]).href
  await build({
    stdin: { contents: `
      const { app, BrowserWindow } = require('electron');
      const assert = require('node:assert/strict');
      const { mkdir, writeFile } = require('node:fs/promises');
      const { join } = require('node:path');
      app.setPath('userData', ${JSON.stringify(resolve(directory, 'profile'))});
      app.whenReady().then(async () => {
        const win = new BrowserWindow({show:false,width:1280,height:1000,webPreferences:{sandbox:true,contextIsolation:true}});
        win.webContents.on('console-message', event => console.log('renderer:',event.message));
        try {
          await win.loadURL(${JSON.stringify(url)});
          for (let i=0;i<200;i++) {
            if (await win.webContents.executeJavaScript('document.querySelectorAll(".chart-card > svg").length===4')) break;
            await new Promise(r=>setTimeout(r,50));
          }
          assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll(".chart-card > svg").length'),4,await win.webContents.executeJavaScript('document.body.innerText'));
          for (const locale of ['en','zh-CN']) for (const dark of [false,true]) for (const width of [1180,700,350]) {
            await win.webContents.executeJavaScript('document.documentElement.classList.toggle("dark",'+dark+'); document.querySelector("#app").style.width="'+width+'px"; window.usageLocale('+JSON.stringify(locale)+');');
            await new Promise(r=>setTimeout(r,80));
            const info = await win.webContents.executeJavaScript(
              '('+(() => {
                const all=s=>Array.from(document.querySelectorAll(s));
                const box=e=>({width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,top:e.getBoundingClientRect().top});
                const panel=document.querySelector('.project-usage');
                return {charts:all('.chart-card').map(box), plots:all('.chart-card > svg').map(box),
                  kpis:all('.metric-card').map(box), panel:box(panel), overflow:panel.scrollWidth>panel.clientWidth,
                  radius:all('.chart-card,.metric-card,button').map(e=>getComputedStyle(e).borderRadius),
                  background:getComputedStyle(all('.chart-card')[0]).backgroundColor,
                  token:getComputedStyle(all('.token-bar')[0]).fill, primary:getComputedStyle(panel).getPropertyValue('--c-primary').trim(),
                  headingOverlap:all('.chart-card').some(card=>{const head=card.querySelector('.cost-heading') || card.querySelector('h3');const caption=card.querySelector('p');return head.getBoundingClientRect().bottom>caption.getBoundingClientRect().top+1;})};
              }).toString()+')()');
            assert.equal(info.charts.length,4); assert.equal(info.plots.length,4);
            assert.ok(info.plots.every(p=>p.height===210));
            assert.ok(info.radius.every(r=>r==='0px')); assert.equal(info.overflow,false);
            assert.equal(info.headingOverlap,false,JSON.stringify({locale,dark,width,info}));
            assert.equal(new Set(info.charts.map(c=>c.height)).size,1);
            assert.equal(info.kpis[0].top===info.kpis[2].top,width>850);
            assert.equal(info.charts[0].top===info.charts[3].top,width>850);
            assert.equal(info.background,dark?'rgb(32, 32, 32)':'rgb(255, 255, 255)');
            assert.equal(info.token,dark?'rgb(139, 183, 255)':'rgb(36, 91, 193)');
            if (process.env.SHADOW_USAGE_SCREENSHOTS) {
              await mkdir(process.env.SHADOW_USAGE_SCREENSHOTS,{recursive:true});
              await writeFile(join(process.env.SHADOW_USAGE_SCREENSHOTS,locale+'-'+(dark?'dark':'light')+'-'+width+'.png'),(await win.webContents.capturePage()).toPNG());
            }
          }
          await win.webContents.executeJavaScript('window.usageLocale("en")');
          await new Promise(r=>setTimeout(r,50));
          await win.webContents.executeJavaScript('document.querySelector(".ui-select-trigger").scrollIntoView({block:"center"})');
          await new Promise(r=>setTimeout(r,50));
          await win.webContents.executeJavaScript('document.querySelector(".ui-select-trigger").click()');
          await new Promise(r=>setTimeout(r,50));
          await win.webContents.executeJavaScript('Array.from(document.querySelectorAll("[role=option]")).find(e=>e.innerText.trim()==="CNY").click()');
          await new Promise(r=>setTimeout(r,50));
          assert.equal(await win.webContents.executeJavaScript('document.querySelector(".ui-select-label").innerText'),'CNY');
          await win.webContents.executeJavaScript('Array.from(document.querySelectorAll("button")).find(e=>e.innerText==="Last 30 days").click(); Array.from(document.querySelectorAll("button")).find(e=>e.innerText==="This month").click(); Array.from(document.querySelectorAll("button")).find(e=>e.innerText==="Load daily history").click();');
          await new Promise(r=>setTimeout(r,80));
          assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll(".token-bar").length'),30);
          assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll(".daily-table tbody tr").length'),10);
          assert.equal(await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".period-switch button")).find(e=>e.innerText==="This month").getAttribute("aria-pressed")'),'true');
          console.log('USAGE_BROWSER_OK'); win.destroy(); app.exit(0);
        } catch(error) { console.error(error); win.destroy(); app.exit(1); }
      }).catch(error=>{console.error(error);app.exit(1)});
    `, resolveDir: root, sourcefile: 'usage-browser.cjs' },
    outfile: resolve(directory, 'main.cjs'), bundle: true, platform: 'node', format: 'cjs', target: 'node24', external: ['electron'], logLevel: 'silent',
  })
  const env: NodeJS.ProcessEnv = { SHADOW_USAGE_SCREENSHOTS: process.env.SHADOW_USAGE_SCREENSHOTS }
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'XAUTHORITY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) if (process.env[key] !== undefined) env[key] = process.env[key]
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = directory
  const child = spawn(desktopRequire('electron') as string, [resolve(directory, 'main.cjs')], { cwd: directory, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })
  const timeout = setTimeout(() => child.kill(), 75_000)
  context.after(() => { clearTimeout(timeout); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, output)
  assert.match(output, /USAGE_BROWSER_OK/)
})
