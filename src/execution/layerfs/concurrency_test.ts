import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { runBridge, type LayerConfig } from './bridge.ts'
import { operationResources, releaseReservation, resourceJournal } from './coordination.ts'
import { branchWorkspace } from './workspace-identity.ts'

async function fixture() {
 const dir=await mkdtemp(join(process.cwd(),'.layerfs-concurrency-test-'))
 const sdkModule=join(dir,'sdk.mjs'), journal=join(dir,'p.jsonl')
 await writeFile(sdkModule, `import {readdirSync,readFileSync,writeFileSync,unlinkSync,existsSync,appendFileSync} from 'node:fs';
 const dir=${JSON.stringify(dir)};
 const mounts=()=>readdirSync(dir).filter(n=>n.startsWith('mount-')).map(n=>JSON.parse(readFileSync(dir+'/'+n)));
 const log=(...a)=>appendFileSync(dir+'/calls',JSON.stringify(a)+'\\n');
 const wait=async path=>{while(!existsSync(path))await new Promise(r=>setTimeout(r,10))};
 export const isRefusal=e=>e.code==='Busy';
 export const LayerFS={open:async(project)=>({
 project:{list_sandboxes:async()=>({items:mounts().filter(m=>m.project===project).map(m=>({sandbox:m.sandbox,workspaces:1})),hasMore:false})},
 sandbox:{list_workspaces:async id=>({items:mounts().filter(m=>m.sandbox===id),hasMore:false}),
 create:async()=>{log('create',process.pid);if(existsSync(dir+'/hold-create')){process.send?.({type:'output',text:'create'});await wait(dir+'/release-create')}if(existsSync(dir+'/unknown-create'))throw Object.assign(Error('upstream allocation intent unresolved'),{code:'Unknown'});return {sandbox:String(process.pid)}},close:async id=>log('close',id)},
 workspace:{mount:async(sandbox,branch)=>{const m={project,sandbox,branch,path:'/workspaces/1'};writeFileSync(dir+'/mount-'+sandbox,JSON.stringify(m));return m},
 exec:async(m,command,message,sinks)=>{if(command.includes('/cancel') && !command.includes('setsid')){writeFileSync(dir+'/release-'+m.branch,'');return {exitCode:0}}log('exec-start',m.branch);sinks.stdout.write(m.branch);if(command.includes('hold'))await wait(dir+'/release-'+m.branch);if(command==='unknown')writeFileSync(dir+'/unknown-'+m.branch,'');log('exec-end',m.branch);return {exitCode:0}},
 commit:async m=>{if(existsSync(dir+'/unknown-'+m.branch))throw Object.assign(Error('unknown checkpoint'),{code:'Unknown'});return {kind:'UpToDate',head:null,root:'aa'}},
 unmount:async m=>unlinkSync(dir+'/mount-'+m.sandbox)},
 fs:{stat:async()=>({type:'file',size:2,root:'aa'}),read:async()=>({text:'ok',root:'aa',truncated:false,lineTruncated:false}),
 write:async(branch,path,content)=>{log('write',branch);return {kind:'UpToDate',branch,head:null,root:'aa'}}},
 branch:{merge:async(...a)=>{log('merge',...a);if(existsSync(dir+'/hold-merge')){process.send?.({type:'output',text:'merge'});await wait(dir+'/release-merge')}if(existsSync(dir+'/unknown-merge'))throw Object.assign(Error('merge uncertain'),{code:'Unknown'});return {kind:'Merged',branch:a[2],fastForward:true,head:null,root:'aa',mergeBase:'bb',sources:[{ref:a[0],node:'cc'},{ref:a[1],node:'dd'}],conflicts:[],lww:[],units:[],conflictsTruncated:false,lwwTruncated:false,unitsTruncated:false}},publish:async(...a)=>{log('publish',...a);if(existsSync(dir+'/hold-publish')){process.send?.({type:'output',text:'publish'});await wait(dir+'/release-publish')}return {kind:'UpToDate',layer:'aa'}},fork:async(...a)=>{log('fork',...a);return {}}},close:async()=>{}})};`)
 const config:LayerConfig={sdkModule,env:{}}
 const call=(action:string,branch='A',args:Record<string,unknown>={},signal=new AbortController().signal,observe?:(text:string)=>void,project='p')=>runBridge(config,project,action,{workspace:branchWorkspace(project,branch),journal:project==='p'?journal:join(dir,project+'.jsonl'),path:'/a',...args},signal,10000,observe?{observe}:undefined)
 return {dir,journal,call,release:(branch:string)=>writeFile(join(dir,'release-'+branch),''),close:()=>rm(dir,{recursive:true,force:true})}
}
const ok=(text:string)=>assert.equal(JSON.parse(text).ok,true)
const busy=(text:string)=>{const r=JSON.parse(text);assert.equal(r.ok,false);assert.equal(r.error.code,'Busy')}

