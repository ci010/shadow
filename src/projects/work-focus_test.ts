import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { InitiativeStore } from '../initiatives/store.ts'
import { workRecordSchema } from '../initiatives/work-contract.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { createProjectScope } from './scope.ts'
import { WorkOrganizer } from './work-organizer.ts'
import { SessionTools, Tools } from '../tools/registry.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { OrganizationController } from './organization-controller.ts'
import { projectWorkPlugin } from './work-routes.ts'
import type { SessionManager } from '../sessions/session-manager.ts'

const source = { id: 'request', physicalId: 'segment' }
const focus = { category: 'Understand release effects', purpose: 'Decide using evidence', motivation: 'May want confidence', evidence: [source] }
const record = (i: number) => workRecordSchema.parse({
  key: `topic:web:chat-${i}`, subject: { kind: 'topic', sessionId: `web:chat-${i}` }, sequence: 1, revision: 1,
  definition: { objective: 'Explain the release', acceptance: [], boundaries: [], evidence: [] },
  origin: 'agent_interpretation', changedBy: 'work-observer', changedAt: '2026-10-11T00:00:00Z',
  change: 'understanding', reason: 'Evidence', paused: false,
  observation: { sessionId: `web:chat-${i}`, observedAt: '2026-10-11T00:00:00Z', sources: [source], focus },
})

test('inference schema is optional for old JSON records and evidence is validated', () => {
  const old = { ...record(1), observation: { sessionId: 'web:chat-1', observedAt: '2026-10-11T00:00:00Z', sources: [source] } }
  assert.equal(workRecordSchema.parse(JSON.parse(JSON.stringify(old))).observation?.focus, undefined)
  assert.deepEqual(workRecordSchema.parse(JSON.parse(JSON.stringify(record(1)))).observation?.focus, focus)
  assert.throws(() => workRecordSchema.parse({ ...record(1), observation: { ...record(1).observation, focus: { ...focus, evidence: [{ ...source, id: 'invented' }] } } }))
})

test('explicit organization dispatches bounded tool organization, persists safely and rejects concurrent/stale runs', async () => withTempWorkspace(async home => {
  let store = new InitiativeStore(home)
  const scope = createProjectScope('fixture')
  for (let i = 0; i < 35; i++) store.saveWork(record(i), 0, 'fixture', 'created')
  let calls = 0, mode = 'success', input = ''
  const gate = Promise.withResolvers<void>()
  const controller = new OrganizationController({ scope, changed() {}, organize: async (runMode,signal) => {
    calls++
    const organizer = new WorkOrganizer(store,{projectId:'fixture',evidence:async()=>({sources:[],partial:true}),activity:()=>'',changed(){}})
    const ctx = {sessionId:'fixture:organizer',physicalSessionId:'physical',projectId:'fixture',signal,tools:new SessionTools(new Tools(home),home)} as ExecutionContext
    input=organizer.begin(ctx.sessionId,runMode,signal)
    try {
      if(mode==='wait')await gate.promise
      if(mode==='fail')throw new Error('Provider unavailable')
      const manifest=JSON.parse(input).manifest as {key:string}[]
      for(const topic of manifest)await organizer.read({key:topic.key},ctx)
      const groups=manifest.map((topic,index)=>({id:'topic-'+index,category:'Concrete topic '+index,purpose:focus.purpose,motivation:focus.motivation,topicKeys:[topic.key],cards:[]}))
      await organizer.patch({patchId:'bounded-patch',expectedRevision:store.projectFocus()?.revision??0,groups,hierarchy:[0,1,2].map(index=>({id:'purpose-'+index,title:'Shared purpose '+index,purpose:focus.purpose,groupIds:groups.slice(index*10,index*10+10).map(g=>g.id)}))},ctx)
      await organizer.finish({},ctx)
    }finally{organizer.end()}
  } })
  try {
    assert.equal(calls, 0)
    await controller.organize(new AbortController().signal)
    assert.equal(calls, 1)
    assert.equal(JSON.parse(input).manifest.length, 30)
    assert.equal(store.projectFocus()?.omittedCount, 5)
    assert.equal(store.projectFocus()?.result.groups.length, 30, 'all bounded concrete topics retained')
    assert.equal(store.projectFocus()?.result.hierarchy?.filter(node => !node.parentId).length, 3, 'organization actually reduces semantic roots, not filters')
    assert.equal(store.projectFocus()?.origin, 'model_interpretation')
    const saved = store.projectFocus()
    mode = 'fail'
    await assert.rejects(controller.organize(new AbortController().signal), /Provider/)
    assert.deepEqual(store.projectFocus(), saved)
    mode = 'wait'
    const running = controller.organize(new AbortController().signal)
    await assert.rejects(controller.organize(new AbortController().signal), /already running/)
    const key = JSON.parse(input).manifest[0].key
    const prior = store.workRecords().find(value => value.key === key)!
    store.saveWork({ ...prior, sequence: 2 }, 1, 'human', 'note')
    gate.resolve()
    await assert.rejects(running, /Topics changed/)
    assert.deepEqual(store.projectFocus(), saved)
    await controller.stop(); store.close()
    store = new InitiativeStore(home)
    assert.deepEqual(store.projectFocus(), saved, 'SQLite reopen retains inference without replay')
  } finally { await controller.stop(); store.close(); scope.close() }
}))

