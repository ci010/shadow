import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkOrganizer } from './work-organizer.ts'
import { projectFocusSnapshotSchema } from './focus-contract.ts'
import { InitiativeStore } from '../initiatives/store.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { overviewGraph } from '../../app/src/project-overview-graph.ts'

import { organizerRecord, organizerSource, organizerPatch } from '../testing/work-organization.ts'

const context=(tools:SessionTools,sessionId='organizer:run'):ExecutionContext=>({sessionId,physicalSessionId:'actual',projectId:'fixture',channel:'organizer',chatId:'run',senderId:'system',messageId:'input',signal:new AbortController().signal,tools})

test('progressive patches are atomic, idempotent, survive failure and SQLite reopen; delta preserves unrelated IDs and stale sequence',async()=>withTempWorkspace(async home=>{
  let store=new InitiativeStore(home);for(let i=1;i<=2;i++)store.saveWork(organizerRecord(i),0,'fixture','created')
  try {
  let notifications=0
  const organizer=new WorkOrganizer(store,{projectId:'fixture',evidence:async id=>({sources:[organizerSource(Number(id.split('-').at(-1)))],partial:false}),activity:()=>'',physical:()=> 'actual',changed:()=>notifications++})
  const tools=new SessionTools(new Tools(home),home),ctx=context(tools)
  organizer.begin(ctx.sessionId,'full',ctx.signal)
  await organizer.read({key:organizerRecord(1).key},ctx)
  const patch=organizerPatch(1,0)
  assert.equal(JSON.parse(await organizer.patch(patch,ctx)).revision,1)
  assert.equal(store.projectFocus()?.result.groups[0]?.cards?.[0]?.id,'card-1','visible before the second patch')
  assert.equal(JSON.parse(await organizer.patch(patch,ctx)).idempotent,true)
  await assert.rejects(organizer.patch({...patch,expectedRevision:99},ctx),/reused/)
  await assert.rejects(organizer.finish({},ctx),/coverage/)
  organizer.end()
  assert.equal(store.projectFocus()?.organization?.status,'partial')
  store.close();store=new InitiativeStore(home)
  assert.equal(store.projectFocus()?.result.groups[0]?.cards?.[0]?.id,'card-1')
  // New service after reopen, with first topic unchanged and therefore outside delta.
  const delta=new WorkOrganizer(store,{now:()=>Date.now()+60_000,projectId:'fixture',evidence:async id=>({sources:[organizerSource(Number(id.split('-').at(-1)))],partial:false}),activity:()=>'',changed:()=>notifications++})
  assert.equal(delta.status()?.status,'partial','persisted coverage remains visible after restart')
  assert.equal(delta.status()?.coveredCount,1)
  const manifest=JSON.parse(delta.begin(ctx.sessionId,'delta',ctx.signal)).manifest
  assert.deepEqual(manifest.map((r:{key:string})=>r.key),[organizerRecord(2).key])
  const unchanged=store.projectFocus()!.result.groups[0]
  // Unrelated sequence change must not make the atomic changed-key patch fail.
  store.saveWork(organizerRecord(1,2),1,'fixture','note')
  await delta.read({key:organizerRecord(2).key},ctx)
  await delta.patch(organizerPatch(2,1),ctx)
  assert.deepEqual(store.projectFocus()!.result.groups.find(g=>g.id==='group-1'),unchanged)
  assert.equal(store.projectFocus()!.sources.find(s=>s.key===organizerRecord(1).key)?.sequence,1)
  await delta.finish({},ctx)
  await assert.rejects(delta.patch(organizerPatch(2,2),ctx),/outside/)
  delta.end()
  const snapshot=store.projectFocus()!
  const graph=overviewGraph({focus:snapshot,items:[],sessions:[],effects:[],requests:[]})
  assert(graph.nodes.some(n=>n.id==='presentation:group-1'))
  assert(notifications>=6)
  } finally {store.close()}
}))

