import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { LayerFSTool } from '../../tools/layerfs.ts'
import { branchWorkspace } from './workspace-identity.ts'
import { layerfsName } from './bridge.ts'
import { isCompletedToolFailure, toolResultText, ToolOutcomeUnknownError } from '../../tools/tool.ts'
import { committedFixture as fixture } from './committed-test-fixture.ts'

test('official fs APIs, paged complete text, checkpoint receipts and unsupported parity refusals', async () => {
 const f=await fixture();try {
  assert.equal(await f.route('read',{path:'AGENTS.md'}),'first\nsecond\n')
  assert.equal((await f.calls()).filter(c=>c[0]==='read').length,3)
  assert.equal(JSON.parse(toolResultText((await f.route('write',{path:'a',content:'new'}))!)).result.head,'a'.repeat(64))
  await f.route('write',{path:'a',match:'new',content:'edited'})
  await f.route('search',{handler:'glob',query:'**/*.ts',path:'src',limit:10,offset:4})
  const page=JSON.parse(toolResultText((await f.route('search',{handler:'grep',query:'a.*',limit:10,offset:5}))!))
  assert.equal(page.result.nextPagePos,11);assert.equal(page.result.skipped,2)
  assert.ok((await f.calls()).some(c=>JSON.stringify(c)===JSON.stringify(['grep','feature','a.*','/',10,5])))
  const directory=JSON.parse(toolResultText((await f.route('read',{path:'/',offset:3,limit:10}))!))
  assert.equal(directory.result.directory.nextPagePos,7)
  for(const args of [{flag:'a'},{flag:'g',match:'x'},{encoding:'utf8-bom'}])await assert.rejects(f.route('write',{path:'a',content:'x',...args}),/unsupported|only/)
  await assert.rejects(f.route('read',{path:'x.png'}),/binary/)
  await assert.rejects(f.route('search',{handler:'grep',query:'x',include:'*.ts'}),/no include/)
  await assert.rejects(f.route('read',{path:'../a'}),/traversal/)
  assert.ok(!(await f.calls()).some(c=>c[0]==='exec'))
  await f.mode('clipped');assert.equal(isCompletedToolFailure((await f.route('read',{path:'a'}))!),true)
  await f.mode('changed');assert.equal(isCompletedToolFailure((await f.route('read',{path:'a'}))!),true)
 }finally{await f.close()}
})

test('exec lifecycle mounts latest branch, checkpoints nonzero exit, unmounts without discard',async()=>{
 const f=await fixture();try{
  await f.mode('nonzero')
  const result=(await f.route('exec',{script:'exit 7'}))!
  assert.equal(isCompletedToolFailure(result),true)
  const receipt=JSON.parse(toolResultText(result));assert.equal(receipt.result.exitCode,7);assert.equal(receipt.result.checkpoint.head,'c'.repeat(64))
  const calls=await f.calls()
  assert.deepEqual(calls.filter(c=>['create','mount','exec','commit','unmount','sandbox.close'].includes(c[0])).map(c=>c[0]),['create','mount','exec','commit','unmount','sandbox.close'])
  assert.deepEqual(calls.find(c=>c[0]==='mount'),['mount','1','feature'])
  assert.equal(calls.find(c=>c[0]==='commit').at(-1),false)
  assert.deepEqual(calls.find(c=>c[0]==='unmount').slice(2),[false])
  await assert.rejects(readFile(f.journal),{code:'ENOENT'})
 }finally{await f.close()}
})

