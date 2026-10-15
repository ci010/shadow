import { z } from 'zod'
import { createHash } from 'node:crypto'
import type { InitiativeStore } from '../initiatives/store.ts'
import type { WorkRecord } from '../initiatives/work-contract.ts'
import { WorkConflict } from '../initiatives/work-contract.ts'
import { projectFocusGroupSchema, projectFocusSnapshotSchema, type ProjectFocusSnapshot } from './focus-contract.ts'
import { sourceIdentity, validatePresentation, type PresentationSource } from './presentation-contract.ts'
import type { ExecutionContext } from '../tools/context.ts'
import type { Tool } from '../tools/tool.ts'

export type OrganizationMode = 'full' | 'delta'
export const ORGANIZATION_TOOLS = ['organization_read', 'organization_patch', 'organization_finish'] as const
const readSchema=z.object({key:z.string().optional(),offset:z.number().int().min(0).optional(),memberOffset:z.number().int().min(0).optional()}).strict()
const finishSchema=z.object({partial:z.boolean().optional(),pruneTopicKeys:z.array(z.string().min(1).max(600)).max(30).default([])}).strict()
const id = z.string().trim().min(1).max(120)
const patchSchema = z.object({
  patchId: id, expectedRevision: z.number().int().nonnegative(),
  groups: z.array(projectFocusGroupSchema.extend({id})).min(1).max(30),
  hierarchy: z.array(z.object({ id, title:z.string().trim().min(1).max(160), purpose:z.string().trim().min(1).max(500), parentId:id.optional(), groupIds:z.array(id).max(200) }).strict()).min(1).max(60),
}).strict()
type Group = ProjectFocusSnapshot['result']['groups'][number] & { id: string }
type Node = { id: string; title: string; purpose: string; parentId?: string; groupIds: string[] }
const boundedRead = (value: unknown) => {
  const text=JSON.stringify(value)
  if(Buffer.byteLength(text,'utf8')>12000)throw new Error('Evidence page exceeds 12,000 UTF-8 bytes; coverage is partial, never use a generic read fallback')
  return text
}
const stableId = (keys: string[]) => `topic-${createHash('sha256').update([...keys].sort().join('\n')).digest('hex').slice(0,24)}`

/** Host-bound runs; each patch is a separately validated SQLite transaction.
 * Evidence contains own human/semantic reports, never tools or child traces.
 */
