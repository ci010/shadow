import assert from 'node:assert/strict'
import childProcess, { type ForkOptions } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { syncBuiltinESMExports } from 'node:module'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { z } from 'zod'
import { contentText, type ChatMessage, type LLMResponse } from '../src/providers/provider.ts'
import type { ToolDefinition } from '../src/tools/tool.ts'
import { CopilotProvider } from '../src/providers/copilot.ts'
import { appId, revisionId, appRecordSchema, appWorkScopeSchema } from '../src/microapps/contracts.ts'
import { MicroApps } from '../src/microapps/service.ts'
import { microAppReceipt } from '../src/tools/micro-app.ts'
import { workDefinitionSchema } from '../src/initiatives/work-contract.ts'
import { withTempWorkspace } from '../src/testing/workspace.ts'
import { runAcceptance, writeAcceptanceArtifact } from './microapp-a2a.ts'

const fixtureDefinition = {
  objective: 'Publish inert fixture',
  acceptance: ['Publish the inert Timeline fixture without claiming runtime verification.'],
}

// Work permits empty criteria, but publication snapshots require at least one per selected goal.
// Keep the synthetic provider's input compatible with both contracts.
test('timeline fixture Work can be snapshotted for app publication', async () => withTempWorkspace(async home => {
  const scope = (definition: unknown) => ({ key: 'fixture', revision: 1,
    acceptance: workDefinitionSchema.parse(definition).acceptance })
  let work = scope({ objective: fixtureDefinition.objective })
  assert.equal(appWorkScopeSchema.safeParse(work).success, false)
  const service = new MicroApps('fixture', home, () => { throw new Error('No model expected') }, () => 'fixture', {
    ownerSession: id => id, ask: async () => { throw new Error('No approval expected') },
    notify: async () => {}, evidence: async () => {}, work: () => [work],
  })
  try {
    await service.init()
    const source = join(home, 'source')
    await mkdir(source)
    await writeFile(join(source, 'index.html'), '<!doctype html><title>Fixture</title>')
    const publish = () => service.publish(source, { version: 1, name: 'Timeline fixture', description: 'Inert fixture',
      entry: 'index.html', files: ['index.html'] }, 'fixture-author', new AbortController().signal)
    await assert.rejects(publish(), /acceptance/)
    assert.deepEqual(service.list(), [], 'The old fixture leaves apps.json empty, even when its author turn completes')
    work = scope(fixtureDefinition)
    const record = await publish()
    assert.deepEqual(record.work, [work])
    const receipt = microAppReceipt(record)
    const parsed = publishedReceipt([{ role: 'tool', name: 'invoke_tool', content: JSON.stringify(receipt) }])
    assert.equal(parsed.id, record.id)
    assert.equal(service.list().length, 1)
  } finally { await service.shutdown() }
}))

function publishedReceipt(messages: ChatMessage[]) {
  const result = messages.findLast(message => message.role === 'tool' && message.name === 'invoke_tool')
  const text = result ? contentText(result.content) : '<missing invoke_tool result>'
  try {
    return z.object({ id: appId, revision: revisionId,
      workRefs: z.array(z.object({ acceptanceCount: z.literal(fixtureDefinition.acceptance.length) })).length(1),
    }).parse(JSON.parse(text))
  } catch (error) {
    assert.fail(`Fixture publication failed; invoke_tool result: ${text.slice(0, 4000)}\n${String(error)}`)
  }
}

test('timeline provider rejects failed publication instead of claiming success', () => {
  const receipt = { id: '11111111-1111-4111-8111-111111111111', revision: 'a'.repeat(64),
    workRefs: [{ acceptanceCount: 1 }] }
  assert.deepEqual(publishedReceipt([{ role: 'tool', name: 'invoke_tool', content: JSON.stringify(receipt) }]), receipt)
  assert.throws(() => publishedReceipt([]), /missing invoke_tool result/)
  assert.throws(() => publishedReceipt([{ role: 'tool', name: 'invoke_tool', content: 'Error: invalid acceptance criteria' }]),
    /Fixture publication failed; invoke_tool result: Error: invalid acceptance criteria/)
  assert.throws(() => publishedReceipt([{ role: 'tool', name: 'invoke_tool', content: JSON.stringify({ tools: [] }) }]),
    /Fixture publication failed/)
})

