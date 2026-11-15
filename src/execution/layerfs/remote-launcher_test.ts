import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { ManagedLayerFS } from './managed.ts'
import { LayerFSResources } from './resource-service.ts'
import { nativeSourceRoot } from './native-source.ts'
import { withLayerFSHostAuthority } from './host-authority.ts'
import { remoteLayerFSLeaseFactory } from './remote-lease.ts'
import { layerFSPayloadHash, type RemoteLayerFSCall } from './remote-contract.ts'
import type { ExecutionContext } from '../../tools/context.ts'
import { RemoteLayerFSRuntimes } from './remote-runtime.ts'

// Real owner IPC and loopback launcher adapter, synthetic pinned official modules.
// Does not invoke WSL, Docker, real source Init or a production Shadow runtime.
test('remote launcher guards list/open/get_init, source-less Init, rebound source, installation change and disconnected/expired leases', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.layerfs-remote-launcher-'))
  const project = 'a'.repeat(32), image = 'sha256:' + 'a'.repeat(64)
  const target = { nodeId: 'windows', pairingId: 'pair', projectScope: project }
  const installation = { apiRoot: dir, bundle: '/fixture', node: '/bin/node', distribution: 'Fixture', image }
  const tools: any = { executionMode: 'session' }; tools.dynamicOwner = tools
  const owner = { projectId: project, sessionId: 'web:owner', channel: 'web', admin: true, isGroup: false, tools, signal: AbortSignal.timeout(30000) } as ExecutionContext
  let live = { online: true, epoch: 1, pairingId: target.pairingId }, clock = Date.now(), inode = '1'
  let service: LayerFSResources | undefined
  let facade: RemoteLayerFSRuntimes | undefined
  try {
    for (const name of ['agent', 'runtime']) {
      await mkdir(join(dir, 'api', name, 'src'), { recursive: true })
      await writeFile(join(dir, 'api', name, 'package.json'), JSON.stringify({ name: '@layerfs/' + name, type: 'module' }))
    }
    await writeFile(join(dir, 'api/runtime/src/index.js'), `export const LayerFSRuntime={open:async()=>({worker:{start:async()=>{}},status:async()=>({worker:{state:'running',answering:true},docker:{level:'ok'}}),close:async()=>{},project:{list:async()=>[{name:'repo',initialized:true,image:'${image}',volume:'volume-repo'}],get_init:async id=>({id}),start_init:async()=>{throw Error('must not dispatch Init')}},volume:{list:async()=>[{name:'volume-repo',owner:'this',project:'repo',live:true}]}})};`)
    await writeFile(join(dir, 'api/agent/src/index.js'), 'export const LayerFS={open:async()=>({close:async()=>{}})};')
    service = new LayerFSResources(project, join(dir, 'home'), { installation: async () => installation, runtime: home => {
      const runtime = new ManagedLayerFS(project, home, undefined, 'win32')
      runtime.sourceIdentity = async path => ['/', ...path.split('/').filter(Boolean).map((_, i, parts) => '/' + parts.slice(0, i + 1).join('/'))].map(path => ({ path, real: path, directory: true, linked: false, device: '1', inode, uid: 0, mode: 0o40755, filesystem: '61267' }))
      return runtime
    } })
    await service.runtimePlan('fixture', owner); await service.runtimeStart('fixture', owner)
    const obtain = async (sourceName?: string) => {
      const input = { runtimeId: 'fixture', ...(sourceName ? { sourceName } : {}) }
      const call: RemoteLayerFSCall = { version: 1, action: 'runtime_context', input, authority: { version: 1, ...target, actorId: 'owner', kind: 'direct-owner', ownerSessionId: owner.sessionId, requestId: randomUUID(), action: 'runtime_context', payloadHash: layerFSPayloadHash('runtime_context', input), expiresAt: new Date(Date.now() + 60000).toISOString() } }
      const entry = await withLayerFSHostAuthority(call, target, owner.signal, context => service!.runtimeContext('fixture', context, sourceName, remoteLayerFSLeaseFactory(call, () => live, () => clock, 1000)))
      const text = await readFile(entry.launcher, 'utf8')
      const profile = JSON.parse(text.match(/const profile = (.*);/)![1]!)
      return async (action: string, input: unknown) => {
        const response = await fetch(`http://127.0.0.1:${profile.port}`, { method: 'POST', headers: { authorization: 'Bearer ' + profile.token }, body: JSON.stringify({ action, input }) })
        return await response.json() as { ok: boolean; code?: string; result?: unknown }
      }
    }
    const sourceLess = await obtain()
    assert.equal((await sourceLess('official_project', { method: 'list', args: [] })).ok, true)
    assert.equal((await sourceLess('official_project', { method: 'get_init', args: ['existing'] })).ok, true)
    assert.equal((await sourceLess('configuration', { project: 'repo' })).ok, true)
    const refusedInit = await sourceLess('official_project', { method: 'start_init', args: ['new', nativeSourceRoot(project, 'fixture') + '/source', { image, timeout: 1000 }] })
    assert.equal(refusedInit.ok, false)
    assert.equal(refusedInit.code, 'SourceScopeMismatch')
    live = { ...live, online: false }
    for (const [action, input] of [['official_project', { method: 'list', args: [] }], ['official_project', { method: 'get_init', args: ['existing'] }], ['configuration', { project: 'repo' }]] as const) assert.equal((await sourceLess(action, input)).ok, false)
    live = { ...live, online: true, epoch: 2 }
    assert.equal((await sourceLess('official_project', { method: 'list', args: [] })).ok, false)
    const rebound = await obtain('source')
    inode = '2'
    assert.equal((await rebound('configuration', { project: 'repo' })).ok, false)
    inode = '1'
    const expired = await obtain()
    clock += 1001
    assert.equal((await expired('official_project', { method: 'get_init', args: ['existing'] })).ok, false)
    const changed = await obtain()
    const configFile = join(dir, 'home', 'layerfs-catalog', 'runtimes', 'fixture', 'runtime.json')
    const original = await readFile(configFile, 'utf8'), saved = JSON.parse(original)
    saved.installation.image = 'sha256:' + 'b'.repeat(64)
    await writeFile(configFile, JSON.stringify(saved))
    assert.equal((await changed('configuration', { project: 'repo' })).ok, false)
    await writeFile(configFile, original)
    facade = new RemoteLayerFSRuntimes(join(dir, 'facade'), target.nodeId, () => live, { platform: 'win32', resources: () => service! })
    const invoke = async (action: 'runtime_context' | 'contexts_revoke', input: Record<string, unknown>, kind: 'direct-owner' | 'project-host') => {
      const call: RemoteLayerFSCall = { version: 1, action, input, authority: { version: 1, ...target, actorId: kind === 'project-host' ? 'project-runtime' : 'owner', kind, ownerSessionId: owner.sessionId, requestId: randomUUID(), action, payloadHash: layerFSPayloadHash(action, input), expiresAt: new Date(Date.now() + 60000).toISOString() } }
      return withLayerFSHostAuthority(call, target, owner.signal, context => facade!.dispatch(call, context))
    }
    const remoteEntry = await invoke('runtime_context', { runtimeId: 'fixture' }, 'direct-owner') as { result: { launcher: string } }
    const profile = JSON.parse((await readFile(remoteEntry.result.launcher, 'utf8')).match(/const profile = (.*);/)![1]!)
    const list = async () => (await (await fetch(`http://127.0.0.1:${profile.port}`, { method: 'POST', headers: { authorization: 'Bearer ' + profile.token }, body: JSON.stringify({ action: 'official_project', input: { method: 'list', args: [] } }) })).json() as { ok: boolean }).ok
    assert.equal(await list(), true)
    await invoke('contexts_revoke', {}, 'project-host')
    assert.equal(await list(), false) // same live connection; Project epoch changed
  } finally { await facade?.close(); await service?.close(); await rm(dir, { recursive: true, force: true }) }
})
