import assert from 'node:assert/strict'
import {join} from 'node:path'
import {setTimeout as delay} from 'node:timers/promises'
import {app,BrowserWindow} from 'electron'
app.setPath('userData',join(process.cwd(),'profile'))
app.on('window-all-closed',()=>{})
async function main(){
 await app.whenReady()
 const window=new BrowserWindow({show:false,width:1000,height:800,webPreferences:{contextIsolation:true,sandbox:true,backgroundThrottling:false}})
 const errors:string[]=[]
 window.webContents.on('console-message',details=>{if(details.level==='error')errors.push(details.message)})
 const run=(s:string)=>window.webContents.executeJavaScript(s)
 const wait=async(s:string)=>{for(let i=0;i<250;i++){if(await run(s))return;await delay(40)}throw Error(`Timeout ${s}\n${errors.join('\n')}`)}
 const change=async(stage:string,child='completed',rail=false,physical=false)=>{console.log(stage,child,rail,physical);await run(`void Object.assign(window.__activity,${JSON.stringify({stage,child,rail,physical})})`);await run('new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')}
 const animation=()=>run(`getComputedStyle(document.querySelector('.composer-box')).animationName`)
 const wave=()=>run(`!!document.querySelector('.folder-session-row > .tree-meta .working-wave')`)
 try{
 await window.loadURL(new URL('__activity',process.env.ACTIVITY_SMOKE_URL).href)
 await wait(`!!document.querySelector('.composer-box')`)
 assert.ok(await run(`!!document.querySelector('.control .activity-spinner')`),'control proves hideSymbol default still renders spinner')
 for(const stage of ['llm','tool']){
 await change(stage)
 assert.equal(await run(`!!document.querySelector('.chat-working .activity-symbol')`),false)
 assert.equal(await run(`!!document.querySelector('.chat-working > .working-wave')`),true)
 assert.equal(await run(`document.querySelector('.chat-working .activity-label').textContent`),stage==='llm'?'Thinking':'Using tools')
 assert.equal(await animation(),'composer-breathe')
 assert.equal(await wave(),true)
 assert.ok(await run(`document.querySelector('.chat-working > .working-wave').getBoundingClientRect().left > document.querySelector('.chat-working .activity-label').getBoundingClientRect().right`))
 }
 for(const rail of [false,true]){
 for(const stage of ['llm','tool','running']){await change(stage,'completed',rail);assert.equal(await wave(),true);assert.equal(await animation(),'composer-breathe')}
 for(const stage of ['idle','waiting','waiting-for-call','inactive','completed','failed','cancelled','pending']){await change(stage,'completed',rail);assert.equal(await wave(),false,stage);assert.equal(await animation(),'none',stage)}
 for(const child of ['running','waiting','pending','completed','failed','cancelled']){
 await change('idle',child,rail);assert.equal(await wave(),child==='running',child);assert.equal(await animation(),child==='running'?'composer-breathe':'none',child)
 if(child==='running'){
 assert.equal(await run(`!!document.querySelector('.folder-session-row .activity-symbol .i-lucide-git-branch')`),true,'delegated work uses a fork on the left')
 assert.equal(await run(`!!document.querySelector('.folder-session-row .activity-symbol .working-wave')`),false,'delegated left icon does not animate')
 }
 if(child==='waiting')assert.equal(await run(`!!document.querySelector('.folder-session-row .activity-symbol .i-lucide-message-circle-question')`),true,'waiting retains priority')
 }
 }
 await change('llm','running');assert.equal(await run(`document.querySelectorAll('.chat-working .working-wave').length`),1,'combined work has one wave');assert.equal(await run(`document.querySelectorAll('.chat-working').length`),1);
 await change('waiting')
 assert.equal(await run(`!!document.querySelector('.chat-working .attention-icon')`),true)
 assert.equal(await run(`!!document.querySelector('.chat-working > .working-wave')`),false)
 await change('llm','running',false,true);assert.equal(await animation(),'none','historical trace suppresses breathing')
 await change('llm')
 console.log('shadow');const shadows=await run(`new Promise(resolve=>{const el=document.querySelector('.composer-box');const a=el.getAnimations()[0];a.pause();a.currentTime=0;const first=getComputedStyle(el).boxShadow;a.currentTime=1500;requestAnimationFrame(()=>resolve([first,getComputedStyle(el).boxShadow]))})`)
 assert.notEqual(shadows[0],shadows[1],'breathing changes actual shadow')
 for(const theme of ['light','dark']){
 const frames=await run(`new Promise(resolve=>{document.documentElement.classList.toggle('dark',${JSON.stringify(theme)}==='dark');const el=document.querySelector('.composer-box');const a=el.getAnimations().find(a=>a.animationName==='composer-breathe');a.pause();const frames=[0,1500,3000,4500,6000,7500,9000].map(time=>{a.currentTime=time;return getComputedStyle(el).boxShadow});resolve(frames)})`)
 assert.equal(new Set(frames.slice(0,6)).size,6,'three distinct color peaks and troughs: '+theme)
 assert.equal(frames[0],frames[6],'color loop returns smoothly to starting shadow: '+theme)
 }
 console.log('media');await window.webContents.debugger.attach('1.3')
 await window.webContents.debugger.sendCommand('Emulation.setEmulatedMedia',{features:[{name:'prefers-reduced-motion',value:'reduce'}]})
 await wait(`matchMedia('(prefers-reduced-motion: reduce)').matches`)
 assert.equal(await animation(),'none')
 assert.equal(await run(`getComputedStyle(document.querySelector('.session-working-wave i')).animationName`),'none')
 assert.equal(await run(`getComputedStyle(document.querySelector('.chat-working .working-wave i')).animationName`),'none')
 assert.deepEqual(errors,[])
 console.log('ACTIVITY_SMOKE_OK: thinking/tool no left spinner; own+delegated sidebar wave; composer stage transitions, actual shadow change, reduced motion')
 }finally{window.destroy()}
}
main().then(()=>app.exit(0),error=>{console.error(error);app.exit(1)})
