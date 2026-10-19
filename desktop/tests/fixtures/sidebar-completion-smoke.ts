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
 try{
 await window.loadURL(new URL('__activity',process.env.ACTIVITY_SMOKE_URL).href)
 await wait(`!!document.querySelector('.folder-session-row')`)
 // Completion is shown at the left only while idle; real delegated/live icons win.
 for(const rail of [false,true]){
 for(const completed of [false,true]){
 await run(`void Object.assign(window.__activity,{completed:${completed}})`)
 assert.equal(await run(`document.querySelector('.session-select').getAttribute('aria-label').includes('Completed')`),completed)
 for(const stage of ['idle','inactive']){
 await change(stage,'completed',rail)
 const icon=completed?'i-lucide-circle-check':'i-lucide-moon'
 assert.equal(await run(`!!document.querySelector('.tree-icon .${icon}')`),true,stage+' completion icon')
 assert.equal(await run(`document.querySelector('.tree-icon .session-activity').getAttribute('aria-label')`),completed?'Completed':'Inactive')
 assert.equal(await run(`document.querySelector('.tree-icon .session-activity').getAttribute('title')`),completed?'Completed':'Inactive')
 assert.equal(await run(`!!document.querySelector('.tree-meta .i-lucide-circle-check')`),false,'no duplicate completion badge')
 }
 for(const stage of ['llm','tool','waiting','running']){
 await change(stage,'completed',rail)
 assert.equal(await run(`!!document.querySelector('.tree-icon .i-lucide-circle-check')`),false,'live state wins')
 }
 for(const child of ['running','waiting','pending']){
 await change('idle',child,rail)
 assert.equal(await run(`!!document.querySelector('.tree-icon .i-lucide-circle-check')`),false,'delegation wins')
 await wait(`!!document.querySelector('.tree-icon .'+${JSON.stringify(child==='waiting'?'i-lucide-message-circle-question':child==='pending'?'i-lucide-clock':'working-wave')})`)
 }
 }
 }
 assert.deepEqual(errors,[])
 console.log('SIDEBAR_COMPLETION_OK')
 }finally{window.destroy()}
}
main().then(()=>app.exit(0),error=>{console.error(error);app.exit(1)})