test('evidence, physical identity, versions, hierarchy injection and prune scopes are enforced',async()=>withTempWorkspace(async home=>{
  const store=new InitiativeStore(home);for(let i=1;i<=2;i++)store.saveWork(organizerRecord(i),0,'fixture','created')
  let activity='v1',evidenceText='Human goal 1'
  const organizer=new WorkOrganizer(store,{projectId:'fixture',activity:()=>activity,physical:()=> 'actual',changed(){},evidence:async id=>({sources:[{...organizerSource(Number(id.split('-').at(-1))),text:id.endsWith('1')?evidenceText:'Human goal 2'}],partial:false})})
  const ctx=context(new SessionTools(new Tools(home),home));organizer.begin(ctx.sessionId,'full',ctx.signal)
  await assert.rejects(organizer.read({}, {...ctx,projectId:'other'}),/outside/)
  await assert.rejects(organizer.read({}, {...ctx,physicalSessionId:'forged'}),/outside/)
  await assert.rejects(organizer.read({key:organizerRecord(99).key},ctx),/manifest/)
  await assert.rejects(organizer.patch(organizerPatch(1,0),ctx),/returned/)
  await organizer.read({key:organizerRecord(1).key},ctx)
  activity='v2';await assert.rejects(organizer.patch(organizerPatch(1,0),ctx),/changed/);activity='v1'
  await assert.rejects(organizer.read({key:organizerRecord(1).key},ctx),/Already invalidated/)
  organizer.end();organizer.begin(ctx.sessionId,'full',ctx.signal);await organizer.read({key:organizerRecord(1).key},ctx)
  evidenceText='rewritten';await assert.rejects(organizer.patch(organizerPatch(1,0),ctx),/changed/);evidenceText='Human goal 1'
  organizer.end();organizer.begin(ctx.sessionId,'full',ctx.signal);await organizer.read({key:organizerRecord(1).key},ctx)
  const forged=organizerPatch(1,0);forged.groups[0]!.cards[0]!.sources[0]!.physicalId='forged'
  await assert.rejects(organizer.patch(forged,ctx),/returned/)
  await organizer.patch(organizerPatch(1,0),ctx)
  await assert.rejects(organizer.finish({pruneTopicKeys:[organizerRecord(2).key]},ctx),/covered/)
  await organizer.read({key:organizerRecord(2).key},ctx);await organizer.patch(organizerPatch(2,1),ctx)
  activity='v2';await assert.rejects(organizer.finish({pruneTopicKeys:[organizerRecord(1).key]},ctx),/changed/);activity='v1'
  await organizer.finish({pruneTopicKeys:[organizerRecord(1).key]},ctx)
  assert.deepEqual(store.projectFocus()!.sources.map(s=>s.key),[organizerRecord(2).key])
  organizer.end()
  organizer.begin(ctx.sessionId,'delta',ctx.signal)
  await assert.rejects(organizer.finish({pruneTopicKeys:[organizerRecord(2).key]},ctx),/full mode/)
  organizer.end();store.close()
}))

test('trusted runtime budgets count denied/invalid calls and cannot be widened by role overrides',async()=>{
  const base=new Tools('fixture');let executed=0
  base.register({name:'exec',description:'Forbidden shell',parameters:{type:'object',properties:{}},execute:async()=>{executed++;return 'unsafe'}})
  const scoped=new SessionTools(base,'fixture') // deliberately permissive workspace override
  scoped.setTrustedLimits({allowedTools:['organization_read'],inferenceRequests:8,toolCalls:2,argumentBytes:1000})
  const ctx=context(scoped)
  assert.match(String(await scoped.execute('exec',{},ctx)),/trusted/)
  assert.match(String(await base.execute('exec',{},ctx)),/trusted/)
  assert.match(String(await scoped.execute('organization_read',{invalid:true},ctx)),/not available|unknown/)
  await assert.rejects(scoped.execute('exec',{},ctx),/budget/)
  assert.equal(executed,0)
  assert.equal(scoped.inferenceRequestLimit,8)
})

test('full fixed manifest never deletes omitted topics; invalid hierarchy and stale revisions are atomic',async()=>withTempWorkspace(async home=>{
  const store=new InitiativeStore(home)
  try {
    for(let i=1;i<=31;i++)store.saveWork(organizerRecord(i),0,'fixture','created')
    const ctx=context(new SessionTools(new Tools(home),home))
    const organizer=new WorkOrganizer(store,{projectId:'fixture',activity:()=>'',changed(){},evidence:async id=>({sources:[organizerSource(Number(id.split('-').at(-1)))],partial:false})})
    organizer.begin(ctx.sessionId,'full',ctx.signal)
    await organizer.read({key:organizerRecord(1).key},ctx)
    const cycle=organizerPatch(1,0);Object.assign(cycle.hierarchy[0]!,{parentId:'root-1'})
    await assert.rejects(organizer.patch(cycle,ctx),/acyclic/)
    assert.equal(store.projectFocus(),undefined)
    await organizer.patch(organizerPatch(1,0),ctx);organizer.end()
    const second=new WorkOrganizer(store,{projectId:'fixture',activity:()=>'',changed(){},evidence:async id=>({sources:[organizerSource(Number(id.split('-').at(-1)))],partial:false})})
    const manifest=JSON.parse(second.begin(ctx.sessionId,'full',ctx.signal)).manifest as {key:string}[]
    assert.equal(manifest.length,30)
    const key=manifest.find(r=>r.key!==organizerRecord(1).key)!.key
    const i=Number(key.split('-').at(-1));await second.read({key},ctx)
    await assert.rejects(second.patch(organizerPatch(i,0),ctx),/revision/)
    await second.patch(organizerPatch(i,1),ctx)
    assert(store.projectFocus()!.result.groups.some(g=>g.id==='group-1'),'full omission is not deletion')
    assert.equal(store.projectFocus()!.omittedCount,29)
    second.end()
  }finally{store.close()}
}))

test('argument bytes include invalid attempts and remain exhausted',async()=>{
  const base=new Tools('fixture'),tools=new SessionTools(base,'fixture')
  tools.setTrustedLimits({allowedTools:['organization_read'],inferenceRequests:8,toolCalls:24,argumentBytes:20})
  await assert.rejects(tools.execute('forbidden',{payload:'x'.repeat(21)},context(tools)),/budget/)
  await assert.rejects(tools.execute('forbidden',{},context(tools)),/budget/)
})