test('same-branch exclusion, matching mounts refused, UNKNOWN retains exact lifecycle journal across calls',async()=>{
 const f=await fixture();try{
  await f.mode('mounted')
  assert.equal(isCompletedToolFailure((await f.route('read',{path:'a'}))!),true)
  await f.mode('slow')
  const running=f.route('exec',{script:'anything'})
  await new Promise(resolve=>setTimeout(resolve,200))
  assert.equal(isCompletedToolFailure((await f.route('read',{path:'a'}))!),true)
  await running
  await f.mode('commit-unknown')
  await assert.rejects(f.route('exec',{script:'anything'}),ToolOutcomeUnknownError)
  const evidence=await readFile(f.journal,'utf8')
  assert.match(evidence,/commit-dispatched/);assert.match(evidence,/\/workspaces\/1/)
  const callsBefore=(await f.calls()).length
  assert.equal(isCompletedToolFailure((await f.route('write',{path:'a',content:'no replay'}))!),true)
  assert.equal((await f.calls()).length,callsBefore)
  assert.equal((await f.calls()).filter(c=>c[0]==='unmount').length,1)
 }finally{await f.close()}
})

test('legacy IDs and main writes refused; project isolation remains enforced',async()=>{
 const f=await fixture();try{
  const legacy='layerfs:'+Buffer.from(JSON.stringify({project:layerfsName('one'),sandbox:'1',path:'/workspaces/1'})).toString('base64url')
  await assert.rejects(f.route('read',{workspace:legacy,path:'a'}),/Legacy.*not routable/)
  await assert.rejects(f.route('write',{workspace:branchWorkspace(layerfsName('one'),'main',f.binding),path:'a',content:'x'}),/readonly/)
  await assert.rejects(f.route('read',{workspace:branchWorkspace(layerfsName('two'),'feature',{...f.binding,ownerProject:'two'}),path:'a'}),/current-Project/)
  const tool=new LayerFSTool('one',f.dir)
  await assert.rejects(tool.execute({action:'commit',workspace:f.workspace},f.context),/Unsupported/)
 }finally{await f.close()}
})

for (const mode of ['unknown', 'transport', 'close-fail', 'bad-receipt']) test(`fs mutation ${mode} retains evidence and blocks subsequent calls without SDK replay`, async () => {
 const f=await fixture();try {
  await f.mode(mode)
  await assert.rejects(f.route('write',{path:'a',content:'checkpoint'}),ToolOutcomeUnknownError)
  assert.match(await readFile(f.journal,'utf8'),/fs-mutation-dispatched/)
  const before=(await f.calls()).length
  assert.equal(isCompletedToolFailure((await f.route('read',{path:'a'}))!),true)
  assert.equal((await f.calls()).length,before)
  if(mode==='unknown') {
   const status=JSON.parse(toolResultText(await new LayerFSTool('one',f.dir).execute({action:'status',workspace:f.workspace},f.context)))
   assert.equal(status.result.operation.phases.at(-1).operation,'write')
   assert.equal(status.result.operation.phases.at(-1).path,'/a')
  }
 }finally{await f.close()}
})

for (const stage of ['create','mount','unmount']) test(`cancellation during ${stage} prevents subsequent lifecycle dispatch`,async()=>{
 const f=await fixture();try{
  await f.mode('cancel-'+stage)
  const controller=new AbortController()
  await assert.rejects(new LayerFSTool('one',f.dir).execute({action:'exec',workspace:f.workspace,command:'must not replay'}, {...f.context,signal:controller.signal}, {observe:text=>{if(text===stage)controller.abort()}}),ToolOutcomeUnknownError)
  const calls=await f.calls()
  const forbidden=stage==='create'?'mount':stage==='mount'?'exec':'sandbox.close'
  assert.ok(!calls.some(c=>c[0]===forbidden))
  assert.match(await readFile(f.journal,'utf8'),/sandbox.*1/)
 }finally{await f.close()}
})

test('exec accepts UpToDate and retains mount when checkpoint is not a successful publication',async()=>{
 const f=await fixture();try{
  await f.mode('uptodate')
  const result=JSON.parse(toolResultText((await f.route('exec',{script:'read only'}))!))
  assert.equal(result.result.checkpoint.kind,'UpToDate')
  await f.mode('bad-receipt')
  await assert.rejects(f.route('exec',{script:'uncertain result'}),ToolOutcomeUnknownError)
  assert.equal((await f.calls()).filter(c=>c[0]==='unmount').length,1)
  assert.match(await readFile(f.journal,'utf8'),/commit-dispatched/)
 }finally{await f.close()}
})
