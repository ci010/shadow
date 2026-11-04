import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { configuration, layerfsName, runBridge } from './bridge.ts'
import { validateLayerArgs, LayerFSTool } from '../../tools/layerfs.ts'
import { ToolOutcomeUnknownError, isCompletedToolFailure, toolResultText } from '../../tools/tool.ts'
import type { ExecutionContext } from '../../tools/context.ts'

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

test('real process bridge dispatches SDK, streams bounded output and preserves dirty refusal', async () => {
 const dir = await mkdtemp(join(process.cwd(), '.layerfs-test-'))
 try {
  const sdkModule = join(dir, 'sdk.mjs')
  await writeFile(sdkModule, `export const LayerFS = { open: async () => ({
   project: { list_branches: async () => ({ env: process.env.LAYERFS_HOME }) },
   workspace: {
    exec: async (ws, command, message, sinks) => { await new Promise((ok, no) => sinks.stdout.write(Buffer.alloc(100000, 65), e => e ? no(e) : ok())); return { code: 0 }; },
    unmount: async (ws, discard, force) => { if (discard || force) throw Error('unsafe'); throw Object.assign(Error('Dirty'), {code:'Dirty'}); }
   }, close: async () => {}
  }) }`)
  const config = { sdkModule, env: { LAYERFS_HOME: dir } }
  const project = layerfsName('one')
  const workspace = Buffer.from(JSON.stringify({ project, sandbox: '1', path: '/workspaces/1' })).toString('base64url')
  const receipt = JSON.parse(await runBridge(config, project, 'exec', { workspace, command: 'test' }, new AbortController().signal))
  assert.equal(receipt.result.stdout.text.length, 65536)
  assert.equal(receipt.result.stdout.bytes, 100000)
  assert.equal(receipt.result.stdout.truncated, true)
  const dirty = JSON.parse(await runBridge(config, project, 'close', { workspace }, new AbortController().signal))
  assert.equal(dirty.error.code, 'Dirty')
  const env = JSON.parse(await runBridge(config, project, 'branches', {}, new AbortController().signal))
  assert.equal(env.result.env, dir)
  assert.equal(process.env.LAYERFS_HOME, undefined)
  await writeFile(sdkModule, `export const LayerFS = { open: async () => { await new Promise(r=>setTimeout(r,10000)); } }`)
  const controller = new AbortController()
  const promise = runBridge(config, project, 'list', {}, controller.signal)
  setTimeout(() => controller.abort(), 50)
  await assert.rejects(promise, ToolOutcomeUnknownError)
  await writeFile(sdkModule, 'process.exit(2)')
  await assert.rejects(runBridge(config, project, 'list', {}, new AbortController().signal), ToolOutcomeUnknownError)
 } finally { await rm(dir, { recursive: true, force: true }) }
})

test('different workspaces run concurrently; same workspace is refused while busy', async () => {
 const dir = await mkdtemp(join(process.cwd(), '.layerfs-test-'))
 const prior = process.env.SHADOW_LAYERFS_CONFIG
 try {
  const sdkModule = join(dir, 'sdk.mjs'), configPath = join(dir, 'config.json')
  await writeFile(sdkModule, `export const LayerFS = { open: async () => ({ workspace: { exec: async () => { await new Promise(r=>setTimeout(r,150)); return {code:0}; } }, close: async () => {} }) }`)
  await writeFile(configPath, JSON.stringify({ projects: { one: { sdkModule, env: { LAYERFS_HOME: dir, LAYERFS_STORE_PATH: join(dir, 'store'), LAYERFS_WORKER_ENDPOINT: join(dir, 'worker') } } } }))
  process.env.SHADOW_LAYERFS_CONFIG = configPath
  const project = layerfsName('one')
  const id = (path: string) => Buffer.from(JSON.stringify({ project, sandbox: '1', path })).toString('base64url')
  const a = {action:'exec', workspace:id('/workspaces/1'), command:'test'}
  const b = {action:'exec', workspace:id('/workspaces/2'), command:'test'}
  const context = { projectId:'one', signal:new AbortController().signal } as ExecutionContext
  const tool = new LayerFSTool('one')
  const first = tool.execute(a, context)
  await assert.rejects(tool.execute(a, context), /already in flight/)
  const second = tool.execute(b, context)
  for (const result of await Promise.all([first, second])) assert.equal(JSON.parse(toolResultText(result)).ok, true)
  let operation = ''
  await assert.rejects(tool.execute({action:'create',workspace:'registered'}, { ...context, resolveToolTarget: async (_, op) => { operation = op; throw Error('grant denied') } }), /grant denied/)
  assert.equal(operation, 'filesystem.read')
 } finally {
  if (prior === undefined) delete process.env.SHADOW_LAYERFS_CONFIG; else process.env.SHADOW_LAYERFS_CONFIG = prior
  await rm(dir, {recursive:true,force:true})
 }
})

