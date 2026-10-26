import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, writeFile, symlink, link, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { FolderRegistry } from '../folders/registry.ts'
import { SourceResources } from './source-resources.ts'

const signal = new AbortController().signal

test('registered source resources enforce scope, traversal, sensitive files, symlinks and bounded text reads', async t => {
  const root = await mkdtemp(join(process.cwd(), '.source-resource-test-'))
  t.after(() => rm(root,{recursive:true,force:true}))
  const home = join(root,'home'), source = join(root,'source'), outside = join(root,'outside')
  await Promise.all([mkdir(home),mkdir(source),mkdir(outside)])
  await mkdir(join(source,'src'))
  await writeFile(join(source,'src/main.ts'),'const example = 1\nexample()\n')
  for (const file of ['.env','credentials.json','id_rsa','private-key.pem','bot.config.json','oauth.json','settings.xml']) await writeFile(join(source,file),'SECRET_CANARY')
  await writeFile(join(source,'data.json'),'\"client_secret\": \"SECRET_VALUE_CANARY\"')
  await writeFile(join(source,'key.ts'),'-----BEGIN PRIVATE KEY-----')
  await writeFile(join(source,'huge.ts'),'x'.repeat(256_001))
  await writeFile(join(outside,'escape.ts'),'OUTSIDE_CANARY')
  await symlink(outside,join(source,'escape'))
  await symlink(join(outside,'escape.ts'),join(source,'linked.ts'))
  await link(join(outside,'escape.ts'),join(source,'hard.ts'))
  const folders = new FolderRegistry(home); await folders.init()
  const folder = await folders.register(source), resources = new SourceResources(folders)
  resources.validate([folder.id])
  assert.deepEqual(await resources.run([folder.id],folder.id,{path:'src/main.ts',offset:2,limit:1},signal),{folderId:folder.id,path:'src/main.ts',offset:2,lines:['example()'],totalLines:3})
  for (const path of ['../outside/escape.ts','/etc/passwd','src/../../outside/escape.ts','escape/escape.ts','linked.ts','hard.ts','.env','credentials.json','private-key.pem','bot.config.json','key.ts','huge.ts','data.json','settings.xml','oauth.json']) await assert.rejects(resources.run([folder.id],folder.id,{path},signal),{name:'Error'},path)
  await assert.rejects(resources.run([],folder.id,{path:'src/main.ts'},signal),/scope/)
  assert.throws(()=>resources.validate(['00000000-0000-4000-a000-000000000000']))
  const found = await resources.run([folder.id],folder.id,{query:'example',mode:'content',limit:1},signal)
  assert('matches' in found); assert.equal(found.matches.length,1); assert.equal(found.truncated,true)
  const names = await resources.run([folder.id],folder.id,{query:'main',mode:'names'},signal)
  assert('matches' in names); assert.deepEqual(names.matches,[{path:'src/main.ts'}])
  const secrets = await resources.run([folder.id],folder.id,{query:'CANARY',mode:'content'},signal)
  assert('matches' in secrets); assert.deepEqual(secrets.matches,[])
  const controller=new AbortController()
  const pending=resources.run([folder.id],folder.id,{path:'src/main.ts'},controller.signal)
  controller.abort()
  await assert.rejects(pending,/aborted/)
  // Recheck registration after the helper completes, not just at admission.
  let lookups=0
  const get=folders.get.bind(folders)
  const lookup=t.mock.method(folders,'get',(id:string)=>++lookups>=4?undefined:get(id))
  await assert.rejects(resources.run([folder.id],folder.id,{path:'src/main.ts'},signal),/changed|unavailable/)
  lookup.mock.restore()
  // Unregistering the resource immediately removes access, without changing the Bot package.
  t.mock.method(folders,'get',()=>undefined)
  await assert.rejects(resources.run([folder.id],folder.id,{path:'src/main.ts'},signal),/unavailable/)
})


test('descriptor-verified traversal rejects ancestor replacement between open and chdir',async t=>{
  const root=await mkdtemp(join(process.cwd(),'.source-race-test-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const source=join(root,'source'),outside=join(root,'outside')
  await mkdir(source);await mkdir(outside);await mkdir(join(source,'src'))
  await writeFile(join(outside,'main.ts'),'OUTSIDE_RACE_CANARY')
  const script=`
    import fs from 'node:fs';
    import {enterSourceDirectory} from ${JSON.stringify(new URL('./source-reader.ts',import.meta.url).href)};
    const original=process.chdir.bind(process);let swapped=false;
    process.chdir=(path)=>{if(path==='src'&&!swapped){swapped=true;fs.renameSync('src','saved');fs.symlinkSync(${JSON.stringify(outside)},'src')} original(path)};
    try {enterSourceDirectory(${JSON.stringify(source)},'src');console.log('UNSAFE')} catch {console.log('BLOCKED')}
  `
  const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',script],{timeout:3000,maxBuffer:1000,env:{}})
  assert.equal(stdout.trim(),'BLOCKED')
})


test('safe source traversal fails closed on unsupported platforms and search bounds enumeration',async t=>{
  const root=await mkdtemp(join(process.cwd(),'.source-bound-test-'))
  t.after(()=>rm(root,{recursive:true,force:true}))
  const source=join(root,'source'),home=join(root,'home')
  await mkdir(source);await mkdir(home)
  for(let start=0;start<10_020;start+=200) await Promise.all(Array.from({length:Math.min(200,10_020-start)},(_,i)=>writeFile(join(source,`entry-${start+i}.bin`),'')))
  const folders=new FolderRegistry(home);await folders.init()
  const folder=await folders.register(source),resources=new SourceResources(folders)
  const result=await resources.run([folder.id],folder.id,{query:'not-found',mode:'names'},signal)
  assert('matches' in result);assert.equal(result.truncated,true);assert.deepEqual(result.matches,[])
  const get=folders.get.bind(folders)
  const remote=t.mock.method(folders,'get',(id:string)=>({...get(id)!,kind:'remote'}) as unknown as ReturnType<typeof folders.get>)
  assert.throws(()=>resources.validate([folder.id]),/unavailable/)
  remote.mock.restore()
  const script=`
    import {enterSourceDirectory} from ${JSON.stringify(new URL('./source-reader.ts',import.meta.url).href)};
    Object.defineProperty(process,'platform',{value:'win32'});
    try {enterSourceDirectory('/');console.log('UNSAFE')} catch {console.log('UNSUPPORTED')}
  `
  const {stdout}=await promisify(execFile)(process.execPath,['--input-type=module','-e',script],{timeout:3000,maxBuffer:1000,env:{}})
  assert.equal(stdout.trim(),'UNSUPPORTED')
})