test('oversized escaped evidence is denied before citations are admitted',async()=>withTempWorkspace(async home=>{
  const store=new InitiativeStore(home);store.saveWork(organizerRecord(1),0,'fixture','created')
  const organizer=new WorkOrganizer(store,{projectId:'fixture',activity:()=>'',changed(){},evidence:async()=>({sources:[{...organizerSource(1),text:'\u0001'.repeat(4000)}],partial:true})})
  const ctx=context(new SessionTools(new Tools(home),home))
  try {
    organizer.begin(ctx.sessionId,'full',ctx.signal)
    await assert.rejects(organizer.read({key:organizerRecord(1).key},ctx),/12,000/)
    await assert.rejects(organizer.patch(organizerPatch(1,0),ctx),/returned/)
  }finally{organizer.end();store.close()}
}))


test('aborted organizer rejects further writes and retains committed patch with partial coverage', async () => withTempWorkspace(async home => {
  const store = new InitiativeStore(home)
  for (let i = 1; i <= 2; i++) store.saveWork(organizerRecord(i), 0, 'fixture', 'created')
  const controller = new AbortController()
  const organizer = new WorkOrganizer(store, { projectId: 'fixture', activity: () => '', changed() {}, evidence: async id => ({ sources: [organizerSource(Number(id.split('-').at(-1)))], partial: false }) })
  const ctx = context(new SessionTools(new Tools(home), home))
  try {
    organizer.begin(ctx.sessionId, 'full', controller.signal)
    await organizer.read({ key: organizerRecord(1).key }, ctx)
    await organizer.patch(organizerPatch(1, 0), ctx)
    controller.abort(new Error('Organization disabled'))
    await assert.rejects(organizer.patch(organizerPatch(2, 1), ctx), /disabled/)
    organizer.end()
    assert.equal(store.projectFocus()?.organization?.status, 'partial')
    assert.equal(store.projectFocus()?.organization?.patches, 1)
    assert.equal(store.projectFocus()?.result.groups[0]?.cards?.[0]?.id, 'card-1')
  } finally { organizer.end(); store.close() }
}))

test('delta selects at most three changed topics while full retains thirty-topic ceiling', async () => withTempWorkspace(async home => {
  const store = new InitiativeStore(home)
  try {
    const empty = new WorkOrganizer(store, { projectId: 'fixture', evidence: async () => ({ sources: [], partial: true }), activity: () => '', changed() {} })
    assert.equal(empty.hasDelta(), false, 'preflight is empty without creating a run')
    for (let i = 1; i <= 35; i++) store.saveWork(organizerRecord(i), 0, 'fixture', 'created')
    assert.equal(empty.hasDelta(), true)
    const organizer = new WorkOrganizer(store, { projectId: 'fixture', evidence: async () => ({ sources: [], partial: true }), activity: () => '', changed() {} })
    const signal = new AbortController().signal
    assert.equal(JSON.parse(organizer.begin('fixture', 'delta', signal)).manifest.length, 3)
    organizer.end()
    assert.equal(JSON.parse(organizer.begin('fixture', 'full', signal)).manifest.length, 30)
    organizer.end()
  } finally { store.close() }
}))


test('host preload authorizes patch and finish without reads; activity changes still reject',async()=>withTempWorkspace(async home=>{
  const store=new InitiativeStore(home);store.saveWork(organizerRecord(1),0,'fixture','created')
  let activity='v1'
  const ctx=context(new SessionTools(new Tools(home),home))
  const organizer=new WorkOrganizer(store,{projectId:'fixture',activity:()=>activity,changed(){},evidence:async()=>({sources:[organizerSource(1)],partial:false})})
  try {
    const initial=JSON.parse(await organizer.initialContext(organizer.begin(ctx.sessionId,'delta',ctx.signal)))
    assert.equal(initial.evidence[0].activityVersion,'v1')
    assert.equal(initial.evidence[0].sources[0].id,organizerSource(1).id)
    activity='v2';await assert.rejects(organizer.patch(organizerPatch(1,0),ctx),/changed/)
    activity='v1';await assert.rejects(organizer.patch(organizerPatch(1,0),ctx),/Already invalidated/)
    await organizer.finish({partial:true},ctx)
    assert.equal(organizer.status()?.coveredCount,0)
    organizer.end();await organizer.initialContext(organizer.begin(ctx.sessionId,'full',ctx.signal))
    await organizer.patch(organizerPatch(1,0),ctx)
    await organizer.finish({},ctx)
    assert.equal(organizer.status()?.status,'completed')
  }finally{organizer.end();store.close()}
}))

