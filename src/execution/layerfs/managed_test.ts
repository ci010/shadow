import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { EventEmitter } from 'node:events'
import type { spawn } from 'node:child_process'
import { ManagedLayerFS, ManagedRuntimeError, spawnManagedDriver, managedLayerFS, closeManagedLayerFS, type Deployment, type ManagedDriver, type LayerFSInstallation } from './managed.ts'
import { LayerFSTool } from '../../tools/layerfs.ts'
import { ReadTool } from '../../tools/read.ts'
import { layerfsName } from './bridge.ts'
import { ToolNoEffectError, ToolOutcomeUnknownError, toolResultText } from '../../tools/tool.ts'
import type { ExecutionContext } from '../../tools/context.ts'

const signal = () => new AbortController().signal
const ready = { worker: 'running', answering: true, docker: 'ok', ready: true, sandboxVerified: false }
function owner(home: string): ExecutionContext {
  const tools: any = { executionMode: 'session' }; tools.dynamicOwner = tools
  return { projectId: 'one', channel: 'web', admin: true, isGroup: false, tools, cwd: home, signal: signal(), sessionId: 'web:test' } as ExecutionContext
}
async function fixture(work: (dir: string, installation: LayerFSInstallation) => Promise<void>) {
  const dir = await mkdtemp(join(process.cwd(), '.layerfs-managed-test-'))
  try {
    for (const name of ['agent', 'runtime']) {
      await mkdir(join(dir, 'api', name, 'src'), { recursive: true })
      await writeFile(join(dir, 'api', name, 'package.json'), JSON.stringify({ name: '@layerfs/' + name, type: 'module' }))
      await writeFile(join(dir, 'api', name, 'src', 'index.js'), 'throw Error("fixture must not execute")')
    }
    await work(dir, { apiRoot: dir, bundle: '/sealed/test-build', node: '/test/bin/node', distribution: 'TestWSL', image: 'sha256:' + 'a'.repeat(64) })
  } finally { await rm(dir, { recursive: true, force: true }) }
}
function fakeDriver(calls: string[], deployments: Deployment[]): ManagedDriver {
  let deployment: Deployment
  return {
    async request(action, input) {
      calls.push(action)
      if (action === 'open') { deployment = input as Deployment; deployments.push(deployment); return ready }
      if (action === 'status') return ready
      if (action === 'configuration') throw new ManagedRuntimeError('NotInitialized')
      if (action === 'create') return { kind: 'Initialized', project: deployment!.project }
      throw Error('unexpected action')
    },
    async close() { calls.push('close') },
  }
}

test('setup gates code execution; persists approval without env/restart and reuses a single Project worker', async () => {
  await fixture(async (dir, installation) => {
    const calls: string[] = [], deployments: Deployment[] = [], home = join(dir, 'home')
    const service = new ManagedLayerFS('one', home, () => fakeDriver(calls, deployments), 'win32')
    const tool = new LayerFSTool('one', undefined, service), context = owner(home)
    const request = { action: 'setup', installation, approved: true, allowRootWorker: true }
    try {
      assert.equal(JSON.parse(toolResultText(await tool.execute({ action: 'connect' }, context))).result.configured, false)
      assert.equal(JSON.parse(toolResultText(await tool.execute({ action: 'doctor' }, context))).result.runtime, 'not_checked')
      for (const patch of [{ admin: false }, { channel: 'a2a' }, { isGroup: true }, { scriptInvocation: true }, { recoveringToolCall: true }, { remoteWorkdir: {} }, { projectId: 'two' }, { tools: { executionMode: 'task' } }]) {
        await assert.rejects(tool.execute(request, { ...context, ...patch } as ExecutionContext))
      }
      for (const patch of [{ approved: false }, { allowRootWorker: false }, { installation: { ...installation, image: 'latest' } }]) await assert.rejects(tool.execute({ ...request, ...patch }, context), ToolNoEffectError)
      assert.deepEqual(calls, [])
      const setup = JSON.parse(toolResultText(await tool.execute(request, context)))
      assert.equal(setup.result.ready, true); assert.equal(setup.result.sandboxVerified, false)
      assert.equal(calls.filter(c => c === 'open').length, 1)
      await tool.execute({ action: 'connect' }, context)
      await service.connect(signal())
      assert.equal(calls.filter(c => c === 'open').length, 1)
      assert.equal(deployments[0]!.settings.sweep, false)
      assert.equal(deployments[0]!.settings.wsl.user, 'root')
      assert.match(deployments[0]!.settings.wsl.home, /^\/var\/lib\/shadow-layerfs\/[a-f0-9]{32}$/)
      assert.equal(deployments[0]!.project, layerfsName('one'))
      await assert.rejects(service.configuration(signal()), /no source has been imported/)
      let resolved = false
      const source = join(dir, 'source'); await mkdir(source); await writeFile(join(source, 'index.ts'), 'export const fixture = true')
      const importContext: ExecutionContext = { ...context, resolveToolTarget: async (_, operation) => {
        assert.equal(operation, 'filesystem.read'); resolved = true; return { cwd: source, fileChangeTarget: { nodeId: 'main', workdirId: 'registered' } }
      } }
      await assert.rejects(tool.execute({ action: 'create', workspace: 'registered' }, importContext), ToolNoEffectError)
      const preview = JSON.parse(toolResultText(await tool.execute({ action: 'import_preview', workspace: 'registered' }, importContext))).result
      await tool.execute({ action: 'create', workspace: 'registered', sourceReview: preview.reviewToken, sourceReviewed: true }, importContext)
      assert.equal(resolved, true); assert.equal(calls.filter(c => c === 'create').length, 1)
      await assert.rejects(tool.execute({ ...request, installation: { ...installation, distribution: 'OtherWSL' } }, context), /already approved/)
    } finally { await service.close() }
    const restarted = new ManagedLayerFS('one', home, () => fakeDriver(calls, deployments), 'win32')
    try {
      assert.equal((await restarted.describe()).configured, true)
      assert.equal((await restarted.describe()).phase, 'stopped')
      await restarted.connect(signal())
      assert.equal(calls.filter(c => c === 'open').length, 2)
      assert.deepEqual(deployments[0], deployments[1])
    } finally { await restarted.close() }
  })
})

