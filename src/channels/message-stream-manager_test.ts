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
import {AbstractChannel} from './base.ts'
import type {SessionManager} from '../sessions/session-manager.ts'
import type {StreamInput} from './message-stream.ts'
class Adapter extends AbstractChannel {
 readonly name='qq';update=undefined
 async start(){this.reportState('connected')}
 async stop(){this.setAccepting(false)}
 async send(){return null}
 push(sender='owner',chat='10',group=true){return this.handleIncoming(sender,chat,'synthetic','1',{isGroup:group})}
 passive(event:Omit<StreamInput,'connection'|'platform'>,group=true){return this.collectStream(event,group)}
 lost(){this.reportState('disconnected')}
}
async function fixture(t:{after(fn:()=>unknown):void},injected:boolean,purpose:'personal'|'service'='service'){
 const root=mkdtempSync(join(process.cwd(),'.stream-manager-test-'));t.after(()=>rmSync(root,{recursive:true,force:true}))
 const defaultHome=join(root,'must-not-be-created'),home=join(root,'explicit-stream-home')
 const store=new BotInstanceStore({projectId:'p',path:join(root,'bots.json')}),bot=store.create('qq','synthetic',{appId:'synthetic-'+root,secret:'synthetic',enabled:true},undefined,purpose)
 const adapter=new Adapter(new Bus());let received=0,assigned=true
 const stream=new ChannelMessageStream(home,'p')
 const sessions={getSessionState:()=>undefined,listSessions:()=>[],retireIdleConversationContexts:async()=>{}} as unknown as SessionManager
 const manager=new ChannelManager(ConfigSchema.parse({agent:{workspace:defaultHome}}),new Bus(),sessions,async m=>{received++;return {status:'accepted',sessionId:'mock',inputId:m.messageId}}, {projectId:'p',instanceStore:store,factory:()=>adapter,serviceAssigned:a=>assigned&&a.conversationId==='10',...(injected?{messageStream:stream}:{})})
 await manager.init();await manager.startAll(new Hono());t.after(()=>manager.stopAll())
 return {root,defaultHome,home,stream,store,bot,manager,adapter,get received(){return received},revoke(){assigned=false}}
}
test('manager without explicitly injected stream never creates default workspace files',async t=>{
 const f=await fixture(t,false)
 await f.adapter.push();await f.adapter.passive({conversation:'10',message:'2',sender:'owner',kind:'created',content:'passive'})
 f.adapter.lost()
 assert.equal(existsSync(f.defaultHome),false);assert.equal(existsSync(f.home),false)
})
test('production-style explicit injection persists admitted shared ingress, passive events and disconnect gaps; rejects unbound groups',async t=>{
 const f=await fixture(t,true)
 await f.adapter.push();assert.equal(f.stream.snapshot().events.length,1)
 await f.adapter.passive({conversation:'10',message:'2',sender:'owner',kind:'created',content:'passive'})
 assert.equal(f.received,1);assert.equal(f.stream.snapshot().events.length,2)
 await assert.rejects(f.adapter.push('owner','unauthorized'),/assignment/)
 await f.adapter.passive({conversation:'unauthorized',message:'3',sender:'owner',kind:'created',content:'must not save'})
 assert.equal(f.stream.snapshot().events.length,2)
 f.revoke();await f.adapter.passive({conversation:'10',message:'4',sender:'owner',kind:'created',content:'revoked'})
 assert.equal(f.stream.snapshot().events.length,2)
 assert.throws(()=>f.manager.assertStreamAccess(f.bot.id,'10'),/assignment/)
 f.adapter.lost();assert.equal(f.stream.snapshot().events.at(-1)?.kind,'gap')
 assert.equal(existsSync(f.defaultHome),false)
})
test('personal passive collection rejects strangers and groups; verified owner DM only',async t=>{
 const f=await fixture(t,true,'personal')
 const challenge=f.manager.createOwnerChallenge(f.bot.id)
 // Pair via normal existing manager owner challenge path, not by mutating persisted verification.
 await f.adapter['handleIncoming']('owner','10',`/shadow-pair ${challenge.challenge}`,'pair',{isGroup:false})
 await f.manager.confirmOwner(f.bot.id,challenge.challenge)
 for(const [sender,group] of [['stranger',false],['owner',true]] as const)await f.adapter.passive({conversation:'10',message:sender+group,sender,kind:'created',content:'private'},group)
 assert.equal(f.stream.snapshot().events.length,0)
 await f.adapter.passive({conversation:'10',message:'owner',sender:'owner',kind:'created',content:'private'},false)
 assert.equal(f.stream.snapshot().events.length,1)
})
