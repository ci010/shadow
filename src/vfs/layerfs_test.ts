import test from 'node:test'
import assert from 'node:assert/strict'
import { readFile, writeFile, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { createLayerFSHandler } from './layerfs.ts'
import { VirtualFs } from './virtual-fs.ts'
import type { FolderRecord } from '../folders/contracts.ts'
import { committedFixture } from '../execution/layerfs/committed-test-fixture.ts'
import { existingLayerFSResources } from '../execution/layerfs/resource-service.ts'
import type { ExecutionContext } from '../tools/context.ts'

const context = {projectId:'one',signal:new AbortController().signal} as ExecutionContext
const folder = (id: string, mount='unused') => ({id,kind:'layerfs',projectId:'one',name:id,mount}) as FolderRecord

test('VFS discovery is bounded and does not initialize service, load tools, or activate worker', async () => {
  let lookups=0
  const handler=createLayerFSHandler({projectId:'one',folders:()=>Array.from({length:105},(_,i)=>folder(String(i))),existing:()=>{lookups++;return undefined}})
  const vfs=new VirtualFs();vfs.mount('v:layerfs','inspection',handler.read,handler.list)
  assert.match(String(await vfs.resolve('v:layerfs',context)),/immutable/)
  const first=JSON.parse(String(await vfs.resolve('v:layerfs/workspaces/0',context)))
  assert.equal(first.items.length,100);assert.equal(first.hasMore,true);assert.equal(first.nextPagePos,100)
  const second=JSON.parse(String(await handler.read('workspaces/100',context)))
  assert.equal(second.items.length,5);assert.equal(second.hasMore,false)
  assert.equal(lookups,0)
  await assert.rejects(async()=>handler.read('0/history/0',context),/did not initialize/)
  assert.equal(lookups,1)
  assert.throws(()=>vfs.write('v:layerfs/0/publish',{content:'x'},context),/read.only|not writable/i)
  for(const path of ['0/publish/0','0/merge/0','0/diff/main/feature/0','0/history/-1','0/history/0/extra','workspaces/../0']) await assert.rejects(async()=>handler.read(path,context))
  assert.equal(lookups,1)
  await assert.rejects(async()=>handler.read('overview',{...context,projectId:'other'}))
})

test('VFS history/branch/immutable diff pages use only official read calls without journal or catalog writes', async()=>{
  const f=await committedFixture()
  try {
    const sdk=join(f.dir,'sdk.mjs')
    const code=await readFile(sdk,'utf8')
    await writeFile(sdk,code.replace('project:{','branch:{list_commits:async(...a)=>{call("history",a);return {items:[{id:"aa"}],hasMore:true}},diff_commits:async(...a)=>{call("diff_commits",a);return {items:[{path:"/a"}],hasMore:true,nextCursor:"/a"}}},project:{list_branches:async(...a)=>{call("branches",a);return {items:[],hasMore:false}},'))
    const service=existingLayerFSResources('one',f.dir)!
    const handler=createLayerFSHandler({projectId:'one',folders:()=>[folder('registered',f.workspace)],existing:()=>service})
    const catalog=join(f.dir,'layerfs-catalog','resources.sqlite')
    const before=await readFile(catalog),mtime=(await stat(catalog)).mtimeMs
    for(const path of ['registered/history/7','registered/branches/2','registered/diff/aa/bb/3']) assert.equal(JSON.parse(String(await handler.read(path,f.context))).ok,true)
    const calls=await f.calls()
    assert.deepEqual(calls.find(c=>c[0]==='history'),['history','feature',100,7])
    assert.deepEqual(calls.find(c=>c[0]==='branches'),['branches',100,2])
    assert.deepEqual(calls.find(c=>c[0]==='diff_commits'),['diff_commits','aa','bb',100,3,{hunks:false}])
    assert.ok(!calls.some(c=>['inventory','create','mount','exec','write','commit'].includes(c[0])))
    assert.deepEqual(await readFile(catalog),before);assert.equal((await stat(catalog)).mtimeMs,mtime)
    await assert.rejects(readdir(join(f.dir,'layerfs-catalog','operations')), {code:'ENOENT'})
    await assert.rejects(service.observe('publish',{workspace:f.workspace},f.context),/read.only/)
    await assert.rejects(service.observe('diff_commits',{workspace:f.workspace,ref:'main',branch:'feature'},f.context),/Immutable/)
  } finally {await f.close()}
})
