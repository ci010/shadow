import assert from 'node:assert/strict'
import test from 'node:test'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'
import vue from '@vitejs/plugin-vue'
import { parse, compileStyle } from 'vue/compiler-sfc'
test('BOT review border radii use global theme tokens without local overrides', async () => {
  const source = await readFile(new URL('./components/BotPublicationReview.vue', import.meta.url), 'utf8')
  const styles = parse(source).descriptor.styles.map(style => style.content).join('\n')
  const radii = [...styles.matchAll(/border-radius\s*:\s*([^;}]+)/g)].map(match => match[1].trim())
  assert(radii.length > 0)
  for (const radius of radii) assert.match(radius, /^var\(--radius-(?:sm|control|surface|overlay|pill|circle)\)$/)
  assert.doesNotMatch(styles, /--radius-[\w-]+\s*:/)
})
const root = fileURLToPath(new URL('../..', import.meta.url))
const require = createRequire(new URL('../../desktop/package.json', import.meta.url))
test('BOT inline review renders frozen scopes and exact human decisions with authoritative receipt and Project race isolation', {timeout:90000,
  skip:process.platform === 'linux' && !process.env.DISPLAY && !process.env.WAYLAND_DISPLAY ? 'Electron requires a display server.' : false,
}, async t => {
  const directory = resolve(root,'.test-artifacts',`bot-review-${randomUUID()}`)
  await mkdir(directory,{recursive:true}); t.after(()=>rm(directory,{recursive:true,force:true,maxRetries:12,retryDelay:250}))
  // Compile the production ChatTab layout rules, not an unconstrained document fixture.
  const chat = parse(await readFile(new URL('./components/ChatTab.vue', import.meta.url), 'utf8')).descriptor
  const template = chat.template!.content
  const reviewPosition = template.lastIndexOf('<BotReviewCard ')
  assert(reviewPosition > template.indexOf('ref="messagesContainer"'))
  assert(reviewPosition < template.indexOf('<MessageHistoryRail v-if="!mobileLayout"'))
  assert(!template.slice(template.indexOf('<template #composer>')).includes('<BotReviewCard '))
  const layout = compileStyle({source:chat.styles.map(s => s.content).join('\n'), filename:'ChatTab.vue', id:'fixture', scoped:false})
  assert.deepEqual(layout.errors, [])
  const fixture = `import '/src/styles.css'; import {createApp,h,reactive} from 'vue'; import Review from '/src/components/BotPublicationReview.vue'; import {setLocalePreference} from '/src/i18n.ts';setLocalePreference('en');
  const source={'BOT.md':"---\\nname: support\\nplatform: discord\\nbotInstanceId: test-connection\\ndescription: Support concierge\\nchannels: [channels/help.json]\\ntools: [read, discord_history]\\nreadDomains: []\\nsourceFolders: [22222222-2222-4222-a222-222222222222]\\ndiscordHistory:\\n  guildId: \\"100\\"\\n  channelIds: [\\"201\\", \\"202\\"]\\n  threads: public-archived\\n  preEpoch: true\\n---\\nFROZEN_SOURCE"}; source['channels/help.json']=JSON.stringify([{"id": "33333333-3333-4333-a333-333333333333", "botInstanceId": "test-connection", "botUserId": "99", "target": {"kind": "channel", "guildId": "100", "channelId": "201"}, "enabled": true, "trigger": "mention", "participants": {"everyone": false, "userIds": ["401"], "roleIds": ["501"]}, "tools": ["read"], "readDomains": [], "sourceFolders": [], "discordHistory": {"guildId": "100", "channelIds": ["201"], "threads": "public-active", "preEpoch": false}, "inheritThreads": false, "manage": false}]);
  const draft={id:'11111111-1111-4111-a111-111111111111',baseRevision:1,hash:'a'.repeat(64),change:{kind:'bot.save',package:{id:'support',source}},actor:{kind:'owner',id:'shadow-owner'},createdAt:new Date().toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),status:'pending',affectedBindings:[],warning:'',validationHash:'validation'};
  const state=reactive({apiBase:location.origin+'/projects/a',projectId:'a',active:true});
  let overview={packages:{},projectId:'a',version:1,revision:1,agents:[],bindings:[],deploymentIssues:[],drafts:[draft],audit:[],domains:[],resources:[],tools:[],templates:[],legacy:[],sessions:[],learning:[]};
  const calls=[]; let failure=false, hold=false, pending, statusFailure=false, statusHold=false, pendingStatus;
  window.fixture={state,calls,long(v){overview.drafts=v?Array.from({length:3},(_,i)=>({...draft,id:'11111111-1111-4111-a111-11111111111'+i,change:{kind:'bot.save',package:{id:'support',source:{...source,'channels/help.json':JSON.stringify(Array.from({length:8},(_,j)=>({...JSON.parse(source['channels/help.json'])[0],id:'33333333-3333-4333-a333-33333333333'+j}))), 'notes.txt':'LONG_CONTENT '.repeat(500)}}}})):[draft]},locale:setLocalePreference,patch(p){Object.assign(draft,p)},setRevision(v){overview.revision=v},statusFail(v){statusFailure=v},statusHold(v){statusHold=v},releaseStatus(){statusHold=false;pendingStatus?.();pendingStatus=undefined},fail(v){failure=v},hold(v){hold=v},release(){pending?.();pending=undefined},reset(){draft.status='pending';draft.baseRevision=1;draft.expiresAt=new Date(Date.now()+60000).toISOString();overview.revision=1;overview.packages={};failure=false;hold=false},published:()=>overview.packages};
  window.fetch=async (url,options={})=>{
    if(options.method==='POST') { calls.push({url:String(url),body:JSON.parse(options.body)}); if(hold) await new Promise(resolve=>pending=resolve); if(failure)return new Response('{}',{status:409});
      draft.status=String(url).endsWith('/cancel')?'cancelled':'applied'; if(draft.status==='applied'){overview.revision=2;overview.packages={support:{active:{id:'support',source},revision:'approved-release-2',history:[]}}} return Response.json(draft);
    }
    if(statusHold)await new Promise(resolve=>pendingStatus=resolve);if(statusFailure)return new Response('{}',{status:503});
    return Response.json({...overview,projectId:state.projectId,drafts:state.projectId==='a'?overview.drafts:[]});
  };
  const style=document.createElement('style');style.textContent=${JSON.stringify(layout.code + '\nhtml,body,#app{height:100%;margin:0;overflow:hidden} .fixture-frame{height:100%;display:flex;flex-direction:column;min-height:0} .fixture-heading{flex:0 0 42px}')} ;document.head.append(style);
  createApp({render:()=>h('div',{class:'fixture-frame'},[h('header',{class:'fixture-heading'},'Conversation'),h('div',{class:'chat-panel',style:'--composer-height:140px'},[h('div',{class:'chat-history'},[h('div',{class:'chat-messages'},[h('div',{class:'chat-message-list'},'Earlier messages'),h(Review,state)])]),h('div',{class:'conversation-dock'},[h('div',{class:'chat-composer',style:'height:112px;background:var(--c-bg)'},[h('textarea',{'aria-label':'Message',placeholder:'Message'}),h('button',{},'Send')])])])])}).mount('#app');`
  const server = await createServer({configFile:false,envDir:false,root:resolve(root,'app'),logLevel:'error',cacheDir:resolve(directory,'cache'),optimizeDeps:{entries:[]},plugins:[vue(),{
    name:'bot-review-fixture',resolveId:id=>id==='/fixture.ts'?'\0fixture':undefined,load:id=>id==='\0fixture'?fixture:undefined,
    configureServer(server){server.middlewares.use((req,res,next)=>{if(req.url==='/'){res.setHeader('Content-Type','text/html');res.end('<div id="app"></div><script type="module" src="/fixture.ts"></script>')}else next()})},
  }],server:{host:'127.0.0.1',port:0}})
  await server.listen();t.after(()=>server.close());const url=server.resolvedUrls?.local[0];assert(url)
  const screenshotDirectory = process.env.BOT_REVIEW_SCREENSHOT_DIR
  if (screenshotDirectory) await mkdir(screenshotDirectory, {recursive:true})
  const script = `const assert=require('node:assert/strict');const {app,BrowserWindow}=require('electron');const {setTimeout:delay}=require('node:timers/promises');app.setPath('userData',require('node:path').join(process.cwd(),'profile'));app.on('window-all-closed',()=>{});
  (async()=>{await app.whenReady();const win=new BrowserWindow({show:false,width:1000,height:1600,webPreferences:{sandbox:true,contextIsolation:true,nodeIntegration:false,backgroundThrottling:false}});const run=s=>win.webContents.executeJavaScript(s);const wait=async s=>{for(let i=0;i<300;i++){if(await run('Boolean('+s+')'))return;await delay(50)}throw Error('Timeout '+s+' '+await run('document.body.innerText'))};
  const approve='document.querySelector("article button")';const ack='document.querySelector("input[type=checkbox]")';
  const refresh=async()=>{await run('window.fixture.state.active=false');await delay(30);await run('window.fixture.state.active=true');await wait('document.querySelector("article")')};
  const check=async()=>{await run(ack+'.click()')};
  await win.loadURL(${JSON.stringify(url)});await wait('document.querySelector("article")');
  assert.equal(await run('document.body.textContent.includes("FROZEN_SOURCE")'),true);assert.equal(await run('document.body.textContent.includes("a".repeat(64))'),true);
  assert.equal(await run('document.querySelectorAll("article button").length'),2);
  assert.equal(await run('document.querySelectorAll("article input[type=checkbox]").length'),1);
  assert.equal(await run('document.querySelector("h4").textContent'), 'Support concierge');
  for (const text of ['22222222-2222-4222-a222-222222222222','201, 202','Active and archived public threads','Not granted by this scope','Allowed','read, discord_history','Listed users and roles only','401','501','Active public threads','Not allowed','Added']) assert.equal(await run('document.querySelector(".permission-summary").textContent.includes('+JSON.stringify(text)+') || document.querySelector(".change-summary").textContent.includes('+JSON.stringify(text)+')'),true,text);
  assert.equal(await run('getComputedStyle(document.querySelector(".bot-publication-review")).maxHeight'), 'none');
  if (${JSON.stringify(screenshotDirectory ?? '')}) {
    const dir=${JSON.stringify(screenshotDirectory ?? '')};const fs=require('node:fs/promises'); const path=require('node:path');
    await delay(100);await fs.writeFile(path.join(dir,'bot-review-light.png'),(await win.webContents.capturePage()).toPNG());
    await run('document.documentElement.classList.add("dark")');await delay(100);await fs.writeFile(path.join(dir,'bot-review-dark.png'),(await win.webContents.capturePage()).toPNG());
    await run('document.querySelector("footer").scrollIntoView({block:"end"})');await delay(100);await fs.writeFile(path.join(dir,'bot-review-footer-dark.png'),(await win.webContents.capturePage()).toPNG());await run('document.querySelector(".chat-messages").scrollTop=0');
    win.setSize(390,1200);await delay(100);assert.equal(await run('document.documentElement.scrollWidth <= window.innerWidth'),true);await fs.writeFile(path.join(dir,'bot-review-mobile.png'),(await win.webContents.capturePage()).toPNG());
    win.setSize(1000,1600);await run('document.documentElement.classList.remove("dark")');
  }
  await run('window.fixture.long(true)');await refresh();
  await wait('document.querySelectorAll("article").length===3');
  for (const [width,height] of [[1000,800],[390,500],[700,420]]) {
    win.setSize(width,height);await delay(100);
    await run('document.querySelectorAll(".technical").forEach(e=>e.open=true)');
    const geometry=await run(\`(() => {
      const scroller=document.querySelector('.chat-messages'), review=document.querySelector('.bot-publication-review');
      const composer=document.querySelector('.chat-composer');
      scroller.scrollTop=0;
      const first=review.querySelector('h3').getBoundingClientRect();
      const topVisible=first.top>=scroller.getBoundingClientRect().top && first.bottom<composer.getBoundingClientRect().top;
      const last=review.querySelector('article:last-child footer');last.scrollIntoView({block:'end'});
      // Include the production composer-clearance padding so the footer clears the overlaid dock.
      scroller.scrollTop=scroller.scrollHeight;
      const footer=last.getBoundingClientRect(), c=composer.getBoundingClientRect();
      return {overflow:scroller.scrollHeight>scroller.clientHeight,top:scroller.scrollTop,topVisible,
        footerVisible:footer.top>=scroller.getBoundingClientRect().top && footer.bottom<=c.top,
        composerVisible:c.top>=0 && c.bottom<=innerHeight,
        noHorizontal:scroller.scrollWidth<=scroller.clientWidth && document.documentElement.scrollWidth<=innerWidth,
        noNested:getComputedStyle(review).overflowY==='visible'};
    })()\`);
    assert.equal(geometry.overflow,true);assert(geometry.top>0);assert.equal(geometry.topVisible,true);
    assert.equal(geometry.footerVisible,true);assert.equal(geometry.composerVisible,true);
    assert.equal(geometry.noHorizontal,true);assert.equal(geometry.noNested,true);
    // Exercise native wheel routing in the actual bounded region, not window scrolling.
    // DOM scrollTop updates synchronously, but Chromium's compositor/hit-test state does not.
    // End the previous scroll/focus transaction and wait for the reset to be painted before
    // native input; otherwise a wheel can race the previous scroll-to-bottom and get lost.
    const point=await run('new Promise(resolve => {const e=document.querySelector(".chat-messages");e.tabIndex=-1;e.focus({preventScroll:true});e.scrollTop=0;window.wheelSeen=false;e.addEventListener("wheel",()=>window.wheelSeen=true,{once:true,passive:true});requestAnimationFrame(()=>requestAnimationFrame(()=>{const r=e.getBoundingClientRect();const x=Math.round(r.left+40),y=Math.round(r.top+50);resolve({x,y,inside:e.contains(document.elementFromPoint(x,y)),top:e.scrollTop})}))})');
    assert.equal(point.inside,true,'Wheel point must hit the history scroller, not the dock');
    assert.equal(point.top,0);
    await delay(200);
    win.webContents.sendInputEvent({type:'mouseMove',x:point.x,y:point.y});
    win.webContents.sendInputEvent({type:'mouseWheel',x:point.x,y:point.y,deltaY:-300,deltaX:0,canScroll:true,phase:'began'});
    win.webContents.sendInputEvent({type:'mouseWheel',x:point.x,y:point.y,deltaY:0,deltaX:0,canScroll:true,phase:'ended'});
    await wait('window.wheelSeen && document.querySelector(".chat-messages").scrollTop>0');
    await run('document.querySelector("textarea").focus()');assert.equal(await run('document.activeElement.tagName'), 'TEXTAREA');
  }
  await run('window.fixture.long(false)');await refresh();win.setSize(1000,1600);
  assert.equal(await run(approve+'.disabled'),true);await run(approve+'.click()');assert.equal(await run('window.fixture.calls.length'),0);
  assert.match(await run('document.querySelector(".action-hint").textContent'), /Check the acknowledgement/);
  await check();assert.equal(await run(ack+'.checked'),true);assert.equal(await run(approve+'.disabled'),false);assert.match(await run('document.querySelector(".action-hint").textContent'),/Ready to approve/);
  assert.equal(await run(approve+'.getAttribute("aria-describedby")'),await run('document.querySelector(".action-hint").id'));
  await run('window.fixture.setRevision(2)');await wait('document.querySelector(".action-hint").textContent.includes("Configuration changed")');assert.equal(await run(ack+'.checked'),true);assert.equal(await run(approve+'.disabled'),true);
  await run('window.fixture.setRevision(1)');await wait(approve+'.disabled===false');
  await run('window.fixture.patch({expiresAt:new Date(Date.now()+2000).toISOString()})');await refresh();await check();assert.equal(await run(approve+'.disabled'),false);await wait('document.querySelector(".action-hint").textContent.includes("expired")');assert.equal(await run(ack+'.checked'),true);assert.equal(await run(approve+'.disabled'),true);
  await run('window.fixture.reset()');await refresh();await check();assert.equal(await run(approve+'.disabled'),false);
  await run('window.fixture.statusFail(true)');await wait('document.querySelector(".action-hint").textContent.includes("could not be verified")');assert.equal(await run(approve+'.disabled'),true);assert.match(await run('document.querySelector("[role=alert]").textContent'),/Approval is paused/);await run(approve+'.click()');assert.equal(await run('window.fixture.calls.length'),0);
  await run('window.fixture.setRevision(2);window.fixture.statusFail(false)');await wait('document.querySelector(".action-hint").textContent.includes("Configuration changed")');assert.equal(await run(approve+'.disabled'),true);assert.equal(await run('!!document.querySelector("[role=alert]")'),false);
  await run('window.fixture.setRevision(1)');await wait(approve+'.disabled===false');
  await run('window.fixture.statusHold(true)');await wait('document.querySelector(".action-hint").textContent.includes("could not be verified")');assert.equal(await run(approve+'.disabled'),true);await run(approve+'.click()');assert.equal(await run('window.fixture.calls.length'),0);await run('window.fixture.releaseStatus()');await wait(approve+'.disabled===false');
  await run('window.fixture.patch({baseRevision:0})');await refresh();await check();assert.equal(await run(approve+'.disabled'),true);assert.match(await run('document.querySelector(".action-hint").textContent'),/Configuration changed/);
  await run('window.fixture.patch({baseRevision:1,expiresAt:new Date(Date.now()-1000).toISOString()})');await refresh();await check();assert.equal(await run(approve+'.disabled'),true);
  await run('window.fixture.reset()');await refresh();await check();await run(approve+'.click();'+approve+'.click()');await wait('document.querySelector(".publication-receipt")');
  assert.equal(await run('window.fixture.calls.length'),1);assert.deepEqual(await run('window.fixture.calls[0].body'),{hash:'a'.repeat(64)});assert.match(await run('window.fixture.calls[0].url'),/projects\\/a\\/api\\/integrations\\/discord\\/drafts\\/11111111-1111-4111-a111-111111111111\\/commit$/);assert.match(await run('document.querySelector(".publication-receipt").textContent'),/applied.*approved-release-2.*configuration 2/);
  await run('window.fixture.reset()');await refresh();await run('document.querySelectorAll("article button")[1].click()');await wait('document.querySelector(".publication-receipt")');assert.equal(await run('window.fixture.calls.length'),2);assert.deepEqual(await run('window.fixture.calls[1].body'),{});assert.match(await run('window.fixture.calls[1].url'),/cancel$/);
  await run('window.fixture.reset();window.fixture.fail(true)');await refresh();await check();await run(approve+'.click()');await wait('document.querySelector("[role=alert]")');assert.match(await run('document.querySelector("[role=alert]").textContent'),/failed/);assert.equal(await run('!!document.querySelector("article")'),true);assert.equal(await run(approve+'.disabled'),true);assert.match(await run('document.querySelector(".action-hint").textContent'),/Check the acknowledgement/);
  await run('window.fixture.reset();window.fixture.hold(true)');await refresh();await check();await run(approve+'.click()');await wait('window.fixture.calls.length===4');assert.match(await run('document.querySelector(".action-hint").textContent'),/Applying your decision/);assert.equal(await run(approve+'.disabled'),true);await run('window.fixture.state.projectId="b";window.fixture.state.apiBase=location.origin+"/projects/b"');await delay(100);assert.equal(await run('document.body.textContent.includes("FROZEN_SOURCE")'),false);await run('window.fixture.release()');await delay(100);assert.equal(await run('!!document.querySelector(".publication-receipt")'),false);assert.equal(await run('window.fixture.calls.length'),4);assert.equal(await run('!!document.querySelector("article button")'),false);
  await run('window.fixture.reset();window.fixture.state.projectId="a";window.fixture.patch({change:{kind:"bot.save",package:{id:"support",source:{"BOT.md":"Invalid metadata <script>window.executed=true</script>"}}}})');await refresh();
  assert.equal(await run('document.querySelector(".permission-summary").textContent.includes("Permission summary unavailable")'),true);assert.equal(await run('window.executed === undefined'),true);assert.equal(await run(approve+'.disabled'),true);assert.equal(await run('window.fixture.calls.length'),4);
  await run('window.fixture.locale("zh-CN")');assert.equal(await run('document.querySelector("h3").textContent'), 'Bot 发布审批');
  await win.close();console.log('BOT_REVIEW_OK');app.exit(0)})().catch(e=>{console.error(e);app.exit(1)});`
  await writeFile(resolve(directory,'main.cjs'),script)
  const env:NodeJS.ProcessEnv={}
  for(const key of ['PATH','DISPLAY','WAYLAND_DISPLAY','XDG_RUNTIME_DIR'])if(process.env[key]!==undefined)env[key]=process.env[key]
  for(const key of ['HOME','USERPROFILE','APPDATA','LOCALAPPDATA','TMP','TEMP','TMPDIR','XDG_CONFIG_HOME','XDG_CACHE_HOME'])env[key]=directory
  const child=spawn(require('electron') as string,[resolve(directory,'main.cjs')],{cwd:directory,env,stdio:['ignore','pipe','pipe']})
  let log='';child.stdout.setEncoding('utf8').on('data',c=>{log+=c});child.stderr.setEncoding('utf8').on('data',c=>{log+=c})
  const timer=setTimeout(()=>child.kill(),75000);t.after(()=>{clearTimeout(timer);if(child.exitCode===null)child.kill()})
  const [code]=await once(child,'close');assert.equal(code,0,log);assert.match(log,/BOT_REVIEW_OK/)
})
