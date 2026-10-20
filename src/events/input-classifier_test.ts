import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { InputClassifier, type ClassifierPolicy } from './input-classifier.ts'
import type { LLMProvider } from '../providers/provider.ts'
import { InputProcessor } from './input-processor.ts'
export const policy:ClassifierPolicy={model:'configured-small',instructions:'Classify suspected campaigns. Unknown if unsure.',fields:['content','attachments'],maxInputBytes:1000,maxTokens:64,maxRequests:2,maxWindowTokens:10000,windowMs:60000,deadlineMs:100,minConfidence:0.9}
function setup(t:{after(fn:()=>void):void},chat:LLMProvider['chat']) {
 const dir=mkdtempSync(path.join(tmpdir(),'classifier-test-'));t.after(()=>rmSync(dir,{recursive:true,force:true}))
 const file=path.join(dir,'ledger.json');const provider:LLMProvider={name:'fake',listModels:()=>['configured-small'],chat}
 const make=()=>new InputClassifier(()=>provider,file)
 const run=(classifier:InputClassifier,id='1',p=policy,authorize=async()=>{})=>classifier.classify({authority:'reviewed-scope/revision',eventId:id,policy:p,data:{content:'special case',secret:'excluded',author:{id:'123'},attachments:[{url:'https://secret',filename:'private',size:42,content_type:'image/png'}]},signal:new AbortController().signal,authorize})
 return {make,run,provider}
}
test('real service contract: reviewed model, minimal scope input, zero tools, durable reservation and result dedupe',async t=>{
 let calls=0
 const f=setup(t,async(messages,tools,options)=>{calls++;assert.deepEqual(tools,[]);assert.equal(options.model,policy.model);assert.equal(options.maxTokens,64);const input=JSON.parse(messages[1]!.content as string);assert.deepEqual(Object.keys(input),['content','attachments']);assert.equal(input.attachments[0].url,undefined);assert.equal(input.author,undefined);return {content:'{"label":"semanticwake","confidence":0.99}',toolCalls:[]}})
 const classifier=f.make();assert.equal(calls,0)
 assert.equal((await f.run(classifier)).label,'semanticwake');assert.equal((await f.run(f.make())).label,'semanticwake');assert.equal(calls,1)
})
test('request/token/input/model limits fail closed without dispatch; window reservations persist',async t=>{
 let calls=0;const f=setup(t,async()=>{calls++;return {content:'{"label":"buffer","confidence":1}',toolCalls:[]}})
 assert.equal((await f.run(f.make(),'a',{...policy,maxWindowTokens:100})).label,'unknown')
 assert.equal((await f.run(f.make(),'b',{...policy,maxInputBytes:1})).label,'unknown')
 assert.equal((await f.run(f.make(),'c',{...policy,model:'external-model'})).label,'unknown');assert.equal(calls,0)
 const classifier=f.make();await f.run(classifier,'1');await f.run(classifier,'2');assert.equal((await f.run(f.make(),'3')).label,'unknown');assert.equal(calls,2)
})
test('malformed schema, low confidence, tools and transport failures are unknown and never retried after recovery',async t=>{
 for(const content of ['invalid','{"label":"semanticwake","confidence":0.1}','{"label":"semanticwake","confidence":1,"model":"evil"}']){
  let calls=0;const f=setup(t,async()=>{calls++;return {content,toolCalls:[]}});assert.equal((await f.run(f.make())).label,'unknown');await f.run(f.make());assert.equal(calls,1)
 }
 let calls=0;const f=setup(t,async()=>{calls++;throw new Error('uncertain billing')});await f.run(f.make());await f.run(f.make());assert.equal(calls,1)
 const g=setup(t,async()=>({content:'{"label":"semanticwake","confidence":1}',toolCalls:[{id:'1',name:'exec',arguments:{}}]}));assert.equal((await g.run(g.make())).label,'unknown')
})
test('deadline bounds uncooperative provider; late answer cannot wake or cause billing retry',async t=>{
 let calls=0;const f=setup(t,async()=>{calls++;await new Promise(r=>setTimeout(r,100));return {content:'{"label":"semanticwake","confidence":1}',toolCalls:[]}})
 const start=Date.now();assert.equal((await f.run(f.make(),'1',{...policy,deadlineMs:10})).label,'unknown');assert.ok(Date.now()-start<90)
 await f.run(f.make(),'1',{...policy,deadlineMs:10});assert.equal(calls,1)
})
test('revocation before dispatch and after response fails closed',async t=>{
 let calls=0;const f=setup(t,async()=>{calls++;return {content:'{"label":"semanticwake","confidence":1}',toolCalls:[]}})
 assert.equal((await f.run(f.make(),'1',policy,async()=>{throw new Error('revoked')})).label,'unknown');assert.equal(calls,0)
 let checks=0;assert.equal((await f.run(f.make(),'2',policy,async()=>{if(++checks===3)throw new Error('changed')})).label,'unknown');assert.equal(calls,1)
})
test('two-phase restricted processor routes a special event once; rule fast path uses no model and unknown never wakes',async t=>{
 let calls=0;const f=setup(t,async()=>{calls++;return {content:'{"label":"semanticwake","confidence":1}',toolCalls:[]}})
 const classifier=f.make(),controller=new AbortController(),outputs:unknown[]=[]
 const processor=new InputProcessor<string>();t.after(()=>{void processor.stop()})
 const code=`export function run({event,classification}) {if(event.data.content==='rule')return {action:'emit',semantic:{type:'campaign',data:{rule:true}}};if(!classification)return {action:'ignore',classify:true};return classification.label==='semanticwake'?{action:'emit',semantic:{type:'suspected',data:{id:event.data.id}}}:{action:'buffer'}}`
 const accept=(id:string,text:string,granted=true)=>processor.accept({key:'scope',id,item:id,event:{type:'discord.MESSAGE_CREATE',data:{content:text,id}},policy:{code,delayMs:10,classifier:policy},signal:controller.signal,publish:async(ids,_signal,semantic)=>{outputs.push({ids,semantic})},classify:signal=>classifier.classify({authority:'scope',eventId:id,policy,data:{content:text},signal,authorize:async()=>{if(!granted)throw Error('revoked')}})})
 await accept('1','rule');assert.equal(calls,0);await accept('2','special');assert.equal(calls,1);await accept('2','special');assert.equal(calls,1);await accept('3','special',false);assert.equal(outputs.length,2)
 await processor.stop()
})

