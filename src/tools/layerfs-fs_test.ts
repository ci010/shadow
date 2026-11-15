import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { committedFixture } from '../execution/layerfs/committed-test-fixture.ts'
import { existingLayerFSResources } from '../execution/layerfs/resource-service.ts'
import { createLayerFSFSTools, validateFSInput } from './layerfs-fs.ts'
import { layerFSToolContracts } from './layerfs.ts'
import { branchWorkspace } from '../execution/layerfs/workspace-identity.ts'
import { operationResources } from '../execution/layerfs/coordination.ts'

async function fixture() {
  const f = await committedFixture()
  const file = join(f.dir, 'sdk.mjs')
  const code = await readFile(file, 'utf8')
  const mutation = `async(...a)=>{call(NAME,a);if(state().mode==='unknown')throw Object.assign(Error('lost'),{code:'Unknown'});return {kind:'Committed',branch:a[0],head:'a'.repeat(64),commit:{id:'a'.repeat(64),root:'d'.repeat(64)}}}`
  await writeFile(file, code.replace('fs:{', 'fs:{' + ['mkdir','rm','cp','mv','apply'].map(name => `${name}:${mutation.replace('NAME', JSON.stringify(name))},`).join('') + `blame:async(...a)=>{call('blame',a);return {items:[],nextLine:2}},diff_files:async(...a)=>{call('diff_files',a);return {hunks:[]}},`))
  const service = existingLayerFSResources('one', f.dir)!
  const tools = createLayerFSFSTools(service)
  const run = (action: string, input: Record<string, unknown>, context = f.context) => tools.find(t => t.name === 'layerfs_fs_' + action)!.execute({ workspace: f.workspace, ...input }, context)
  return { ...f, service, tools, run }
}

test('lazy contracts expose official filesystem methods without base schema expansion', () => {
  const names = layerFSToolContracts().map(t => t.name)
  for (const op of ['mkdir','rm','cp','mv','apply','diff_files','blame']) assert.ok(names.includes('layerfs_fs_' + op))
  assert.equal(names.filter(n => n.startsWith('layerfs_fs_')).length, 7)
})

test('registered selectors and selected branch use official positional calls and checkpoint receipts', async () => {
  const f = await fixture()
  try {
    const inputs: Record<string, Record<string, unknown>> = { mkdir: {path:'/dir'}, rm:{path:'/old'}, cp:{from:'/a',to:'/b'}, mv:{from:'/b',to:'/c'}, apply:{changes:[{op:'write',path:'/a',content:'text'},{op:'edit',path:'/a',oldText:'text',newText:'new'},{op:'mkdir',path:'/d'},{op:'rm',path:'/z'},{op:'cp',from:'/a',to:'/b'},{op:'mv',from:'/b',to:'/c'}]}, blame:{path:'/a',fromLine:2}, diff_files:{leftPath:'/a',rightRef:'aa',rightPath:'/b'} }
    for (const [action, input] of Object.entries(inputs)) {
      const output = JSON.parse(String(await f.run(action, input)))
      assert.equal(output.ok, true)
      if (!['blame','diff_files'].includes(action)) assert.equal(output.result.kind, 'Committed')
    }
    const calls = await f.calls()
    assert.deepEqual(calls.find(c => c[0] === 'cp'), ['cp','feature','/a','/b','Shadow cp'])
    assert.deepEqual(calls.find(c => c[0] === 'blame'), ['blame','feature','/a',2])
    assert.deepEqual(calls.find(c => c[0] === 'diff_files'), ['diff_files','feature','/a','aa','/b'])
    assert.deepEqual(calls.find(c => c[0] === 'apply')?.slice(1), ['feature', inputs.apply!.changes, 'Shadow apply'])
    assert.ok(!calls.some(c => ['create','mount','exec'].includes(c[0])))
    let resolved = 0
    await f.run('mkdir', {workspace:'registered-selector',path:'/d'}, { ...f.context, resolveToolTarget: async (id, operation) => { assert.equal(id,'registered-selector'); assert.equal(operation,'filesystem.write'); resolved++; return {layerfsWorkdir:{workspace:f.workspace}} } } as typeof f.context)
    assert.equal(resolved,1)
    await f.tools.find(t=>t.name==='layerfs_fs_mkdir')!.execute({path:'/d'}, {...f.context, layerfsWorkdir:{workspace:f.workspace}})
  } finally { await f.close() }
})

test('filesystem validation, cross-project/unregistered/main/recovery authority refuse before SDK dispatch', async () => {
  const f = await fixture()
  try {
    const before = (await f.calls()).length
    for (const input of [{path:'/../x'},{path:'relative'},{path:'/a',action:'publish'}]) await assert.rejects(f.run('rm',input))
    for (const changes of [[],[{op:'publish'}],[{op:'write',path:'/a',bytes:[1]}],[{op:'edit',path:'/a',oldText:'x'}],[{op:'cp',from:'/a',to:'/../b'}]]) assert.throws(()=>validateFSInput('apply',{changes}))
    await assert.rejects(f.run('mkdir',{path:'/a'}, {...f.context,projectId:'other'}))
    await assert.rejects(f.run('mkdir',{path:'/a'}, {...f.context,recoveringToolCall:true}))
    await assert.rejects(f.run('mkdir',{path:'/a',workspace:branchWorkspace('unknown','feature',f.binding)}),/Unregistered/)
    const main = branchWorkspace('main-project','main',f.binding);f.service.catalog.bindWorkspace(main)
    await assert.rejects(f.run('mkdir',{path:'/a',workspace:main}),/readonly/)
    await assert.rejects(f.service.execute('mkdir',{workspace:f.workspace,path:'/../x'},f.context))
    assert.equal((await f.calls()).length,before)
    assert.deepEqual(operationResources('apply',{workspace:f.workspace}),['feature'])
    assert.deepEqual(operationResources('diff_files',{workspace:f.workspace,rightRef:'other'}),['feature','other'])
  } finally { await f.close() }
})

test('unknown FS mutation retains original journal and cannot be replayed', async () => {
  const f = await fixture()
  try {
    await f.mode('unknown')
    await assert.rejects(f.run('mkdir',{path:'/a'}),/unknown/i)
    const evidence = await readFile(f.journal,'utf8')
    const blocked = await f.run('rm',{path:'/a'})
    assert.match(JSON.stringify(blocked),/unknown|unresolved|reserved|busy|admitted/i)
    assert.notEqual(typeof blocked, 'string')
    assert.equal(await readFile(f.journal,'utf8'),evidence)
    assert.equal((await f.calls()).filter(c=>c[0]==='mkdir').length,1)
    assert.equal((await f.calls()).filter(c=>c[0]==='rm').length,0)
  } finally { await f.close() }
})