test('A slow exec overlaps B read/write AND second sandbox exec; same branch refused', {timeout:15000},async()=>{
 const f=await fixture();try {
  const aStarted=Promise.withResolvers<void>(),bStarted=Promise.withResolvers<void>()
  const a=f.call('exec','A',{command:'hold'},undefined,()=>aStarted.resolve())
  await aStarted.promise
  ok(await f.call('read','B'));ok(await f.call('write','B',{content:'B'}))
  busy(await f.call('write','A',{content:'no split'}))
  const b=f.call('exec','B',{command:'hold'},undefined,()=>bStarted.resolve())
  await bStarted.promise
  const calls=(await readFile(join(f.dir,'calls'),'utf8')).trim().split('\n').map(s=>JSON.parse(s))
  assert.deepEqual(calls.filter(c=>c[0]==='exec-start').map(c=>c[1]),['A','B'])
  assert.equal(calls.filter(c=>c[0]==='exec-end').length,0)
  assert.equal(new Set(calls.filter(c=>c[0]==='create').map(c=>c[1])).size,2)
  await f.release('A');await f.release('B');ok(await a);ok(await b)
 }finally{await f.close()}
})

test('known A checkpoint UNKNOWN survives new process; B remains fully usable; namespace isolation',async()=>{
 const f=await fixture();try {
  await assert.rejects(f.call('exec','A',{command:'unknown'}),/unknown/i)
  busy(await f.call('read','A'))
  ok(await f.call('read','B'));ok(await f.call('write','B',{content:'B'}));ok(await f.call('exec','B',{command:'normal'}))
  // The same branch name in another namespace is independent.
  const db=new DatabaseSync(f.journal+'.sqlite');const rows=db.prepare('SELECT * FROM reservations').all();db.close()
  assert.equal(rows.length,1);assert.equal(rows[0].resource,'branch:A')
  ok(await f.call('write','A',{content:'other'},undefined,undefined,'other'))
  assert.match(await readFile(resourceJournal(f.journal,'A'),'utf8'),/"branch":"A"/)
 }finally{await f.close()}
})

test('merge reserves both sources and output; publish reserves source and main; deterministic resource planning',async()=>{
 assert.deepEqual(operationResources('merge',{ref:'B',branch:'A',name:'C'}),['A','B','C'])
 assert.deepEqual(operationResources('publish',{branch:'A',ref:'abcdef'}),['A','main'])
 assert.deepEqual(operationResources('fork',{branch:'B',ref:'abcdef'}),['B','abcdef'])
 assert.deepEqual(operationResources('load',{branch:'B',ref:'main'}),['B','main'])
 const f=await fixture();try{
  const started=Promise.withResolvers<void>()
  const a=f.call('exec','A',{command:'hold'},undefined,()=>started.resolve());await started.promise
  busy(await f.call('merge','B',{ref:'A',branch:'B',name:'C'}))
  busy(await f.call('merge','B',{ref:'B',branch:'C',name:'A'}))
  busy(await f.call('publish','A',{branch:'A'}))
  ok(await f.call('merge','B',{ref:'B',branch:'C',name:'D'}))
  ok(await f.call('publish','B',{branch:'B'}))
  await f.release('A');ok(await a)
  const db=new DatabaseSync(f.journal+'.sqlite');assert.equal(db.prepare('SELECT * FROM reservations').all().length,0);db.close()
 }finally{await f.close()}
})

test('release validates exact owner and does not erase another operation; legacy project journal blocks',async()=>{
 const f=await fixture();try{
  await assert.rejects(f.call('exec','A',{command:'unknown'}),/unknown/i)
  assert.throws(()=>releaseReservation(f.journal+'.sqlite','wrong-owner',[resourceJournal(f.journal,'A')]),/mismatch/)
  busy(await f.call('read','A'));ok(await f.call('read','B'))
  await writeFile(f.journal,'legacy unknown create\n');busy(await f.call('read','B'))
 }finally{await f.close()}
})

test('cancellation retains A reservation and mount across bridge restart while B proceeds', {timeout:15000},async()=>{
 const f=await fixture();try{
  const controller=new AbortController()
  await assert.rejects(f.call('exec','A',{command:'hold'},controller.signal,()=>controller.abort()),/unknown/i)
  busy(await f.call('write','A',{content:'no replay'}))
  ok(await f.call('read','B'));ok(await f.call('exec','B',{command:'normal'}))
  assert.match(await readFile(resourceJournal(f.journal,'A'),'utf8'),/exec-dispatched/)
 }finally{await f.close()}
})