test('preload keeps original goal and newest evidence, bounds escaped input and supports fallback pages',async()=>withTempWorkspace(async home=>{
  const store=new InitiativeStore(home);store.saveWork(organizerRecord(1),0,'fixture','created')
  const sources=Array.from({length:60},(_,i)=>({...organizerSource(1),id:`source-${i}`,kind:i===0?'human' as const:'assistant' as const,text:i===0?'Original goal':`Recent report ${i}`}))
  const ctx=context(new SessionTools(new Tools(home),home))
  const organizer=new WorkOrganizer(store,{projectId:'fixture',activity:()=>'',changed(){},evidence:async()=>({sources,partial:true})})
  try {
    const text=await organizer.initialContext(organizer.begin(ctx.sessionId,'delta',ctx.signal)),initial=JSON.parse(text)
    assert(Buffer.byteLength(text)<=48000)
    assert.equal(initial.evidence[0].sources[0].id,'source-59')
    assert.equal(initial.evidence[0].sources[1].id,'source-0')
    const next=initial.omissions.find((o:{kind:string})=>o.kind==='evidence').read
    const page=JSON.parse(await organizer.read(next,ctx))
    assert.equal(page.sources[0].id,'source-54')
    assert.equal(page.coverage.historyPartial,true)
  }finally{organizer.end();store.close()}
}))

test('mixed membership placement includes complete keys and ancestor chain; shared ancestor cannot be renamed',async()=>withTempWorkspace(async home=>{
  const store=new InitiativeStore(home);for(let i=1;i<=2;i++)store.saveWork(organizerRecord(i),0,'fixture','created')
  const ctx=context(new SessionTools(new Tools(home),home))
  const organizer=new WorkOrganizer(store,{projectId:'fixture',activity:()=>'',changed(){},evidence:async id=>({sources:[organizerSource(Number(id.split('-').at(-1)))],partial:false})})
  try {
    await organizer.initialContext(organizer.begin(ctx.sessionId,'full',ctx.signal))
    const patch=organizerPatch(1,0);patch.groups[0]!.topicKeys.push(organizerRecord(2).key)
    patch.hierarchy=[{id:'shared',title:'Shared',purpose:'Shared ancestor',groupIds:[]},{...patch.hierarchy[0]!,parentId:'shared'}] as typeof patch.hierarchy
    await organizer.patch(patch,ctx);await organizer.finish({},ctx);organizer.end()
    store.saveWork(organizerRecord(1,2),1,'fixture','note')
    const initial=JSON.parse(await organizer.initialContext(organizer.begin(ctx.sessionId,'delta',ctx.signal)))
    assert.deepEqual(initial.placement[0].topicKeys,[organizerRecord(1).key,organizerRecord(2).key])
    assert(initial.placement[0].hierarchy.some((n:{id:string})=>n.id==='shared'))
    await assert.rejects(organizer.patch(organizerPatch(1,1),ctx),/unrelated group members/)
    const move=organizerPatch(1,1);move.groups[0]!.id='new-group';move.hierarchy=[{id:'shared',title:'Renamed',purpose:'Shared ancestor',groupIds:['new-group']}]
    await assert.rejects(organizer.patch(move,ctx),/unrelated hierarchy/)
  }finally{organizer.end();store.close()}
}))


test('large full preload is bounded, signals source omission and never loads non-manifest sessions',async()=>withTempWorkspace(async home=>{
  const store=new InitiativeStore(home);for(let i=1;i<=35;i++)store.saveWork(organizerRecord(i),0,'fixture','created')
  const loaded:string[]=[]
  const ctx=context(new SessionTools(new Tools(home),home))
  const organizer=new WorkOrganizer(store,{projectId:'fixture',activity:()=>'',changed(){},evidence:async id=>{
    loaded.push(id);const i=Number(id.split('-').at(-1));return {sources:Array.from({length:100},(_,j)=>({...organizerSource(i),id:`source-${j}`,text:'\u0001'.repeat(4000)})),partial:true}
  }})
  try {
    const text=await organizer.initialContext(organizer.begin(ctx.sessionId,'full',ctx.signal)),initial=JSON.parse(text)
    assert(Buffer.byteLength(text)<=48000)
    assert.equal(initial.manifest.length,30)
    assert.equal(loaded.length,30)
    assert.deepEqual(new Set(loaded),new Set(initial.evidence.map((item:{sessionId:string})=>item.sessionId)))
    assert(initial.omissions.length>0)
    assert(initial.evidence.every((item:{coverage:{available:number;retained:number}})=>item.coverage.available===100&&item.coverage.retained===8))
  }finally{organizer.end();store.close()}
}))


