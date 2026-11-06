import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { CapabilityBroker } from '../../execution/grants.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'
import { EventProviderRuntime } from './runtime.ts'

const processor = 'export function run({event}){return [{content:event.data.title}]}'
const http = { origin: 'https://public.example', routes: [{ method: 'GET' as const, path: '/items', querySchema: { type: 'object', additionalProperties: false, properties: { cursor: { type: 'string' } } } }] }
const schemas = { demandSchema: { type: 'object', additionalProperties: false }, eventSchema: { type: 'object', required: ['title'], properties: { title: { type: 'string' } }, additionalProperties: false }, examples: [] }
const rest = { id: 'rest', version: 1, description: 'REST cursor fixture', http, ...schemas, code: `import {call} from '@shadow/fetch';
export async function run({demands}) {
 const result={}; for(const d of demands){
  let cursor=d.checkpoint, events=[];
  for(let page=0;page<4;page++){
   const response=await call({method:'GET',path:'/items',query:{cursor:cursor||''}});
   if(response.status!==200)throw new Error('HTTP failed');
   events.push(...response.body.events);cursor=response.body.cursor;
   if(!response.body.more){result[d.key]={mode:'delta',events,checkpoint:cursor};break;}
  }
  if(!result[d.key])throw new Error('page limit');
 } return result;
}` }

test('REST JSON pages: silent delta baseline, cursor plus jobs, bounded dedup survives restart; binding escalation blocked', async t => {
 await withTempWorkspace(async workspace => {
  let now=Date.now(); t.mock.method(Date,'now',()=>now)
  let stage=0; const cursors:string[]=[]; const messages:string[]=[]
  const broker=new CapabilityBroker({ projectId:'fixture',directory:join(workspace,'receipts'),resolveSecret:async()=>{throw new Error('public source must not resolve secrets')},deliver:async()=>undefined,canDeliver:()=>false,
   request:async(url,options)=>{
    assert.equal(options?.method,'GET');assert.equal((options?.headers as Record<string,string>).authorization,undefined)
    const cursor=new URL(String(url)).searchParams.get('cursor')!;cursors.push(cursor)
    const event=(id:string)=>({id,data:{title:id}})
    const body=stage===0?{events:[event('a')],cursor:'base',more:false}:cursor==='base'?{events:[event('a'),event('b')],cursor:'page2',more:true}:{events:[event('b'),event('c')],cursor:'end',more:false}
    // Duplicate IDs within a single acquisition must be normalized by the implementation.
    if(cursor==='page2') body.events=[event('c')]
    return new Response(JSON.stringify(body))
   } })
  const make=()=>new EventProviderRuntime(workspace,broker,async(id,input)=>{messages.push(input.kind === 'message' ? input.content : '');return {status:'accepted',sessionId:id,inputId:input.id}},()=>true,()=>false)
  let runtime=make();runtime.start();runtime.publish('owner',rest)
  runtime.create('owner',{id:'watch',provider:'rest',version:1})
  runtime.subscribe('owner',{id:'sub',instance:'watch',demand:{},processor})
  assert.throws(()=>runtime.subscribe('owner',{id:'bad',instance:'watch',demand:{unknown:true},processor}))
  await runtime.run();assert.deepEqual(messages,[])
  stage=1;now+=60001;await runtime.run();assert.deepEqual(messages,['b','c']);assert.deepEqual(cursors,['','base','page2'])
  await runtime.stop();runtime=make();runtime.start();now+=60001;await runtime.run();assert.deepEqual(messages,['b','c'])
  // Use manifest form (no version) to exercise actual binding enforcement.
  const {version:_version,...manifest}=rest
  for(const changed of [{...http,origin:'https://other.example'},{...http,routes:[{method:'DELETE',path:'/items'}]},{...http,credential:{header:'Authorization',prefix:'Bearer '}}]){
   assert.throws(()=>runtime.reload('owner',{...manifest,http:changed}),/binding|expansion/)
  }
  assert.throws(()=>runtime.reload('owner',{...manifest,http:{...http,routes:[{method:'GET',path:'/private'}]}}),/binding/)
  assert.equal(runtime.discover('owner').instances[0].version,1)
  await runtime.stop()
 })
})