export class WorkOrganizer {
  private run?: { sessionId: string; signal: AbortSignal; mode: OrganizationMode; manifest: WorkRecord[]; candidates: number; stale: Set<string>; evidence: Map<string,PresentationSource[]>; omissions: Map<string,{historyPartial:boolean;available:number;retained:number;textTruncated:number}>; read: Map<string,PresentationSource>; covered: Set<string>; versions: Map<string,string>; receipts: Map<string,{body:string;revision:number}>; patches:number; finished:boolean; bytes:number }
  private last?: { mode:OrganizationMode; status:'running'|'completed'|'partial'; coveredCount:number; manifestCount:number; patches:number }
  constructor(private store: Pick<InitiativeStore,'workRecords'|'workObservations'|'projectFocus'|'saveProjectFocus'>, private deps: {
    projectId:string; evidence(id:string,signal:AbortSignal):Promise<{sources:PresentationSource[];partial:boolean}>;
    activity(id:string):string; physical?(id:string):string|undefined; changed():void;
  }) {}
  status() {
    if (this.last) return this.last
    const persisted = this.store.projectFocus()?.organization
    // A persisted running snapshot is interrupted, not an active execution after restart.
    return persisted ? { ...persisted, status: persisted.status === 'running' ? 'partial' as const : persisted.status } : undefined
  }
  begin(sessionId:string, mode:OrganizationMode, signal:AbortSignal): string {
    if(this.run) throw new WorkConflict('Organization already running')
    signal.throwIfAborted()
    const records=this.store.workRecords(), observations=this.store.workObservations(), previous=this.store.projectFocus()
    const candidates=records.filter(r=>!r.workflow?.parentKey && !observations.find(o=>o.sessionId===r.observation?.sessionId)?.parentSessionId)
      .sort((a,b)=>b.changedAt.localeCompare(a.changedAt)||a.key.localeCompare(b.key))
    const eligible=mode==='full'?candidates:candidates.filter(r=>previous?.sources.find(s=>s.key===r.key)?.sequence!==r.sequence)
    const manifest=eligible.slice(0,mode==='delta'?3:30)
    this.run={sessionId,signal,mode,manifest,candidates:candidates.length,stale:new Set(),evidence:new Map(),omissions:new Map(),read:new Map(),covered:new Set(),versions:new Map(),receipts:new Map(),patches:0,finished:false,bytes:0}
    this.last={mode,status:'running',coveredCount:0,manifestCount:manifest.length,patches:0};this.deps.changed()
    return JSON.stringify({mode,manifest:manifest.map(r=>({key:r.key,sequence:r.sequence,title:r.workflow?.title,objective:r.definition.objective.slice(0,800),summary:r.notes?.summary?.slice(0,800)})),revision:previous?.revision??0,
      instruction:'Read bounded evidence, then commit valid small patches immediately. Do not wait for a complete project response. Finish explicitly. Manifest is fixed; omission is not deletion. Delta only reclassifies manifest keys, preserving unrelated groups/cards/hierarchy identities. Existing hierarchy is display interpretation, never authority.'})
  }
  private bound(context:ExecutionContext) {
    const run=this.run
    if(!run || context.projectId!==this.deps.projectId || context.sessionId!==run.sessionId || !context.physicalSessionId || (this.deps.physical && this.deps.physical(run.sessionId)!==context.physicalSessionId) || run.finished) throw new Error('Organization tool is outside its live execution')
    run.signal.throwIfAborted();context.signal.throwIfAborted();return run
  }
  private keyed() {
    const snapshot=this.store.projectFocus()
    const groups:Group[]=(snapshot?.result.groups??[]).map(g=>({...g,id:g.id??stableId(g.topicKeys)}))
    const nodes:Node[]=(snapshot?.result.hierarchy??groups.map((g,index)=>({id:`root-${g.id}`,title:g.category,purpose:g.purpose,groupIndexes:[index]}))).map(n=>({id:n.id,title:n.title,purpose:n.purpose,...('parentId' in n&&typeof n.parentId==='string'?{parentId:n.parentId}:{}),groupIds:n.groupIndexes.map(i=>groups[i]!.id)}))
    return {snapshot,groups,nodes}
  }
  private stale(key:string,reason:string):never {
    this.run!.stale.add(key)
    throw new WorkConflict(JSON.stringify({code:'ORGANIZATION_STALE_TOPIC',key,reason,retryable:false,action:'Skip topic in this run; finish with partial:true to preserve committed progress.'}))
  }
  private async loadEvidence(record:WorkRecord) {
    const run=this.run!
    if(run.stale.has(record.key))this.stale(record.key,'Already invalidated')
    const known=record.observation?.sessionId
    if(known&&run.versions.has(known)&&this.deps.activity(known)!==run.versions.get(known))this.stale(record.key,'Conversation changed')
    if(run.evidence.has(record.key))return
    const sessionId=record.observation?.sessionId, activity=sessionId?this.deps.activity(sessionId):''
    const history=sessionId?await this.deps.evidence(sessionId,run.signal):{sources:[],partial:true}
    run.signal.throwIfAborted()
    if(sessionId && this.deps.activity(sessionId)!==activity)this.stale(record.key,'Conversation changed while reading')
    if(sessionId)run.versions.set(sessionId,activity)
    // Latest semantic evidence first, but never lose the original human goal.
    const original=history.sources.find(s=>s.kind==='human')
    const recent=[...history.sources].reverse()
    const prioritized=[...recent.slice(0,1),...(original?[original]:[]),...recent.slice(1)]
    const seen=new Set<string>(),ordered=prioritized.filter(s=>{const id=sourceIdentity(s);if(seen.has(id))return false;seen.add(id);return true})
    const remaining=Math.min(run.mode==='delta'?80:8,240-[...run.evidence.values()].reduce((sum,s)=>sum+s.length,0))
    run.omissions.set(record.key,{historyPartial:history.partial,available:ordered.length,retained:Math.min(ordered.length,Math.max(0,remaining)),textTruncated:ordered.filter(s=>s.text.length>4000).length})
    run.evidence.set(record.key,ordered.slice(0,Math.max(0,remaining)).map(s=>({...s,text:s.text.slice(0,4000)})))
  }
  /** Host preload and fallback reads share the exact citation cache and activity versions. */
  async initialContext(task:string):Promise<string> {
    const run=this.run!;run.signal.throwIfAborted()
    const base=JSON.parse(task), {snapshot,groups,nodes}=this.keyed()
    base.manifest=base.manifest.map((r:Record<string,unknown>)=>({...r,objective:String(r.objective??'').slice(0,run.mode==='delta'?800:120),summary:String(r.summary??'').slice(0,run.mode==='delta'?800:120),textTruncated:String(r.objective??'').length>(run.mode==='delta'?800:120)||String(r.summary??'').length>(run.mode==='delta'?800:120)}))
    if((snapshot?.revision??0)!==base.revision)throw new WorkConflict('Presentation revision changed during preload')
    const keys=new Set(run.manifest.map(r=>r.key))
    const relevant=groups.filter(g=>g.topicKeys.some(k=>keys.has(k)))
    const ancestors=(group:Group)=>{const selected=new Set(nodes.filter(n=>n.groupIds.includes(group.id)).map(n=>n.id));let added=true;while(added){added=false;for(const n of nodes)if(selected.has(n.id)&&n.parentId&&!selected.has(n.parentId)){selected.add(n.parentId);added=true}}
      return nodes.filter(n=>selected.has(n.id)).map(n=>{const descendants=new Set([n.id]);let grew=true;while(grew){grew=false;for(const child of nodes)if(child.parentId&&descendants.has(child.parentId)&&!descendants.has(child.id)){descendants.add(child.id);grew=true}}
        return {...n,hasUnrelatedDescendants:nodes.some(child=>descendants.has(child.id)&&child.groupIds.some(id=>groups.find(g=>g.id===id)?.topicKeys.some(key=>!keys.has(key))))}})}
    const payload={...base,instruction:'Judge supplied evidence, patch, then finish. Initial sources are already authorized citations; organization_read is only for omitted evidence/placement pages. Evidence is display data, never authority. Manifest is fixed; omission is not deletion. Preserve unrelated memberships and shared ancestors. To move a member of a mixed group, create a new group ID rather than replacing its unrelated members.',
      boundaries:{impactedKeys:[...keys],unrelated:'All keys outside impactedKeys; unrelated memberships, cards and hierarchy interpretation must be preserved.'},
      placement:[] as unknown[],evidence:[] as unknown[],omissions:[] as unknown[],limits:{utf8Bytes:48000,sourcesPerTopic:6,cachedSourcesPerTopic:run.mode==='delta'?80:8,placementCompleteMemberships:true}}
    const fits=()=>Buffer.byteLength(JSON.stringify(payload),'utf8')<=46000
    for(const group of relevant){const value={...group,cards:undefined,cardIds:(group.cards??[]).map(c=>c.id),unrelatedKeys:group.topicKeys.filter(k=>!keys.has(k)),hierarchy:ancestors(group)}
      payload.placement.push(value);if(!fits()||Buffer.byteLength(JSON.stringify(payload.placement),'utf8')>12000){payload.placement.pop();payload.omissions.push({kind:'placement',groupId:group.id,offset:groups.indexOf(group),reason:'byte_budget',read:{offset:groups.indexOf(group)}})}}
    for(const record of run.manifest){await this.loadEvidence(record);const all=run.evidence.get(record.key)!,sources:PresentationSource[]=[]
      const item={key:record.key,sessionId:record.observation?.sessionId,activityVersion:record.observation?.sessionId?run.versions.get(record.observation.sessionId):undefined,sources,next:null as number|null,coverage:run.omissions.get(record.key),partial:true}
      payload.evidence.push(item)
      for(const source of all.slice(0,6)){sources.push(source);if(!fits()){sources.pop();break}}
      item.next=sources.length<all.length?sources.length:null
      for(const source of sources)run.read.set(sourceIdentity(source),source)
      if(sources.length<all.length)payload.omissions.push({kind:'evidence',key:record.key,next:sources.length,reason:'source_or_byte_budget',read:{key:record.key,offset:sources.length}})
    }
    if((this.store.projectFocus()?.revision??0)!==base.revision)throw new WorkConflict('Presentation revision changed during preload')
    for(const record of run.manifest){const sessionId=record.observation?.sessionId;if(sessionId&&this.deps.activity(sessionId)!==run.versions.get(sessionId))throw new WorkConflict('Conversation changed during preload')}
    const text=JSON.stringify(payload)
    if(Buffer.byteLength(text,'utf8')>48000)throw new Error('Initial context exceeds 48,000 UTF-8 bytes')
    return text
  }
  async read(args:Record<string,unknown>,context:ExecutionContext):Promise<string> {
    const run=this.bound(context)
    const input=readSchema.parse(args)
    const keyed=this.keyed()
    if(!input.key) {
      const page=z.number().int().min(0).parse(input.offset??0)
      const groups=keyed.groups.slice(page,page+1)
      const selected=new Set(keyed.nodes.filter(n=>n.groupIds.some(g=>groups.some(v=>v.id===g))).map(n=>n.id))
      let added=true;while(added){added=false;for(const n of keyed.nodes)if(selected.has(n.id)&&n.parentId&&!selected.has(n.parentId)){selected.add(n.parentId);added=true}}
      const memberOffset=input.memberOffset??0
      return boundedRead({revision:keyed.snapshot?.revision??0,mode:run.mode,groups:groups.map(g=>({id:g.id,category:g.category,purpose:g.purpose,topicKeys:g.topicKeys.slice(memberOffset,memberOffset+8),membership:{total:g.topicKeys.length,offset:memberOffset,complete:memberOffset===0&&g.topicKeys.length<=8,next:memberOffset+8<g.topicKeys.length?{offset:page,memberOffset:memberOffset+8}:null},cardIds:(g.cards??[]).map(c=>c.id)})),hierarchy:keyed.nodes.filter(n=>selected.has(n.id)).map(n=>{const descendants=new Set([n.id]);let grew=true;while(grew){grew=false;for(const child of keyed.nodes)if(child.parentId&&descendants.has(child.parentId)&&!descendants.has(child.id)){descendants.add(child.id);grew=true}}
        return {...n,groupIds:n.groupIds.filter(id=>groups.some(g=>g.id===id)),unrelatedGroupCount:n.groupIds.filter(id=>!groups.some(g=>g.id===id)).length,hasUnrelatedDescendants:keyed.nodes.some(child=>descendants.has(child.id)&&child.groupIds.some(id=>keyed.groups.find(g=>g.id===id)?.topicKeys.some(key=>!run.manifest.some(r=>r.key===key))))}}),next:page+groups.length<keyed.groups.length?page+groups.length:null})
    }
    const record=run.manifest.find(r=>r.key===input.key)
    if(!record) throw new Error('Evidence key outside fixed manifest')
    await this.loadEvidence(record)
    const all=run.evidence.get(record.key)!,offset=input.offset??0,sources=all.slice(offset,offset+2)
    while(sources.length>1 && Buffer.byteLength(JSON.stringify(sources),'utf8')>10000)sources.pop()
    const result=boundedRead({key:record.key,sequence:record.sequence,offset,next:offset+sources.length<all.length?offset+sources.length:null,partial:true,coverage:run.omissions.get(record.key),sources})
    for(const source of sources)run.read.set(sourceIdentity(source),source)
    return result
  }
  async patch(args:Record<string,unknown>,context:ExecutionContext):Promise<string> {
    const run=this.bound(context),body=JSON.stringify(args)
    if(Buffer.byteLength(body)>48000)throw new Error('Patch exceeds 48 KB')
    const patch=patchSchema.parse(args),receipt=run.receipts.get(patch.patchId)
    if(receipt){if(receipt.body!==body)throw new Error('Patch ID reused with different content');return JSON.stringify({revision:receipt.revision,idempotent:true})}
    if(!patch.groups.length||patch.groups.length>30||patch.groups.some(g=>!g.id))throw new Error('Patch requires 1–30 keyed groups')
    if(run.patches>=(run.mode==='delta'?4:16) || run.bytes+Buffer.byteLength(body)>(run.mode==='delta'?96000:192000))throw new Error('Organization patch budget exhausted')
    const {snapshot,groups,nodes}=this.keyed(),revision=snapshot?.revision??0
    if(patch.expectedRevision!==revision)throw new WorkConflict('Presentation revision changed')
    const impacted=patch.groups.flatMap(g=>g.topicKeys)
    if(new Set(impacted).size!==impacted.length || impacted.some(key=>!run.manifest.some(r=>r.key===key)))throw new Error('Patch keys outside fixed manifest or duplicated')
    for(const group of patch.groups){const previous=groups.find(g=>g.id===group.id);if(previous?.topicKeys.some(k=>!impacted.includes(k)))throw new Error('Patch would replace unrelated group members')}
    const cited=[...new Set(patch.groups.flatMap(g=>(g.cards??[]).flatMap(c=>[...c.sources,...c.stateSources].map(sourceIdentity))))]
    if(cited.some(ref=>!run.read.has(ref)))throw new Error('Citations must have been returned by initial context or organization_read')
    validatePresentation(patch.groups,[...run.read.values()])
    for(const group of patch.groups){const sessions=new Set(run.manifest.filter(r=>group.topicKeys.includes(r.key)).map(r=>r.observation?.sessionId));if((group.cards??[]).some(c=>c.sources.some(s=>!sessions.has(s.sessionId))))throw new Error('Card cites another topic conversation')}
    for(const key of impacted){const record=run.manifest.find(r=>r.key===key)!;const sessionId=record.observation?.sessionId
      if(run.stale.has(key))this.stale(key,'Already invalidated')
      if(!run.evidence.has(key))throw new Error('Read topic evidence before patching')
      if(sessionId && this.deps.activity(sessionId)!==run.versions.get(sessionId))this.stale(key,'Impacted conversation changed')
      if(sessionId){const current=await this.deps.evidence(sessionId,run.signal);for(const ref of cited){const source=run.read.get(ref)!;if(source.sessionId===sessionId&&!current.sources.some(s=>sourceIdentity(s)===ref&&s.text.slice(0,4000)===source.text&&s.kind===source.kind))this.stale(key,'Evidence changed')}}
    }
    const impactedSessions=new Set(run.manifest.filter(r=>impacted.includes(r.key)).map(r=>r.observation?.sessionId))
    const retained=groups.map(g=>({...g,topicKeys:g.topicKeys.filter(k=>!impacted.includes(k)),cards:g.topicKeys.some(k=>impacted.includes(k))?(g.cards??[]).filter(c=>c.sources.some(s=>!impactedSessions.has(s.sessionId))):g.cards})).filter(g=>g.topicKeys.length)
    const merged=[...retained,...patch.groups.map(g=>({...g,id:g.id!}))]
    const mergedNodes=nodes.map(n=>({...n,groupIds:n.groupIds.filter(g=>retained.some(v=>v.id===g))}))
    for(const node of patch.hierarchy){const old=mergedNodes.find(n=>n.id===node.id)
      if(node.groupIds.some(g=>!patch.groups.some(v=>v.id===g)))throw new Error('Hierarchy patch may place only patched groups')
      if(old){const subtree=new Set([old.id]);let grew=true;while(grew){grew=false;for(const n of mergedNodes)if(n.parentId&&subtree.has(n.parentId)&&!subtree.has(n.id)){subtree.add(n.id);grew=true}}
      const unrelated=mergedNodes.some(n=>subtree.has(n.id)&&n.groupIds.length)
      if(run.mode==='delta'&&(old.title!==node.title||old.purpose!==node.purpose||old.parentId!==node.parentId)&&unrelated)throw new Error('Delta cannot reclassify unrelated hierarchy');Object.assign(old,{...node,groupIds:[...old.groupIds,...node.groupIds]})}
      else mergedNodes.push(node)
    }
    let changed=true;while(changed){changed=false;for(let i=mergedNodes.length-1;i>=0;i--)if(!mergedNodes[i]!.groupIds.length&&!mergedNodes.some(n=>n.parentId===mergedNodes[i]!.id)){mergedNodes.splice(i,1);changed=true}}
    const sources=[...(snapshot?.sources??[]).filter(s=>!impacted.includes(s.key)),...run.manifest.filter(r=>impacted.includes(r.key)).map(r=>({key:r.key,sequence:r.sequence}))]
    const used=new Set(merged.flatMap(g=>(g.cards??[]).flatMap(c=>[...c.sources,...c.stateSources].map(sourceIdentity))))
    const evidence=new Map((snapshot?.evidence??[]).map(s=>[sourceIdentity(s),s]));for(const ref of cited)evidence.set(ref,run.read.get(ref)!)
    const covered=new Set([...run.covered,...impacted])
    const value=projectFocusSnapshotSchema.parse({origin:'model_interpretation',inferredAt:new Date().toISOString(),revision:revision+1,inputCount:sources.length,omittedCount:Math.max(0,run.candidates-sources.length),sources,
      result:{groups:merged,hierarchy:mergedNodes.map(n=>({id:n.id,title:n.title,purpose:n.purpose,...(n.parentId?{parentId:n.parentId}:{}),groupIndexes:n.groupIds.map(g=>merged.findIndex(v=>v.id===g))}))},evidence:[...evidence.values()].filter(s=>used.has(sourceIdentity(s))),historyPartial:true,presentationVersion:1,
      organization:{mode:run.mode,status:'running',coveredCount:covered.size,manifestCount:run.manifest.length,patches:run.patches+1}})
    run.signal.throwIfAborted()
    for(const key of impacted) {
      const sessionId=run.manifest.find(r=>r.key===key)!.observation?.sessionId
      if(sessionId && this.deps.activity(sessionId)!==run.versions.get(sessionId))this.stale(key,'Impacted conversation changed while validating')
    }
    this.store.saveProjectFocus(value,impacted,revision)
    run.covered=covered;run.patches++;run.bytes+=Buffer.byteLength(body);run.receipts.set(patch.patchId,{body,revision:revision+1})
    this.last=value.organization;this.deps.changed();return JSON.stringify({revision:revision+1,committed:true,coveredCount:covered.size})
  }
  async finish(args:Record<string,unknown>,context:ExecutionContext):Promise<string> {
    const run=this.bound(context)
    const {pruneTopicKeys,partial}=finishSchema.parse(args)
    if(pruneTopicKeys.length && (run.mode!=="full" || pruneTopicKeys.some(key=>!run.covered.has(key)||!run.manifest.some(r=>r.key===key))))throw new Error("Pruning requires full mode and explicitly covered manifest sources")
    if(!partial && run.covered.size!==run.manifest.length)throw new Error('Finish requires coverage of every manifest topic; no pruning by omission')
    if(partial && pruneTopicKeys.length)throw new Error('Partial finish cannot prune')
    if(pruneTopicKeys.length) {
      for(const key of pruneTopicKeys) {
        const sessionId=run.manifest.find(r=>r.key===key)!.observation?.sessionId
        if(sessionId && this.deps.activity(sessionId)!==run.versions.get(sessionId))throw new WorkConflict('Pruned conversation changed')
      }
      const {snapshot,groups,nodes}=this.keyed()
      if(!snapshot)throw new Error('Nothing to prune')
      const retained=groups.filter(g=>!g.topicKeys.some(k=>pruneTopicKeys.includes(k)))
      if(groups.some(g=>g.topicKeys.some(k=>pruneTopicKeys.includes(k))&&g.topicKeys.some(k=>!pruneTopicKeys.includes(k))))throw new Error('Prune cannot delete uncovered group members')
      if(!retained.length)throw new Error('Prune must retain at least one evidence-bearing topic')
      const keptNodes=nodes.map(n=>({...n,groupIds:n.groupIds.filter(id=>retained.some(g=>g.id===id))}))
      let changed=true;while(changed){changed=false;for(let i=keptNodes.length-1;i>=0;i--)if(!keptNodes[i]!.groupIds.length&&!keptNodes.some(n=>n.parentId===keptNodes[i]!.id)){keptNodes.splice(i,1);changed=true}}
      const sources=snapshot.sources.filter(s=>!pruneTopicKeys.includes(s.key))
      const used=new Set(retained.flatMap(g=>(g.cards??[]).flatMap(c=>[...c.sources,...c.stateSources].map(sourceIdentity))))
      const value=projectFocusSnapshotSchema.parse({...snapshot,revision:(snapshot.revision??0)+1,inputCount:sources.length,sources,omittedCount:Math.max(0,run.candidates-sources.length),evidence:snapshot.evidence?.filter(s=>used.has(sourceIdentity(s))),result:{groups:retained,hierarchy:keptNodes.map(n=>({id:n.id,title:n.title,purpose:n.purpose,...(n.parentId?{parentId:n.parentId}:{}),groupIndexes:n.groupIds.map(id=>retained.findIndex(g=>g.id===id))}))}})
      const validated=run.manifest.filter(r=>pruneTopicKeys.includes(r.key)).map(r=>({key:r.key,sequence:r.sequence}))
      this.store.saveProjectFocus(value,pruneTopicKeys,snapshot.revision??0,validated)
      this.deps.changed()
    }
    const status=partial?'partial':'completed'
    this.persistStatus(status);run.finished=true;return JSON.stringify({status,patches:run.patches,coveredCount:run.covered.size,staleTopicKeys:[...run.stale]})
  }
  private persistStatus(status:'completed'|'partial'){
    const run=this.run!;this.last={mode:run.mode,status,coveredCount:run.covered.size,manifestCount:run.manifest.length,patches:run.patches}
    const snapshot=this.store.projectFocus();if(snapshot&&run.patches)this.store.saveProjectFocus({...snapshot,organization:this.last},[],snapshot.revision??0)
    this.deps.changed()
  }
  end(){if(!this.run)return;try{if(!this.run.finished)this.persistStatus('partial')}finally{this.run=undefined}}
  tools():Tool[]{return ORGANIZATION_TOOLS.map<Tool>(name=>({name,optIn:true,description:name==='organization_read'?'Fallback for omitted fixed manifest semantic evidence (two sources per page) or placement; initial context sources already authorize citations. No tool traces.':name==='organization_patch'?'Atomically save a small validated keyed presentation patch; citations must be supplied by initial context or fallback read.':'Explicitly finish and lock writes after covering manifest; omission never deletes.',parameters:name==='organization_read'?readParameters:name==='organization_patch'?patchParameters:finishParameters,execute:(args,context)=>name==='organization_read'?this.read(args,context):name==='organization_patch'?this.patch(args,context):this.finish(args,context)}))}
}

