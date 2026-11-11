import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm, mkdir, chmod } from 'node:fs/promises'
import { readFile } from 'node:fs/promises'
import { ReadTool } from './read.ts'
import { SearchTool } from './search.ts'
import { WriteTool } from './filesystem.ts'
import { SessionTools, Tools } from './registry.ts'
import { ExecTool } from './shell.ts'
import { CommandHandlerManager } from './shell-commands/command-handler.ts'
import type { ProcessManager } from '../execution/processes/manager.ts'
import { Bus } from '../bus/bus.ts'
import { EventService } from '../events/service.ts'
import { createProjectScope } from '../projects/scope.ts'
import { BackgroundTaskManager } from '../agent/background-task.ts'
import { join } from 'node:path'
import { layerfsRoute } from './layerfs-route.ts'
import { layerfsName } from '../execution/layerfs/bridge.ts'
import { toolResultText, ToolOutcomeUnknownError, isCompletedToolFailure } from './tool.ts'
import type { ExecutionContext } from './context.ts'
import { resolveExecShell } from '../execution/processes/shells.ts'

test('ordinary tool execute entrypoints: Project isolation, bounded text/overwrite provenance, subdirectory shell and timeout', async t => {
 if (process.platform === 'win32') { t.skip('POSIX setsid fixture requires Python /usr/bin/python3'); return }
 const shell = await resolveExecShell('sh')
 if (!shell) { t.skip('POSIX shell required for the local SDK fixture'); return }
 const dir = await mkdtemp(join(process.cwd(), '.layer-route-'))
 const prior = process.env.SHADOW_LAYERFS_CONFIG
 try {
  const sdkModule = join(dir, 'sdk.mjs'), config = join(dir, 'config.json')
  await mkdir(join(dir, 'sub'))
  // POSIX session fixture; production requires the Linux setsid utility.
  const setsid = join(dir, 'setsid')
  await writeFile(setsid, '#!/usr/bin/python3\nimport os,sys\nos.setsid()\nargs=sys.argv[1:]\nif args[0]=="-w": args=args[1:]\nos.execvp(args[0],args)\n')
  await chmod(setsid, 0o755)
  // This SDK fixture executes only the generated command, not host login profiles.
  // Timeout windows below transfer this same command to the background.
  await writeFile(sdkModule, `import {execFile} from 'node:child_process';
   import {appendFileSync} from 'node:fs'; appendFileSync(${JSON.stringify(join(dir,'sdk-dispatched'))},'import\\n');
   export const LayerFS={open:async()=>({workspace:{exec:async(ws,command,message,sinks)=>new Promise(resolve=>{
    const child=execFile(${JSON.stringify(shell.command)},['-c','PATH=' + ${JSON.stringify(dir)} + ':$PATH; ' + command],{cwd:${JSON.stringify(dir)},encoding:'buffer'},(error)=>resolve({exitCode:error?.code??0}));
    child.stdout.pipe(sinks.stdout); child.stderr.pipe(sinks.stderr);
   })},close:async()=>{}})};`)
  await writeFile(config, JSON.stringify({projects:{one:{sdkModule,env:{LAYERFS_HOME:dir,LAYERFS_STORE_PATH:join(dir,'store'),LAYERFS_WORKER_ENDPOINT:'fake-worker'}}}}))
  process.env.SHADOW_LAYERFS_CONFIG = config
  const workspace = 'layerfs:' + Buffer.from(JSON.stringify({project:layerfsName('one'),sandbox:'1',path:'/workspaces/1'})).toString('base64url')
  const changes: any[] = []
  const context = {projectId:'one',sessionId:'session',toolCallId:'call',signal:new AbortController().signal,recordFileChange:async(c:any)=>{changes.push(c)},resolveToolTarget:async()=>{throw Error('must not resolve registered')}} as unknown as ExecutionContext
  const jobs: {options:any,promise:Promise<string>}[] = []
  const background = {runPromiseTask(options:any,promise:Promise<string>){ jobs.push({options,promise}); void promise.catch(()=>{}); return String(jobs.length) }} as unknown as BackgroundTaskManager
  const nodeOnly = new ExecTool(dir,120000,new CommandHandlerManager(),{} as ProcessManager,'sh',background,undefined,true)
  // Target resolution must not permit registered/default LayerFS to bypass node-only policy.
  // These contexts would throw if configuration/SDK dispatch were reached.
  for (const [args,ctx] of [
    [{script:'touch node-only-dispatched'}, {...context,layerfsWorkdir:{workspace}}],
    [{workspace:'registered-layer',script:'touch node-only-dispatched'}, {...context,resolveToolTarget:async()=>({layerfsWorkdir:{workspace}})}],
  ] as const) await assert.rejects(nodeOnly.execute(args,ctx as ExecutionContext),/node-only exec/)
  await assert.rejects(readFile(join(dir,'node-only-dispatched')), {code:'ENOENT'})
  await assert.rejects(readFile(join(dir,'sdk-dispatched')), {code:'ENOENT'})
  assert.equal(jobs.length,0)
  const tools = {
   read: new ReadTool(dir), write: new WriteTool(dir),
   exec: new ExecTool(dir,120000,new CommandHandlerManager(),{} as ProcessManager,'sh',background),
  }
  const route = (kind:'read'|'write'|'exec',args:Record<string,unknown>)=>tools[kind].execute({workspace,...args},context)
  const written = toolResultText((await route('write',{path:'sub/text',content:"literal ' $HOME\nsecond\n"}))!)
  assert.match(written,/edit=/)
  assert.equal(changes.length,1)
  assert.match(written,new RegExp('edit='+changes[0].id))
  assert.equal(changes[0].patch.includes("literal ' $HOME"),true)
  assert.equal(changes[0].target,undefined)
  assert.equal(changes[0].path,workspace+'/sub/text')
  const read = toolResultText((await route('read',{path:'sub/text',offset:2,limit:1}))!)
  assert.match(read,/^second/)
  assert.match(toolResultText((await route('read',{path:'sub',flag:'n'}))!),/text/)
  assert.match(toolResultText((await route('read',{path:'sub/text',encoding:'utf-8',flag:'n'}))!),/1\t/)
  const exec = JSON.parse(toolResultText((await route('exec',{script:'cat text',cwd:'sub',shell:'sh',timeout_ms:2000}))!))
  assert.equal(exec.result.exitCode,0)
  assert.equal(exec.result.stdout.text,"literal ' $HOME\nsecond\n")
  await route('write',{path:'sub/text',match:'second',content:'changed'})
  await route('write',{path:'sub/text',content:'appended\n',flag:'a'})
  assert.match(await readFile(join(dir,'sub/text'),'utf8'),/changed\nappended/)
  await route('write',{path:'sub/text',content:"literal ' $HOME\nsecond\n"})
  for (const [kind,args] of [['write',{path:'sub/text',content:'bad',match:'missing'}],['exec',{script:'pwd',shell:'node'}],['exec',{script:'pwd',cwd:'/host/not-the-mount'}]] as const) await assert.rejects(route(kind,args),/No operation/)
  await assert.rejects(route('read',{path:'x.png'}),/not found/)
  await assert.rejects(route('read',{path:'text',workspace:'layerfs:bad'}),/Invalid LayerFS/)
  await assert.rejects(tools.read.execute({workspace,path:'text'},{...context,projectId:'two'}),/another Project/)
  assert.equal(await layerfsRoute('read',{workspace:'registered',path:'x'},context),undefined)
  assert.match(toolResultText((await route('read',{path:'sub'}))!),/text/)
  const failed = await route('exec',{script:'exit 7'})
  assert.equal(isCompletedToolFailure(failed),true)
  assert.equal(JSON.parse(toolResultText(failed)).result.exitCode,7)
  await writeFile(join(dir,'invalid.txt'),Buffer.from([0x61,0xff,0x0a]))
  await assert.rejects(route('read',{path:'invalid.txt'}),/UTF|encoding|encoded/i)
  for (const kind of ['read','write','exec'] as const) {
   await assert.rejects(route(kind,{folder:'registered',path:'sub/text',content:'bad',script:'true'}),/not both/)
   await assert.rejects(route(kind,{workspace:'layerfs:bad',path:'sub/text',content:'bad',script:'true'}),/Invalid LayerFS/)
  }
  assert.equal(await readFile(join(dir,'sub/text'),'utf8'),"literal ' $HOME\nsecond\n")
  const defaultContext = {...context,cwd:'/never-read-on-main',layerfsWorkdir:{workspace}}
  assert.match(toolResultText(await tools.read.execute({path:'sub/text'},defaultContext)),/second/)
  const registeredLayer = {...context,resolveToolTarget:async()=>({layerfsWorkdir:{workspace},fileChangeTarget:{nodeId:'layerfs',workdirId:workspace,folderId:'registered-layer'}})}
  assert.match(toolResultText(await tools.read.execute({workspace:'registered-layer',path:'sub/text'},registeredLayer)),/second/)
  const search = new SearchTool(dir,undefined,undefined,false)
  assert.match(await search.execute({workspace,handler:'grep',query:'second',path:'sub',include:'**/text'},context),/Line 2/)
  assert.match(await search.execute({handler:'glob',query:'**/text'},defaultContext),/sub\/text/)
  await writeFile(join(dir,'large.txt'),'x'.repeat(100000))
  assert.equal(toolResultText(await route('read',{path:'large.txt'})).length,100000)
  await writeFile(join(dir,'tiny.png'),Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=','base64'))
  const image = await route('read',{path:'tiny.png'})
  assert.equal(typeof image,'object')
  assert.equal(typeof image === 'object' && image.content.some(part=>part.type==='image_url'),true)
  const resolved: string[] = []
  const registeredContext = {...context,resolveToolTarget:async(selector:string,operation:string)=>{
   resolved.push(selector+':'+operation); throw Error('registered resolver refusal; no local access')
  }}
  for (const kind of ['read','write','exec'] as const) await assert.rejects(tools[kind].execute({workspace:'registered',path:'sub/text',content:'bad',script:'true'},registeredContext),/registered resolver refusal/)
  assert.deepEqual(resolved,['registered:filesystem.read','registered:filesystem.write','registered:workdir.process.execute-once'])
  await route('exec',{script:'head -c 100000 /dev/zero; sleep 0.1; printf after-limit',timeout_ms:0})
  const largeJob=jobs.at(-1)!
  const largeResult=JSON.parse(await largeJob.promise)
  assert.equal(largeResult.result.stdout.truncated,true)
  assert.match(largeJob.options.observe(),/after-limit/)
  for (const timeout_ms of [0,50]) {
    assert.match(toolResultText(await route('exec',{script:'printf first; sleep 0.3; printf last',timeout_ms})),/Execution ID:/)
    const job=jobs.at(-1)!
    const text=await job.promise
    assert.match(text,/firstlast/)
    assert.match(job.options.observe(),/firstlast/)
  }
  assert.match(toolResultText(await route('exec',{script:'sleep 0.2; exit 7',timeout_ms:0})),/Execution ID:/)
  await assert.rejects(jobs.at(-1)!.promise,/exitCode.*7/)
  await route('exec',{script:'(while :; do printf tick >> ticks; printf tick; sleep 0.05; done) & wait',timeout_ms:0})
  const cancelJob=jobs.at(-1)!
  await new Promise(resolve=>setTimeout(resolve,300))
  assert.match(cancelJob.options.observe(),/tick/)
  await cancelJob.options.onCancel()
  await assert.rejects(cancelJob.promise,/137/)
  const stopped = await readFile(join(dir,'ticks'),'utf8')
  await new Promise(resolve=>setTimeout(resolve,200))
  assert.equal(await readFile(join(dir,'ticks'),'utf8'),stopped)
  const registry = new Tools(dir); registry.register(tools.exec)
  const callTools = new SessionTools(registry,dir); callTools.setExecutionScope('call',[])
  const before = jobs.length
  const expired = await tools.exec.execute({workspace,script:'(while :; do printf x >> leafTicks; sleep 0.05; done) & wait',timeout_ms:300},{...context,tools:callTools})
  assert.equal(isCompletedToolFailure(expired),true)
  assert.equal(jobs.length,before)
  const leafStopped = await readFile(join(dir,'leafTicks'),'utf8')
  await new Promise(resolve=>setTimeout(resolve,200))
  assert.equal(await readFile(join(dir,'leafTicks'),'utf8'),leafStopped)
  const turn = new AbortController()
  const aborted = tools.exec.execute({workspace,script:'sleep 30',timeout_ms:10000},{...context,tools:callTools,signal:turn.signal})
  void aborted.catch(()=>{})
  setTimeout(()=>turn.abort(),150)
  await assert.rejects(aborted,{name:'AbortError'})
  assert.equal(jobs.length,before)
  const bgTurn = new AbortController()
  await tools.exec.execute({workspace,script:'sleep 0.3; echo survived',timeout_ms:10},{...context,signal:bgTurn.signal})
  bgTurn.abort()
  assert.match(await jobs.at(-1)!.promise,/survived/)
  for (const timeout_ms of [-1,2147483648]) await assert.rejects(route('exec',{script:'true',timeout_ms}),/0–2147483647/)

  await assert.rejects(tools.exec.execute({workspace,script:'true'},{...context,recoveringToolCall:true}),ToolOutcomeUnknownError)
  const inputs: string[] = [], bus = new Bus()
  const events = new EventService(dir,bus,async(sessionId,input)=>{
    inputs.push(JSON.stringify(input)); return {status:'accepted',sessionId,inputId:input.id}
  })
  const tasks = new BackgroundTaskManager(bus,events,createProjectScope('one'),dir)
  const managedExec = new ExecTool(dir,120000,new CommandHandlerManager(),{} as ProcessManager,'sh',tasks)
  try {
    for (const timeout_ms of [0,10]) {
      const turn = new AbortController(), count = inputs.length
      const result = await managedExec.execute({workspace,script:'echo live; sleep 0.6; echo failed >&2; exit 7',timeout_ms},
        {...context,channel:'test',chatId:'test',signal:turn.signal})
      assert.match(toolResultText(result),/Execution ID: bg:/)
      turn.abort()
      const task = tasks.listTasks().find(task=>task.status==='running')!
      await t.waitFor(async()=>assert.match(await tasks.getTaskOutput(task.id),/\nlive/),{timeout:5000})
      assert.equal(tasks.listTasks().find(item=>item.id===task.id)!.status,'running')
      await t.waitFor(()=>assert.equal(tasks.listTasks().find(item=>item.id===task.id)!.status,'failed'),{timeout:5000})
      assert.match(await tasks.getTaskOutput(task.id),/failed/)
      await t.waitFor(()=>assert.equal(inputs.length,count+1),{timeout:5000})
      await new Promise(resolve=>setTimeout(resolve,100))
      assert.equal(inputs.length,count+1)
    }
    await managedExec.execute({workspace,script:'touch cancelledBeforeDispatch',timeout_ms:0},{...context,channel:'test',chatId:'test'})
    const immediate = tasks.listTasks().find(task=>task.status==='running')!
    assert.equal(await tasks.cancelTask(immediate.id,context),'cancelled')
    await assert.rejects(readFile(join(dir,'cancelledBeforeDispatch')),{code:'ENOENT'})
    const count = inputs.length
    await managedExec.execute({workspace,script:'echo complete',timeout_ms:0},{...context,channel:'test',chatId:'test'})
    await t.waitFor(()=>assert.equal(tasks.listTasks().filter(task=>task.status==='completed').length,1),{timeout:5000})
    await t.waitFor(()=>assert.equal(inputs.length,count+1),{timeout:5000})
    await new Promise(resolve=>setTimeout(resolve,100))
    assert.equal(inputs.length,count+1)
    await managedExec.execute({workspace,script:'(while :; do echo tick >> managedTicks; echo tick; sleep 0.05; done) & wait',timeout_ms:0},
      {...context,channel:'test',chatId:'test'})
    const cancellable = tasks.listTasks().find(task=>task.status==='running')!
    await t.waitFor(async()=>assert.match(await tasks.getTaskOutput(cancellable.id),/\ntick/),{timeout:5000})
    await t.waitFor(async()=>assert.match(await readFile(join(dir,'managedTicks'),'utf8'),/tick/),{timeout:5000})
    assert.equal(await tasks.cancelTask(cancellable.id,context),'cancelled')
    assert.equal(tasks.listTasks().find(task=>task.id===cancellable.id)!.status,'cancelled')
    const stopped = await readFile(join(dir,'managedTicks'),'utf8')
    await new Promise(resolve=>setTimeout(resolve,200))
    assert.equal(await readFile(join(dir,'managedTicks'),'utf8'),stopped)
  } finally { await tasks.stop() }
 } finally {
  if(prior===undefined) delete process.env.SHADOW_LAYERFS_CONFIG; else process.env.SHADOW_LAYERFS_CONFIG=prior
  // UNKNOWN deliberately does not kill the fixture's shell; allow its short command
  // to release the cwd handle before deleting this test-owned directory on Windows.
  await rm(dir,{recursive:true,force:true,maxRetries:10,retryDelay:100})
 }
})