test('preload detects evidence changes before task delivery and placement fallback pages expose full memberships',async()=>withTempWorkspace(async home=>{
  const store=new InitiativeStore(home);for(let i=1;i<=10;i++)store.saveWork(organizerRecord(i),0,'fixture','created')
  const ctx=context(new SessionTools(new Tools(home),home))
  let activity='v1',mutate=true
  const organizer=new WorkOrganizer(store,{projectId:'fixture',activity:()=>activity,changed(){},evidence:async id=>{if(mutate)activity='v2';return {sources:[organizerSource(Number(id.split('-').at(-1)))],partial:false}}})
  try {
    await assert.rejects(organizer.initialContext(organizer.begin(ctx.sessionId,'delta',ctx.signal)),/changed/)
    organizer.end();mutate=false
    await organizer.initialContext(organizer.begin(ctx.sessionId,'full',ctx.signal))
    const patch=organizerPatch(1,0);patch.groups[0]!.topicKeys=Array.from({length:10},(_,i)=>organizerRecord(i+1).key)
    await organizer.patch(patch,ctx);await organizer.finish({},ctx);organizer.end()
    organizer.begin(ctx.sessionId,'full',ctx.signal)
    const first=JSON.parse(await organizer.read({},ctx))
    assert.equal(first.groups[0].membership.complete,false)
    assert.equal(first.groups[0].topicKeys.length,8)
    const last=JSON.parse(await organizer.read(first.groups[0].membership.next,ctx))
    assert.equal(last.groups[0].membership.next,null)
    assert.deepEqual([...first.groups[0].topicKeys,...last.groups[0].topicKeys],patch.groups[0]!.topicKeys)
  }finally{organizer.end();store.close()}
}))


test('provider schema derives exact nested Zod bounds without narrowing evidence IDs or enum values',()=>{
  const organizer=new WorkOrganizer({} as InitiativeStore,{projectId:'fixture',activity:()=>'',evidence:async()=>({sources:[],partial:false}),changed(){}})
  const [read,patch,finish]=organizer.tools().map(tool=>tool.parameters as any)
  assert.equal(read.properties.key.maxLength,undefined)
  assert.equal(read.properties.offset.minimum,0)
  assert.equal(patch.properties.expectedRevision.type,'integer')
  assert.equal(patch.properties.groups.minItems,undefined) // phase-dependent nonempty enforcement is host-side
  assert.equal(patch.properties.groups.maxItems,30)
  const group=patch.properties.groups.items.properties,card=group.cards.items.properties
  assert.equal(group.id.maxLength,120)
  assert.equal(group.topicKeys.items.maxLength,600)
  assert.equal(card.sources.items.properties.id.maxLength,600)
  assert.equal(card.state.minLength,undefined)
  assert.equal(card.state.maxLength,undefined)
  assert.equal(card.markdown.maxLength,4000)
  assert.equal(card.stateSources.minItems,1)
  assert.equal(patch.properties.hierarchy.items.properties.groupIds.maxItems,200)
  assert.equal(patch.properties.hierarchy.items.properties.groupIds.items.maxLength,120)
  assert.equal(finish.properties.pruneTopicKeys.maxItems,30)
})

test('stale topic is isolated: partial finish preserves real coverage and rejects deletion',async()=>withTempWorkspace(async home=>{
  const store=new InitiativeStore(home)
  for(let i=1;i<=2;i++)store.saveWork(organizerRecord(i),0,'fixture','created')
  let version='v1'
  const organizer=new WorkOrganizer(store,{projectId:'fixture',activity:id=>id.endsWith('2')?version:'v1',evidence:async id=>({sources:[organizerSource(Number(id.split('-').at(-1)))],partial:false}),changed(){}})
  const ctx=context(new SessionTools(new Tools(home),home))
  try{
    await organizer.initialContext(organizer.begin(ctx.sessionId,'full',ctx.signal))
    await organizer.patch(organizerPatch(1,0),ctx)
    version='v2'
    await assert.rejects(organizer.patch(organizerPatch(2,1),ctx),/ORGANIZATION_STALE_TOPIC/)
    version='v1'
    await assert.rejects(organizer.read({key:organizerRecord(2).key},ctx),/Already invalidated/)
    await assert.rejects(organizer.finish({},ctx),/coverage/)
    await assert.rejects(organizer.finish({partial:true,pruneTopicKeys:[organizerRecord(1).key]},ctx),/cannot prune/)
    const result=JSON.parse(await organizer.finish({partial:true},ctx))
    assert.equal(result.coveredCount,1)
    assert.deepEqual(result.staleTopicKeys,[organizerRecord(2).key])
    assert.equal(store.projectFocus()?.organization?.status,'partial')
    assert.equal(store.projectFocus()?.sources.length,1)
    assert.equal(store.projectFocus()?.result.groups[0]?.id,'group-1')
  }finally{organizer.end();store.close()}
}))


