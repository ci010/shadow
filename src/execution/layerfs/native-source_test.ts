import test from 'node:test'
import assert from 'node:assert/strict'
import { nativeSourcePath, nativeSourceRoot, verifyNativeSource, nativeSourceProbe } from './native-source.ts'
import { layerfsResourceContracts } from '../../tools/layerfs-resource.ts'
import { runInNewContext } from 'node:vm'
import { managedRunner } from './managed-runner.ts'

const root = nativeSourceRoot('project', 'runtime')
const path = nativeSourcePath(root, 'repo')
const evidence = () => ['/', ...path.split('/').filter(Boolean).map((_, i, parts) => '/' + parts.slice(0, i + 1).join('/'))].map(path => ({path, real:path, directory:true, linked:false, device:'1', inode:'2', uid:0, mode:0o40755, filesystem:'61267'}))
test('native scope is Project/runtime specific and never accepts arbitrary or cross-distro source paths', () => {
  const contract = layerfsResourceContracts().find(tool => tool.name === 'layerfs_runtime_context')!
  assert.equal(contract.parameters.additionalProperties, false)
  assert.ok(Object.hasOwn(contract.parameters.properties, 'sourceName'))
  assert.equal(Object.hasOwn(contract.parameters.properties, 'sourceWorkspace'), false)
  assert.notEqual(root, nativeSourceRoot('other', 'runtime'))
  assert.notEqual(root, nativeSourceRoot('project', 'other'))
  assert.match(root, /^\/var\/lib\/shadow-layerfs-sources\/[a-f0-9]{64}$/)
  for (const name of ['', '.', '..', '../repo', '/etc', '/mnt/c/repo', 'C:\\repo', '\\\\wsl.localhost\\Other\\repo', 'repo/sub', 'repo\0']) assert.throws(() => nativeSourcePath(root, name))
  assert.equal(verifyNativeSource(path, evidence()), JSON.stringify(evidence()))
})
test('actual filesystem evidence must be complete, native, unlinked, root-owned and protected', () => {
  for (const change of [{linked:true}, {real:'/elsewhere'}, {directory:false}, {filesystem:'16914836'}, {filesystem:'0'}, {uid:1000}, {mode:0o40777}]) {
    const value = evidence(); Object.assign(value[2]!, change)
    assert.throws(() => verifyNativeSource(path, value))
  }
  assert.throws(() => verifyNativeSource(path, evidence().slice(1)))
  const value = evidence(); value.at(-1)!.inode = '3'
  assert.notEqual(verifyNativeSource(path, value), verifyNativeSource(path, evidence()))
})
test('fixed owner probe uses bound distribution/root/Node without shell and refuses unscoped IPC paths', () => {
  assert.match(managedRunner, /'--distribution',w.distribution,'--user','root','--exec',w.node/)
  assert.match(managedRunner, /timeout:8000,maxBuffer:65536/)
  assert.match(managedRunner, /source_identity/)
  assert.match(nativeSourceProbe, /fs.lstat/)
  assert.match(nativeSourceProbe, /fs.statfs/)
  assert.match(nativeSourceProbe, /fs.realpath/)
})

test('fixed probe executes filesystem checks and stops before traversing an unsafe ancestor (synthetic fs)', async () => {
  async function probe(change: Record<string, unknown> = {}) {
    const seen: string[] = []
    const result = await new Promise<{code:number, output?:string}>(resolve => {
      const fs = {
        lstat: async (p: string) => { seen.push(p); return {dev:1n, ino:2n, uid:0n, mode:0o40755n, isDirectory:()=>true, isSymbolicLink:()=>false, ...(p === '/var/lib' ? change : {})} },
        realpath: async (p: string) => p,
        statfs: async () => ({type:61267n}),
      }
      runInNewContext(nativeSourceProbe, {require: (name:string) => {assert.equal(name,'node:fs/promises'); return fs}, process: {argv:['node',path], stdout:{write:(output:string)=>resolve({code:0,output})}, set exitCode(code:number) {resolve({code})}}})
    })
    return {...result, seen}
  }
  const successful = await probe()
  assert.equal(successful.code, 0)
  verifyNativeSource(path, JSON.parse(successful.output!))
  for (const change of [{isSymbolicLink:()=>true}, {uid:1000n}, {mode:0o40777n}, {isDirectory:()=>false}]) {
    const result = await probe(change)
    assert.equal(result.code, 1)
    assert.deepEqual(result.seen, ['/', '/var', '/var/lib'])
  }
})
