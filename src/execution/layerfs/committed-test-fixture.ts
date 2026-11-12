import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { layerfsRoute } from '../../tools/layerfs-route.ts'
import { branchWorkspace } from './workspace-identity.ts'
import { layerfsName } from './bridge.ts'
import { resourceJournal } from './coordination.ts'
import type { ExecutionContext } from '../../tools/context.ts'
// Contract fixture, not an installed SDK or sandbox: records positional calls;
// workspace.exec does not run shell commands. Each bridge gets a fresh process.
export async function committedFixture() {
 const dir = await mkdtemp(join(process.cwd(), '.layerfs-committed-test-'))
 const prior = process.env.SHADOW_LAYERFS_CONFIG
 const sdkModule = join(dir, 'sdk.mjs'), state = join(dir, 'state.json'), log = join(dir, 'calls.jsonl')
 await writeFile(state, JSON.stringify({ text: 'first\nsecond\n', mode: '' }))
 await writeFile(sdkModule, `import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
 const statePath=${JSON.stringify(state)}, log=${JSON.stringify(log)};
 const state=()=>JSON.parse(readFileSync(statePath));
 const call=(name,args)=>appendFileSync(log,JSON.stringify([name,...args])+'\\n');
 const save=s=>writeFileSync(statePath,JSON.stringify(s));
 const cancelPoint=async name=>{if(state().mode==='cancel-'+name){process.send?.({type:'output',text:name});await new Promise(r=>setTimeout(r,100))}};
 export const LayerFS={open:async()=>({
  project:{list_sandboxes:async(...a)=>{call('inventory',a);return {items:state().mode==='mounted'?[{sandbox:'9',workspaces:1}]:[],hasMore:false,nextPagePos:null}}},
  fs:{
   stat:async(...a)=>{call('stat',a);return {type:a[1]==='/'?'directory':'file',size:state().text.length,root:'root1'}},
   read:async(...a)=>{call('read',a);const s=state(); if(s.mode==='binary')throw Object.assign(Error('Binary'),{code:'Binary'}); const lines=s.text.split('\\n');const start=a[2]??1;const end=Math.min(a[3]??lines.length,start);return {root:s.mode==='changed'?'root2':'root1',text:lines.slice(start-1,end).join('\\n')+(end<lines.length?'\\n':''),truncated:end<Math.min(a[3]??lines.length,lines.length),lineTruncated:s.mode==='clipped',nextLine:end+1}},
   list:async(...a)=>{call('list',a);return {items:[{name:'a'}],hasMore:true,nextPagePos:7}},
   glob:async(...a)=>{call('glob',a);return {items:['/a'],hasMore:true,nextPagePos:9}},
   grep:async(...a)=>{call('grep',a);return {items:[{path:'/a',line:1,text:'literal',lineTruncated:false}],hasMore:true,nextPagePos:11,skipped:2}},
   write:async(...a)=>{call('write',a);if(['unknown','transport'].includes(state().mode))throw Object.assign(Error('lost'),{code:state().mode==='transport'?'ECONNRESET':'Unknown'});save({...state(),text:a[2]});return state().mode==='bad-receipt'?{kind:'Conflict'}:{kind:'Committed',branch:a[0],head:'a'.repeat(64),commit:{id:'a'.repeat(64),root:'d'.repeat(64)}}},
   edit:async(...a)=>{call('edit',a);save({...state(),text:state().text.replace(a[2],a[3])});return {kind:'Committed',branch:a[0],head:'b'.repeat(64),commit:{id:'b'.repeat(64),root:'d'.repeat(64)}}}
  },
  sandbox:{list_workspaces:async()=>({items:[{branch:'feature'}],hasMore:false}),create:async()=>{call('create',[]);await cancelPoint('create');return {sandbox:'1'}},close:async(...a)=>{call('sandbox.close',a);return {kind:'Closed'}}},
  workspace:{mount:async(...a)=>{call('mount',a);await cancelPoint('mount');return {sandbox:'1',path:'/workspaces/1'}},
   exec:async(...a)=>{call('exec',a.slice(0,3));if(state().mode==='slow')await new Promise(r=>setTimeout(r,500));a[3].stdout.write('command-output');return {exitCode:state().mode==='nonzero'?7:0}},
   commit:async(...a)=>{call('commit',a);if(state().mode==='commit-unknown')throw Object.assign(Error('lost'),{code:'Unknown'});return state().mode==='bad-receipt'?{kind:'Conflict'}:state().mode==='uptodate'?{kind:'UpToDate',head:null,root:'d'.repeat(64)}:{kind:'Committed',head:'c'.repeat(64),commit:{id:'c'.repeat(64),root:'d'.repeat(64)}}},
   unmount:async(...a)=>{call('unmount',a);await cancelPoint('unmount');return {kind:'Unmounted'}}},close:async()=>{if(state().mode==='close-fail')throw Error('close failed')}
 })};`)
 const config = join(dir, 'config.json')
 await writeFile(config, JSON.stringify({ projects: { one: { sdkModule, env: { LAYERFS_HOME: dir, LAYERFS_STORE_PATH: join(dir, 'store'), LAYERFS_WORKER_ENDPOINT: 'fake' } } } }))
 process.env.SHADOW_LAYERFS_CONFIG = config
 const workspace = branchWorkspace(layerfsName('one'), 'feature')
 const context = { projectId: 'one', sessionId: 'fixture', signal: new AbortController().signal } as ExecutionContext
 const route = (kind: 'read'|'write'|'search'|'exec', args: Record<string, unknown> = {}) => layerfsRoute(kind, { workspace, ...args }, context, dir, {run: fn => fn(context.signal, () => {})})
 return { dir, workspace, context, route,
  journal: resourceJournal(join(dir, 'layerfs-operations', layerfsName('one') + '.jsonl'), 'feature'),
  calls: async () => (await readFile(log, 'utf8')).trim().split('\n').map(s => JSON.parse(s)),
  mode: async (mode: string) => {const s=JSON.parse(await readFile(state,'utf8'));await writeFile(state,JSON.stringify({...s,mode}))},
  close: async () => {if(prior===undefined)delete process.env.SHADOW_LAYERFS_CONFIG;else process.env.SHADOW_LAYERFS_CONFIG=prior;await rm(dir,{recursive:true,force:true})},
 }
}

