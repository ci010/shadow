import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ManagedLayerFS } from './managed.ts'
import { LayerFSResources } from './resource-service.ts'
import { nativeSourceRoot } from './native-source.ts'
import { branchWorkspace } from './workspace-identity.ts'
import type { ExecutionContext } from '../../tools/context.ts'

// Executes the actual owner IPC, private launcher and bridge against a synthetic
// implementation of the pinned official contract. No real SDK/WSL/Docker runs.
test('official exec entry -> two projects/images -> registration -> fork and ordinary tools; identity and unknown refusals', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.layerfs-resources-test-'))
  const image = 'sha256:' + 'a'.repeat(64), otherImage = 'sha256:' + 'b'.repeat(64)
  const tools: any = { executionMode: 'session' }; tools.dynamicOwner = tools
  const context = { projectId: 'one', sessionId: 'owner', admin: true, channel: 'web', isGroup: false, tools, signal: new AbortController().signal } as ExecutionContext
  let service: LayerFSResources | undefined
  try {
    const state = join(dir, 'fixture.json'); await writeFile(state, JSON.stringify({ projects: [], branches: {} }))
    for (const name of ['agent', 'runtime']) {
      await mkdir(join(dir, 'api', name, 'src'), { recursive: true })
      await writeFile(join(dir, 'api', name, 'package.json'), JSON.stringify({ name: '@layerfs/' + name, type: 'module' }))
    }
    const storage = `import {readFileSync,writeFileSync} from 'node:fs';const path=${JSON.stringify(state)};const read=()=>JSON.parse(readFileSync(path));const save=s=>writeFileSync(path,JSON.stringify(s));`
    await writeFile(join(dir, 'api/runtime/src/index.js'), storage + `
export const LayerFSRuntime={open:async settings=>({
 worker:{start:async()=>{}},status:async()=>({worker:{state:'running',answering:true},docker:{level:'ok'}}),close:async()=>{},
 project:{list:async()=>read().projects,start_init:async(name,source,options)=>{const s=read();s.projects.push({name,source,image:options.image,volume:'volume-'+name,initialized:true});save(s);if(name==='lost')throw Object.assign(Error('lost init receipt'),{code:'Unknown'});return {id:name}},get_init:async id=>({step:'done',project:read().projects.find(p=>p.name===id)})},
 volume:{list:async()=>read().projects.map(p=>({name:p.volume,owner:p.name==='foreign'?'other':'this',project:p.name,live:true}))}
})};`)
    await writeFile(join(dir, 'api/agent/src/index.js'), storage + `
export const LayerFS={open:async project=>({
 fs:{stat:async(ref,path)=>{if(!['aa','bb'].includes(ref)&&!read().branches[project+':'+ref])throw Object.assign(Error('missing ref'),{code:'NotFound'});return {type:path==='/'?'directory':'file',root:'aa',size:6}},read:async()=>({root:'aa',text:'hello\\n',truncated:false,lineTruncated:false})},
 project:{list_sandboxes:async()=>({items:[],hasMore:false}),list_branches:async()=>({items:[{name:'main',base:'aa'}],hasMore:false})},branch:{fork:async(branch,ref)=>{const s=read();s.branches[project+':'+branch]=ref;save(s);return {kind:'Forked',branch,base:ref}}},close:async()=>{}
})};`)
    const installation = { apiRoot: dir, bundle: '/fixture', node: '/bin/node', distribution: 'Fixture', image }
    const sourceDirectory = nativeSourceRoot('one', 'test') + '/source'
    let allowed = true, inode = '1', linked = false, filesystem = '61267'
    service = new LayerFSResources('one', join(dir, 'home'), { installation: async () => installation, runtime: home => {
      const runtime = new ManagedLayerFS('one', home, undefined, 'win32')
      // Synthetic filesystem evidence only; actual owner IPC/launcher/SDK below.
      runtime.sourceIdentity = async path => {
        assert.ok([sourceDirectory, nativeSourceRoot('one', 'test') + '/other'].includes(path))
        if (!allowed) throw Error('read denied')
        return ['/', ...path.split('/').filter(Boolean).map((_, i, parts) => '/' + parts.slice(0, i + 1).join('/'))].map(path => ({ path, real:path, directory:true, linked, device:'1', inode, uid:0, mode:0o40755, filesystem }))
      }
      return runtime
    } })
    await service.runtimePlan('test', context); await service.runtimeStart('test', context)
    await assert.rejects(service.runtimeStart('test', context), /consumed/)
    const entry = await service.runtimeContext('test', context, 'source')
    assert.equal(entry.sourcePath, sourceDirectory)
    assert.doesNotMatch(JSON.stringify(entry), /token|endpoint\.json|Bearer/)
    const transport = JSON.parse((await readFile(entry.launcher, 'utf8')).match(/const profile = (.*);/)![1]!)
    const endpoint = `http://127.0.0.1:${transport.port}`
    assert.equal((await fetch(endpoint, { method: 'POST', headers: { authorization: 'Bearer wrong' }, body: '{}' })).status, 403)
    const invalid = await fetch(endpoint, { method: 'POST', headers: { authorization: `Bearer ${transport.token}` }, body: JSON.stringify({ action: 'eval', input: { module: '/evil' } }) })
    assert.equal((await invalid.json() as { code: string }).code, 'InvalidAction')
    await assert.rejects(service.runtimeContext('test', { ...context, sessionId: 'other' }), /owner/)
    const secondEntry = await service.runtimeContext('test', context, 'other')
    const secondScript = join(dir, 'second.mjs')
    await writeFile(secondScript, `export default async ({runtime})=>{await runtime.project.start_init('second',${JSON.stringify(secondEntry.sourcePath)},{image:${JSON.stringify(otherImage)},timeout:1000})}`)
    await assert.rejects(promisify(execFile)(entry.executable, [entry.launcher, secondScript], { env: { ...process.env, ...entry.env }, windowsHide: true }), /SourceScopeMismatch/)
    await promisify(execFile)(secondEntry.executable, [secondEntry.launcher, secondScript], { env: { ...process.env, ...secondEntry.env }, windowsHide: true, timeout: 10000 })
    assert.notEqual(secondEntry.sourcePath, entry.sourcePath)
    const script = join(dir, 'init.mjs')
    await writeFile(script, `export default async ({runtime})=>{for(const [name,image] of [['first',${JSON.stringify(image)}],['foreign',${JSON.stringify(image)}]]){const job=await runtime.project.start_init(name,${JSON.stringify(sourceDirectory)},{image,timeout:1000});console.log(JSON.stringify(await runtime.project.get_init(job.id)))}try{await runtime.project.start_init('lost',${JSON.stringify(sourceDirectory)},{image:${JSON.stringify(image)},timeout:1000})}catch(e){console.error(e.message)}try{await runtime.project.start_init('lost',${JSON.stringify(sourceDirectory)},{image:${JSON.stringify(image)},timeout:1000})}catch(e){console.error(e.message)}}`)
    const result = await promisify(execFile)(entry.executable, [entry.launcher, script], { env: { ...process.env, ...entry.env }, windowsHide: true, timeout: 10000 })
    assert.equal(result.stdout.trim().split('\n').length, 2)
    assert.match(result.stderr, /lost init receipt/); assert.match(result.stderr, /ImportAlreadyAttempted/)
    assert.equal(JSON.parse(await readFile(state, 'utf8')).projects.filter((p: any) => p.name === 'lost').length, 1)
    const guarded = join(dir, 'guarded.mjs')
    await writeFile(guarded, `export default async({runtime})=>{await runtime.project.start_init('guarded',${JSON.stringify(sourceDirectory)},{image:${JSON.stringify(image)},timeout:1000})}`)
    const runGuarded = () => promisify(execFile)(entry.executable, [entry.launcher, guarded], { env: { ...process.env, ...entry.env }, windowsHide: true })
    context.admin = false
    await assert.rejects(runGuarded(), /SourceScopeRequired/)
    context.admin = true
    allowed = false
    await assert.rejects(runGuarded(), /SourceScopeRequired/)
    allowed = true; inode = '2'
    await assert.rejects(runGuarded(), /SourceScopeRequired/)
    inode = '1'; linked = true
    await assert.rejects(service.runtimeContext('test', context, 'source'), /Linked/)
    await assert.rejects(runGuarded(), /SourceScopeRequired/)
    linked = false; filesystem = '16914836'
    await assert.rejects(runGuarded(), /SourceScopeRequired/)
    await assert.rejects(service.runtimeContext('test', context, 'source'), /DrvFS/)
    filesystem = '61267'
    for (const name of ['/mnt/c/source', '/etc', '\\wsl.localhost\Other\source', '../other']) await assert.rejects(service.runtimeContext('test', context, name), /directory name/)
    const unscoped = await service.runtimeContext('test', context)
    await assert.rejects(promisify(execFile)(unscoped.executable, [unscoped.launcher, guarded], { env: { ...process.env, ...unscoped.env }, windowsHide: true }), /SourceScopeRequired/)
    assert.equal(JSON.parse(await readFile(state, 'utf8')).projects.some((p: any) => p.name === 'guarded'), false)
    const demo = join(dir, 'sdk-init.mjs')
    await writeFile(demo, await readFile(new URL('../../skills/builtin/layerfs/sdk-init.mjs', import.meta.url), 'utf8'))
    const demonstrated = await promisify(execFile)(entry.executable, [entry.launcher, demo, 'tiny-demo', sourceDirectory, image, 'https://example.invalid/tiny-fixture', 'a'.repeat(40)], { env: { ...process.env, ...entry.env }, windowsHide: true })
    assert.equal(JSON.parse(demonstrated.stdout.trim().split('\n').at(-1)!).baselineRef, 'aa')
    const spec = { runtimeId: 'test', name: 'one', layerfsProject: 'first', image, baselineRef: 'aa', source: { repository: 'https://example.com/one', commit: 'a'.repeat(40) } }
    const first = await service.register(spec, context)
    const second = await service.register({ ...spec, name: 'two', layerfsProject: 'second', image: otherImage, baselineRef: 'bb' }, context)
    assert.equal(service.catalog.list().length, 2); assert.notEqual(first.revision, second.revision)
    await assert.rejects(service.register(spec, { ...context, projectId: 'two' }), /Project/)
    await assert.rejects(service.register({ ...spec, image: otherImage }, context), /image differs/)
    await assert.rejects(service.register({ ...spec, layerfsProject: 'foreign' }, context), /ResourceOwnershipMismatch/)
    await assert.rejects(service.register({ ...spec, layerfsProject: 'missing' }, context), /NotInitialized/)
    await assert.rejects(service.register({ ...spec, baselineRef: 'ff' }, context))
    await assert.rejects(service.register({ ...spec, sdkModule: '/evil' }, context))
    let mount = ''
    await service.createWorkspace({ source: first.revision, branch: 'work', idempotencyKey: 'one' }, context, async value => { mount = value; return { id: 'registered-one' } }, () => {})
    const receipt = JSON.parse(String(await service.execute('read', { workspace: mount, path: '/README.md' }, context)))
    assert.equal(receipt.result.text, 'hello\n')
    assert.equal(JSON.parse(await readFile(state, 'utf8')).branches['first:work'], 'aa')
    const forged = branchWorkspace('first', 'forged', { ownerProject: 'one', runtimeId: 'test', resourceId: first.revision })
    await assert.rejects(service.execute('read', { workspace: forged, path: '/README.md' }, context), /forged/)
    // Ordinary exec owns stderr and nonzero status rather than an internal bg pipeline.
    await writeFile(script, "export default async()=>{console.error('fixture failure');process.exitCode=7}")
    await assert.rejects(promisify(execFile)(entry.executable, [entry.launcher, script], { env: { ...process.env, ...entry.env }, windowsHide: true }), (error: any) => error.code === 7 && /fixture failure/.test(error.stderr))
    await service.close(); service = undefined
    await assert.rejects(fetch(endpoint))
    await assert.rejects(promisify(execFile)(entry.executable, [entry.launcher, join(dir, 'gone.mjs')], { env: { ...process.env, ...entry.env }, windowsHide: true }))
  } finally { await service?.close(); await rm(dir, { recursive: true, force: true }) }
})
