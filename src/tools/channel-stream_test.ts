import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync,rmSync } from 'node:fs'
import { join } from 'node:path'
import { ChannelStreamTool } from './channel-stream.ts'
import { ChannelMessageStream } from '../channels/message-stream.ts'
import type { ExecutionContext } from './context.ts'
function fixture(t:{after(fn:()=>void):void}){
 const home=mkdtempSync(join(process.cwd(),'.channel-stream-test-'));t.after(()=>rmSync(home,{recursive:true,force:true}))
 const stream=new ChannelMessageStream(home,'p');let sends=0,fail=false
 const deps={authorized:(id:string)=>id.startsWith('web:'),assertConnection:(id:string,c?:string)=>{if(id!=='bot'||c==='forbidden')throw Error('Access denied')},send:async()=>{sends++;if(fail)throw Error('network');return {id:'9'}}}
 const ctx={projectId:'p',sessionId:'web:1',signal:new AbortController().signal} as ExecutionContext
 const run=async(args:Record<string,unknown>,context=ctx)=>JSON.parse(await new ChannelStreamTool('channel_read',home,'p',deps).execute({consumer:'worker',connection:'bot',conversations:['10'],...args},context))
 const append=(message:string,kind:'created'|'updated'|'deleted'='created',conversation='10',parent?:string)=>stream.append({connection:'bot',conversation,platform:'discord',kind,message,sender:'8',content:kind==='deleted'?undefined:message,...(parent?{parent}:{})})
 return {home,stream,ctx,run,append,deps,get sends(){return sends},fail(){fail=true}}
}
test('stable consumers survive sessions and restart, fixed batches, independent readers, fencing and no implicit ack',async t=>{
 const f=fixture(t);f.append('1');f.append('2')
 const first=await f.run({limit:1,attempt:'a'});assert.equal(first.hasMore,true)
 f.append('3');const replay=await f.run({limit:100},{...f.ctx,sessionId:'web:rebuilt'})
 assert.deepEqual(replay.events.map((e:any)=>e.message),['1']);assert.equal(replay.batch.id,first.batch.id)
 const independent=await f.run({consumer:'other'});assert.equal(independent.events.length,3)
 await f.run({action:'retry',batch:first.batch.id,attempt:'a',error:'restart'})
 await f.run({attempt:'b'});await assert.rejects(f.run({action:'ack',batch:first.batch.id,attempt:'a'}),/Stale/)
 await f.run({action:'ack',batch:first.batch.id,attempt:'b'})
 assert.deepEqual((await f.run({})).events.map((e:any)=>e.message),['2','3'])
})
test('late updates, deletes, children, dedupe and explicit retention gaps',async t=>{
 const f=fixture(t);f.append('1');f.append('1');f.append('old','created','20','10');f.append('1','updated');f.append('1','deleted')
 const result=await f.run({includeChildren:true});assert.deepEqual(result.events.map((e:any)=>e.kind),['created','created','updated','deleted'])
 assert.equal(result.events[1].parent,'10')
 const bounded=new ChannelMessageStream(f.home,'p',2);bounded.append({connection:'bot',conversation:'10',platform:'discord',kind:'created',message:'new'})
 await assert.rejects(f.run({consumer:'expired'}),/retention gap/)
 const floor=bounded.snapshot().floor;assert.ok((await f.run({consumer:'reset',initialAfter:floor})).events.length)
})
test('Project and untrusted access denied; idempotent send and uncertain result fail closed',async t=>{
 const f=fixture(t)
 await assert.rejects(f.run({}, {...f.ctx,projectId:'other'}),/Trusted/)
 await assert.rejects(f.run({}, {...f.ctx,sessionId:'discord:10'}),/Trusted/)
 await assert.rejects(f.run({connection:'foreign'}),/Access/)
 const send=async(key:string,content='hello')=>new ChannelStreamTool('channel_send',f.home,'p',f.deps).execute({connection:'bot',conversation:'10',content,idempotencyKey:key},f.ctx)
 await send('one');await send('one');assert.equal(f.sends,1)
 await assert.rejects(send('one','changed'),/different/)
 f.fail();await assert.rejects(send('two'),/network/);await assert.rejects(send('two'),/uncertain/);assert.equal(f.sends,2)
})
test('unfinished includeChildren payload is fixed even when later discovery changes directory membership',async t=>{
 const f=fixture(t);f.append('hidden','created','20');f.append('parent')
 const first=await f.run({includeChildren:true,attempt:'a'});assert.deepEqual(first.events.map((e:any)=>e.message),['parent'])
 f.stream.append({connection:'bot',platform:'discord',conversation:'20',parent:'10',kind:'discovered'})
 const replay=await f.run({includeChildren:true});assert.deepEqual(replay.events,first.events)
 assert.throws(()=>new ChannelMessageStream(f.home,'other').snapshot(),/Project mismatch/)
})
test('concurrent readers cannot replace or duplicate pending batch',async t=>{
 const f=fixture(t);f.append('one')
 const results=await Promise.allSettled([f.run({attempt:'a'}),f.run({attempt:'b'})])
 assert.equal(results.filter(r=>r.status==='fulfilled').length,1)
 const replay=await f.run({});assert.equal(replay.batch.attempts.at(-1),'a')
 await assert.rejects(f.run({action:'ack',batch:replay.batch.id,attempt:'b'}),/Stale/)
})
test('late platform IDs append after acknowledged local progress rather than falling behind a timestamp/ID cursor',async t=>{
 const f=fixture(t);f.append('1000');const first=await f.run({attempt:'first'})
 await f.run({action:'ack',batch:first.batch.id,attempt:'first'})
 f.append('1')
 const late=await f.run({});assert.deepEqual(late.events.map((e:any)=>e.message),['1'])
 assert.ok(late.events[0].position>first.events[0].position)
})