test('Project Homes get independent Linux homes, and non-Windows setup refuses without loading code', async () => {
  await fixture(async (dir, installation) => {
    const calls: string[] = [], deployments: Deployment[] = []
    for (const home of ['a', 'b']) {
      const service = new ManagedLayerFS('one', join(dir, home), () => fakeDriver(calls, deployments), 'win32')
      try { await service.setup(installation, signal()) } finally { await service.close() }
    }
    assert.notEqual(deployments[0]!.settings.wsl.home, deployments[1]!.settings.wsl.home)
    assert.notEqual(deployments[0]!.settings.containerPrefix, deployments[1]!.settings.containerPrefix)
    const other = new ManagedLayerFS('two', join(dir, 'a'), () => { throw Error('must not launch') }, 'win32')
    await assert.rejects(other.describe(), /another Project/)
    const linux = new ManagedLayerFS('one', join(dir, 'c'), () => { throw Error('must not launch') }, 'linux')
    await assert.rejects(linux.setup(installation, signal()), /Windows\/WSL only/)
  })
})

test('failed startup and uncertain import retain a durable no-replay marker even after clean shutdown', async () => {
  await fixture(async (dir, installation) => {
    for (const failedAction of ['open', 'create']) {
      let starts = 0
      const home = join(dir, failedAction)
      const service = new ManagedLayerFS('one', home, () => ({
        async request(action) { if (action === 'open') starts++; if (action === failedAction) throw new ToolOutcomeUnknownError('lost reply'); return ready }, async close() {},
      }), 'win32')
      try {
        if (failedAction === 'open') await assert.rejects(service.setup(installation, signal()), ToolOutcomeUnknownError)
        else { await service.setup(installation, signal()); await assert.rejects(service.create(dir, signal()), ToolOutcomeUnknownError) }
        await assert.rejects(service.connect(signal()), ToolOutcomeUnknownError)
        assert.equal(starts, 1)
      } finally { await service.close() }
      const restarted = new ManagedLayerFS('one', home, () => { throw Error('must not replay') }, 'win32')
      await assert.rejects(restarted.connect(signal()), ToolOutcomeUnknownError)
      assert.equal((await restarted.describe()).phase, 'uncertain')
    }
  })
})

test('cancellation before setup does not save approval or launch; doctor/status never start a saved worker', async () => {
  await fixture(async (dir, installation) => {
    const home = join(dir, 'home'), calls: string[] = [], deployments: Deployment[] = []
    const service = new ManagedLayerFS('one', home, () => fakeDriver(calls, deployments), 'win32')
    await assert.rejects(service.setup(installation, AbortSignal.abort()))
    assert.equal((await service.describe()).configured, false); assert.deepEqual(calls, [])
    await service.setup(installation, signal()); await service.close()
    const restarted = new ManagedLayerFS('one', home, () => { throw Error('read must not start') }, 'win32')
    assert.equal((await restarted.describe()).phase, 'stopped')
    const status = await restarted.status(signal())
    assert.ok('runtime' in status); assert.equal(status.runtime, 'not_checked')
    await restarted.close()
  })
})

