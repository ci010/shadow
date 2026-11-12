import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join, dirname } from 'node:path'
import { configuration, layerfsName, runBridge as rawBridge } from './bridge.ts'
import { validateLayerArgs, LayerFSTool } from '../../tools/layerfs.ts'
import { ToolOutcomeUnknownError, isCompletedToolFailure, toolResultText } from '../../tools/tool.ts'
import type { ExecutionContext } from '../../tools/context.ts'

const runBridge: typeof rawBridge = (config, project, action, args, signal, timeout, lifecycle) => rawBridge(config, project, action, { journal: join(dirname(config.sdkModule), 'operation.jsonl'), ...args }, signal, timeout, lifecycle)

test('workspace IDs are Project-bound, source selectors are not host paths, reads bounded', () => {
 const project = layerfsName('one')
 const workspace = Buffer.from(JSON.stringify({ project, sandbox: '1', path: '/workspaces/1' })).toString('base64url')
 validateLayerArgs({ action: 'commit', workspace }, project)
 assert.throws(() => validateLayerArgs({ action: 'commit', workspace }, layerfsName('two')))
 assert.throws(() => validateLayerArgs({ action: 'read', workspace, path: '../escape' }, project))
 assert.throws(() => validateLayerArgs({ action: 'read', workspace, path: '/x', start: 1, end: 1001 }, project))
 assert.throws(() => validateLayerArgs({ action: 'load', branch: 'restore' }, project))
 validateLayerArgs({ action: 'create', workspace: 'registered-id' }, project)
})

test('tool refuses foreign Project and remote contexts before configuration', async () => {
 const tool = new LayerFSTool('one')
 await assert.rejects(tool.execute({ action: 'list' }, { projectId: 'two' } as ExecutionContext), /mismatch/)
 await assert.rejects(tool.execute({ action: 'list' }, { projectId: 'one', remoteWorkdir: {} } as ExecutionContext), /no Main fallback/)
})

test('host configuration is opt-in, allowlisted and refuses shared Project stores', async () => {
 const dir = await mkdtemp(join(process.cwd(), '.layerfs-test-'))
 const prior = process.env.SHADOW_LAYERFS_CONFIG
 try {
  delete process.env.SHADOW_LAYERFS_CONFIG
  await assert.rejects(configuration('one'), /disabled/)
  const path = join(dir,'config.json')
  process.env.SHADOW_LAYERFS_CONFIG = path
  const env = {LAYERFS_HOME:dir,LAYERFS_STORE_PATH:join(dir,'store'),LAYERFS_WORKER_ENDPOINT:join(dir,'worker')}
  await writeFile(path, JSON.stringify({projects:{one:{sdkModule:join(dir,'sdk.mjs'),env:{...env,NODE_OPTIONS:'bad'}}}}))
  await assert.rejects(configuration('one'), /Invalid LayerFS environment/)
  await writeFile(path, JSON.stringify({projects:{one:{sdkModule:join(dir,'sdk.mjs'),env},two:{sdkModule:join(dir,'sdk.mjs'),env}}}))
  await assert.rejects(configuration('one'), /must not share/)
 } finally {
  if (prior === undefined) delete process.env.SHADOW_LAYERFS_CONFIG; else process.env.SHADOW_LAYERFS_CONFIG = prior
  await rm(dir,{recursive:true,force:true})
 }
})