test('unknown upstream allocation quarantines A locally, permits B fs, never bypasses SDK create intent',async()=>{
 const f=await fixture();try{
  await writeFile(join(f.dir,'unknown-create'),'')
  await assert.rejects(f.call('exec','A',{command:'normal'}),/unknown/i)
  busy(await f.call('read','A'));ok(await f.call('read','B'));ok(await f.call('write','B',{content:'ok'}))
  await assert.rejects(f.call('exec','B',{command:'normal'}),/unknown/i)
  assert.match(await readFile(resourceJournal(f.journal,'A'),'utf8'),/sandbox-create-dispatched/)
 }finally{await f.close()}
})

test('legacy unknown mount ownership fails closed, known unrelated mount does not',async()=>{
 const f=await fixture();try{
  const path=join(f.dir,'mount-legacy')
  await writeFile(path,JSON.stringify({project:'p',sandbox:'legacy',branch:null,path:'/workspaces/99'}))
  const refused=JSON.parse(await f.call('read','B'));assert.equal(refused.error.code,'MountedWorkspace')
  await writeFile(path,JSON.stringify({project:'p',sandbox:'legacy',branch:'A',path:'/workspaces/99'}))
  ok(await f.call('read','B'))
  assert.equal(JSON.parse(await f.call('read','A')).error.code,'MountedWorkspace')
 }finally{await f.close()}
})

test('death during transactional admission rolls back partial reservations, no stale global gate',async()=>{
 const f=await fixture();try{
  ok(await f.call('read','B'))
  const child=spawn(process.execPath,['--input-type=module','-e',`import {DatabaseSync} from 'node:sqlite';const db=new DatabaseSync(${JSON.stringify(f.journal+'.sqlite')});db.exec('BEGIN IMMEDIATE');db.prepare('INSERT INTO reservations VALUES (?, ?, ?, ?, ?)').run('branch:A','dead','partial','p','merge');process.stdout.write('held');setInterval(()=>{},1000);`],{stdio:['ignore','pipe','pipe']})
  await once(child.stdout!,'data');const closed=once(child,'close');child.kill();await closed
  ok(await f.call('read','A'));ok(await f.call('read','B'))
 }finally{await f.close()}
})

test('inflight merge/publish reserve complete ref sets, not unrelated branches; merge UNKNOWN retains all refs',async()=>{
 const f=await fixture();try{
  await writeFile(join(f.dir,'hold-merge'),'')
  const started=Promise.withResolvers<void>()
  const merge=f.call('merge','A',{ref:'B',branch:'A',name:'C'},undefined,()=>started.resolve());await started.promise
  for(const branch of ['A','B','C'])busy(await f.call('write',branch,{content:'blocked'}))
  busy(await f.call('merge','B',{ref:'A',branch:'B',name:'E'}))
  ok(await f.call('exec','D',{command:'normal'}))
  await f.release('merge');ok(await merge)
  await writeFile(join(f.dir,'hold-publish'),'')
  const pubStarted=Promise.withResolvers<void>()
  const publish=f.call('publish','A',{branch:'A'},undefined,()=>pubStarted.resolve());await pubStarted.promise
  busy(await f.call('read','main'));busy(await f.call('write','A',{content:'blocked'}));ok(await f.call('write','B',{content:'allowed'}))
  await f.release('publish');ok(await publish)
  await writeFile(join(f.dir,'unknown-merge'),'')
  await assert.rejects(f.call('merge','A',{ref:'B',branch:'A',name:'C'}),/unknown/i)
  for(const branch of ['A','B','C'])busy(await f.call('read',branch))
  ok(await f.call('read','D'))
 }finally{await f.close()}
})

test('two branch bridges dispatch sandbox creation concurrently, then retain overlapping exec lifetimes',{timeout:15000},async()=>{
 const f=await fixture();try{
  await writeFile(join(f.dir,'hold-create'),'')
  const creates=[Promise.withResolvers<void>(),Promise.withResolvers<void>()],execs=[Promise.withResolvers<void>(),Promise.withResolvers<void>()]
  const runs=['A','B'].map((branch,index)=>f.call('exec',branch,{command:'hold'},undefined,text=>{if(text==='create')creates[index]!.resolve();else execs[index]!.resolve()}))
  await Promise.all(creates.map(c=>c.promise))
  // Neither create has returned: there is no project-long Shadow admission lock.
  const calls=(await readFile(join(f.dir,'calls'),'utf8')).trim().split('\n').map(s=>JSON.parse(s))
  assert.equal(calls.filter(c=>c[0]==='create').length,2);assert.equal(calls.filter(c=>c[0]==='exec-start').length,0)
  await f.release('create');await Promise.all(execs.map(c=>c.promise))
  await f.release('A');await f.release('B');for(const result of await Promise.all(runs))ok(result)
 }finally{await f.close()}
})