test('delta explicitly converges old roots and reuses the macro root across batches without altering unread data',async()=>withTempWorkspace(async home=>{
  const store=new InitiativeStore(home)
  try {
    for(let i=1;i<=2;i++)store.saveWork(organizerRecord(i),0,'fixture','created')
    const organizer=new WorkOrganizer(store,{projectId:'fixture',evidence:async id=>({sources:[organizerSource(Number(id.split('-').at(-1)))],partial:false}),activity:()=>'',changed(){}})
    const ctx=context(new SessionTools(new Tools(home),home))
    organizer.begin(ctx.sessionId,'full',ctx.signal)
    for(let i=1;i<=2;i++){await organizer.read({key:organizerRecord(i).key},ctx);await organizer.patch(organizerPatch(i,i-1),ctx)}
    await organizer.finish({},ctx);organizer.end()
    const old=store.projectFocus()!
    store.saveWork(organizerRecord(3),0,'fixture','created')
    const task=organizer.begin(ctx.sessionId,'delta',ctx.signal)
    const initial=JSON.parse(await organizer.initialContext(task))
    assert.equal(initial.placement.length,0,'new manifest has no relevant old groups')
    assert.deepEqual(initial.globalRoots.roots.map((r:{id:string})=>r.id),['root-1','root-2'])
    const parent={id:'macro',title:'Shared human outcomes',purpose:'Display aggregation only'}
    const patch={...organizerPatch(3,2),rootRegroup:[{parent,rootIds:['root-1','root-2']}]}
    await assert.rejects(organizer.patch({...patch,rootRegroup:[{parent,rootIds:['root-1','root-1']}]},ctx),/unique/)
    await assert.rejects(organizer.patch({...patch,rootRegroup:[{parent,rootIds:['invented','root-1']}]},ctx),/existing shown/)
    await assert.rejects(organizer.patch({...patch,expectedRevision:1},ctx),/revision/)
    assert.equal(store.projectFocus()!.revision,2)
    await organizer.patch(patch,ctx)
    let next=store.projectFocus()!
    assert.deepEqual(next.result.groups.slice(0,2),old.result.groups)
    assert.deepEqual(next.sources.slice(0,2),old.sources)
    assert.deepEqual(next.evidence?.slice(0,2),old.evidence)
    assert.deepEqual(next.result.hierarchy?.filter(n=>n.id==='root-1'||n.id==='root-2'),old.result.hierarchy?.map(n=>({...n,parentId:'macro'})))
    const beforeBatch=next
    await organizer.finish({},ctx);organizer.end()
    store.saveWork(organizerRecord(4),0,'fixture','created')
    await organizer.initialContext(organizer.begin(ctx.sessionId,'delta',ctx.signal))
    // Attach manifest evidence directly to a known existing macro, and fold the
    // previous batch's remaining flat root into that same parent.
    const batch=organizerPatch(4,3)
    batch.hierarchy[0]!.id='macro';batch.hierarchy[0]!.title=parent.title;batch.hierarchy[0]!.purpose=parent.purpose
    await organizer.patch({...batch,rootRegroup:[{parent,rootIds:['root-3']}]},ctx)
    next=store.projectFocus()!
    assert.equal(next.result.hierarchy?.filter(n=>!n.parentId).length,1)
    assert.deepEqual(next.result.groups.slice(0,3),beforeBatch.result.groups)
    await organizer.finish({},ctx);organizer.end()
  }finally{store.close()}
}))

test('bounded global root pagination, unread-root protection, cycles and retained subtree depth are enforced atomically',async()=>withTempWorkspace(async home=>{
  const store=new InitiativeStore(home)
  try {
    for(let i=1;i<=12;i++)store.saveWork(organizerRecord(i),0,'fixture','created')
    const organizer=new WorkOrganizer(store,{projectId:'fixture',evidence:async id=>({sources:[organizerSource(Number(id.split('-').at(-1)))],partial:false}),activity:()=>'',changed(){}})
    const ctx=context(new SessionTools(new Tools(home),home))
    organizer.begin(ctx.sessionId,'full',ctx.signal)
    for(let i=1;i<=12;i++){
      await organizer.read({key:organizerRecord(i).key},ctx)
      const patch=organizerPatch(i,i-1)
      if(i===1)patch.hierarchy=[{id:'leaf',title:'Leaf',purpose:'Display',groupIds:['group-1'],parentId:'level3'},{id:'level3',title:'Level 3',purpose:'Display',groupIds:[],parentId:'level2'},{id:'level2',title:'Level 2',purpose:'Display',groupIds:[],parentId:'root-1'},{id:'root-1',title:'Purpose 1',purpose:'Shared benefit',groupIds:[]}] as typeof patch.hierarchy
      await organizer.patch(patch,ctx)
    }
    await organizer.finish({},ctx);organizer.end()
    store.saveWork(organizerRecord(13),0,'fixture','created')
    const raw=await organizer.initialContext(organizer.begin(ctx.sessionId,'delta',ctx.signal)),initial=JSON.parse(raw)
    assert(Buffer.byteLength(raw)<48000)
    assert.equal(initial.globalRoots.total,12)
    assert.equal(initial.globalRoots.roots.length,8)
    assert.equal(initial.globalRoots.roots[0].subtreeMaxDepth,4)
    assert.equal(initial.globalRoots.roots[0].canAddParent,false)
    assert.equal(initial.globalRoots.roots[1].subtreeMaxDepth,1)
    assert.equal(initial.globalRoots.roots[1].canAddParent,true)
    assert.deepEqual(initial.globalRoots.next,{rootOffset:8})
    const patch={patchId:'hierarchy',expectedRevision:12,groups:[],hierarchy:[]},parent={id:'macro',title:'Macro',purpose:'Display aggregation'}
    await assert.rejects(organizer.patch({...patch,rootRegroup:[{parent,rootIds:['root-12','root-11']}]},ctx),/root pages/)
    await organizer.read({rootOffset:8},ctx)
    await assert.rejects(organizer.patch({...patch,rootRegroup:[{parent,rootIds:['root-2']}]},ctx),/at least two/)
    const page=JSON.parse(await organizer.read(initial.globalRoots.next,ctx))
    assert.equal(page.roots.length,4);assert.equal(page.next,null)
    assert(Buffer.byteLength(JSON.stringify(page))<12000)
    await assert.rejects(organizer.patch({...patch,rootRegroup:[{parent,rootIds:['root-1','root-2']}]},ctx),/four/)
    const a={id:'root-2',title:'Purpose 2',purpose:'Shared benefit'},b={id:'root-3',title:'Purpose 3',purpose:'Shared benefit'}
    await assert.rejects(organizer.patch({...patch,rootRegroup:[{parent:a,rootIds:['root-3']},{parent:b,rootIds:['root-2']}]},ctx),/acyclic/)
    assert.equal(store.projectFocus()!.revision,12)
    await organizer.patch({...patch,rootRegroup:[{parent,rootIds:['root-11','root-12']}]},ctx)
    await assert.rejects(organizer.patch({...organizerPatch(13,13),rootRegroup:[{parent:a,rootIds:['root-4']}]},ctx),/fixed-revision/,'hierarchy phase permits one patch only')
    await organizer.finish({},ctx);organizer.end()
  }finally{store.close()}
}))


