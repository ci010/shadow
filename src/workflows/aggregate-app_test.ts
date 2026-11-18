import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MicroApps } from '../microapps/service.ts'
import { SignalProviderRuntime } from '../signals/providers/runtime.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { WorkflowTool } from './management.ts'
import { WorkflowRuntime } from './runtime.ts'

const unused = () => { throw new Error('No model or inbox expected') }

test('named provider signals survive restart, invoke JS even with missing inputs, and reach an independently opened app', async t => {
  await withTempWorkspace(async home => {
    const source = join(home, 'source')
    await mkdir(source)
    await writeFile(join(source, 'index.html'), '<title>Signal dashboard</title>')
    let now = Date.now()
    t.mock.method(Date, 'now', () => now)
    let left: string | null = 'previous value', right: string | null = null
    const canUse = (id: string) => id === 'web:owner'
    const createApps = () => new MicroApps('fixture', home, unused, () => 'fixture')
    let apps = createApps()
    await apps.init()
    const make = () => {
      const workflows = new WorkflowRuntime(home, 'fixture', { canUse, deliver: async () => unused(), appInput: {
        check: id => { apps.store.get(id) }, write: (id, name, runId, value) => apps.store.writeInput(id, name, runId, value),
      } })
      const providers = new SignalProviderRuntime(home, { execute: async (_grant, input) => {
        const { variables } = input.body as { variables: Record<string, unknown> }
        const repo = variables.n0
        assert.ok(repo === 'left' || repo === 'right')
        const title = repo === 'left' ? left : right
        const nodes = title === null ? [] : [{ id: `${repo}-issue`, title, updatedAt: new Date(now).toISOString(), number: 1,
          url: `https://github.com/test/${repo}/issues/1`, state: 'OPEN' }]
        return { status: 200, body: { data: { r0: { issues: { nodes, pageInfo: { hasNextPage: false, endCursor: null } } } } } }
      } }, workflows, canUse, ref => ref === 'test-pat')
      workflows.start(); providers.start()
      return { workflows, providers, stop: async () => { await providers.stop(); await workflows.stop() } }
    }
    let runtime = make()
    try {
      const app = await apps.publish(source, { version: 1, name: 'Dashboard', description: 'Signal dashboard', entry: 'index.html', files: ['index.html'] }, 'web:owner', AbortSignal.timeout(5000))
      for (const id of ['left', 'right']) runtime.providers.create('web:owner', { id, provider: 'github-issues', version: 1, secretRef: 'test-pat' })
      const definition = { id: 'dashboard', name: 'Dashboard', source: { kind: 'external', id: 'left' }, enabled: true,
        nodes: [{ kind: 'aggregate', inputs: [{ name: 'first', instance: 'left', demand: { repository: 'test/left' } }, { name: 'second', instance: 'right', demand: { repository: 'test/right' } }],
          edge: { appId: app.id, input: 'summary' }, code: 'export function run({ inputs }) { return !Object.hasOwn(inputs, "second") || inputs.second.title === "skip" ? { kind: "skip" } : { kind: "emit", value: [inputs.first.title, inputs.second.title] } }' }] }
      const tool = new WorkflowTool(runtime.workflows)
      const ctx = { sessionId: 'web:owner', projectId: 'fixture', inputSource: 'user', signal: AbortSignal.timeout(30_000) } as ExecutionContext
      await assert.rejects(tool.execute({ action: 'create', definition: { ...definition, nodes: [{ ...definition.nodes[0], edge: { ...definition.nodes[0].edge, appId: '719acb3a-3b5f-4987-84bc-efd35cd31a1f' } }] } }, ctx), /not found/)
      await tool.execute({ action: 'create', definition }, ctx)
      await assert.rejects(tool.execute({ action: 'create', definition: { ...definition, id: 'other' } }, ctx), /already has a Workflow edge/)
      await runtime.providers.run()
      assert.deepEqual(runtime.workflows.inspect().runs.map(r => r.status), ['completed'], 'JS ran and skipped with the second input absent')
      assert.equal(apps.store.readInput(app.id, 'summary'), null)
      await runtime.stop()
      // The first input does not emit again; only the persisted latest value can complete the set.
      left = null; right = 'new value'; now += 60_001
      runtime = make()
      await runtime.providers.run()
      const saved = apps.store.readInput(app.id, 'summary')
      assert.deepEqual(saved?.value, ['previous value', 'new value'])
      assert.deepEqual(runtime.workflows.inspect().runs.map(r => r.status), ['completed', 'completed'])
      assert.equal(apps.get(app.id).status, 'stopped')
      right = 'skip'; now += 60_001
      await runtime.providers.run()
      assert.deepEqual(apps.store.readInput(app.id, 'summary'), saved)
      assert.equal(runtime.workflows.inspect().runs.filter(r => r.status === 'completed').length, 3)
      await runtime.stop()
      await apps.shutdown()
      apps = createApps(); await apps.init()
      const opened = new URL((await apps.open(app.id)).url)
      const ticket = new URLSearchParams(opened.hash.slice(1)).get('shadow_ticket')
      const endpoint = opened.origin + '/_shadow/input?name=summary'
      assert.equal((await fetch(endpoint)).status, 401)
      const access = await fetch(opened.origin + '/_shadow/connect', { method: 'POST', headers: { Authorization: `Bearer ${ticket}` } })
      assert.equal(access.status, 200)
      const { token } = await access.json() as { token: string }
      const response = await fetch(endpoint, { headers: { Authorization: `Bearer ${token}` } })
      assert.equal(response.status, 200)
      assert.deepEqual(await response.json(), saved)
      assert.equal((await fetch(opened.origin + '/_shadow/input?name=constructor', { headers: { Authorization: `Bearer ${token}` } })).status, 400)
    } finally { await runtime.stop(); await apps.shutdown() }
  })
})