test('organization endpoint enforces authorization and strict empty input before model execution', async () => {
  let calls = 0
  const sessions = { alignment: {} } as unknown as SessionManager
  const app = new Hono()
  projectWorkPlugin(sessions, request => request.headers.get('x-fixture-user') === 'yes', undefined, undefined,
    async () => { calls++; throw new Error('Provider failure') })(app)
  const post = (body: string, user = true) => app.request('/api/work/organize', { method: 'POST', body,
    headers: { 'content-type': 'application/json', ...(user ? { 'x-fixture-user': 'yes' } : {}) } })
  assert.equal((await post('{}', false)).status, 401)
  assert.equal((await post('{"projectId":"another-project"}')).status, 400)
  assert.equal(calls, 0)
  assert.equal((await post('{}')).status, 502)
  assert.equal(calls, 1)
})


test('dedicated patches reject malformed structures, invented keys and unknown arguments without losing saved state',async()=>withTempWorkspace(async home=>{
  const store=new InitiativeStore(home)
  store.saveWork(record(1),0,'fixture','created')
  const organizer=new WorkOrganizer(store,{projectId:'fixture',evidence:async()=>({sources:[],partial:true}),activity:()=>'',changed(){}})
  const ctx={sessionId:'fixture:organizer',physicalSessionId:'physical',projectId:'fixture',signal:new AbortController().signal,tools:new SessionTools(new Tools(home),home)} as ExecutionContext
  try{
    organizer.begin(ctx.sessionId,'full',ctx.signal)
    await organizer.read({key:record(1).key},ctx)
    const patch={patchId:'valid',expectedRevision:0,groups:[{id:'release',category:'Release confidence',purpose:'Understand effects',motivation:'May want confidence',topicKeys:[record(1).key],cards:[]}],hierarchy:[{id:'release',title:'Release confidence',purpose:'Understand effects',groupIds:['release']}]}
    await organizer.patch(patch,ctx)
    const saved=store.projectFocus()
    for(const invalid of [{...patch,patchId:'invalid',expectedRevision:1,extra:true},{...patch,patchId:'invalid',expectedRevision:1,groups:'{truncated'},{...patch,patchId:'invalid',expectedRevision:1,groups:[{...patch.groups[0],topicKeys:['invented']}]}]){
      await assert.rejects(organizer.patch(invalid,ctx))
      assert.deepEqual(store.projectFocus(),saved)
    }
    await organizer.finish({},ctx)
  }finally{organizer.end();store.close()}
}))

test('organization route does not call model failures invalid requests and distinguishes overview failure', async () => {
  const { OrganizationOutputError } = await import('./organization-output.ts')
  const sessions = { alignment: {} } as unknown as SessionManager
  for (const [error, code] of [[new SyntaxError('private model text'), 'organization_failed'], [new OrganizationOutputError('model_json_invalid'), 'model_json_invalid'], [new OrganizationOutputError('model_schema_invalid'), 'model_schema_invalid'], [undefined, 'organization_refresh_failed']] as const) {
    const app = new Hono()
    projectWorkPlugin(sessions, () => true, undefined, undefined, async () => { if (error) throw error })(app)
    const response = await app.request('/api/work/organize', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } })
    assert.equal(response.status, 502)
    const body = await response.json()
    assert.equal(body.error, code)
    assert(!JSON.stringify(body).includes('private model text'))
  }
})