test('sandbox read/write use quoted literal content and do not overwrite source', async () => {
 const dir = await mkdtemp(join(process.cwd(), '.layerfs-test-'))
 try {
  const sdkModule = join(dir, 'sdk.mjs')
  await writeFile(sdkModule, `import {execSync} from 'node:child_process';
   export const LayerFS = {open: async()=>({workspace:{exec:async(ws,command,message,sinks)=>{
    const output=execSync(command,{cwd: ${JSON.stringify(dir)}}); await new Promise((ok,no)=>sinks.stdout.write(output,e=>e?no(e):ok())); return {code:0};
   }},close:async()=>{}})}`)
  const project = layerfsName('one'), workspace = Buffer.from(JSON.stringify({project,sandbox:'1',path:'/workspaces/1'})).toString('base64url')
  const config = {sdkModule, env:{LAYERFS_HOME:dir}}, signal = new AbortController().signal
  const content = "literal ' quote $HOME ; $(false)\nsecond line\n"
  const written = JSON.parse(await runBridge(config,project,'write',{workspace,path:"a'b.txt",content},signal))
  assert.equal(written.ok,true)
  const read = JSON.parse(await runBridge(config,project,'read',{workspace,path:"a'b.txt",start:1,end:20},signal))
  assert.equal(read.result.stdout.text,content)
 } finally { await rm(dir,{recursive:true,force:true}) }
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
  await writeFile(sdkModule, `export const LayerFS = {
   init: async(project,source,timeout)=>({created:{kind:'Initialized',project,source,timeout},close:async()=>{}}),
   open: async()=>({workspace:{unmount:async()=>{throw Object.assign(Error('Dirty workspace'),{code:'Dirty'});}},branch:{fork:async()=>{throw Object.assign(Error('Bad branch'),{code:'InvalidInput'});}},project:{list_branches:async()=>{throw Object.assign(Error('Lost reply'),{code:'Unknown'});}},close:async()=>{}})
  }`)
  await writeFile(configPath,JSON.stringify({projects:{one:{sdkModule,env:{LAYERFS_HOME:dir,LAYERFS_STORE_PATH:join(dir,'store'),LAYERFS_WORKER_ENDPOINT:join(dir,'worker')}}}}))
  process.env.SHADOW_LAYERFS_CONFIG = configPath
  let selected = ''
  const context = {projectId:'one',signal:new AbortController().signal,resolveToolTarget:async(selector:string,operation:string)=>{
   selected = selector; assert.equal(operation,'filesystem.read'); return {cwd:dir,fileChangeTarget:{nodeId:'main',workdirId:'registered'}};
  }} as ExecutionContext
  const tool = new LayerFSTool('one')
  const created = await tool.execute({action:'create',workspace:'shadow-991eee02'},context)
  assert.equal(selected,'shadow-991eee02')
  assert.equal(isCompletedToolFailure(created),false)
  const receipt = JSON.parse(toolResultText(created))
  assert.equal(receipt.ok,true)
  assert.equal(receipt.result.kind,'Initialized')
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
