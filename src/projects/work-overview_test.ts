import assert from 'node:assert/strict'
import test from 'node:test'
import { projectWorkOverviewSchema } from './work-overview.ts'

test('overview retains optional organizer phase, accepts historical receipts and rejects unknown phases',()=>{
  const base={items:[],sessions:[],effects:[],requests:[]}
  const outcome={mode:'delta',status:'completed',coveredCount:0,manifestCount:0,patches:0}
  const parse=(organization:unknown)=>projectWorkOverviewSchema.parse({...base,organization:{enabled:true,running:false,organization}})
  assert.deepEqual(parse(outcome).organization?.organization,outcome)
  for(const phase of ['hierarchy','evidence'])assert.equal(parse({...outcome,phase}).organization?.organization?.phase,phase)
  assert.throws(()=>parse({...outcome,phase:'anything'}))
})

test('overview retains safe controller diagnostics and check deadlines', () => {
  const organization = { enabled: true, running: false,
    lastAutomaticError: 'organization_delta_check_failed',
    lastCheckedAt: '2026-11-02T00:00:00.000Z', nextAutomaticAt: '2026-11-02T00:00:30.000Z' }
  const base = { items: [], sessions: [], effects: [], requests: [] }
  assert.deepEqual(projectWorkOverviewSchema.parse({ ...base, organization }).organization, organization)
  assert.throws(() => projectWorkOverviewSchema.parse({ ...base, organization: { ...organization, lastAutomaticError: 'private error text' } }))
})
