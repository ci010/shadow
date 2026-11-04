import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { ReadTool } from './read.ts'
import { WriteTool } from './filesystem.ts'
import { ExecTool } from './shell.ts'
import { CommandHandlerManager } from './shell-commands/command-handler.ts'
import type { ProcessManager } from '../execution/processes/manager.ts'
import type { BackgroundTaskManager } from '../agent/background-task.ts'
import { join } from 'node:path'
import { layerfsRoute } from './layerfs-route.ts'
import { layerfsName } from '../execution/layerfs/bridge.ts'
import { toolResultText, ToolOutcomeUnknownError, isCompletedToolFailure } from './tool.ts'
import type { ExecutionContext } from './context.ts'

test('ordinary tool execute entrypoints: Project isolation, bounded text/overwrite provenance, subdirectory shell and timeout', async () => {
 const dir = await mkdtemp(join(process.cwd(), '.layer-route-'))
 const prior = process.env.SHADOW_LAYERFS_CONFIG
 try {
  const sdkModule = join(dir, 'sdk.mjs'), config = join(dir, 'config.json')
  await mkdir(join(dir, 'sub'))
  await writeFile(sdkModule, `import {exec} from 'node:child_process';
   export const LayerFS={open:async()=>({workspace:{exec:async(ws,command,message,sinks)=>new Promise(resolve=>{
    const child=exec(command,{cwd:${JSON.stringify(dir)}},(error)=>resolve({exitCode:error?.code??0}));
    child.stdout.pipe(sinks.stdout); child.stderr.pipe(sinks.stderr);
   })},close:async()=>{}})};`)
  await writeFile(config, JSON.stringify({projects:{one:{sdkModule,env:{LAYERFS_HOME:dir,LAYERFS_STORE_PATH:join(dir,'store'),LAYERFS_WORKER_ENDPOINT:'fake-worker'}}}}))
  process.env.SHADOW_LAYERFS_CONFIG = config
  const workspace = 'layerfs:' + Buffer.from(JSON.stringify({project:layerfsName('one'),sandbox:'1',path:'/workspaces/1'})).toString('base64url')
  const changes: any[] = []
  const context = {projectId:'one',sessionId:'session',toolCallId:'call',signal:new AbortController().signal,recordFileChange:async(c:any)=>{changes.push(c)},resolveToolTarget:async()=>{throw Error('must not resolve registered')}} as unknown as ExecutionContext
  const tools = {
   read: new ReadTool(dir), write: new WriteTool(dir),
   exec: new ExecTool(dir,120000,new CommandHandlerManager(),{} as ProcessManager,'sh',{} as BackgroundTaskManager),
  }
  const route = (kind:'read'|'write'|'exec',args:Record<string,unknown>)=>tools[kind].execute({workspace,...args},context)
  const written = toolResultText((await route('write',{path:'sub/text',content:"literal ' $HOME\nsecond\n"}))!)
  assert.match(written,/edit=/)
  assert.equal(changes.length,1)
  assert.match(written,new RegExp('edit='+changes[0].id))
  assert.equal(changes[0].writtenContent,"literal ' $HOME\nsecond\n")
  assert.equal(changes[0].target,undefined)
  assert.equal(changes[0].path,workspace+'/sub/text')
  const read = JSON.parse(toolResultText((await route('read',{path:'sub/text',offset:2,limit:1}))!))
  assert.equal(read.result.stdout.text,'second\n')
  const exec = JSON.parse(toolResultText((await route('exec',{script:'cat text',cwd:'sub',shell:'sh',timeout_ms:2000}))!))
  assert.equal(exec.result.exitCode,0)
  assert.equal(exec.result.stdout.text,"literal ' $HOME\nsecond\n")
  for (const [kind,args] of [['write',{path:'sub/text',content:'bad',flag:'a'}],['write',{path:'sub/text',content:'bad',match:'second'}],['read',{path:'x.png'}],['read',{path:'sub/text',encoding:'shift_jis'}],['exec',{script:'pwd',shell:'node'}],['exec',{script:'pwd',timeout_ms:0}],['exec',{script:'pwd',cwd:'/workspaces/1'}]] as const) await assert.rejects(route(kind,args),/No operation/)
  await assert.rejects(route('read',{path:'text',workspace:'layerfs:bad'}),/Invalid LayerFS/)
  await assert.rejects(tools.read.execute({workspace,path:'text'},{...context,projectId:'two'}),/another Project/)
  assert.equal(await layerfsRoute('read',{workspace:'registered',path:'x'},context),undefined)
  assert.equal(isCompletedToolFailure((await route('read',{path:'sub'}))!),true)
  const failed = await route('exec',{script:'exit 7'})
  assert.equal(isCompletedToolFailure(failed),true)
  assert.equal(JSON.parse(toolResultText(failed)).result.exitCode,7)
  await writeFile(join(dir,'invalid.txt'),Buffer.from([0x61,0xff,0x0a]))
  assert.equal(isCompletedToolFailure(await route('read',{path:'invalid.txt'})),true)
  for (const kind of ['read','write','exec'] as const) {
   await assert.rejects(route(kind,{folder:'registered',path:'sub/text',content:'bad',script:'true'}),/not both/)
   await assert.rejects(route(kind,{workspace:'layerfs:bad',path:'sub/text',content:'bad',script:'true'}),/Invalid LayerFS/)
  }
  assert.equal(await readFile(join(dir,'sub/text'),'utf8'),"literal ' $HOME\nsecond\n")
  const resolved: string[] = []
  const registeredContext = {...context,resolveToolTarget:async(selector:string,operation:string)=>{
   resolved.push(selector+':'+operation); throw Error('registered resolver refusal; no local access')
  }}
  for (const kind of ['read','write','exec'] as const) await assert.rejects(tools[kind].execute({workspace:'registered',path:'sub/text',content:'bad',script:'true'},registeredContext),/registered resolver refusal/)
  assert.deepEqual(resolved,['registered:filesystem.read','registered:filesystem.write','registered:workdir.process.execute-once'])
  await assert.rejects(route('exec',{script:'sleep 0.3',timeout_ms:50}),ToolOutcomeUnknownError)
 } finally {
  if(prior===undefined) delete process.env.SHADOW_LAYERFS_CONFIG; else process.env.SHADOW_LAYERFS_CONFIG=prior
  await rm(dir,{recursive:true,force:true})
 }
})
