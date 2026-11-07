// Opt-in real upstream harness; run only once in a fresh private test directory.
import assert from 'node:assert/strict'
import {readFile, writeFile, mkdir, appendFile} from 'node:fs/promises'
import {join, isAbsolute} from 'node:path'
import {pathToFileURL} from 'node:url'
import {LayerFSTool} from '../../src/tools/layerfs.ts'
import {ReadTool} from '../../src/tools/read.ts'
import {WriteTool} from '../../src/tools/filesystem.ts'
import {ExecTool} from '../../src/tools/shell.ts'
import {CommandHandlerManager} from '../../src/tools/shell-commands/command-handler.ts'
import {layerfsName} from '../../src/execution/layerfs/bridge.ts'
import {toolResultText,isCompletedToolFailure} from '../../src/tools/tool.ts'
import type {ExecutionContext} from '../../src/tools/context.ts'
const base=process.env.LAYERFS_E2E_ROOT!; assert.ok(base && isAbsolute(base),'absolute private LAYERFS_E2E_ROOT required'); const root=join(base,'real-run-'+process.argv[2]); await mkdir(root,{mode:0o700})
const setup=JSON.parse(await readFile(join(base,'setup.json'),'utf8'))
const iteration=process.argv[2]; assert.match(iteration,/^[1-8]$/); const tag=process.env.LAYERFS_E2E_TAG!; assert.match(tag,/^[a-z0-9-]{1,32}$/); const projectId='layerfs-mac-'+tag+'-'+iteration
const project=layerfsName(projectId), home=join(root,'home'), source=join(root,'source')
await mkdir(home,{mode:0o700}); await mkdir(source,{mode:0o700})
await writeFile(join(source,'hello.txt'),'baseline\n'); await writeFile(join(source,'.ignored-fixture'),'included\n')
const {LayerFSRuntime}=await import(pathToFileURL(join(setup.bundle,'api/runtime/src/index.js')).href)
const runtime=await LayerFSRuntime.open({home,image:setup.nodeImage,bundle:setup.bundle,docker:setup.socket,containerPrefix:`lfs-mac-${tag}-${iteration}-`,sweep:false})
const log=async(step:string,result:unknown)=>{await appendFile(join(root,'receipts.jsonl'),JSON.stringify({at:new Date().toISOString(),step,result})+'\n'); console.log(step,JSON.stringify(result))}
const env={LAYERFS_HOME:home,LAYERFS_STORE_PATH:`/var/lib/docker/volumes/lfs-mac-${tag}-${iteration}-store/_data/global/store.sqlite`,LAYERFS_VOLUME:`lfs-mac-${tag}-${iteration}-store`,LAYERFS_IMAGE:setup.nodeImage,LAYERFS_DAEMON_HOST:'docker-bridge',LAYERFS_DOCKER:'/var/run/docker.sock',LAYERFS_DAEMON:join(setup.bundle,'layerfs-daemon'),LAYERFS_NATIVE:join(setup.bundle,'layerfs.node'),LAYERFS_WORKER_ENDPOINT:join(home,'worker/endpoint.json'),LAYERFS_CONTAINER_PREFIX:`lfs-mac-${tag}-${iteration}-`}
await writeFile(join(root,'config.json'),JSON.stringify({projects:{[projectId]:{sdkModule:join(setup.bundle,'api/agent/src/index.js'),env}}}),{mode:0o600})
process.env.SHADOW_LAYERFS_CONFIG=join(root,'config.json')
const ctx={projectId,sessionId:'mac-e2e',toolCallId:'mac-e2e',signal:new AbortController().signal,resolveToolTarget:async(selector:string)=>{assert.equal(selector,'fixture');return {cwd:source}},recordFileChange:async()=>{}} as unknown as ExecutionContext
const layer=new LayerFSTool(projectId)
async function call(step:string,args:any,expectFailure=false){const raw=await layer.execute(args,ctx);const result=JSON.parse(toolResultText(raw));await log(step,result);assert.equal(isCompletedToolFailure(raw),expectFailure,step);return result.result??result.error}
const tools={read:new ReadTool(source),write:new WriteTool(source),exec:new ExecTool(source,120000,new CommandHandlerManager(),{} as any,'sh',{} as any)}
async function ordinary(kind:'read'|'write'|'exec',workspace:string,args:any){const raw=await tools[kind].execute({workspace,...args},ctx);await log('ordinary-'+kind,{workspace,result:toolResultText(raw)});assert.equal(isCompletedToolFailure(raw),false);const text=toolResultText(raw);return JSON.parse(text.split('\nedit=')[0]).result}
try{
 await log('worker-start',await runtime.worker.start())
 await call('create',{action:'create',workspace:'fixture'})
 await call('fork-a',{action:'fork',branch:'agent-a'})
 await call('fork-b',{action:'fork',branch:'agent-b'})
 const a=await call('mount-a',{action:'mount',branch:'agent-a'}), b=await call('mount-b',{action:'mount',branch:'agent-b'})
 assert.equal((await ordinary('read',a.workspace,{path:'hello.txt'})).stdout.text,'baseline\n')
 await Promise.all([ordinary('write',a.workspace,{path:'hello.txt',content:'agent-a\n'}),ordinary('write',b.workspace,{path:'hello.txt',content:'agent-b\n'})])
 const [ar,br]=await Promise.all([ordinary('exec',a.workspace,{script:'cat hello.txt && test -f .ignored-fixture'}),ordinary('exec',b.workspace,{script:'cat hello.txt'})]);assert.equal(ar.stdout.text,'agent-a\n');assert.equal(br.stdout.text,'agent-b\n')
 const dirty=await call('dirty-close',{action:'close',workspace:a.workspace},true); assert.equal(dirty.code,'Dirty')
 const checkpoint=await call('checkpoint',{action:'commit',workspace:a.workspace,message:'checkpoint-a'})
 const history=await call('history',{action:'history',branch:'agent-a'})
 await log('checkpoint-shape',{checkpoint,history})
 // Pinned upstream list_commits returns items; sdk_values.rs supplies the id.
 const rows=history.items
 assert.ok(Array.isArray(rows)&&rows.length,'history list shape')
 const ref=rows[0].id
 assert.equal(rows[0].message,'checkpoint-a')
 assert.equal(typeof ref,'string','historical ref shape')
 await ordinary('write',a.workspace,{path:'hello.txt',content:'newer\n'})
 await call('second-checkpoint',{action:'commit',workspace:a.workspace,message:'newer'})
 await call('load',{action:'load',branch:'restored',ref})
 const restored=await call('mount-restored',{action:'mount',branch:'restored'})
 assert.equal((await ordinary('read',restored.workspace,{path:'hello.txt'})).stdout.text,'agent-a\n')
 await call('commit-b',{action:'commit',workspace:b.workspace,message:'checkpoint-b'})
 for(const [name,ws] of [['a',a.workspace],['b',b.workspace],['restored',restored.workspace]])await call('clean-close-'+name,{action:'close',workspace:ws})
 assert.equal(await readFile(join(source,'hello.txt'),'utf8'),'baseline\n')
 await log('PASS',{project})
} catch(e:any){await log('FAIL',{message:e.message,stack:e.stack});process.exitCode=1}finally{await runtime.close();await log('runtime-close',{})}