test('public HTML acquisition and pure local HTML extraction fan out to subscriber inbox',async t=>{
 await withTempWorkspace(async workspace=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now);let headline='old';const messages:string[]=[]
  const broker=new CapabilityBroker({projectId:'fixture',directory:join(workspace,'receipts'),resolveSecret:async()=>{throw new Error('no credential')},deliver:async()=>undefined,canDeliver:()=>false,request:async()=>new Response('<html><h1>'+headline+'</h1></html>',{headers:{'content-type':'text/html'}})})
  const runtime=new EventProviderRuntime(workspace,broker,async(id,input)=>{messages.push(input.kind === 'message' ? input.content : '');return {status:'accepted',sessionId:id,inputId:input.id}},()=>true,()=>false)
  runtime.start();runtime.publish('owner',{id:'html',version:1,description:'public HTML',http:{origin:http.origin,routes:[{method:'GET',path:'/news'}]},...schemas,code:`import {call} from '@shadow/fetch';import {parseHtml} from '@shadow/html';export async function run({demands}){const r={};for(const d of demands){const response=await call({method:'GET',path:'/news'});if(response.status!==200||typeof response.body!=='string')throw new Error('HTML expected');const title=parseHtml(response.body).querySelector('h1')?.textContent;if(!title)throw new Error('missing title');r[d.key]={mode:'snapshot',events:[{id:title,data:{title}}],checkpoint:null}}return r}`})
  runtime.create('owner',{id:'news',provider:'html',version:1,allowedSubscribers:['reader']});runtime.subscribe('reader',{id:'headlines',instance:'news',demand:{},processor:`import {parseHtml} from '@shadow/html';export function run({event}){return [{content:parseHtml('<p>'+event.data.title+'</p>').querySelector('p').textContent}]}`})
  await runtime.run();headline='new';now+=60001;await runtime.run();assert.deepEqual(messages,['new']);await runtime.stop()
 })
})

test('broker enforces provider route/query/body and fixed GraphQL restrictions before transport',async()=>{
 await withTempWorkspace(async workspace=>{
  let requests=0
  const broker=new CapabilityBroker({projectId:'fixture',directory:join(workspace,'receipts'),resolveSecret:async()=>{throw new Error('no secrets')},deliver:async()=>undefined,canDeliver:()=>false,request:async()=>{requests++;return new Response('{}')}})
  const grant={id:'fetch',kind:'http' as const,...http}
  const context={sessionId:'owner',inputId:'fixture',toolCallId:'fixture',bindingKey:'fixture',revision:'1',signal:new AbortController().signal,assertCurrent:()=>undefined}
  await assert.rejects(broker.execute(grant,{method:'GET',path:'/private'},context))
  await assert.rejects(broker.execute(grant,{method:'GET',path:'/items',query:{injected:'yes'}},context))
  await assert.rejects(broker.execute(grant,{method:'POST',path:'/items',body:{}},context))
  await assert.rejects(broker.execute(grant,{method:'GET',path:'/items',secretRef:'other',headers:{Authorization:'injected'}},context))
  assert.equal(requests,0)
 })
})

test('REST broker requests abort on reload/stop; restricted looping collector is terminated on reload',async t=>{
 await withTempWorkspace(async workspace=>{
  let now=Date.now();t.mock.method(Date,'now',()=>now)
  let entered!:()=>void;let entering=new Promise<void>(resolve=>{entered=resolve});let aborted=0
  const broker=new CapabilityBroker({projectId:'fixture',directory:join(workspace,'receipts'),resolveSecret:async()=>{throw new Error('no secret')},deliver:async()=>undefined,canDeliver:()=>false,
   request:async(_url,options)=>{entered();return new Promise<Response>((_resolve,reject)=>{options?.signal?.addEventListener('abort',()=>{aborted++;reject(new Error('aborted'))},{once:true})})}})
  const runtime=new EventProviderRuntime(workspace,broker,async()=>{throw new Error('no delivery')},()=>true,()=>false)
  runtime.start();runtime.publish('owner',rest);runtime.create('owner',{id:'watch',provider:'rest',version:1});runtime.subscribe('owner',{id:'sub',instance:'watch',demand:{},processor})
  const {version:_version,...manifest}=rest
  let run=runtime.run();await entering
  await runtime.reload('owner',manifest);await run;assert.equal(aborted,1)
  entering=new Promise<void>(resolve=>{entered=resolve});now+=60001;run=runtime.run();await entering
  await runtime.stop();await run;assert.equal(aborted,2)
  runtime.start()
  await runtime.reload('owner',{...manifest,code:'export function run({demands}){if(!demands.length)return {};while(true){}}'})
  now+=60001;run=runtime.run();await new Promise(resolve=>setTimeout(resolve,150))
  await runtime.reload('owner',manifest);await run
  assert.equal(runtime.discover('owner').pending.length,0)
  await runtime.reload('owner',{...manifest,code:'export function run({demands}){if(!demands.length)return {};while(true){}}'})
  now+=60001;run=runtime.run();await new Promise(resolve=>setTimeout(resolve,150))
  await runtime.stop();await run
  await assert.rejects(runtime.run(),/stopped/)
 })
})