test('automatic selection excludes busy turns, recovers idle sources, backs off failures and admits new versions fairly',async()=>withTempWorkspace(async home=>{
  const store=new InitiativeStore(home)
  let now=1000,busy=true
  const organizer=new WorkOrganizer(store,{projectId:'fixture',now:()=>now,busy:id=>id.endsWith('1')&&busy,activity:()=>'',evidence:async id=>({sources:[organizerSource(Number(id.split('-').at(-1)))],partial:false}),changed(){}})
  const ctx=context(new SessionTools(new Tools(home),home))
  try{
    store.saveWork(organizerRecord(1),0,'fixture','created')
    assert.equal(organizer.hasDelta(),false)
    busy=false // turn.finished, not session destruction
    assert.equal(organizer.hasDelta(),true)
    assert.equal(JSON.parse(organizer.begin(ctx.sessionId,'delta',ctx.signal)).manifest.length,1)
    organizer.end() // failed before a first snapshot: still deduplicated in this runtime
    assert.equal(organizer.hasDelta(),false)
    store.saveWork(organizerRecord(2),0,'fixture','created')
    assert.deepEqual(JSON.parse(organizer.begin(ctx.sessionId,'delta',ctx.signal)).manifest.map((r:{key:string})=>r.key),[organizerRecord(2).key])
    await organizer.initialContext(JSON.stringify({manifest:[{key:organizerRecord(2).key}],revision:0}))
    await organizer.patch(organizerPatch(2,0),ctx);await organizer.finish({},ctx);organizer.end()
    assert.equal(organizer.hasDelta(),false)
    now+=30_000
    organizer.begin(ctx.sessionId,'delta',ctx.signal);organizer.end()
    assert.equal(store.projectFocus()?.organizerAdmission?.failures[0]?.attempts,2)
    now+=30_001
    assert.equal(organizer.hasDelta(),false,'second failure waits 60 seconds')
    const reopened=new WorkOrganizer(store,{projectId:'fixture',now:()=>now,activity:()=>'',evidence:async()=>({sources:[],partial:false}),changed(){}})
    assert.equal(reopened.hasDelta(),false,'cooldown restored from existing focus snapshot')
    store.saveWork(organizerRecord(1,2),1,'fixture','changed')
    assert.equal(reopened.hasDelta(),true,'new version bypasses old-version cooldown')
  }finally{organizer.end();store.close()}
}))

