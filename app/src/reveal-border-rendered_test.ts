import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { createServer } from 'vite'

const root = fileURLToPath(new URL('../..', import.meta.url))
const desktopRequire = createRequire(new URL('../../desktop/package.json', import.meta.url))

test('rendered Reveal proximity, state preservation, accessibility, lifecycle and preview', {
  timeout: 90_000,
  skip: process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root, '.test-artifacts/reveal-border-preview')
  const runtime = resolve(directory, 'runtime')
  await mkdir(runtime, { recursive: true })
  t.after(() => rm(runtime, { recursive: true, force: true, maxRetries: 12, retryDelay: 250 }))
  const server = await createServer({ configFile: false, root: resolve(root, 'app'), logLevel: 'error',
    cacheDir: resolve(runtime, 'vite-cache'), optimizeDeps: { noDiscovery: true, include: [] }, server: { host: '127.0.0.1', port: 0, watch: null, hmr: false },
    plugins: [{ name: 'reveal-fixture', configureServer(server) {
      server.middlewares.use((req, res, next) => {
        if (req.url !== '/__reveal') return next()
        res.setHeader('Content-Type', 'text/html')
        res.end(`<!doctype html><html><head><meta charset="utf-8"><link rel="stylesheet" href="/src/styles.css"><style>
          body{margin:0;padding:80px;font:14px system-ui;background:var(--c-bg)}
          .row{display:flex;gap:24px}.reveal-border{width:220px;height:110px;padding:16px;box-sizing:border-box;border:1px solid var(--c-border);background:var(--c-bg-card)}
          h1{font-size:18px;color:var(--c-text)}p{color:var(--c-text-secondary)}
          .selected{border-color:var(--c-selection-border)}.error{border-color:var(--c-error)}
          #clip{height:50px;overflow:hidden;margin-top:24px}#large{height:350px;margin-top:24px}
        </style></head><body><h1>Fluent Reveal · synthetic small-surface fixture</h1><p>Move near the gap: only local border segments illuminate.</p>
          <div class="row"><article id="a" class="reveal-border">Provider card</article><article id="b" class="reveal-border">Work item</article></div>
          <div id="clip"><div id="clipped" class="reveal-border">Clipped card</div></div>
          <div id="large" class="reveal-border">Large panels stay quiet</div>
          <script type="module">
            import {installRevealBorder} from '/src/reveal-border.ts';
            window.framesRequested=0;const raf=window.requestAnimationFrame.bind(window);
            window.requestAnimationFrame=(cb)=>{window.framesRequested++;return raf(cb)};
            window.observerDisconnects=0;window.nativeIO=window.IntersectionObserver;window.nativeMO=window.MutationObserver;
            window.IntersectionObserver=class extends window.nativeIO{disconnect(){window.observerDisconnects++;super.disconnect()}};
            window.MutationObserver=class extends window.nativeMO{disconnect(){window.observerDisconnects++;super.disconnect()}};
            window.stopReveal=installRevealBorder();window.ready=true;
          </script></body></html>`)
      })
    } }],
  })
  await server.listen()
  t.after(() => server.close())
  const url = new URL('__reveal', server.resolvedUrls!.local[0]).href
  const main = resolve(runtime, 'main.cjs')
  await writeFile(main, `const {app,BrowserWindow}=require('electron');const assert=require('node:assert/strict');const fs=require('node:fs/promises');
    app.setPath('userData',require('node:path').join(process.cwd(),'profile'));app.on('window-all-closed',()=>{});
    app.whenReady().then(async()=>{const win=new BrowserWindow({width:900,height:850,show:false,webPreferences:{contextIsolation:true,nodeIntegration:false,sandbox:true,backgroundThrottling:false,offscreen:true}});
    try{await win.loadURL(${JSON.stringify(url)});const run=s=>win.webContents.executeJavaScript(s);for(let i=0;i<100&&!await run('window.ready');i++)await new Promise(r=>setTimeout(r,50));
    await run(
      \`window.wait=ms=>new Promise(r=>setTimeout(r,ms));window.a=document.querySelector('#a');window.b=document.querySelector('#b');
        window.near=()=>{const r=a.getBoundingClientRect();document.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:r.right+12,clientY:r.top+55}));};
        window.opacity=el=>el.classList.contains('reveal-border-target')?Number(getComputedStyle(el,'::after').opacity):0;
        window.originalBorder=getComputedStyle(a).borderColor;window.originalRect=a.getBoundingClientRect().toJSON();\`);
    const screenshot=async name=>{await fs.writeFile(${JSON.stringify(directory)}+'/'+name+'.png',(await win.webContents.capturePage()).toPNG())};
    for(const theme of ['light','dark']){await run(\`document.documentElement.classList.toggle('dark', '\${theme}'==='dark');document.dispatchEvent(new Event('pointerleave'));wait(240)\`);await screenshot(theme+'-before');const baseBorder=await run('getComputedStyle(a).borderColor');
      await run('near();wait(240)');assert.equal(await run('getComputedStyle(a).borderColor'),baseBorder,'Reveal preserves original border in '+theme);assert.equal(await run('opacity(a)>0.4 && opacity(b)>0.4'),true,'outside proximity lights adjacent targets');await screenshot(theme+'-near');}
    assert.equal(await run('getComputedStyle(a).borderColor===originalBorder'),false,'dark theme updates base border');
    assert.equal(await run('JSON.stringify(a.getBoundingClientRect().toJSON())===JSON.stringify(originalRect)'),true,'no layout changes');
    for(const state of ['selected','error']){assert.equal(await run(\`a.classList.add('\${state}');near();wait(240).then(()=>opacity(a)===0&&opacity(b)>0)\`),true,state);await run(\`a.classList.remove('\${state}')\`)}
    for(const attribute of ['aria-invalid','aria-selected','aria-disabled']){assert.equal(await run(\`a.setAttribute('\${attribute}','true');near();wait(240).then(()=>opacity(a)===0)\`),true,attribute);await run(\`a.removeAttribute('\${attribute}')\`)}
    assert.equal(await run(\`a.innerHTML='<input id="field">';document.querySelector('#field').focus();near();wait(240).then(()=>opacity(a)===0)\`),true,'focus-within');await run('document.activeElement.blur()');
    assert.equal(await run(\`const fieldset=document.createElement('fieldset');fieldset.disabled=true;a.parentNode.insertBefore(fieldset,a);fieldset.append(a);near();wait(240).then(()=>opacity(a)===0)\`),true,'disabled fieldset');
    await run('const fs=a.parentNode;fs.parentNode.insertBefore(a,fs);fs.remove()');
    await run('near();wait(240)');assert.equal(await run('opacity(a)>0'),true);
    await run('near();wait(240)');
    assert.equal(await run(\`document.dispatchEvent(new Event('pointerleave'));wait(60).then(()=>a.classList.contains('reveal-border-target')&&opacity(a)>0)\`),true,'fade remains visible before cleanup');
    await run('near();wait(260)');assert.equal(await run('opacity(a)>0.4'),true,'reactivation cancels pending cleanup');
    assert.equal(await run(\`document.dispatchEvent(new Event('pointerleave'));wait(260).then(()=>!a.classList.contains('reveal-border-target')&&!a.style.getPropertyValue('--reveal-x'))\`),true,'transparent decoration reclaimed');
    for(const event of ['scroll','pointerleave','pointercancel']){await run('near();wait(240)');assert.equal(await run(\`document.dispatchEvent(new Event('\${event}'));wait(240).then(()=>opacity(a)===0&&opacity(b)===0)\`),true,event+' clears');}
    assert.equal(await run(\`window.framesRequested=0;for(let i=0;i<30;i++)near();window.framesRequested\`),1,'rAF coalesces pointer burst');await run('wait(240)');
    assert.equal(await run(\`document.dispatchEvent(new PointerEvent('pointermove',{pointerType:'touch',clientX:100,clientY:100}));wait(240).then(()=>opacity(a)===0)\`),true,'touch clears');
    assert.equal(await run(\`const lr=document.querySelector('#large').getBoundingClientRect();document.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:lr.left-5,clientY:lr.top+25}));wait(240).then(()=>!document.querySelector('#large').classList.contains('reveal-border-target'))\`),true,'large panel excluded even near its border');
    // Native raster evidence: decoration inherits the target's ancestor clip and never floats over dialogs.
    const clipRect=await run("(()=>{const r=document.querySelector('#clip').getBoundingClientRect();return {x:Math.round(r.left),y:Math.round(r.bottom+2),width:220,height:10}})()");
    const clipBefore=(await win.webContents.capturePage(clipRect)).toPNG();
    await run(\`const cr=document.querySelector('#clipped').getBoundingClientRect();document.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:cr.right-1,clientY:cr.top+45}));wait(240)\`);
    assert.equal(await run("opacity(document.querySelector('#clipped'))>0"),true,'clipped target receives effect');
    assert.deepEqual((await win.webContents.capturePage(clipRect)).toPNG(),clipBefore,'no drawing outside ancestor clip');
    await run(\`const overlay=document.createElement('div');overlay.id='dialog';overlay.style.cssText='position:fixed;inset:0;background:rgb(55,44,33);z-index:100';document.body.append(overlay);document.dispatchEvent(new Event('pointerleave'));wait(240)\`);
    const overlayBefore=(await win.webContents.capturePage()).toPNG();await run('near();wait(240)');
    assert.deepEqual((await win.webContents.capturePage()).toPNG(),overlayBefore,'decoration cannot draw through unrelated overlay');await run("document.querySelector('#dialog').remove()");
    // Representative ChatTab classes, including a streaming-size reply, not an explicit synthetic opt-in.
    await run(\`window.chat=document.createElement('section');chat.style.cssText='position:fixed;inset:30px;background:var(--c-bg);overflow:auto';chat.innerHTML='<article id="reply" class="chat-bubble chat-assistant"><p>Long assistant reply</p></article><article id="user" class="chat-bubble chat-user">User message</article>';document.body.append(chat);window.reply=chat.querySelector('#reply');reply.style.cssText='height:520px;width:600px;border:1px solid var(--c-border);border-radius:8px';window.user=chat.querySelector('#user');user.style.cssText='height:60px;width:300px;border:1px solid var(--c-border)';wait(120)\`);
    await run(\`var r=reply.getBoundingClientRect();document.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:r.left+2,clientY:r.top+240}));wait(240)\`);
    assert.equal(await run('reply.getBoundingClientRect().height>320 && opacity(reply)>0.4'),true,'real long assistant card reveals along side border');await screenshot('dark-long-reply');
    await run(\`var r=user.getBoundingClientRect();document.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:r.left+2,clientY:r.top+20}));wait(240)\`);
    assert.equal(await run('opacity(user)>0.4'),true,'real user card opts in');
    // Shared outer shell used by ExecutionMessage, completion ConversationEvent,
    // and SessionMessageDisclosure/MessageAction; expanded cards can exceed 320px.
    for (const variant of ['execution-card', 'system-event event-response', 'session-message message-action', 'session-message chat-session']) {
      await run(\`reply.className='message-preview-card \${variant}';reply.innerHTML='<div class="message-preview-body">Card content</div>';wait(100)\`);
      await run(\`var r=reply.getBoundingClientRect();document.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:r.left-2,clientY:r.top+240}));wait(240)\`);
      assert.equal(await run('opacity(reply)>0.4 && reply.getBoundingClientRect().height>320'),true,'expanded '+variant+' outer shell reveals');
      for (const selected of ['execution-selected', 'event-selected']) {
        await run(\`reply.classList.add('\${selected}');wait(40)\`);
        assert.equal(await run('opacity(reply)===0'),true,selected+' immediately suppresses decoration');
        await run(\`reply.classList.remove('\${selected}');wait(240)\`);
      }
    }
    await run(\`reply.className='chat-bubble chat-assistant';wait(100)\`);
    // Conversation status and task chips use the shared resting border.
    await run(\`window.chips=document.createElement('div');chips.style.cssText='position:fixed;left:40px;top:40px';chips.innerHTML='<div class="session-work-triggers"><button aria-expanded="false" style="width:160px;height:32px;border-width:1px;border-style:solid">Subagents</button></div><div class="chat-working" style="width:260px;height:32px;border-width:1px;border-style:solid">Working</div><div class="context-chip" style="width:120px;height:32px;border-width:1px;border-style:solid">Context</div>';document.body.append(chips);wait(100)\`);
    for(const selector of ['.session-work-triggers > button','.chat-working','.context-chip']) {
      assert.equal(await run(\`(async()=>{const chip=chips.querySelector('\${selector}');const r=chip.getBoundingClientRect();document.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:r.right+2,clientY:r.top+16}));await wait(240);return opacity(chip)>0.4&&getComputedStyle(chip).borderColor===getComputedStyle(a).borderColor})()\`),true,'chip reveals with unified border: '+selector);
    }
    await run(\`chips.querySelector('button').setAttribute('aria-expanded','true');wait(40)\`);
    assert.equal(await run("opacity(chips.querySelector('button'))===0"),true,'expanded chip keeps state');
    await run('chips.remove();wait(100)');
    // Streaming growth has fresh geometry, without needing a new target registration.
    await run(\`reply.style.height='620px';wait(100)\`);
    await run(\`var r=reply.getBoundingClientRect();document.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:r.left+2,clientY:r.bottom-5}));wait(240)\`);
    assert.equal(await run('opacity(reply)>0.4'),true,'streaming growth uses current perimeter');
    await run(\`window.fixedPoint={x:reply.getBoundingClientRect().left+300,y:reply.getBoundingClientRect().bottom-5};document.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:fixedPoint.x,clientY:fixedPoint.y}));wait(240)\`);
    assert.equal(await run('opacity(reply)>0.4'),true,'near bottom before growth');
    await run(\`reply.style.height='750px';document.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:fixedPoint.x,clientY:fixedPoint.y}));wait(260)\`);
    assert.equal(await run('opacity(reply)===0'),true,'unchanged pointer rereads streaming growth, not stale geometry');
    await run(\`chat.replaceChildren();for(let i=0;i<2000;i++){const card=document.createElement('article');card.className='chat-bubble '+(i%2?'chat-user':'chat-assistant');card.textContent='Message '+i;card.style.cssText='box-sizing:border-box;height:80px;width:600px;border:1px solid var(--c-border)';chat.append(card)}wait(160)\`);
    // Instrument actual browser geometry and selector calls after registration settles.
    await run(\`window.geometryReads=0;window.selectorScans=0;window.nativeRect=Element.prototype.getBoundingClientRect;window.nativeQuery=Element.prototype.querySelectorAll;window.nativeDocQuery=Document.prototype.querySelectorAll;Element.prototype.getBoundingClientRect=function(){if(this.matches('.chat-bubble, .reveal-border'))geometryReads++;return nativeRect.call(this)};Element.prototype.querySelectorAll=function(...args){selectorScans++;return nativeQuery.apply(this,args)};Document.prototype.querySelectorAll=function(...args){selectorScans++;return nativeDocQuery.apply(this,args)};window.sample=async()=>{geometryReads=0;selectorScans=0;document.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:32,clientY:70}));await wait(60);return {reads:geometryReads,scans:selectorScans}};undefined\`);
    const samples=[];for(let i=0;i<8;i++)samples.push(await run('sample()'));
    for(const sample of samples){assert.ok(sample.reads>0 && sample.reads<=20,JSON.stringify(sample));assert.equal(sample.scans,0,'mousemove never rescans history (including its own class mutations)')}
    await run(\`window.propertyWrites=0;window.classAdds=0;window.nativeSet=CSSStyleDeclaration.prototype.setProperty;window.nativeAdd=DOMTokenList.prototype.add;CSSStyleDeclaration.prototype.setProperty=function(...args){if(args[0].startsWith('--reveal-'))propertyWrites++;return nativeSet.apply(this,args)};DOMTokenList.prototype.add=function(...args){if(args.includes('reveal-border-target'))classAdds++;return nativeAdd.apply(this,args)};undefined\`);
    for(let i=0;i<8;i++)await run('sample()');
    const unchanged=await run('({propertyWrites,classAdds})');assert.deepEqual(unchanged,{propertyWrites:0,classAdds:0},'settled identical pointer writes nothing');
    // Streaming text nodes do not scan subtrees. Removing 100 leaf cards must
    // not test containment against the 2,000-card registry for each removal.
    await run(\`window.containsCalls=0;window.nativeContains=Node.prototype.contains;Node.prototype.contains=function(...args){containsCalls++;return nativeContains.apply(this,args)};selectorScans=0;for(const card of Array.from(chat.children).slice(100,200)){card.append(document.createTextNode(' streamed'));card.remove()}wait(80)\`);
    const churn=await run('({containsCalls,scans:selectorScans})');assert.deepEqual(churn,{containsCalls:0,scans:0});
    await run('Node.prototype.contains=nativeContains;CSSStyleDeclaration.prototype.setProperty=nativeSet;DOMTokenList.prototype.add=nativeAdd;undefined');
    await run('chat.scrollTop=80000;wait(160)');const scrolled=await run('sample()');assert.ok(scrolled.reads>0&&scrolled.reads<=20,JSON.stringify(scrolled));assert.equal(scrolled.scans,0);
    console.log('REVEAL_GEOMETRY_2000 '+JSON.stringify({samples,scrolled,unchanged,churn,limit:20}));
    await run(\`Element.prototype.getBoundingClientRect=nativeRect;Element.prototype.querySelectorAll=nativeQuery;Document.prototype.querySelectorAll=nativeDocQuery;chat.remove();wait(100)\`);
    // Vue-style class reuse and route insertion/removal.
    await run(\`window.dynamic=document.createElement('article');dynamic.style.cssText='position:fixed;left:40px;top:40px;width:200px;height:100px';document.body.append(dynamic);dynamic.className='chat-bubble chat-assistant';wait(100)\`);
    await run(\`document.dispatchEvent(new PointerEvent('pointermove',{pointerType:'mouse',clientX:42,clientY:80}));wait(240)\`);assert.equal(await run('opacity(dynamic)>0.4'),true,'class-only dynamic registration');
    await run(\`dynamic.className='unrelated-panel';wait(100)\`);assert.equal(await run("!dynamic.classList.contains('reveal-border-target')&&!dynamic.style.getPropertyValue('--reveal-opacity')"),true,'class reuse unregisters');await run('dynamic.remove()');
    win.webContents.setBackgroundThrottling(false);await win.webContents.debugger.attach('1.3');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]});await run('near();wait(240)');assert.equal(await run("!a.classList.contains('reveal-border-target')"),true,'reduced motion removes decoration');
    await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[]});await run('near();wait(240)');
    await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled',{enabled:true,maxTouchPoints:1});await run('near();wait(240)');
    assert.equal(await run("!matchMedia('(pointer: fine)').matches && !a.classList.contains('reveal-border-target')"),true,'coarse pointer disables decoration');
    await win.webContents.debugger.sendCommand('Emulation.setTouchEmulationEnabled',{enabled:false});await run('near();wait(240)');
    assert.equal(await run(\`stopReveal();!a.classList.contains('reveal-border-target')&&!a.style.getPropertyValue('--reveal-opacity')\`),true,'dispose removes decoration');
    assert.equal(await run(\`near();wait(100).then(()=>!a.classList.contains('reveal-border-target'))\`),true,'listeners removed');
    assert.equal(await run('observerDisconnects'),2,'both observers disconnected');
    assert.equal(await run('window.framesRequested=0;wait(120).then(()=>framesRequested)'),0,'no idle animation frames after disposal');
    console.log('REVEAL_BORDER_OK');win.destroy();app.quit();}catch(e){console.error(e);app.exit(1)}});
  `)
  const env: NodeJS.ProcessEnv = {}
  for (const key of ['SystemRoot', 'WINDIR', 'PATH', 'Path', 'ComSpec', 'PATHEXT', 'DISPLAY', 'WAYLAND_DISPLAY', 'XDG_RUNTIME_DIR']) if (process.env[key] !== undefined) env[key] = process.env[key]
  for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TMP', 'TEMP', 'TMPDIR', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = runtime
  const child = spawn(desktopRequire('electron') as string, [main], { cwd: runtime, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let output = ''
  child.stdout.setEncoding('utf8').on('data', chunk => { output += chunk })
  child.stderr.setEncoding('utf8').on('data', chunk => { output += chunk })
  const timer = setTimeout(() => child.kill(), 75_000)
  t.after(() => { clearTimeout(timer); if (child.exitCode === null) child.kill() })
  const [code] = await once(child, 'close')
  assert.equal(code, 0, output)
  assert.match(output, /REVEAL_BORDER_OK/)
  console.log(output.match(/REVEAL_GEOMETRY_2000 [^\r\n]+/)?.[0])
})
