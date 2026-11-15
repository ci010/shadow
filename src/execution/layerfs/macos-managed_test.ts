import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ManagedLayerFS, installationSchema, type Deployment } from './managed.ts'
import { nativeSourceRoot, verifyNativeSource, macSourceProbe } from './native-source.ts'
import { managedRunner } from './managed-runner.ts'

test('macOS installation uses host-owned official Runtime settings without WSL and rejects foreign host profiles', async () => {
 const dir = await mkdtemp(join(process.cwd(), '.layerfs-macos-test-'))
 try {
  for (const name of ['agent','runtime']) {
   await mkdir(join(dir,'api',name,'src'),{recursive:true})
   await writeFile(join(dir,'api',name,'src','index.js'),'throw Error("fixture must not load")')
   await writeFile(join(dir,'api',name,'package.json'),JSON.stringify({name:'@layerfs/'+name}))
  }
  const installation = {platform:'darwin',apiRoot:dir,bundle:dir,image:'sha256:'+'a'.repeat(64),docker:'/var/run/docker.sock'}
  assert.equal(installationSchema.safeParse({...installation,distribution:'WSL'}).success,false)
  const deployments: Deployment[] = []
  const ready = {worker:'running',answering:true,docker:'ok',ready:true,sandboxVerified:false}
  const service = new ManagedLayerFS('mac',join(dir,'home'),()=>({request:async(action,input)=>{if(action==='open')deployments.push(input as Deployment);return ready},close:async()=>{}}),'darwin')
  await service.setup(installation,AbortSignal.timeout(1000))
  assert.equal(deployments.length,1)
  assert.equal(deployments[0]!.settings.wsl,undefined)
  assert.equal(deployments[0]!.settings.docker,installation.docker)
  assert.equal(deployments[0]!.settings.sweep,false)
  await service.close()
  const wrong = new ManagedLayerFS('mac',join(dir,'foreign'),()=>{throw Error('must not dispatch')},'win32')
  await assert.rejects(wrong.setup(installation,AbortSignal.timeout(1000)),/platform/)
 } finally {await rm(dir,{recursive:true,force:true})}
})

test('macOS scoped APFS evidence accepts protected host ownership, refuses links, substitutions and Linux assumptions',()=>{
 const root = nativeSourceRoot('p','r','/Users/owner/runtime')
 assert.equal(root,'/Users/owner/runtime/sources')
 const path = root+'/repo'
 const paths = ['/',...path.split('/').filter(Boolean).map((_,i,a)=>'/'+a.slice(0,i+1).join('/'))]
 const evidence = paths.map((path,i)=>({path,real:path,directory:true,linked:false,device:'1',inode:String(i),uid:i<2?0:501,mode:0o40755,filesystem:'26'}))
 assert.equal(typeof verifyNativeSource(path,evidence,501),'string')
 for (const patch of [{uid:502},{filesystem:'61267'},{mode:0o40777},{linked:true},{real:'/elsewhere'}]) {
  const changed=structuredClone(evidence);Object.assign(changed.at(-1)!,patch)
  assert.throws(()=>verifyNativeSource(path,changed,501))
 }
 assert.throws(()=>verifyNativeSource(path,evidence))
 assert.match(macSourceProbe,/f.type !== 26n/)
 assert.match(managedRunner,/runtime.project.start_init\(name,source,options\)/)
 assert.match(managedRunner,/LAYERFS_HOME: s.wsl \? s.wsl.home : s.home/)
})
