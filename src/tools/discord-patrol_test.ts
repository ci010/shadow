import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { DiscordPatrolTool } from './discord-patrol.ts'
import type { ExecutionContext } from './context.ts'
import type { DiscordApi } from '../channels/discord-directory.ts'
const message=(n:number,channel='10')=>({id:String(n),channel_id:channel,type:0,author:{id:'8',username:'human'},content:`m${n}`,timestamp:'2026-01-01T00:00:00Z'})
function fixture(api:DiscordApi) {
 const workspace=mkdtempSync(join(process.cwd(),'.patrol-test-'))
 const make=()=>new DiscordPatrolTool(workspace,'p',{authorized:s=>s==='web:owner',bots:()=>[{id:'bot'}],api:b=>{if(b!=='bot')throw Error('Bot outside Project');return api}})
 const context={projectId:'p',sessionId:'web:owner',channel:'web',signal:new AbortController().signal} as ExecutionContext
 const run=async(args:Record<string,unknown>,ctx=context)=>JSON.parse(await make().execute({bot:'bot',...args},ctx))
 return {run,context,cleanup:()=>rmSync(workspace,{recursive:true,force:true})}
}
test('trusted Web cron without sender: bounded initial, incremental pages, no implicit ack, restart retry and reply deduplication',async()=>{
 let values=[1,2,3,4],posts=0
 const f=fixture(async(path,init)=>{
  if(init?.method==='POST'){posts++;return message(99)}
  const u=new URL(path,'https://mock'),after=Number(u.searchParams.get('after')),before=Number(u.searchParams.get('before')),limit=Number(u.searchParams.get('limit'))
  if(path.includes('/messages/'))return message(3)
  let list=values.filter(n=>(!after||n>after)&&(!before||n<before))
  list=after?list.slice(0,limit):list.slice(-limit)
  return list.reverse().map(n=>message(n))
 })
 try {
  const first=await f.run({action:'read',channel:'10',limit:2,attempt:'a'})
  assert.deepEqual(first.messages.map((m:any)=>m.id),['3','4'])
  assert.equal((await f.run({action:'inspect'})).cursors['10'],undefined)
  values.push(5,6,7)
  const replay=await f.run({action:'read',channel:'10',limit:100})
  assert.deepEqual(replay.messages.map((m:any)=>m.id),['3','4'])
  await f.run({action:'retry',batch:first.batch.id,attempt:'a',error:'restart'})
  const recovered=await f.run({action:'read',channel:'10',attempt:'b'})
  assert.equal(recovered.batch.id,first.batch.id)
  await assert.rejects(f.run({action:'ack',batch:first.batch.id,attempt:'a'}),/Stale/)
  await f.run({action:'ack',batch:first.batch.id,attempt:'b'})
  const next=await f.run({action:'read',channel:'10',limit:2,attempt:'c'})
  assert.deepEqual(next.messages.map((m:any)=>m.id),['5','6'])
  await f.run({action:'ack',batch:next.batch.id,attempt:'c'})
  assert.deepEqual((await f.run({action:'read',channel:'10'})).messages.map((m:any)=>m.id),['7'])
  const reply={action:'reply',channel:'10',message:'3',content:'hello',key:'question-3'}
  assert.equal((await f.run(reply)).id,'99');assert.equal((await f.run(reply)).id,'99');assert.equal(posts,1)
  await assert.rejects(f.run({...reply,content:'different'}),/different content/)
  assert.equal((await f.run({action:'context',channel:'10',message:'3'})).id,'3')
 } finally {f.cleanup()}
})
test('denies nontrusted and cross Project sessions before API; Project Bot selection enforced',async()=>{
 let calls=0
 const f=fixture(async()=>{calls++;return []})
 try {
  for(const ctx of [{...f.context,sessionId:'discord:10'},{...f.context,sessionId:'web:service'},{...f.context,projectId:'other'}])await assert.rejects(f.run({action:'read',channel:'10'},ctx),/Trusted/)
  await assert.rejects(f.run({action:'read',bot:'foreign',channel:'10'}),/outside Project/)
  assert.equal(calls,0)
 }finally{f.cleanup()}
})
test('archived thread pagination is explicit and parent validated; permission errors never become empty success',async()=>{
 const paths:string[]=[]
 const f=fixture(async path=>{paths.push(path);if(path.includes('before='))return {threads:[],has_more:false};return {threads:[{id:'20',parent_id:'10',thread_metadata:{archive_timestamp:'2026-01-01T00:00:00Z'}}],has_more:true}})
 try {
  const page=await f.run({action:'threads',channel:'10',archived:true,limit:1})
  assert.equal(page.nextBefore,'2026-01-01T00:00:00Z')
  assert.equal((await f.run({action:'threads',channel:'10',archived:true,before:page.nextBefore})).nextBefore,null)
  assert.match(paths[1]!,/before=2026/)
 }finally{f.cleanup()}
 const denied=fixture(async()=>{throw Error('Discord 403')})
 try {await assert.rejects(denied.run({action:'read',channel:'10'}),/403/);assert.equal((await denied.run({action:'inspect'})).batches.length,0)}finally{denied.cleanup()}
})
test('ambiguous send is recorded before network and does not resend on restart',async()=>{
 let posts=0
 const f=fixture(async()=>{posts++;throw Error('timeout')})
 const args={action:'reply',channel:'10',content:'hello',key:'stable'}
 try{await assert.rejects(f.run(args),/timeout/);await assert.rejects(f.run(args),/uncertain/);assert.equal(posts,1)}finally{f.cleanup()}
})
test('malformed message channel rejected without advancing watermark',async()=>{
 const f=fixture(async()=>[message(1,'11')])
 try{await assert.rejects(f.run({action:'read',channel:'10'}),/Invalid Discord message/);assert.deepEqual((await f.run({action:'inspect'})).cursors,{})}finally{f.cleanup()}
})

