import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync} from 'node:fs'
import {join} from 'node:path'
import {collectDiscordHistory} from './discord-stream.ts'
import {ChannelMessageStream} from './message-stream.ts'
import {DiscordChannel} from './discord.ts'
import {Bus} from '../bus/bus.ts'
test('history pagination is bounded, deduped and separate from consumer; malformed pages rejected',async t=>{
 const home=mkdtempSync(join(process.cwd(),'.channel-history-test-'));t.after(()=>rmSync(home,{recursive:true,force:true}))
 const paths:string[]=[];let next=1
 const api=async(path:string)=>{paths.push(path);const start=next;next+=100;return Array.from({length:100},(_,i)=>({id:String(start+i),channel_id:'10',type:0,author:{id:'8',username:'human'},content:'message',timestamp:'2026-01-01T00:00:00Z'})).reverse()}
 const signal=new AbortController().signal
 assert.equal((await collectDiscordHistory(home,'p','bot','10',api,signal)).hasMore,true)
 await collectDiscordHistory(home,'p','bot','10',api,signal)
 assert.match(paths[1]!,/after=100/)
 const stream=new ChannelMessageStream(home,'p');assert.equal(stream.snapshot().events.length,201);assert.equal(stream.snapshot().events[0].kind,'gap')
 await assert.rejects(collectDiscordHistory(home,'p','bot','10',async()=>[{id:'1',channel_id:'wrong'}],signal))
})
test('gateway passive collection is separate from mention trigger, own messages never trigger; changes recorded',async t=>{
 const channel=new DiscordChannel(new Bus(),{token:'synthetic',triggerMode:'mention',reactionEmoji:''});t.after(()=>channel.stop());Object.assign(channel,{botUserId:'900'})
 const collected:unknown[]=[],received:unknown[]=[]
 channel.setStreamCollector(async e=>{collected.push(e)})
 channel.setReceiver(async m=>{received.push(m);return {status:'accepted',sessionId:'discord:10',inputId:m.messageId}})
 const dispatch=(event:string,data:Record<string,unknown>)=>(channel as unknown as {handleDispatch:(e:string,d:Record<string,unknown>)=>Promise<void>}).handleDispatch(event,data)
 const msg={id:'1',channel_id:'10',guild_id:'100',author:{id:'8',username:'human'},content:'ordinary',mentions:[]}
 await dispatch('MESSAGE_CREATE',msg);assert.equal(collected.length,1);assert.equal(received.length,0)
 // No REST channel-name lookup in this synthetic fixture.
 Object.assign(channel,{channelNameCache:new Map([['10','test']])})
 await dispatch('MESSAGE_CREATE',{...msg,id:'2',content:'<@900> hello',mentions:[{id:'900'}]});assert.equal(received.length,1)
 await dispatch('MESSAGE_CREATE',{...msg,id:'3',author:{id:'900',bot:true}});assert.equal(received.length,1)
 await dispatch('MESSAGE_UPDATE',{...msg,content:'edit',edited_timestamp:'2026-01-01T00:00:00Z'})
 await dispatch('MESSAGE_DELETE',{id:'1',channel_id:'10',guild_id:'100'})
 assert.equal(collected.length,4)
})
test('history overlap dedupes platform IDs and admission filters unauthorized senders without widening collection',async t=>{
 const home=mkdtempSync(join(process.cwd(),'.channel-overlap-test-'));t.after(()=>rmSync(home,{recursive:true,force:true}))
 const stream=new ChannelMessageStream(home,'p');stream.append({connection:'bot',conversation:'10',platform:'discord',kind:'created',message:'1',sender:'8',content:'gateway'})
 const raw=(id:string,sender:string)=>({id,channel_id:'10',type:0,author:{id:sender,username:'human'},content:'history',timestamp:'2026-01-01T00:00:00Z'})
 const signal=new AbortController().signal
 await collectDiscordHistory(home,'p','bot','10',async()=>[raw('1','8'),raw('2','9')],signal,undefined,async sender=>sender==='8')
 assert.equal(stream.snapshot().events.filter(e=>e.message==='1').length,1)
 assert.equal(stream.snapshot().events.some(e=>e.sender==='9'),false)
 await assert.rejects(collectDiscordHistory(home,'p','bot','10',async()=>[raw('3','8')],signal,undefined,async()=>{throw Error('permission inspection unavailable')}),/unavailable/)
})
