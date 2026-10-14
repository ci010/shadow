import assert from 'node:assert/strict'
import test from 'node:test'
import { WorkOrganizer } from './work-organizer.ts'
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
  const delta=new WorkOrganizer(store,{projectId:'fixture',evidence:async id=>({sources:[organizerSource(Number(id.split('-').at(-1)))],partial:false}),activity:()=>'',changed:()=>notifications++})
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
  evidenceText='rewritten';await assert.rejects(organizer.patch(organizerPatch(1,0),ctx),/changed/);evidenceText='Human goal 1'
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
    for (let i = 1; i <= 35; i++) store.saveWork(organizerRecord(i), 0, 'fixture', 'created')
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
    activity='v1';await organizer.patch(organizerPatch(1,0),ctx)
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