test('concurrent reads conflict before replacing pending batch; deleted initial messages never pull older history into replay',async()=>{
 let values=[1,2,3,4]
 const f=fixture(async path=>{
  await new Promise(resolve=>setTimeout(resolve,1))
  const u=new URL(path,'https://mock'),before=Number(u.searchParams.get('before')),limit=Number(u.searchParams.get('limit'))
  return values.filter(n=>!before||n<before).slice(-limit).reverse().map(n=>message(n))
 })
 try {
  const results=await Promise.allSettled([f.run({action:'read',channel:'10',limit:2}),f.run({action:'read',channel:'10',limit:2})])
  assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
  assert.equal(results.filter(r=>r.status==='rejected').length,1)
  values=[1,2,4]
  assert.deepEqual((await f.run({action:'read',channel:'10'})).messages.map((m:any)=>m.id),['4'])
 }finally{f.cleanup()}
})
test('production compatibility delegates consumption and send without a second patrol cursor/API history store',async()=>{
 const workspace=mkdtempSync(join(process.cwd(),'.patrol-transition-test-'))
 const calls:Array<{action:string;args:Record<string,unknown>}>=[]
 const tool=new DiscordPatrolTool(workspace,'p',{authorized:()=>true,bots:()=>[],api:()=>async()=>{throw Error('legacy API history must not run')},stream:async(action,args)=>{calls.push({action,args});return JSON.stringify({events:[],batch:null})}})
 const context={projectId:'p',sessionId:'web:owner',signal:new AbortController().signal} as ExecutionContext
 try {
  await tool.execute({action:'read',bot:'bot',channel:'10',consumer:'stable'},context)
  await tool.execute({action:'reply',bot:'bot',channel:'10',content:'answer',key:'stable-key'},context)
  assert.equal(calls[0].args.consumer,'stable');assert.deepEqual(calls[0].args.conversations,['10'])
  assert.equal(calls[1].action,'send');assert.equal(calls[1].args.idempotencyKey,'stable-key')
 } finally {rmSync(workspace,{recursive:true,force:true})}
})
