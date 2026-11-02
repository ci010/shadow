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
