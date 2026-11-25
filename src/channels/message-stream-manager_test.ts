import {test} from 'node:test'
import assert from 'node:assert/strict'
import {mkdtempSync,rmSync,existsSync} from 'node:fs'
import {join} from 'node:path'
import {Hono} from 'hono'
import {Bus} from '../bus/bus.ts'
import {ConfigSchema} from '../config/schema.ts'
import {ChannelManager} from './manager.ts'
import {BotInstanceStore} from './bot-store.ts'
import {ChannelMessageStream} from './message-stream.ts'
import {DiscordChannel} from './discord.ts'
import {connectionSinkProjection} from './sink-projection.ts'
import {parseChannelSource, passiveChannelId, type ChannelSource} from './passive-contract.ts'
import {AbstractChannel} from './base.ts'
import type {SessionManager} from '../sessions/session-manager.ts'
import type {StreamInput} from './message-stream.ts'
class Adapter extends AbstractChannel {
 readonly name='qq';update=undefined
 async start(){this.reportState('connecting');this.reportState('connected')}
 async stop(){this.reportState('disconnected');this.setAccepting(false)}
 async send(){return null}
 async push(sender='owner',chat='10',group=true){
  const input={senderId:sender,chatId:chat,messageId:'1',content:'synthetic',isGroup:group}
  const arrival=await this.collectPassive(input)
  if (!arrival?.eligible) throw new Error('Explicit BOT assignment required')
  await this.runReceivePolicy({...input,channelInputGuard:arrival.assertCurrent},async()=>{await this.handleIncoming(sender,chat,'synthetic','1',{isGroup:group})})
 }
 passive(event:Omit<StreamInput,'connection'|'platform'>,group=true){return this.collectStream(event,group)}
 lost(){this.reportState('disconnected')}
}
async function fixture(t:{after(fn:()=>unknown):void},injected:boolean,configure?:(stream:ChannelMessageStream,botId:string)=>void){
 const root=mkdtempSync(join(process.cwd(),'.stream-manager-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}))
 const defaultHome=join(root,'must-not-be-created'),home=join(root,'explicit-stream-home')
 const store=new BotInstanceStore({projectId:'p',path:join(root,'bots.json')}),bot=store.create('qq','synthetic',{appId:'synthetic-'+root,secret:'synthetic',enabled:true})
 const adapter=new Adapter(new Bus());let received=0,assigned=true
 const stream=new ChannelMessageStream(home,'p')
 configure?.(stream,bot.id)
 const sessions={getSessionState:()=>undefined,listSessions:()=>[],retireIdleConversationContexts:async()=>{},recordPassiveChannel:async()=>({disposition:'recorded'})} as unknown as SessionManager
 const manager=new ChannelManager(ConfigSchema.parse({agent:{workspace:defaultHome}}),new Bus(),sessions,async m=>{received++;return {status:'accepted',sessionId:'mock',inputId:m.messageId}}, {projectId:'p',instanceStore:store,factory:()=>adapter,serviceAssigned:a=>assigned&&a.conversationId==='10',serviceGeneration:()=> 'generation',routeInputPolicy:(_m,run)=>run({platform:'qq',trigger:'all'}),...(injected?{messageStream:stream}:{})})
 await manager.init();await manager.startAll(new Hono());t.after(()=>manager.stopAll())
 return {root,defaultHome,home,stream,store,bot,manager,adapter,get received(){return received},revoke(){assigned=false}}
}
test('manager without explicitly injected stream never creates default workspace files',async t=>{
 const f=await fixture(t,false)
 await f.adapter.push();await f.adapter.passive({conversation:'10',message:'2',sender:'owner',kind:'created',content:'passive'})
 f.adapter.lost()
 assert.equal(existsSync(f.defaultHome),false);assert.equal(existsSync(f.home),false)
})
test('common stream records unbound and revoked transport events without granting execution or stream access',async t=>{
 const f=await fixture(t,true)
 await f.adapter.push();assert.equal(f.stream.snapshot().events.length,1)
 await f.adapter.passive({conversation:'10',message:'2',sender:'owner',kind:'created',content:'passive'})
 assert.equal(f.received,1);assert.equal(f.stream.snapshot().events.length,2)
 await assert.rejects(f.adapter.push('owner','unauthorized'),/assignment/)
 await f.adapter.passive({conversation:'unauthorized',message:'3',sender:'owner',kind:'created',content:'must not save'})
 assert.equal(f.stream.snapshot().events.length,4)
 f.revoke();await f.adapter.passive({conversation:'10',message:'4',sender:'owner',kind:'created',content:'revoked'})
 assert.equal(f.stream.snapshot().events.length,5)
 assert.equal(f.received,1, 'Recording never dispatches unbound/revoked messages')
 assert.throws(()=>f.manager.assertStreamAccess(f.bot.id,'10'),/assignment/)
 f.adapter.lost();await f.stream.drain();assert.equal(f.stream.snapshot().events.at(-1)?.kind,'gap')
 assert.equal(existsSync(f.defaultHome),false)
})
for(const failure of ['directory','append','append-async'] as const)test(`transport ${failure} failure is diagnostic only during start, status and stop`,async t=>{
 const logs:string[]=[]
 t.mock.method(console,'error',(...args:unknown[])=>{logs.push(args.map(String).join(' '))})
 const f=await fixture(t,true,(stream,botId)=>{
  t.mock.method(stream,'directory',()=>{
   if(failure==='directory')throw new Error('synthetic journal read failure')
   return [{connection:botId,conversation:'10',parent:'parent',platform:'qq',capabilities:{received:true,history:false,changes:false,send:false},notice:''}]
  })
  if(failure==='append')t.mock.method(stream,'append',()=>{throw new Error('synthetic journal write failure')})
  if(failure==='append-async')t.mock.method(stream,'append',async()=>{throw new Error('synthetic queued write failure')})
 })
 assert.ok(logs.some(line=>line.includes('phase=stream-gap')), 'startup gap failure must be logged')
 assert.equal(f.manager.botStatuses()[0].state,'connected')
 assert.match(f.manager.botStatuses()[0].message??'',/event stream degraded/)
 const startupLogs=logs.length
 assert.doesNotThrow(()=>f.adapter.lost())
 await f.stream.drain()
 assert.equal(f.manager.botStatuses()[0].state,'disconnected')
 assert.match(f.manager.botStatuses()[0].message??'',/event stream degraded/)
 const beforeStop=logs.length
 assert.ok(beforeStop>startupLogs, 'status callback failure must be logged')
 await assert.doesNotReject(f.manager.stopAll())
 assert.ok(logs.length>beforeStop, 'shutdown gap failure must be logged')
 assert.ok(logs.some(line=>line.includes('phase=stream-gap')&&line.includes(`bot=${f.bot.id}`)))
 assert.ok(!logs.some(line=>/phase=(start|stop|cleanup-after-start-failure)\b/.test(line)))
})

test('actual ingress stream write failure remains fail-closed and gains a safe stage',async t=>{
 const f=await fixture(t,true)
 const failure=Object.assign(new Error('private synthetic content'),{code:'ENOSPC'})
 t.mock.method(f.stream,'append',()=>{throw failure})
 const {ingressErrorDetail}=await import('./ingress-diagnostic.ts')
 await assert.rejects(f.adapter.push(),error=>{
  assert.equal(error,failure)
  assert.equal(ingressErrorDetail(error),'phase=stream category=system:ENOSPC')
  return true
 })
 assert.equal(f.received,0)
 await assert.rejects(f.adapter.push('owner','unauthorized'),error=>error===failure)
 await assert.rejects(f.adapter.passive({conversation:'10',message:'2',sender:'owner',kind:'created',content:'synthetic'}),error=>{
  assert.equal(error,failure);assert.equal(ingressErrorDetail(error),'phase=stream category=system:ENOSPC');return true
 })
})

test('partial changes retain message identity and durable dedupe without a fabricated sender or BOT assignment', async t => {
 const f=await fixture(t,true)
 f.revoke()
 await f.adapter.passive({conversation:'unbound',kind:'created',message:'original',sender:'original-sender',content:'before'})
 await f.adapter.passive({conversation:'unbound',kind:'updated',message:'original',content:'after',revision:'edit-one'})
 await f.adapter.passive({conversation:'unbound',kind:'deleted',message:'original',revision:'delete-one'})
 await f.adapter.passive({conversation:'unbound',kind:'deleted',message:'unknown-message',revision:'delete-unknown'})
 const restarted=new ChannelMessageStream(f.home,'p')
 await restarted.append({connection:f.bot.id,platform:'qq',conversation:'unbound',kind:'updated',message:'original',content:'after',revision:'edit-one'})
 await restarted.append({connection:f.bot.id,platform:'qq',conversation:'unbound',kind:'deleted',message:'original',revision:'delete-one'})
 const rows=restarted.snapshot().events
 assert.equal(rows.length,4)
 assert.deepEqual(rows.slice(0,3).map(row=>[row.conversation,row.message,row.sender]),[
  ['unbound','original','original-sender'],['unbound','original','original-sender'],['unbound','original','original-sender'],
 ])
 assert.equal(rows[3]?.message,'unknown-message')
 assert.equal(rows[3]?.sender,undefined,'An unknown deletion must not invent an actor')
 assert.equal(f.received,0)
 assert.equal(restarted.directory()[0]?.conversation,'unbound')
})


test('Discord manager receipts distinguish category ancestry from public thread parents before history, stream and receiver projection', async t => {
 const root=mkdtempSync(join(process.cwd(),'.stream-manager-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}))
 const bus=new Bus(),store=new BotInstanceStore({projectId:'p',path:join(root,'connections.json')})
 const bot=store.create('discord','Synthetic Discord',{token:'synthetic',enabled:true})
 const adapter=new DiscordChannel(bus,{token:'synthetic'}),stream=new ChannelMessageStream(root,'p')
 const sources:ChannelSource[]=[]
 const sessions={recordPassiveChannel:async(source:ChannelSource)=>{
  sources.push(parseChannelSource(source,passiveChannelId(source),'p')!)
  return {disposition:'recorded'}
 }} as unknown as SessionManager
 let received=0
 const manager=new ChannelManager(ConfigSchema.parse({agent:{workspace:root}}),bus,sessions,async()=>{
  received++;assert.fail('Common receipts must not execute a BOT')
 },{projectId:'p',instanceStore:store,factory:()=>adapter,messageStream:stream})
 t.after(()=>manager.stopAll())
 await manager.init()
 // All identities are synthetic. Include raw category parents to exercise the
 // manager boundary even if the current inspector already normalizes them away.
 const locations=new Map([
  ['201',{type:0,parentId:'101'}],['202',{type:5,parentId:'101'}],
  ['301',{type:11,parentId:'201'}],['302',{type:10,parentId:'202'}],
  ['401',{type:1,parentId:'101'}],['303',{type:12,parentId:'201'}],
 ])
 t.mock.method(adapter,'inspectReceipt',async(chatId:string)=>{
  const location=locations.get(chatId)!
  return {botUserId:'900',canView:true,location:{id:chatId,name:'Synthetic',...location,
   guildId:location.type===1?null:'100',guildName:null,parentName:null,recipientId:location.type===1?'500':null}}
 })
 for(const chatId of ['201','202','301','302','401']){
  await adapter['collectPassive']({senderId:'500',chatId,content:'Synthetic receipt',messageId:`create-${chatId}`,
   isGroup:chatId!=='401',passiveParentId:'stale-adapter-parent'})
  await adapter['collectStream']({conversation:chatId,kind:'updated',message:`create-${chatId}`,
   content:'Synthetic edit',revision:'one',parent:'stale-event-parent'},chatId!=='401')
 }
 assert.deepEqual(sources.map(source=>[source.conversationId,source.kind,source.parentId]),[
  ['201','channel',undefined],['202','channel',undefined],['301','thread','201'],['302','thread','202'],['401','direct',undefined],
 ])
 for(const source of sources.filter(source=>source.kind!=='thread'))assert.equal(Object.hasOwn(source,'parentId'),false,'No stale spread parent remains')
 const events=stream.snapshot().events
 assert.equal(events.length,10)
 for(const row of events)assert.equal(row.parent,row.conversation==='301'?'201':row.conversation==='302'?'202':undefined)
 const sink=connectionSinkProjection({projectId:'p',connectionId:bot.id,platform:'discord',
  histories:sources.map(source=>({sessionId:passiveChannelId(source),projectId:'p',channelSource:source})),observations:stream.directory()})
 assert.deepEqual(sink.receivers.map(receiver=>receiver.address.conversationId).sort(),['201','202','401'],'The shared category never becomes a receiver')
 for(const receiver of sink.receivers){
  if(receiver.address.conversationId==='401') assert.equal(receiver.navigation.kind,'conversation')
  else {assert.equal(receiver.navigation.kind,'channel-content');assert.equal('view' in receiver.navigation&&receiver.navigation.view,'messages-and-threads')}
 }
 await assert.rejects(adapter['collectPassive']({senderId:'500',chatId:'303',content:'Private thread',messageId:'private',isGroup:true}),/visibility denied/)
 await assert.rejects(adapter['collectStream']({conversation:'303',kind:'discovered',parent:'201'},true),/visibility denied/)
 assert.equal(sources.length,5);assert.equal(stream.snapshot().events.length,10);assert.equal(received,0)
})

test('shutdown waits for admitted stream writes and transport stop gaps', async t => {
 const f=await fixture(t,true)
 await f.adapter.push()
 const pending=f.stream.append({connection:f.bot.id,platform:'qq',conversation:'10',kind:'updated',message:'1',content:'queued before shutdown'})
 await f.manager.stopAll()
 await pending
 const rows=new ChannelMessageStream(f.home,'p').snapshot().events
 assert.ok(rows.some(row=>row.content==='queued before shutdown'))
 assert.equal(rows.at(-1)?.kind,'gap')
})
