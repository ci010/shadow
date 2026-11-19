import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ReadTool } from './read.ts'
import { WriteTool } from './filesystem.ts'
import { SearchTool } from './search.ts'
import { ExecTool } from './shell.ts'
import { CommandHandlerManager } from './shell-commands/command-handler.ts'
import type { ProcessManager } from '../execution/processes/manager.ts'
import type { BackgroundTaskManager } from '../agent/background-task.ts'
import { committedFixture } from '../execution/layerfs/committed-test-fixture.ts'
import { isCompletedToolFailure, toolResultText } from './tool.ts'
import { SessionTools, Tools } from './registry.ts'
import { createProjectScope } from '../projects/scope.ts'
import { EvalBridgeRuntime } from '../script-runtime/bridge.ts'

test('JavaScript reads, edits and tests on the resolved LayerFS branch', async () => {
  const f = await committedFixture()
  const scope = createProjectScope('one')
  const evalBridge = new EvalBridgeRuntime({ projectId: 'one', scope })
  try {
    const base = new Tools(f.dir)
    base.register(new ReadTool(f.dir))
    base.register(new WriteTool(f.dir))
    const tools = new SessionTools(base, f.dir)
    const exec = new ExecTool(f.dir, 15_000, new CommandHandlerManager(), {} as ProcessManager, 'sh', {} as BackgroundTaskManager)
    base.register(exec)
    const output = await exec.execute({ shell: 'javascript', workspace: f.workspace, script: `
      import exec from '@shadow/exec'
      export default async () => {
        const before = await read({ path: 'a' })
        await write({ path: 'a', content: 'branch-only' })
        const tested = await exec({ script: 'echo checked', shell: 'sh', timeout_ms: 5000 })
        return { before, tested }
      }
    ` }, { ...f.context, tools, evalBridge })
    const result = JSON.parse(toolResultText(output)).result
    assert.equal(result?.before, 'first\nsecond\n', toolResultText(output))
    assert.match(JSON.stringify(result.tested), /command-output/)
    const calls = await f.calls()
    assert.ok(calls.some(c => c[0] === 'write' && c[1] === 'feature'))
    assert.ok(calls.some(c => c[0] === 'exec' && JSON.stringify(c).includes('echo checked')))
    assert.ok(calls.some(c => c[0] === 'unmount'))
    await assert.rejects(exec.execute({ shell: 'javascript', workspace: 'layerfs:unknown', script: '1' }, { ...f.context, tools, evalBridge }), /registered LayerFS target/)
  } finally {
    await evalBridge.shutdown()
    scope.close()
    await f.close()
  }
})

test('ordinary entrypoints select registered/default LayerFS without host fallback; background owns lifecycle',async()=>{
 const f=await committedFixture()
 try{
  const context={...f.context,layerfsWorkdir:{workspace:f.workspace},resolveToolTarget:async()=>({layerfsWorkdir:{workspace:f.workspace},fileChangeTarget:{nodeId:'layerfs',workdirId:f.workspace,folderId:'registered'}})}
  const read=new ReadTool(f.dir),write=new WriteTool(f.dir),search=new SearchTool(f.dir,undefined,undefined,false)
  assert.equal(toolResultText(await read.execute({path:'a'},context)),'first\nsecond\n')
  assert.match(toolResultText(await write.execute({workspace:'registered',path:'a',content:'value'},context)),/Committed/)
  assert.match(await search.execute({handler:'glob',query:'**',path:'/'},context),/nextPagePos/)
  assert.match(await search.execute({handler:'glob',query:'v:*',path:'.'},context),/nextPagePos/)
  assert.ok((await f.calls()).some(c=>c[0]==='glob' && c[2]==='v:*' && c[3]==='/'))
  const jobs:{options:any,promise:Promise<string>}[]=[]
  const background={runPromiseTask(options:any,promise:Promise<string>){jobs.push({options,promise});void promise.catch(()=>{});return String(jobs.length)}} as unknown as BackgroundTaskManager
  const nodeOnly=new ExecTool(f.dir,120000,new CommandHandlerManager(),{} as ProcessManager,'sh',background,undefined,true)
  await assert.rejects(nodeOnly.execute({shell:'sh',script:'anything'},context),/Only shell=javascript/)
  const exec=new ExecTool(f.dir,120000,new CommandHandlerManager(),{} as ProcessManager,'sh',background)
  await f.mode('slow')
  const started=await exec.execute({script:'fixture only',timeout_ms:0},context)
  assert.match(toolResultText(started),/background|bg:/i)
  assert.equal(jobs.length,1)
  await new Promise(resolve=>setTimeout(resolve,200))
  assert.equal(isCompletedToolFailure(await read.execute({path:'a'},context)),true)
  await jobs[0].promise
  const calls=await f.calls()
  assert.ok(calls.some(c=>c[0]==='commit'));assert.ok(calls.some(c=>c[0]==='unmount'))
  assert.equal(toolResultText(await read.execute({path:'a'},context)),'value')
  await f.mode('nonzero')
  assert.equal(isCompletedToolFailure(await exec.execute({script:'fixture only'},context)),true)
 }finally{await f.close()}
})
