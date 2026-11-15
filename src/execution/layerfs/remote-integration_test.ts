import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { RemoteLayerFSRuntimes } from './remote-runtime.ts'
import { RemoteLayerFSService } from './remote-service.ts'
import { RemoteLayerFSGateway, registerRemoteLayerFSGateway } from './remote-gateway.ts'
import { remoteLayerFSOwnerVerifier } from './remote-owner.ts'
import { LayerFSResources } from './resource-service.ts'
import { branchWorkspace } from './workspace-identity.ts'
import { LocalExecutor } from '../local-executor.ts'
import { ProjectExecutor } from '../../projects/executor.ts'
import { managedProjectScope } from '../managed-workdir.ts'
import { ProcessManager } from '../processes/manager.ts'
import { createLayerFSHandler } from '../../vfs/layerfs.ts'
import { LayerFSTool } from '../../tools/layerfs.ts'
import { layerfsRoute } from '../../tools/layerfs-route.ts'
import { toolResultText, isCompletedToolFailure } from '../../tools/tool.ts'
import type { ExecutionContext } from '../../tools/context.ts'
import type { FolderRecord, LayerFSFolderRecord } from '../../folders/contracts.ts'
import type { SessionState } from '../../sessions/session-store.ts'
import { LAYERFS_REMOTE_OPERATION } from './remote-contract.ts'