test('create accepts a registered source selector and SDK refusals are completed tool failures', async () => {
 const dir = await mkdtemp(join(process.cwd(), '.layerfs-test-'))
 const prior = process.env.SHADOW_LAYERFS_CONFIG
 try {
  const sdkModule = join(dir,'sdk.mjs'), configPath = join(dir,'config.json')
  await writeFile(sdkModule, `export const isRefusal=e=>['Dirty','InvalidInput','Failed'].includes(e?.code); export const LayerFS = {
   init: async(project,source,timeout)=>({created:{kind:'Initialized',project,source,timeout},close:async()=>{}}),
   open: async()=>({workspace:{unmount:async()=>{throw Object.assign(Error('Dirty workspace'),{code:'Dirty'});}},branch:{fork:async()=>{throw Object.assign(Error('Bad branch'),{code:'InvalidInput'});}},project:{list_sandboxes:async()=>({items:[],hasMore:false}),list_branches:async()=>{throw Object.assign(Error('Lost reply'),{code:'Unknown'});}},close:async()=>{}})
  }`)
  await writeFile(configPath,JSON.stringify({projects:{one:{sdkModule,env:{LAYERFS_HOME:dir,LAYERFS_STORE_PATH:join(dir,'store'),LAYERFS_WORKER_ENDPOINT:join(dir,'worker')}}}}))
  process.env.SHADOW_LAYERFS_CONFIG = configPath
  let selected = ''
  const context = {projectId:'one',sessionId:'web:bridge',signal:new AbortController().signal,resolveToolTarget:async(selector:string,operation:string)=>{
   selected = selector; assert.equal(operation,'filesystem.read'); return {cwd:dir,fileChangeTarget:{nodeId:'main',workdirId:'registered'}};
  }} as ExecutionContext
  const tool = new LayerFSTool('one')
  const preview = JSON.parse(toolResultText(await tool.execute({action:'import_preview',workspace:'shadow-991eee02'},context))).result
  const created = await tool.execute({action:'create',workspace:'shadow-991eee02',sourceReview:preview.reviewToken,sourceReviewed:true},context)
  assert.equal(selected,'shadow-991eee02')
  assert.equal(isCompletedToolFailure(created),false)
  const receipt = JSON.parse(toolResultText(created))
  assert.equal(receipt.ok,true)
  assert.equal(receipt.result.kind,'Initialized')
  assert.equal(receipt.result.timeout,300000, 'Shared default reaches the SDK unchanged')
  assert.equal(receipt.result.source,dir)
  assert.equal(receipt.result.project,layerfsName('one'))
  const workspace = Buffer.from(JSON.stringify({project:layerfsName('one'),sandbox:'1',path:'/workspaces/1'})).toString('base64url')
  for (const [args,code] of [[{action:'close',workspace},'Dirty'],[{action:'fork',branch:'bad'},'InvalidInput']] as const) {
   const failure = await tool.execute(args,context)
   assert.equal(typeof failure,'object')
   assert.equal(isCompletedToolFailure(failure),true)
   assert.equal(typeof failure !== 'string' && failure.isError,true)
   assert.equal(JSON.parse(toolResultText(failure)).error.code,code)
  }
  await assert.rejects(tool.execute({action:'branches'},context),ToolOutcomeUnknownError)
 } finally {
  if (prior === undefined) delete process.env.SHADOW_LAYERFS_CONFIG; else process.env.SHADOW_LAYERFS_CONFIG = prior
  await rm(dir,{recursive:true,force:true})
 }
})


for (const fails of [false, true]) test(`operator import uses the SDK budget and heartbeat liveness, not a competing wall-clock timeout; fails=${fails}`, async () => {
 const dir = await mkdtemp(join(process.cwd(), '.layerfs-timeout-test-'))
 try {
  const sdkModule = join(dir, 'sdk.mjs')
  await writeFile(sdkModule, `export const isRefusal=e=>['Dirty','InvalidInput','Failed'].includes(e?.code); export const LayerFS = { init: async (_project,_source,timeout) => {
   if(timeout!==1000) throw Error('Wrong native import budget');
   await new Promise(resolve=>setTimeout(resolve,1700));
   ${fails ? "throw Object.assign(Error('Project(Deadline)'),{code:'Failed'});" : "return {created:{kind:'Initialized',timeout},close:async()=>{}};"}
  } }`)
  // 1250ms is only the silence watchdog. The 1s helper heartbeat must keep
  // observation alive until the SDK's own result, even beyond its nominal budget.
  const receipt = JSON.parse(await runBridge({sdkModule,env:{}}, 'fixture', 'create', {source:dir,importTimeoutMs:1000}, new AbortController().signal, 1250))
  assert.equal(receipt.ok, !fails)
  if (fails) { assert.equal(receipt.error.code, 'Failed'); assert.equal(receipt.error.message, 'Project(Deadline)') }
  else assert.equal(receipt.result.timeout, 1000)
 } finally { await rm(dir,{recursive:true,force:true}) }
})

test('silent or cancelled operator imports remain unknown; no automatic retry', async () => {
 const dir = await mkdtemp(join(process.cwd(), '.layerfs-timeout-test-'))
 try {
  const sdkModule = join(dir, 'sdk.mjs')
  // Blocking the fixture event loop prevents heartbeats. It is not a native import.
  await writeFile(sdkModule, `export const LayerFS={init:async()=>{const until=Date.now()+2000;while(Date.now()<until){};return {created:{kind:'Initialized'},close:async()=>{}}}}`)
  await assert.rejects(runBridge({sdkModule,env:{}}, 'fixture', 'create', {source:dir}, new AbortController().signal, 250), (error: unknown) => error instanceof ToolOutcomeUnknownError && /heartbeat lost/.test(error.message))
  await writeFile(sdkModule, `export const LayerFS={init:async()=>{await new Promise(resolve=>setTimeout(resolve,2000));return {created:{kind:'Initialized'},close:async()=>{}}}}`)
  const controller = new AbortController()
  const blocked = JSON.parse(await runBridge({sdkModule,env:{}}, 'fixture', 'create', {source:dir}, controller.signal))
  assert.equal(blocked.error.code, 'Busy', 'Retained journal prevents a new process from replaying the unknown import')
  const request = runBridge({sdkModule,env:{}}, 'other-fixture', 'create', {source:dir,journal:join(dir,'other-operation.jsonl')}, controller.signal)
  const timer = setTimeout(()=>controller.abort(),250)
  try { await assert.rejects(request, (error: unknown) => error instanceof ToolOutcomeUnknownError && /cancelled/.test(error.message)) }
  finally { clearTimeout(timer) }
 } finally { await rm(dir,{recursive:true,force:true}) }
})
