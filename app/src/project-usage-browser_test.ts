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
    optimizeDeps: { noDiscovery: true, include: ['vue', 'vue-i18n', 'echarts/core', 'echarts/charts', 'echarts/components', 'echarts/renderers'] },
    server: { host: '127.0.0.1', port: 43180, strictPort: false, watch: null },
    plugins: [vue(), {
      name: 'usage-fixture',
      resolveId: id => id === '/usage-fixture.ts' ? '\0usage-fixture' : undefined,
      load(id) {
        if (id !== '\0usage-fixture') return
        return `import '/src/styles.css';
          import { createApp, h } from 'vue';
          import { getInstanceByDom } from 'echarts/core';
          import Usage from '/src/components/ProjectUsage.vue';
          import { i18n, setLocalePreference } from '/src/i18n.ts';
          const metrics = { calls: 120, tokens: 1234567, unknownTokenCalls: 0, costs: [{currency:'USD',amount:12.34},{currency:'AI_CREDITS',amount:48400},{currency:'CNY',amount:10}], unknownCostCalls:0, durationMs:293000, unknownDurationCalls:0 };
          const data = { projectId:'fixture', asOf:'2026-10-01T12:00:00Z', timeZone:'UTC', total:metrics, today:metrics, past7Days:metrics, month:metrics,
            daily: Array.from({length:31}, (_,i) => ({date:new Date(Date.UTC(2026,9,1-i)).toISOString().slice(0,10), usage:{...metrics,tokens:10000*(i+1)}})),
            scanLimitReached:false, untrackedSessions:0, undatedCalls:0 };
          const activity = { models: [{name:'gpt-6.1-sol@account-0037227c-cf26-4d72-9b67-052b4aa88064-copilot',calls:532},{name:'gpt-6-astra@account-0037227c-cf26-4d72-9b67-052b4aa88064-copilot',calls:14}], tools: ['exec','read','write','search','message','learning_result','subagent','task','learned_skill','learning_memory','ask','log','cancel','cron_add','reply'].map((name,i)=>({name,calls:[4990,4759,3494,1640,498,317,212,187,155,66,65,65,37,36,18][i]})) };
          data.activity = {total:activity,today:activity,past7Days:activity,month:activity};
          window.fetch = async url => {
            if (String(url).endsWith('/api/project/usage')) return Response.json(data);
            if (String(url).includes('/api/project/usage/daily')) return Response.json({projectId:'fixture',asOf:data.asOf,page:1,pageSize:10,total:31,hasMore:true,daily:data.daily.slice(0,10)});
            throw new Error('Unexpected fixture request: '+url);
          };
          data.daily[0].usage = {...metrics, unknownTokenCalls:1,unknownCostCalls:1,unknownDurationCalls:1};
          data.daily[1].usage = {...metrics,tokens:0,durationMs:0,costs:[{currency:'USD',amount:0},{currency:'CNY',amount:0}]};
          data.daily[2].usage = {...metrics,tokens:null,durationMs:null,costs:[],unknownTokenCalls:1,unknownCostCalls:1,unknownDurationCalls:1};
          data.month = {...metrics,tokens:42000000};
          window.usageInstance = getInstanceByDom;
          window.usageLocale = setLocalePreference;
          window.usageApp = createApp({render:()=>h(Usage,{apiBase:location.origin+'/projects/fixture',projectId:'fixture',active:true})}).use(i18n); window.usageApp.mount('#app');`
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
            if (await win.webContents.executeJavaScript('document.querySelectorAll(".echart-plot canvas").length===3')) break;
            await new Promise(r=>setTimeout(r,50));
          }
          assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll(".echart-plot canvas").length'),3,await win.webContents.executeJavaScript('document.body.innerText'));
          for (const locale of ['en','zh-CN']) for (const dark of [false,true]) for (const width of [1180,700,350]) {
            await win.webContents.executeJavaScript('document.documentElement.classList.toggle("dark",'+dark+'); document.querySelector("#app").style.width="'+width+'px"; window.usageLocale('+JSON.stringify(locale)+');');
            // ResizeObserver + canvas resize can settle after more than one frame,
            // especially in a hidden Windows Electron window. Await the observable
            // size rather than relying on a fixed 80ms delay.
            for (let attempt=0;attempt<30;attempt++) {
              await new Promise(r=>setTimeout(r,30));
              if (await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".echart-plot")).every(e=>Math.abs(window.usageInstance(e).getWidth()-e.clientWidth)<2)')) break;
            }
            const info = await win.webContents.executeJavaScript(
              '('+(() => {
                const all=s=>Array.from(document.querySelectorAll(s));
                const box=e=>({width:e.getBoundingClientRect().width,height:e.getBoundingClientRect().height,top:e.getBoundingClientRect().top});
                const panel=document.querySelector('.project-usage');
                return {charts:all('.chart-card').map(box), plots:all('.echart-plot canvas').map(box),
                  kpis:all('.metric-card').map(box), panel:box(panel), overflow:panel.scrollWidth>panel.clientWidth,
                  radius:all('.chart-card,.metric-card,button').map(e=>getComputedStyle(e).borderRadius),
                  background:getComputedStyle(all('.chart-card')[0]).backgroundColor,
                  token:window.usageInstance(all('.echart-plot')[0]).getOption().series[0].data[0].itemStyle.color, primary:getComputedStyle(panel).getPropertyValue('--c-primary').trim(),
                  headingOverlap:all('.chart-card').some(card=>{const head=card.querySelector('.cost-heading') || card.querySelector('h3');const caption=card.querySelector('p');return head.getBoundingClientRect().bottom>caption.getBoundingClientRect().top+1;})};
              }).toString()+')()');
            assert.equal(info.charts.length,3); assert.equal(info.plots.length,3);
            assert.ok(info.plots.every(p=>p.height===240));
            assert.ok(info.radius.every(r=>r==='0px')); assert.equal(info.overflow,false);
            assert.equal(info.headingOverlap,false,JSON.stringify({locale,dark,width,info}));
            const rankings = await win.webContents.executeJavaScript('('+(() => {
              const sections = [...document.querySelectorAll('.activity-section')];
              return { rows: sections.map(s => s.querySelectorAll('.ranking-row').length),
                widths: [...document.querySelectorAll('.ranking-bar')].map(e => e.style.width),
                overflow: sections.some(s => s.scrollWidth > s.clientWidth),
                stacked: sections[1].getBoundingClientRect().top >= sections[0].getBoundingClientRect().bottom };
            }).toString()+')()');
            assert.deepEqual(rankings.rows,[2,10]); assert.equal(rankings.overflow,false); assert.equal(rankings.stacked,true);
            assert.equal(rankings.widths[0],'100%');
            assert.ok(info.charts[0].top < info.charts[1].top);
            assert.equal(info.kpis[0].top===info.kpis[2].top,width>850);
            assert.equal(info.charts[1].top===info.charts[2].top,width>850);
            assert.equal(info.background,dark?'rgb(32, 32, 32)':'rgb(255, 255, 255)');
            assert.equal(info.token,info.primary);
            assert.equal(await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".echart-plot")).every(e=>Math.abs(window.usageInstance(e).getWidth()-e.clientWidth)<2)'),true);
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
          await win.webContents.executeJavaScript('Array.from(document.querySelectorAll("button")).find(e=>e.innerText.trim()==="Last 30 days").click(); Array.from(document.querySelectorAll("button")).find(e=>e.innerText.trim()==="This month").click(); Array.from(document.querySelectorAll("button")).find(e=>e.innerText.trim()==="Load daily history").click();');
          await new Promise(r=>setTimeout(r,80));
          assert.equal(await win.webContents.executeJavaScript('window.usageInstance(document.querySelector(".echart-plot")).getOption().xAxis[0].data.length'),30);
          assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll(".daily-table tbody tr").length'),10);
          assert.equal(await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".period-switch button")).find(e=>e.innerText.trim()==="This month").getAttribute("aria-pressed")'),'true');
          // Native keyboard events exercise the accessible exact readout, not canvas markup.
          await win.webContents.executeJavaScript('document.querySelector("#app").style.width="1180px"; document.querySelector(".chart-interaction").scrollIntoView({block:"center"}); document.querySelector(".chart-interaction").focus()');
          const key = async name => { win.webContents.sendInputEvent({type:'keyDown',keyCode:name}); win.webContents.sendInputEvent({type:'keyUp',keyCode:name}); await new Promise(r=>setTimeout(r,60)); };
          const readout = () => win.webContents.executeJavaScript('document.querySelector(".chart-readout").innerText');
          await key('End'); assert.equal(await readout(),'2026-10-01: 1,234,567');
          await key('Left'); assert.equal(await readout(),'2026-09-30: 0');
          await key('Left'); assert.equal(await readout(),'2026-09-29: Unavailable');
          await key('Right'); assert.equal(await readout(),'2026-09-30: 0');
          await key('Home'); assert.match(await readout(),/^2026-09-02:/);
          await key('Escape'); assert.match(await readout(),/Hover or tap/);
          for (const [index,label] of [[1,'2026-10-01: 10 CNY'],[2,'2026-10-01: 293 s']]) {
            await win.webContents.executeJavaScript('document.querySelectorAll(".chart-interaction")['+index+'].focus()');
            await key('End');
            assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll(".chart-readout")['+index+'].innerText'),label);
          }
          await win.webContents.executeJavaScript('document.querySelector(".ui-select-trigger").click()');
          await new Promise(r=>setTimeout(r,50));
          await win.webContents.executeJavaScript('Array.from(document.querySelectorAll("[role=option]")).find(e=>e.innerText.trim()==="USD").click(); document.querySelectorAll(".chart-interaction")[1].focus()');
          await key('End');
          assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll(".chart-readout")[1].innerText'),'2026-10-01: 496.34 USD');
          // Real pointer movement uses ECharts' coordinate conversion solely for observation.
          const position = await win.webContents.executeJavaScript('(()=>{const e=document.querySelector(".echart-plot");const c=window.usageInstance(e);const p=c.convertToPixel({seriesIndex:0},[29,1234567]);const r=e.getBoundingClientRect(); document.activeElement.blur(); return {x:Math.round(r.left+p[0]),y:Math.round(r.top+p[1])};})()');
          win.webContents.sendInputEvent({type:'mouseMove',...position});
          await new Promise(r=>setTimeout(r,100));
          assert.equal(await readout(),'2026-10-01: 1,234,567');
          assert.equal(await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".usage-chart div")).some(e=>e.innerText.trim().split(String.fromCharCode(10)).join(" ")==="2026-10-01 1,234,567")'),true);
          assert.equal(await win.webContents.executeJavaScript('document.querySelector(".project-usage").scrollWidth>document.querySelector(".project-usage").clientWidth'),false);
          win.webContents.sendInputEvent({type:'mouseDown',button:'left',clickCount:1,...position});
          win.webContents.sendInputEvent({type:'mouseUp',button:'left',clickCount:1,...position});
          await new Promise(r=>setTimeout(r,80));
          assert.equal(await readout(),'2026-10-01: 1,234,567');
          assert.equal(await win.webContents.executeJavaScript('document.querySelectorAll("details.chart-data tbody tr").length'),90);
          assert.equal(await win.webContents.executeJavaScript('Array.from(document.querySelectorAll(".echart-plot")).every(e=>e.getAttribute("aria-hidden")==="true")'),true);
          await win.webContents.executeJavaScript('window.oldCharts=Array.from(document.querySelectorAll(".echart-plot")).map(e=>window.usageInstance(e)); window.usageApp.unmount(); document.documentElement.classList.toggle("dark")');
          await new Promise(r=>setTimeout(r,80));
          assert.equal(await win.webContents.executeJavaScript('window.oldCharts.every(c=>c.isDisposed())'),true);
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