test('isolated Node-only fixture reaches separate review and timed author confirmation without real model calls', { timeout: 150_000 }, async t =>
  withTempWorkspace(async home => {
    const forkRuntime = childProcess.fork
    const runtimeFork = t.mock.method(childProcess, 'fork', (modulePath: string | URL, args: readonly string[], options: ForkOptions) =>
      forkRuntime(modulePath, args, {
        ...options,
        // The synthetic runtime only uses loopback, never the host's proxy/PAC settings.
        env: { ...options.env, HTTP_PROXY: '', HTTPS_PROXY: '', NO_PROXY: '*' },
      }))
    syncBuiltinESMExports()
    t.after(() => { runtimeFork.mock.restore(); syncBuiltinESMExports() })
    const model = 'acceptance-timeline-fixture'
    t.mock.method(CopilotProvider.prototype, 'listModels', async () => [model])
    t.mock.method(CopilotProvider.prototype, 'listModelInfos', async () => [{ id: model, name: model, contextWindow: 128000 }])
    let calls = 0
    let providerFailure: unknown
    const manifest = { version: 1, name: 'Timeline fixture', description: 'Synthetic source; no device or model calls',
      entry: 'index.html', files: ['index.html'] }
    const respond = async (messages: ChatMessage[], definitions: ToolDefinition[]): Promise<LLMResponse> => {
      calls++
      const policy = String(messages[0].content)
      assert.match(policy, /Only Node exec is enabled/)
      assert.deepEqual(definitions.find(tool => tool.function.name === 'exec')?.function.parameters.properties.shell.enum, ['node'])
      const tools = (...items: Array<{ name: string; arguments: Record<string, unknown> }>): LLMResponse => ({
        content: null, toolCalls: items.map((item, index) => ({ id: `timeline-${calls}-${index}`, ...item })),
      })
      assert.doesNotMatch(policy, /Execution Budget|ends CREATION|ends AUTHOR TESTING/)
      const testingReady = messages.some(message => message.role === 'user' &&
        contentText(message.content).includes('The post-review testing question selected continue'))
      if (testingReady) {
        assert.equal(calls, 8)
        return { content: 'Synthetic author turn ended without tests. No runtime pass or report is claimed.', toolCalls: [] }
      }
      assert.ok(calls <= 7, 'Author testing requires the real post-approval input event')
      assert.ok(messages.some(message => message.role === 'user' &&
        contentText(message.content).includes('Publish only the inert synthetic fixture.')))
      if (calls === 1) return tools({ name: 'work', arguments: { action: 'create', data: {
        title: 'Timeline fixture', definition: fixtureDefinition, notes: { kind: 'task' },
      } } })
      if (calls === 2) {
        const value = messages.findLast(message => message.role === 'tool' && message.name === 'work')?.content
        assert.equal(typeof value, 'string')
        const record = JSON.parse(String(value))
        assert.equal(typeof record.key, 'string')
        assert.equal(typeof record.version, 'number')
        return tools({ name: 'work', arguments: { action: 'update', key: record.key, version: record.version,
          data: { notes: { summary: 'Publish inert fixture only', next: 'Publish source' } } } })
      }
      if (calls === 3) {
        const value = messages.findLast(message => message.role === 'tool' && message.name === 'work')?.content
        const record = JSON.parse(String(value))
        assert.equal(typeof record.key, 'string', 'Work note update must succeed')
        assert.equal(typeof record.version, 'number')
        return tools({ name: 'read', arguments: { path: 'v:skills/micro-app' } })
      }
      if (calls === 4) return tools({ name: 'read', arguments: { path: 'v:tools/micro_app/micro_app' } })
      if (calls === 5) return tools(
        { name: 'exec', arguments: { script: `
          import { execFile } from 'node:child_process'
          import { promisify } from 'node:util'
          const { stdout } = await promisify(execFile)(process.execPath, ['-p', '"native-fixture"'], { shell: false })
          console.log(stdout)
        ` } },
        { name: 'exec', arguments: { shell: 'powershell', script: 'Write-Output "must-not-run"' } },
        { name: 'write', arguments: { path: 'app/index.html', content: '<!doctype html><title>Fixture</title><p>Not runtime-tested</p>' } },
        { name: 'write', arguments: { path: 'app/shadow-app.json', content: JSON.stringify(manifest) } },
      )
      if (calls === 6) {
        const results = messages.filter(message => message.role === 'tool' && message.name === 'exec')
        assert.equal(results.length, 2)
        assert.match(String(results[0].content), /native-fixture/)
        assert.match(String(results[1].content), /Only shell=node/)
        return tools({ name: 'invoke_tool', arguments: { name: 'micro_app', args: { action: 'publish', directory: 'app' } } })
      }
      assert.equal(calls, 7)
      publishedReceipt(messages)
      return { content: 'Fixture published; exact version still requires owner review.', toolCalls: [] }
    }
    t.mock.method(CopilotProvider.prototype, 'chat', async (messages: ChatMessage[], definitions: ToolDefinition[]) => {
      try { return await respond(messages, definitions) }
      catch (error) { providerFailure = error; throw error }
    })
    const previous = { live: process.env.SHADOW_MICROAPP_LIVE, model: process.env.SHADOW_MICROAPP_MODEL }
    process.env.SHADOW_MICROAPP_LIVE = '1'
    process.env.SHADOW_MICROAPP_MODEL = model
    const output = join(home, 'evidence'), runtime = join(home, 'runtime')
    let outcome: { error?: unknown } | undefined
    const running = runAcceptance(output, 'Publish only the inert synthetic fixture. No external APIs, dependencies or devices.', undefined, 12, runtime, true)
      .then(() => { outcome = {} }, error => { outcome = { error } })
    async function waitFile<T>(name: string, schema: z.ZodType<T>, predicate: (value: T) => boolean, timeout = 30_000) {
      const deadline = Date.now() + timeout
      let lastValue: unknown = '<artifact not yet written>'
      while (Date.now() < deadline) {
        if (providerFailure) throw providerFailure
        if (outcome) throw outcome.error ?? new Error('Controller ended before the expected fixture outcome')
        try {
          const value = schema.parse(JSON.parse(await readFile(join(output, name), 'utf8')))
          lastValue = value
          if (predicate(value)) return value
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        await delay(100)
      }
      const progress = await readFile(join(output, 'progress.json'), 'utf8').catch(error => `Unavailable: ${String(error)}`)
      throw new Error(`Timed out waiting for fixture artifact ${name}; provider calls=${calls}; last value=${JSON.stringify(lastValue).slice(0, 4000)}; progress=${progress.slice(0, 4000)}`)
    }
    let controlId = 0
    async function control(action: string, fields: Record<string, unknown> = {}) {
      const id = `timeline-control-${++controlId}`
      await writeAcceptanceArtifact(join(output, 'control.json'), JSON.stringify({ id, action, ...fields }))
      return await waitFile('control-result.json', z.object({ id: z.string(), done: z.boolean(), error: z.string().optional() }), result => result.id === id)
    }
    try {
      await waitFile('progress.json', z.object({ status: z.object({ state: z.string() }) }), value => value.status.state === 'TASK_STATE_COMPLETED')
      const [app] = await waitFile('apps.json', appRecordSchema.strip().array(), apps => apps.length === 1)
      const exact = { appId: app.id, revision: app.revision }
      assert.equal((await control('review', exact)).done, true)
      const review = JSON.parse(await readFile(join(output, 'timeline.json'), 'utf8'))
      assert.equal(review.phase, 'review')
      assert.equal(Date.parse(review.deadlineAt) - Date.parse(review.phaseStartedAt), 5 * 60_000)
      assert.equal((await control('review', exact)).done, true)
      assert.equal(JSON.parse(await readFile(join(output, 'timeline.json'), 'utf8')).deadlineAt, review.deadlineAt)
      const stale = await control('approve', { ...exact, revision: '0'.repeat(64) })
      assert.equal(stale.done, false)
      assert.match(stale.error ?? '', /stale/)
      const followup = await control('message', { text: 'This cannot reset creation' })
      assert.equal(followup.done, false)
      assert.match(followup.error ?? '', /belong to creation/)
      assert.equal(calls, 7, 'Review never calls the fixture provider')
      assert.equal((await control('approve', exact)).done, true)
      const testing = JSON.parse(await readFile(join(output, 'timeline.json'), 'utf8'))
      const approval = JSON.parse(await readFile(join(output, 'approval.json'), 'utf8'))
      assert.equal(testing.phase, 'testing')
      assert.equal(Date.parse(testing.deadlineAt) - Date.parse(approval.approvedAt), 10 * 60_000)
      const apps = await waitFile('apps.json', appRecordSchema.strip().array(), apps => !!apps[0]?.acceptance?.authorTurn?.finishedAt, 90_000)
      const acceptance = apps[0].acceptance
      assert.ok(acceptance?.authorTurn)
      assert.equal(acceptance.decision, 'timeout')
      assert.equal(acceptance.authorTurn.outcome, 'completed')
      assert.ok(['incomplete', 'blocked'].includes(acceptance.status), 'An ended author turn is not a fabricated passing report')
      assert.equal(acceptance.report, undefined)
      assert.equal(calls, 8)
      assert.equal(JSON.parse(await readFile(join(output, 'timeline.json'), 'utf8')).deadlineAt, testing.deadlineAt)
    } finally {
      if (!outcome) await writeAcceptanceArtifact(join(output, 'control.json'), JSON.stringify({ id: 'timeline-finish', action: 'finish' }))
      await running
      if (previous.live === undefined) delete process.env.SHADOW_MICROAPP_LIVE
      else process.env.SHADOW_MICROAPP_LIVE = previous.live
      if (previous.model === undefined) delete process.env.SHADOW_MICROAPP_MODEL
      else process.env.SHADOW_MICROAPP_MODEL = previous.model
    }
    assert.equal(outcome?.error, undefined)
    const final = JSON.parse(await readFile(join(output, 'final.json'), 'utf8'))
    assert.equal(final.state, 'finished')
    assert.equal(final.calls, 8)
    assert.equal(final.maxCalls, 12)
    assert.equal(final.timeline.phase, 'testing')
    assert.equal(JSON.parse(await readFile(join(output, 'shutdown.json'), 'utf8')).success, true)
    assert.equal(JSON.parse(await readFile(join(output, 'isolation.json'), 'utf8')).nodeOnly, true)
    assert.equal(JSON.parse(await readFile(join(output, 'prompt.json'), 'utf8')).nodeOnly, true)
    const learning = z.object({
      enabled: z.boolean(),
      pipelines: z.record(z.string(), z.object({
        dispatching: z.boolean(), lastStartedAt: z.string().optional(), lastDispatchedAt: z.string().optional(),
      })),
    }).parse(JSON.parse(await readFile(join(output, 'learning.json'), 'utf8')))
    const work = JSON.parse(await readFile(join(output, 'work.json'), 'utf8'))
    assert.equal(work.organization.enabled, false, 'Organization is independent of learning and must not call the fixture provider')
    assert.equal(work.organization.running, false)
    assert.equal(learning.enabled, false)
    for (const pipeline of Object.values(learning.pipelines)) {
      // A persisted ledger can be pending while scheduling remains disabled.
      assert.equal(pipeline.dispatching, false)
      assert.equal(pipeline.lastStartedAt, undefined)
      assert.equal(pipeline.lastDispatchedAt, undefined)
    }
  }))
