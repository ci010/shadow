import { test } from 'node:test'
import assert from 'node:assert/strict'
import { committedRunner } from './committed-runner.ts'

const image = 'sha256:' + 'a'.repeat(64)
const otherImage = 'sha256:' + 'b'.repeat(64)
// Execute the exact embedded placement code without a worker, Docker or provisioning.
const place = new Function('client', 'definiteRefusal', 'image', `
 const a = {}, ws = {branch:'feature'}, project = 'registered-project', action = 'exec';
 const process = {env:{LAYERFS_IMAGE:image}};
 ${committedRunner}
 phase = async () => {};
 return mountForExec;
`)
function fixture(items: Array<{sandbox:string,image:string,workspaces:number}> = []) {
 const calls: unknown[][] = []
 const client = {
  project: {list_sandboxes: async (size:number, pos:number) => { calls.push(['inventory',size,pos]); return {items:items.slice(pos,pos+size),hasMore:pos+size<items.length} }},
  sandbox: { create: async (options:unknown) => {calls.push(['create',options]); const item={sandbox:String(items.length+1),image,workspaces:0};items.push(item);return item}},
  workspace: {mount: async (sandbox:string, branch:string) => {calls.push(['mount',sandbox,branch]);return {sandbox,path:'/workspaces/1',image}}},
 }
 return {items,calls,client,mount:place(client,(e:any)=>e.refusal===true,image) as (branch:string)=>Promise<any>}
}

test('sequential exec placement reuses live matching sandbox without create/close',async()=>{
 const f=fixture()
 assert.equal((await f.mount('feature')).sandbox,'1')
 assert.equal((await f.mount('feature')).sandbox,'1')
 assert.equal(f.calls.filter(c=>c[0]==='create').length,1)
 assert.deepEqual(f.calls.filter(c=>c[0]==='create')[0],['create',{image}])
})
test('image mismatch and full capacity allocate only when no suitable live sandbox exists',async()=>{
 const f=fixture([{sandbox:'1',image:otherImage,workspaces:0},{sandbox:'2',image,workspaces:16}])
 assert.equal((await f.mount('feature')).sandbox,'3')
 assert.equal(f.calls.filter(c=>c[0]==='mount').length,1)
})
for(const code of ['NoSuchSandbox','Capacity']) test(`verified ${code} race permits fresh placement`,async()=>{
 const f=fixture([{sandbox:'1',image,workspaces:0}])
 const original=f.client.workspace.mount
 f.client.workspace.mount=async(s,b)=>{if(s==='1'){f.calls.push(['mount',s,b]);throw Object.assign(Error(code),{code,refusal:true})}return original(s,b)}
 assert.equal((await f.mount('feature')).sandbox,'2')
 assert.equal(f.calls.filter(c=>c[0]==='create').length,1)
})
for(const code of ['Unknown','ECONNRESET','Capacity','NoSuchSandbox']) test(`unverified ${code} mount is never replayed`,async()=>{
 const f=fixture([{sandbox:'1',image,workspaces:0}])
 f.client.workspace.mount=async()=>{f.calls.push(['mount']);throw Object.assign(Error(code),{code})}
 await assert.rejects(f.mount('feature'),new RegExp(code))
 assert.equal(f.calls.filter(c=>c[0]==='mount').length,1)
 assert.equal(f.calls.filter(c=>c[0]==='create').length,0)
})
test('independent branches share sandbox capacity concurrently',async()=>{
 const f=fixture([{sandbox:'1',image,workspaces:14}])
 const results=await Promise.all([f.mount('feature'),f.mount('other')])
 assert.deepEqual(results.map(r=>r.sandbox),['1','1'])
 assert.equal(f.calls.filter(c=>c[0]==='create').length,0)
 assert.deepEqual(f.calls.filter(c=>c[0]==='mount').map(c=>c[2]).sort(),['feature','other'])
})
test('inventory paging uses official items length, not undocumented nextPagePos',async()=>{
 const f=fixture(Array.from({length:101},(_,i)=>({sandbox:String(i+1),image:i===100?image:otherImage,workspaces:0})))
 assert.equal((await f.mount('feature')).sandbox,'101')
 assert.deepEqual(f.calls.filter(c=>c[0]==='inventory').map(c=>c[2]),[0,100])
})