test('hierarchy-only 29-root convergence preserves all data; no-change checks persist, cooldown never starves evidence',async()=>withTempWorkspace(async home=>{
  let store=new InitiativeStore(home),now=1000
  let evidenceReads=0
  const make=()=>new WorkOrganizer(store,{projectId:'fixture',now:()=>now,activity:()=>'',evidence:async id=>{evidenceReads++;return {sources:[organizerSource(Number(id.split('-').at(-1)))],partial:false}},changed(){}})
  let organizer=make()
  const ctx=context(new SessionTools(new Tools(home),home))
  try{
    for(let i=1;i<=29;i++)store.saveWork(organizerRecord(i),0,'fixture','created')
    const patches=Array.from({length:29},(_,i)=>organizerPatch(i+1,0))
    const seed={origin:'model_interpretation' as const,inferredAt:new Date().toISOString(),revision:1,inputCount:29,omittedCount:0,sources:Array.from({length:29},(_,i)=>({key:organizerRecord(i+1).key,sequence:1})),result:{groups:patches.flatMap(p=>p.groups),hierarchy:patches.flatMap((p,i)=>p.hierarchy.map(n=>({id:n.id,title:n.title,purpose:n.purpose,groupIndexes:[i]})))},evidence:Array.from({length:29},(_,i)=>organizerSource(i+1)),historyPartial:true,presentationVersion:1 as const}
    store.saveProjectFocus(projectFocusSnapshotSchema.parse(seed),seed.sources.map(s=>s.key),0)
    const before=store.projectFocus()!
    const initial=JSON.parse(await organizer.initialContext(organizer.begin(ctx.sessionId,'delta',ctx.signal)))
    assert.equal(initial.phase,'hierarchy');assert.deepEqual(initial.manifest,[]);assert.equal(evidenceReads,0)
    await assert.rejects(organizer.finish({},ctx),/all root pages/)
    for(const rootOffset of [8,16,24])await organizer.read({rootOffset},ctx)
    await organizer.patch({patchId:'roots',expectedRevision:1,groups:[],hierarchy:[],rootRegroup:[{parent:{id:'macro-a',title:'Shared outcomes A',purpose:'Display only'},rootIds:Array.from({length:15},(_,i)=>'root-'+(i+1))},{parent:{id:'macro-b',title:'Shared outcomes B',purpose:'Display only'},rootIds:Array.from({length:14},(_,i)=>'root-'+(i+16))}]},ctx)
    await organizer.finish({},ctx);organizer.end()
    const after=store.projectFocus()!
    assert.equal(after.result.hierarchy?.filter(n=>!n.parentId).length,2)
    assert.deepEqual(after.result.groups,before.result.groups);assert.deepEqual(after.evidence,before.evidence);assert.deepEqual(after.sources,before.sources)
    assert.equal(organizer.hasDelta(),false,'<=5 roots need no check')
    // Restore a flat graph to exercise no-change and failure cooldown paths.
    store.saveProjectFocus({...after,revision:3,result:before.result},[],2)
    await organizer.initialContext(organizer.begin(ctx.sessionId,'delta',ctx.signal))
    organizer.end() // hierarchy failure; evidence remains independently eligible
    store.saveWork(organizerRecord(30),0,'fixture','created')
    const content=JSON.parse(organizer.begin(ctx.sessionId,'delta',ctx.signal))
    assert.equal(content.phase,'evidence');assert.deepEqual(content.manifest.map((r:{key:string})=>r.key),[organizerRecord(30).key])
    await assert.rejects(organizer.patch({patchId:'empty',expectedRevision:3,groups:[],hierarchy:[]},ctx),/1–30/)
    await organizer.initialContext(JSON.stringify(content));await organizer.patch(organizerPatch(30,3),ctx);await organizer.finish({},ctx);organizer.end()
    now+=30_000
    await organizer.initialContext(organizer.begin(ctx.sessionId,'delta',ctx.signal))
    for(const rootOffset of [8,16,24])await organizer.read({rootOffset},ctx)
    await organizer.finish({},ctx);organizer.end()
    assert.equal(organizer.hasDelta(),false,'same hierarchy checked once even with >5 roots')
    store.close();store=new InitiativeStore(home);organizer=make()
    assert.equal(organizer.hasDelta(),false,'no-change receipt survives SQLite restart')
    const snapshot=store.projectFocus()!
    store.saveProjectFocus({...snapshot,revision:(snapshot.revision??0)+1,inferredAt:new Date().toISOString()},[],snapshot.revision??0)
    assert.equal(organizer.hasDelta(),false,'revision-only/content updates do not reset hierarchy check')
  }finally{organizer.end();store.close()}
}))


test('admission metadata is optional, bounded and rejects invalid cooldown values',()=>{
  const base={origin:'model_interpretation',inferredAt:new Date().toISOString(),revision:0,inputCount:1,omittedCount:0,sources:[{key:'one',sequence:1}],result:{groups:[{category:'One',purpose:'Display',motivation:'Display',topicKeys:['one']}]}}
  assert(projectFocusSnapshotSchema.safeParse(base).success,'old snapshots stay valid')
  const metadata={failures:[{key:'one',sequence:1,attempts:1,retryAt:1000}]}
  assert(projectFocusSnapshotSchema.safeParse({...base,organizerAdmission:metadata}).success)
  for(const field of [{attempts:0},{attempts:17},{retryAt:-1},{retryAt:Infinity},{sequence:0}])assert.equal(projectFocusSnapshotSchema.safeParse({...base,organizerAdmission:{failures:[{...metadata.failures[0],...field}]}}).success,false)
  assert.equal(projectFocusSnapshotSchema.safeParse({...base,organizerAdmission:{failures:Array.from({length:201},()=>metadata.failures[0])}}).success,false)
})

test('documented startup gap: failures before the first focus snapshot are runtime-only',async()=>withTempWorkspace(async home=>{
  let store=new InitiativeStore(home)
  const make=()=>new WorkOrganizer(store,{projectId:'fixture',now:()=>1000,activity:()=>'',evidence:async()=>({sources:[],partial:true}),changed(){}})
  try{
    store.saveWork(organizerRecord(1),0,'fixture','created')
    const organizer=make();organizer.begin('fixture','delta',new AbortController().signal);organizer.end()
    assert.equal(organizer.hasDelta(),false)
    assert.equal(store.projectFocus(),undefined,'no synthetic empty focus is written')
    store.close();store=new InitiativeStore(home)
    assert.equal(make().hasDelta(),true,'restart retries once when no durable focus exists yet')
  }finally{store.close()}
}))