// Real Main gateway -> ProjectExecutor -> LocalExecutor -> typed Child handler ->
// target resource/workspace services. Only official SDK/runtime drivers are synthetic.
// This neither installs LayerFS nor launches WSL/Docker/a real worker.
test('typed remote production adapters route lifecycle, resource, workspace, ordinary tools and VFS without Main fallback', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.layerfs-remote-integration-'))
  const projectId = 'main-project', scope = managedProjectScope(projectId), image = 'sha256:' + 'a'.repeat(64)
  const target = { nodeId: 'windows', pairingId: 'paired-credential', projectScope: scope }
  let online = true, epoch = 1, checkpoints = 0
  const branches = new Map<string, string>([['aa', 'baseline\n']])
  const folders: FolderRecord[] = []
  const tools: any = { executionMode: 'session' }; tools.dynamicOwner = tools
  const context = { projectId, sessionId: 'web:owner', channel: 'web', senderId: 'human-owner', admin: true, isGroup: false, tools, signal: AbortSignal.timeout(30000), remoteWorkdir: { nodeId: target.nodeId, workdirId: 'registered-native', executor: {} } } as ExecutionContext
  const state = { projectId, sessionId: context.sessionId, mode: 'session' } as SessionState
  let resources: LayerFSResources | undefined
  const runtimes = new RemoteLayerFSRuntimes(join(dir, 'target'), target.nodeId, () => ({ online, epoch, pairingId: target.pairingId }), { platform: 'win32', resources: (project, home) => resources = new LayerFSResources(project, home, {
    installation: async () => ({ apiRoot: dir, bundle: '/fixture', node: '/bin/node', distribution: 'Fixture', image }),
    runtime: () => ({ setup: async () => ({ ready: true }), status: async () => ({ ready: true, worker: 'running', answering: true, docker: 'ok' }), close: async () => {},
      sourceIdentity: async () => { throw Error('unused source probe') }, execContext: async () => { throw Error('unused launcher') }, projectConfiguration: async () => ({ sdkModule: '/fixture/agent.mjs', env: {} }) as any }),
    bridge: async (_config, officialProject, action, input, _signal, _timeout, lifecycle) => {
      const args = input as any
      const branch = args.workspace ? JSON.parse(Buffer.from(args.workspace.slice(8), 'base64url').toString()).branch : args.branch
      let result: unknown
      if (action === 'validate_ref') result = { ref: args.ref }
      else if (action === 'fork') { branches.set(args.branch, branches.get(args.ref)!); result = { branch: args.branch } }
      else if (action === 'branch_workspace') result = { workspace: branchWorkspace(officialProject, branch, args.binding) }
      else if (action === 'status') result = { branch }
      else if (action === 'read') result = { text: branches.get(branch) }
      else if (action === 'write') { branches.set(branch, args.content); checkpoints++; result = { checkpoint: checkpoints } }
      else if (action === 'search') result = { items: branches.get(branch)?.includes(args.query) ? ['/README.md'] : [], hasMore: false }
      else if (action === 'exec') { lifecycle?.observe('live target progress\n'); checkpoints++; result = { code: 7, stdout: { text: 'target stdout\n' }, checkpoint: checkpoints } }
      else if (action === 'history') result = { items: [{ id: 'aa' }], hasMore: false }
      else if (action === 'branches') result = { items: [...branches.keys()].map(name => ({ name })), hasMore: false }
      else if (action === 'diff_commits') result = { items: ['/README.md'], hasMore: false }
      else throw Error('Unexpected SDK action ' + action)
      return JSON.stringify({ ok: true, result })
    },
  }) })
  const service = new RemoteLayerFSService({ ...target, directory: join(dir, 'receipts'), authorize: async () => { if (!online) throw Error('offline') }, dispatch: (call, ctx, observe) => runtimes.dispatch(call, ctx, observe) })
  const local = new LocalExecutor(new ProcessManager(), target.nodeId, [service], (request, signal) => service.admit(request, signal).then(() => {}))
  const executor = new ProjectExecutor(projectId, local, request => { assert.equal(request.operation, LAYERFS_REMOTE_OPERATION); if (!online) throw Error('offline') })
  const gateway = new RemoteLayerFSGateway({ projectId, folders: () => folders, executor,
    target: node => { if (!online || node !== target.nodeId) throw Error('offline'); return target },
    verify: remoteLayerFSOwnerVerifier({ projectId, state: id => id === context.sessionId ? state : undefined, assertFolderAccess: () => {}, records: async () => [] }),
    register: async (mount, location) => { const folder: LayerFSFolderRecord = { id: randomUUID(), kind: 'layerfs', projectId, name: 'remote branch', mount, location, workdir: { version: 2, nodeId: 'layerfs', workdirId: mount }, path: 'layerfs-branch:fixture', createdAt: new Date().toISOString() }; folders.push(folder); return folder }, validateWork: () => {},
  })
  const unregister = registerRemoteLayerFSGateway(projectId, dir, gateway)
  try {
    const invoke = async (action: Parameters<typeof gateway.tryCall>[0], args: Record<string, unknown> = {}) => JSON.parse(toolResultText((await gateway.tryCall(action, args, context))!))
    assert.equal((await invoke('runtime_plan', { runtimeId: 'fixture' })).result.phase, 'planned')
    assert.equal((await invoke('runtime_start', { runtimeId: 'fixture' })).result.ready, true)
    const resource = (await invoke('resource_register', { runtimeId: 'fixture', name: 'fixture', layerfsProject: 'repo', baselineRef: 'aa', image, source: { repository: 'https://example.invalid/repo', commit: 'a'.repeat(40) } })).result
    assert.equal(resource.projectId, scope)
    const created = JSON.parse((await gateway.createWorkspace({ source: resource.revision, branch: 'first', idempotencyKey: 'first' }, context))!)
    const folder = folders.find(f => f.id === created.workspaceId) as LayerFSFolderRecord
    assert.equal(folder.location?.nodeId, 'windows')
    assert.equal(resources!.catalog.hasWorkspace(folder.mount), true)
    const selected = { ...context, remoteWorkdir: undefined, layerfsWorkdir: { workspace: folder.mount } }
    assert.equal(toolResultText((await layerfsRoute('read', { path: 'README.md' }, selected, dir))!), 'baseline\n')
    await layerfsRoute('write', { path: 'README.md', content: 'remote change\n' }, selected, dir)
    assert.equal(toolResultText((await layerfsRoute('read', { path: 'README.md' }, selected, dir))!), 'remote change\n')
    const grep = JSON.parse(toolResultText((await layerfsRoute('search', { handler: 'grep', path: '/', query: 'remote' }, selected, dir))!))
    assert.deepEqual(grep.result.items, ['/README.md'])
    let progress = ''
    const exec = await layerfsRoute('exec', { script: 'exit 7' }, selected, dir, { run: start => start(selected.signal, text => { progress += text }) })
    assert.equal(progress, 'live target progress\n')
    assert.equal(isCompletedToolFailure(exec!), true)
    assert.equal(JSON.parse(toolResultText(exec!)).result.code, 7)
    assert.equal(checkpoints, 2)
    const second = JSON.parse((await gateway.createWorkspace({ source: resource.revision, branch: 'second', idempotencyKey: 'second' }, context))!)
    const secondFolder = folders.find(f => f.id === second.workspaceId) as LayerFSFolderRecord
    assert.equal(branches.get('second'), 'baseline\n')
    const vfs = createLayerFSHandler({ projectId, folders: () => folders, existing: () => { throw Error('Main service must not be used') }, remote: async (f, action, args, ctx) => toolResultText((await gateway.tryCall(action, { ...args, workspace: f.mount }, ctx))!) })
    const history = await vfs.read(`${folder.id}/history/0`, context)
    assert.match(String(history), /aa/)
    online = false; epoch++
    await assert.rejects(new LayerFSTool(projectId, dir).execute({ action: 'read', workspace: folder.mount, path: '/README.md' }, selected), /offline/)
    assert.equal(branches.get('first'), 'remote change\n')
    online = true; target.pairingId = 're-paired'
    await assert.rejects(gateway.tryCall('read', { workspace: secondFolder.mount, path: '/README.md' }, selected), /pairing\/Project changed/)
  } finally { unregister(); await runtimes.close(); await rm(dir, { recursive: true, force: true }) }
})
