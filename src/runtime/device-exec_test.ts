import assert from 'node:assert/strict'
import { once } from 'node:events'
import { mkdir, readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { join } from 'node:path'
import test from 'node:test'
import type { MainCluster } from '../cluster/main-cluster.ts'
import { ConfigSchema } from '../config/schema.ts'
import type { ExecutionRequestV2 } from '../execution/contracts.ts'
import type { Executor } from '../execution/executor.ts'
import { LocalExecutor } from '../execution/local-executor.ts'
import { ManagedChildWorkdirs } from '../execution/managed-child-workdirs.ts'
import { DEVICE_HOME_WORKDIR } from '../execution/device-home.ts'
import { ProcessManager } from '../execution/processes/manager.ts'
import { DURABLE_SHELL_OPERATION } from '../execution/shell-journal.ts'
import { folderFixture } from '../folders/test-fixtures.ts'
import { ProjectCatalog } from '../projects/catalog.ts'
import { ProjectConfigStore } from '../projects/config-store.ts'
import { createProjectScope } from '../projects/scope.ts'
import { CopilotAuthenticatorV2 } from '../providers/copilot-v2.ts'
import { createProjectRuntime } from './main/project-runtime.ts'

// Real owner tool loop, Project admission and Child operation handlers. Only
// model inference and the device transport are fixture-backed.
test('owner device exec starts in the exact Child home without a Workspace or direct-read opt-in', { timeout: 60_000 }, async t => {
  const { root, workspace } = await folderFixture(t)
  const home = join(workspace, 'project')
  const childHome = join(root, 'child-home')
  await Promise.all([mkdir(home), mkdir(childHome)])
  const workdirs = new ManagedChildWorkdirs(join(root, 'child-managed'), 'child', [], childHome)
  await workdirs.init()
  const child = new LocalExecutor(new ProcessManager(), 'child', workdirs.operationHandlers,
    (request, signal) => workdirs.assertCanExecute(request, signal))
  const dispatched: ExecutionRequestV2[] = []
  const transport: Executor = {
    getStatus: child.getStatus.bind(child), cancel: child.cancel.bind(child),
    async *execute(request, signal) {
      dispatched.push(request)
      assert.equal(request.nodeId, 'child')
      yield* child.execute(request, signal)
    },
  }
  let online = true
  const cluster = {
    remoteExecutor: transport, observeInventory: () => () => {},
    workdirLookup: (ref: { nodeId: string; workdirId: string }) => {
      const workdir = online && workdirs.workdirs.find(dir => dir.nodeId === ref.nodeId && dir.workdirId === ref.workdirId)
      return { node: online ? 'online' : 'offline', ...(workdir ? { workdir: { online: workdir.online } } : {}) }
    },
    registry: { listWorkdirs: () => workdirs.workdirs, nodeSupport: () => workdirs.support },
    getNodeInventory: () => ({ version: 1, nodes: [{ nodeId: 'child', role: 'child', displayName: 'Child',
      connection: online ? 'connected' : 'offline', executionProtocol: 'compatible', supportsManagedSessions: online,
      workdirs: workdirs.workdirs, support: workdirs.support }] }),
  } as unknown as MainCluster
  const results = new Map<string, string>()
  const server = createServer(async (request, response) => {
    response.setHeader('content-type', 'application/json')
    if (request.method === 'GET') return response.end(JSON.stringify({ data: [{ id: 'fixture' }] }))
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw) as { messages: { role: string; content: string }[] }
    const user = body.messages.findLastIndex(message => message.role === 'user')
    const turn = JSON.stringify(body.messages[user]?.content).match(/device-case:(first|reuse|home|offline|wrong)/)?.[1] ?? ''
    const result = body.messages.slice(user + 1).find(message => message.role === 'tool')
    if (result) results.set(turn, typeof result.content === 'string' ? result.content : JSON.stringify(result.content))
    const workspace = turn === 'wrong' ? 'device:wrong' : 'device:child'
    const args = turn === 'home' ? { workspace, path: '~/first.txt' } : {
      workspace, script: `echo ${turn} > ${turn}.txt`, ...(turn === 'reuse' ? { cwd: '~' } : {}),
    }
    const message = result ? { content: 'Fixture done' } : { content: null, tool_calls: [{
      id: `exec-${turn}`, type: 'function', function: { name: turn === 'home' ? 'read' : 'exec', arguments: JSON.stringify(args) },
    }] }
    response.end(JSON.stringify({ model: 'fixture', choices: [{ message, finish_reason: 'stop' }] }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  t.after(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())))
  const address = server.address()
  assert(address && typeof address !== 'string')
  const config = ConfigSchema.parse({ agent: { workspace: home, model: 'fixture@openai', autoHandoff: false },
    providers: { openai: { apiKey: 'fixture', baseUrl: `http://127.0.0.1:${address.port}/v1` } },
    organization: { enabled: false }, channels: {}, mcp: {} })
  const catalog = new ProjectCatalog(join(root, 'catalog'))
  await catalog.init()
  const configStore = new ProjectConfigStore({ configPath: join(root, 'config', 'project.json'), home, getSharedConfig: () => config })
  const effective = await configStore.init(config)
  const scope = createProjectScope('default')
  const runtime = await scope.run(() => createProjectRuntime(effective, {
    project: catalog.get('default')!, home, scope, catalog, configStore, mainCluster: cluster,
    copilotAuth: new CopilotAuthenticatorV2(join(root, 'empty-auth'), { isolated: true }), authorize: () => true,
  }))
  try {
    await runtime.ready
    const chatId = 'chat-00000000-0000-4000-8000-000000000001'
    const send = async (turn: string) => {
      const response = await runtime.app.request('/api/chat/send', { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chatId, content: `device-case:${turn}`, stream: false }) })
      assert.equal(response.status, 200, await response.clone().text())
      const deadline = Date.now() + 10_000
      while (!results.has(turn)) {
        assert(Date.now() < deadline, `No ${turn} tool result; got ${JSON.stringify([...results])}`)
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      return results.get(turn)!
    }
    assert.match(await send('first'), /exit code 0/)
    assert.match(await send('reuse'), /exit code 0/)
    assert.match(await send('home'), /Direct home reads or searches are unavailable/)
    assert.match(await send('wrong'), /No Main fallback/)
    online = false
    assert.match(await send('offline'), /No Main fallback/)
    assert.deepEqual(dispatched.map(request => [request.operation, request.workdirId]), [
      [DURABLE_SHELL_OPERATION, DEVICE_HOME_WORKDIR], [DURABLE_SHELL_OPERATION, DEVICE_HOME_WORKDIR],
    ])
    assert.deepEqual(workdirs.workdirs.map(dir => dir.workdirId), [DEVICE_HOME_WORKDIR])
    for (const turn of ['first', 'reuse']) assert.equal((await readFile(join(childHome, `${turn}.txt`), 'utf8')).trim(), turn)
    assert.equal(catalog.folders().length, 0)
  } finally {
    await scope.run(() => runtime.shutdown())
    scope.close()
  }
})
