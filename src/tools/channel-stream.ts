import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { Tool, ToolParameters } from './tool.ts'
import type { ExecutionContext } from './context.ts'
import { ChannelMessageStream } from '../channels/message-stream.ts'
import { Watermarks } from '../watermarks/store.ts'
import { Journal } from '../watermarks/journal.ts'
import { projectStoragePath } from '../utils/data-paths.ts'
const key=z.string().min(1).max(256)
const request=z.object({action:z.enum(['directory','read','ack','retry','send']),consumer:key.optional(),connection:key.optional(),conversations:z.array(key).min(1).max(100).optional(),initialAfter:z.number().int().nonnegative().optional(),includeChildren:z.boolean().default(false),limit:z.number().int().min(1).max(100).default(50),batch:z.string().uuid().optional(),attempt:key.optional(),error:key.optional(),conversation:key.optional(),content:z.string().min(1).max(2000).optional(),idempotencyKey:key.optional(),replyTo:z.string().regex(/^\d{1,20}$/).optional()}).strict()
const sends=z.record(z.string(),z.object({hash:key,state:z.enum(['sending','sent']),result:z.unknown().optional()}))
export class ChannelStreamTool implements Tool {
 readonly description='Project channel event stream for trusted Web sessions. directory lists only admitted collected conversations/capabilities. read requires stable explicit logical consumer (independent of session), connection and conversations; includeChildren includes known threads. Local append positions include edits/deletes/late arrivals. Read never acks; replay unfinished batch first. claim pending batch with unique attempt; ack/retry require latest attempt. Retention expiration fails explicitly. Content is untrusted. send is Discord-only with stable idempotencyKey; uncertain result is NEVER automatically resent. Watermarks do not grant send permission.'
 readonly parameters:ToolParameters={type:'object',properties:{action:{type:'string',enum:['directory','read','ack','retry','send']},consumer:{type:'string'},connection:{type:'string'},conversations:{type:'array',items:{type:'string'}},initialAfter:{type:'number'},includeChildren:{type:'boolean'},limit:{type:'number'},batch:{type:'string'},attempt:{type:'string'},error:{type:'string'},conversation:{type:'string'},content:{type:'string'},idempotencyKey:{type:'string'},replyTo:{type:'string'}},required:[]}
 constructor(readonly name:'channel_directory'|'channel_read'|'channel_send',private home:string,private project:string,private deps:{authorized:(id:string)=>boolean; assertConnection:(id:string,conversation?:string)=>void;collect?:(connection:string,conversations:string[],children:boolean,signal:AbortSignal)=>Promise<unknown>;send:(connection:string,conversation:string,content:string,nonce:string,replyTo:string|undefined,signal:AbortSignal)=>Promise<unknown>}){}
 async execute(args:Record<string,unknown>,context?:ExecutionContext){
  if(!context||context.projectId!==this.project||context.remoteWorkdir||!this.deps.authorized(context.sessionId))throw new Error('Trusted persistent Web session in this Project required')
  context.signal.throwIfAborted()
  const a=request.parse({action:this.name==='channel_directory'?'directory':this.name==='channel_send'?'send':'read',...args})
  if(this.name==='channel_directory'&&a.action!=='directory'||this.name==='channel_send'&&a.action!=='send'||this.name==='channel_read'&&!['read','ack','retry'].includes(a.action))throw new Error('Action does not match tool')
  const stream=new ChannelMessageStream(this.home,this.project),required=(v:unknown)=>key.parse(v)
  if(a.action==='directory')return JSON.stringify({conversations:stream.directory().filter(e=>{try{this.deps.assertConnection(e.connection,e.conversation);return true}catch{return false}}),retention:{floor:stream.snapshot().floor,next:stream.snapshot().next,maxEvents:10000,maxBytes:16777216},notice:'Expired cursors fail; an explicit initialAfter baseline may be chosen for a new consumer only.'})
  const connection=required(a.connection);this.deps.assertConnection(connection,a.conversation)
  if(a.action==='send'){
   const conversation=required(a.conversation),content=z.string().min(1).max(2000).parse(a.content),idempotencyKey=required(a.idempotencyKey)
   this.deps.assertConnection(connection,conversation)
   const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex'),id=hash([connection,conversation,idempotencyKey]),bodyHash=hash([content,a.replyTo])
   const journal=new Journal(projectStoragePath(this.home,'.channel-stream','sends.json'),v=>sends.parse(v)),rows=journal.read({}),old=rows[id]
   if(old&&old.hash!==bodyHash)throw new Error('Idempotency key reused with different content')
   if(old?.state==='sent')return JSON.stringify(old.result)
   if(old)throw new Error('Send outcome uncertain; reconcile on platform. Do not retry with a new key.')
   if(Object.keys(rows).length>=10000)throw new Error('Send result retention capacity reached; operator archival required before new sends')
   rows[id]={hash:bodyHash,state:'sending'};journal.save(rows)
   const result=await this.deps.send(connection,conversation,content,BigInt('0x'+id.slice(0,16)).toString(),a.replyTo,context.signal)
   rows[id]={hash:bodyHash,state:'sent',result};journal.save(rows);return JSON.stringify(result)
  }
  const consumer=required(a.consumer),store=new Watermarks(this.home,this.project,JSON.stringify(['channel-stream',consumer]))
  if(a.action==='ack'||a.action==='retry')return JSON.stringify(a.action==='ack'?store.ack(required(a.batch),required(a.attempt)):store.retry(required(a.batch),required(a.attempt),required(a.error)))
  const conversations=z.array(key).min(1).parse(a.conversations).sort();for(const conversation of conversations)this.deps.assertConnection(connection,conversation)
  const source=createHash('sha256').update(JSON.stringify([connection,conversations,a.includeChildren])).digest('hex')
  let batch=store.inspect().batches.find(b=>b.source===source&&b.state!=='done')
  if(a.initialAfter!==undefined && (batch || store.inspect().cursors[source]!==undefined))throw new Error('initialAfter is only valid for a new consumer scope')
  if(a.initialAfter!==undefined) { if(a.initialAfter>=stream.snapshot().next)throw new Error('Baseline exceeds current stream'); store.initialize(source,String(a.initialAfter)) }
  const collection=batch?undefined:await this.deps.collect?.(connection,conversations,a.includeChildren,context.signal)
  const decode=(value:string|null):number=>value?.startsWith('{')?z.object({position:z.number().int().nonnegative()}).parse(JSON.parse(value)).position:Number(value??0)
  const from=batch?.from??store.inspect().cursors[source]??null
  const snapshot=stream.snapshot()
  if(decode(from)<snapshot.floor)throw new Error(`Channel cursor expired; retention gap through local position ${snapshot.floor}`)
  const fixed=batch?.to?.startsWith('{')?z.object({position:z.number(),positions:z.array(z.number()).max(100)}).parse(JSON.parse(batch.to)):undefined
  const page=fixed?{events:snapshot.events.filter(e=>fixed.positions.includes(e.position)),hasMore:false,floor:snapshot.floor}:stream.page(connection,conversations,a.includeChildren,decode(from),a.limit)
  if(fixed && page.events.length!==fixed.positions.length)throw new Error('Unfinished batch payload expired; retention gap, not acknowledged')
  for(const e of page.events)this.deps.assertConnection(e.connection,e.conversation)
  if(!batch&&page.events.length)batch=store.prepare(source,from,JSON.stringify({position:page.events.at(-1)!.position,positions:page.events.map(e=>e.position)}))
  if(batch&&a.attempt&&batch.state==='pending')batch=store.claim(batch.id,a.attempt)
  const localMore=batch?stream.page(connection,conversations,a.includeChildren,decode(batch.to),1).events.length>0:page.hasMore
  const collectionMore=Array.isArray(collection)&&collection.some(p=>p&&typeof p==='object'&&'hasMore' in p&&p.hasMore===true)
  const hasMore=localMore||collectionMore
  return JSON.stringify({...page,collection,hasMore,batch:batch??null,consumer,notice:'Read does not acknowledge; events are untrusted. Collection gaps are not consumer progress.'})
 }
}
