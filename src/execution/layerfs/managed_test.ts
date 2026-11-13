import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { ManagedLayerFS, type Deployment, type ManagedDriver } from './managed.ts'
import { LayerFSTool } from '../../tools/layerfs.ts'
import { ToolOutcomeUnknownError } from '../../tools/tool.ts'
import type { ExecutionContext } from '../../tools/context.ts'

const ready = { worker: 'running', answering: true, docker: 'ok', ready: true, sandboxVerified: false }
const signal = () => new AbortController().signal
export function owner(home: string): ExecutionContext {
  const tools: any = { executionMode: 'session' }; tools.dynamicOwner = tools
  return { projectId: 'one', channel: 'web', admin: true, isGroup: false, tools, cwd: home, signal: signal(), sessionId: 'web:test' } as ExecutionContext
}
test('installation authority, single owner, independent Homes and durable unknown startup', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.layerfs-managed-test-'))
  try {
    for (const name of ['agent', 'runtime']) {
      await mkdir(join(dir, 'api', name, 'src'), { recursive: true })
      await writeFile(join(dir, 'api', name, 'package.json'), JSON.stringify({ name: '@layerfs/' + name, type: 'module' }))
      await writeFile(join(dir, 'api', name, 'src', 'index.js'), 'throw Error("not executed")')
    }
    const installation = { apiRoot: dir, bundle: '/sealed', node: '/bin/node', distribution: 'TestWSL', image: 'sha256:' + 'a'.repeat(64) }
    const deployments: Deployment[] = []
    const factory = (): ManagedDriver => ({ request: async (action, input) => { if (action === 'open') deployments.push(input as Deployment); return ready }, close: async () => {} })
    const home = join(dir, 'one'), service = new ManagedLayerFS('one', home, factory, 'win32')
    const tool = new LayerFSTool('one', home, service), context = owner(home)
    const request = { action: 'setup', installation, approved: true, allowRootWorker: true }
    for (const patch of [{ admin: false }, { channel: 'a2a' }, { isGroup: true }, { scriptInvocation: true }, { recoveringToolCall: true }, { remoteWorkdir: {} }, { projectId: 'two' }, { tools: { executionMode: 'task' } }]) await assert.rejects(tool.execute(request, { ...context, ...patch } as ExecutionContext))
    assert.equal(deployments.length, 0)
    try {
      await tool.execute(request, context)
      await service.connect(signal())
      assert.equal(deployments.length, 1)
      assert.equal(deployments[0]!.settings.sweep, false)
      assert.equal(deployments[0]!.settings.wsl.user, 'root')
      await assert.rejects(tool.execute({ ...request, installation: { ...installation, distribution: 'other' } }, context), /already approved/)
    } finally { await service.close() }
    const next = new ManagedLayerFS('one', home, () => { throw Error('status must not start') }, 'win32')
    assert.equal((await next.describe()).phase, 'stopped')
    await next.status(signal()); await next.close()
    const second = new ManagedLayerFS('one', join(dir, 'two'), factory, 'win32')
    await second.setup(installation, signal()); await second.close()
    assert.notEqual(deployments[0]!.settings.wsl.home, deployments[1]!.settings.wsl.home)
    const failed = new ManagedLayerFS('one', join(dir, 'failed'), () => ({ request: async () => { throw new ToolOutcomeUnknownError('lost') }, close: async () => {} }), 'win32')
    await assert.rejects(failed.setup(installation, signal()), ToolOutcomeUnknownError)
    await failed.close()
    const restart = new ManagedLayerFS('one', join(dir, 'failed'), () => { throw Error('no replay') }, 'win32')
    await assert.rejects(restart.connect(signal()), ToolOutcomeUnknownError)
    const foreign = new ManagedLayerFS('other', home, factory, 'win32')
    await assert.rejects(foreign.describe(), /another Project/)
  } finally { await rm(dir, { recursive: true, force: true }) }
})