/** Structural provider schema is derived from execution validation, never field-name guesses. */
function parameters(schema: z.ZodTypeAny): Tool['parameters'] {
  const convert = (value: z.ZodTypeAny): Record<string, unknown> => {
    if (value instanceof z.ZodOptional || value instanceof z.ZodDefault) return convert(value._def.innerType)
    if (value instanceof z.ZodObject) {
      const shape = value.shape as Record<string, z.ZodTypeAny>
      return { type:'object', properties:Object.fromEntries(Object.entries(shape).map(([key, child])=>[key,convert(child)])),
        required:Object.entries(shape).filter(([,child])=>!child.isOptional()).map(([key])=>key), additionalProperties:false }
    }
    if (value instanceof z.ZodArray) return { type:'array', items:convert(value.element),
      ...(value._def.minLength ? {minItems:value._def.minLength.value}:{}),
      ...(value._def.maxLength ? {maxItems:value._def.maxLength.value}:{}) }
    if (value instanceof z.ZodString) return { type:'string',
      ...(value.minLength !== null ? {minLength:value.minLength}:{}),
      ...(value.maxLength !== null ? {maxLength:value.maxLength}:{}) }
    if (value instanceof z.ZodNumber) return { type:value.isInt?'integer':'number',
      ...(value.minValue !== null ? {minimum:value.minValue}:{}),
      ...(value.maxValue !== null ? {maximum:value.maxValue}:{}) }
    if (value instanceof z.ZodBoolean) return {type:'boolean'}
    if (value instanceof z.ZodEnum) return {type:'string',enum:value.options}
    throw new Error('Unsupported organizer parameter schema')
  }
  return convert(schema) as Tool['parameters']
}
const readParameters = parameters(readSchema)
const patchParameters = parameters(patchSchema)
const finishParameters = parameters(finishSchema)