test('catalog timeout and concurrent durable reservation never dispatch twice or resume after cancellation',async t=>{
 let calls=0;const f=setup(t,async()=>{calls++;return {content:'{"label":"semanticwake","confidence":1}',toolCalls:[]}})
 let release!:()=>void;f.provider.listModels=async()=>{await new Promise<void>(r=>{release=r});return ['configured-small']}
 assert.equal((await f.run(f.make(),'catalog',{...policy,deadlineMs:10})).label,'unknown');release();await new Promise(r=>setTimeout(r,10));assert.equal(calls,0)
 f.provider.listModels=()=>['configured-small']
 const c=f.make();await Promise.all([f.run(c),f.run(c),f.run(c)]);assert.equal(calls,1)
})
test('in-flight provider reservation recovers as unknown with no second bill; aborted authority dispatches nothing',async t=>{
 let calls=0;let finish!:()=>void
 const f=setup(t,async()=>{calls++;await new Promise<void>(r=>{finish=r});return {content:'{"label":"semanticwake","confidence":1}',toolCalls:[]}})
 const pending=f.run(f.make());while(!calls)await new Promise(r=>setTimeout(r,1))
 assert.equal((await f.run(f.make())).label,'unknown');assert.equal(calls,1);finish();await pending
 const controller=new AbortController();controller.abort()
 assert.equal((await f.make().classify({authority:'other',eventId:'1',policy,data:{},signal:controller.signal,authorize:async()=>{}})).label,'unknown');assert.equal(calls,1)
})
test('ordinary processors cannot borrow classifier grants, and stop prevents late classifier wake',async t=>{
 const processor=new InputProcessor<string>();let calls=0,wakes=0
 const common={key:'scope',id:'1',item:'1',event:{type:'discord.MESSAGE_CREATE',data:{}},policy:{code:'export function run(){return {action:"ignore",classify:true}}',delayMs:10},signal:new AbortController().signal,publish:async()=>{wakes++},classify:async()=>{calls++;return {label:'semanticwake' as const,confidence:1}}}
 await assert.rejects(processor.accept(common),/No reviewed classifier/);assert.equal(calls,0);await processor.stop()
 const second=new InputProcessor<string>();let release!:(value:{label:'semanticwake';confidence:number})=>void
 const pending=second.accept({...common,id:'2',policy:{...common.policy,classifier:policy},classify:async()=>{calls++;return new Promise(r=>{release=r})}})
 const rejected=assert.rejects(pending);while(!release)await new Promise(r=>setTimeout(r,1));await second.stop();release({label:'semanticwake',confidence:1});await rejected;assert.equal(wakes,0)
})