test('real managed IPC helper runs the public runtime contract against synthetic SDK only, then feeds the bridge', async () => {
  await fixture(async (dir, installation) => {
    // No WSL, Docker, real SDK or root process is invoked by this fixture.
    await writeFile(join(dir, 'api', 'runtime', 'src', 'index.js'), `
      import {mkdir, writeFile, readFile} from 'node:fs/promises'; import {join} from 'node:path';
      export class LayerFSRuntime { static async open(settings) {
       if (settings.sweep !== false) throw Error('sweep forbidden');
       await mkdir(settings.home,{recursive:true}); let initialized=false;
       return {worker:{start:async()=>{}}, status:async()=>({worker:{state:'running',answering:true},docker:{level:'ok',error:'SECRET_NOT_FOR_REPORT'}}),
        project:{start_init:async(name,source,options)=>{if(options.timeout!==300000)throw Error('timeout'); initialized=true; return {id:'test'};},
         get_init:async()=>({step:'done'}),list:async()=>initialized?[{name:${JSON.stringify(layerfsName('one'))},initialized:true,volume:'fixture-store',image:settings.image}]:[]},close:async()=>{}};
      }}
    `)
    await writeFile(join(dir, 'api', 'agent', 'src', 'index.js'), `export const LayerFS={open:async()=>({project:{list_branches:async()=>({volume:process.env.LAYERFS_VOLUME,home:process.env.LAYERFS_HOME})},workspace:{exec:async(ws,command,message,sinks)=>{await new Promise(r=>sinks.stdout.write('managed-route\\n',r));return {code:0}}},close:async()=>{}})}`)
    const home = join(dir, 'home')
    const service = managedLayerFS('one', home, () => new ManagedLayerFS('one', home, undefined, 'win32'))
    const tool = new LayerFSTool('one', home), context = owner(dir)
    try {
      const connected = await service.setup(installation, signal())
      assert.deepEqual(connected, ready)
      assert.doesNotMatch(JSON.stringify(connected), /SECRET_NOT_FOR_REPORT/)
      await assert.rejects(service.configuration(signal()), /no source has been imported/)
      await service.create(dir, signal())
      const config = await service.configuration(signal())
      assert.equal(config.env.LAYERFS_STORE_PATH, '/var/lib/docker/volumes/fixture-store/_data/global/store.sqlite')
      const result = JSON.parse(toolResultText(await tool.execute({ action: 'branches' }, context)))
      assert.equal(result.result.volume, 'fixture-store')
      assert.match(result.result.home, /^\/var\/lib\/shadow-layerfs\//)
      const workspace = 'layerfs:' + Buffer.from(JSON.stringify({ project: layerfsName('one'), sandbox: '1', path: '/workspaces/1' })).toString('base64url')
      const read = await new ReadTool(home).execute({ workspace, path: 'example.txt' }, { ...context, resolveToolTarget: async () => { throw Error('must not fall back to host') } })
      assert.equal(JSON.parse(toolResultText(read)).result.stdout.text, 'managed-route\n')
      assert.equal(managedLayerFS('one', home), service)
    } finally { await closeManagedLayerFS('one', home) }
    assert.equal(JSON.parse(await readFile(join(dir, 'home', 'state', 'layerfs', 'worker-state.json'), 'utf8')).phase, 'stopped')
  })
})

test('IPC Unknown retains execution-unknown semantics; Busy and timed-out shutdown always disconnect without kill', async () => {
  for (const code of ['Unknown', 'Busy', 'timeout']) {
    const child: any = new EventEmitter()
    let disconnected = 0, unreferenced = 0
    child.connected = true
    child.send = (request: any, callback: (error?: Error) => void) => {
      callback()
      if (code !== 'timeout') queueMicrotask(() => child.emit('message', { id: request.id, ok: false, code }))
    }
    child.disconnect = () => { child.connected = false; disconnected++ }
    child.unref = () => { unreferenced++; return child }
    child.kill = () => { throw Error('must never kill the daemon owner') }
    const driver = spawnManagedDriver({ launch: (() => child) as unknown as typeof spawn, requestTimeoutMs: 20 })
    if (code === 'Unknown') await assert.rejects(driver.request('create', {}, signal()), ToolOutcomeUnknownError)
    await assert.rejects(driver.close(), code === 'Busy' ? ManagedRuntimeError : ToolOutcomeUnknownError)
    assert.equal(disconnected, 1); assert.equal(unreferenced, 1)
  }
})

test('normal and failed-startup Project shutdown both own LayerFS cleanup, after active agents quiesce', async () => {
  const source = await readFile(new URL('../../runtime/main/project-runtime.ts', import.meta.url), 'utf8')
  assert.match(source, /cleanup\.push\(closeLayerFS\)/)
  assert.match(source, /\(\) => agent\.shutdown\(\),\s+closeLayerFS,/)
})

test('explicit operator override wins, including invalid overrides; managed setup cannot silently replace it', async () => {
  await fixture(async (dir, installation) => {
    const prior = process.env.SHADOW_LAYERFS_CONFIG
    const service = new ManagedLayerFS('one', join(dir, 'home'), () => { throw Error('override must not start managed code') }, 'win32')
    const tool = new LayerFSTool('one', undefined, service), context = owner(dir)
    try {
      process.env.SHADOW_LAYERFS_CONFIG = 'invalid-relative-config.json'
      await assert.rejects(tool.execute({ action: 'connect' }, context), /absolute operator-owned/)
      await assert.rejects(tool.execute({ action: 'setup', approved: true, allowRootWorker: true, installation }, context), /explicit operator configuration was not replaced/)
      assert.equal((await service.describe()).configured, false)
    } finally {
      if (prior === undefined) delete process.env.SHADOW_LAYERFS_CONFIG
      else process.env.SHADOW_LAYERFS_CONFIG = prior
      await service.close()
    }
  })
})
