import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { z } from 'zod'
import type { ChatMessage, LLMResponse } from '../src/providers/provider.ts'
import { CopilotProvider } from '../src/providers/copilot.ts'
import { appRecordSchema } from '../src/microapps/contracts.ts'
import { withTempWorkspace } from '../src/testing/workspace.ts'
import { runAcceptance, writeAcceptanceArtifact } from './microapp-a2a.ts'

test('isolated fixture reaches separate review and timed author confirmation without real model calls', { timeout: 150_000 }, async t =>
  withTempWorkspace(async home => {
    const model = 'acceptance-timeline-fixture'
    t.mock.method(CopilotProvider.prototype, 'listModels', async () => [model])
    t.mock.method(CopilotProvider.prototype, 'listModelInfos', async () => [{ id: model, name: model, contextWindow: 128000 }])
    let calls = 0
    const manifest = { version: 1, name: 'Timeline fixture', description: 'Synthetic source; no device or model calls',
      entry: 'index.html', files: ['index.html'] }
    t.mock.method(CopilotProvider.prototype, 'chat', async (messages: ChatMessage[]): Promise<LLMResponse> => {
      calls++
      const policy = String(messages[0].content)
      const tools = (...items: Array<{ name: string; arguments: Record<string, unknown> }>): LLMResponse => ({
        content: null, toolCalls: items.map((item, index) => ({ id: `timeline-${calls}-${index}`, ...item })),
      })
      if (policy.includes('ends AUTHOR TESTING')) {
        assert.equal(calls, 8)
        return { content: 'Synthetic author turn ended without tests. No runtime pass or report is claimed.', toolCalls: [] }
      }
      assert.match(policy, /ends CREATION/)
      if (calls === 1) return tools({ name: 'work', arguments: { action: 'create', data: {
        title: 'Timeline fixture', reason: 'Synthetic lifecycle check',
        definition: { objective: 'Publish inert fixture', acceptance: ['Report honest test status'], boundaries: ['No devices'], evidence: [] },
      } } })
      if (calls === 2) {
        const value = messages.findLast(message => message.role === 'tool' && message.name === 'work')?.content
        assert.equal(typeof value, 'string')
        const record = JSON.parse(String(value))
        return tools({ name: 'work', arguments: { action: 'adopt', key: record.key, revision: record.revision,
          data: { understanding: 'Publish inert fixture only', next: ['Publish source'] } } })
      }
      if (calls === 3) return tools({ name: 'read', arguments: { path: 'v:skills/micro-app' } })
      if (calls === 4) return tools({ name: 'read', arguments: { path: 'v:tools/micro_app/micro_app' } })
      if (calls === 5) return tools(
        { name: 'write', arguments: { path: 'app/index.html', content: '<!doctype html><title>Fixture</title><p>Not runtime-tested</p>' } },
        { name: 'write', arguments: { path: 'app/shadow-app.json', content: JSON.stringify(manifest) } },
      )
      if (calls === 6) return tools({ name: 'invoke_tool', arguments: { name: 'micro_app', args: { action: 'publish', directory: 'app' } } })
      assert.equal(calls, 7)
      return { content: 'Fixture published; exact version still requires owner review.', toolCalls: [] }
    })
    const previous = { live: process.env.SHADOW_MICROAPP_LIVE, model: process.env.SHADOW_MICROAPP_MODEL }
    process.env.SHADOW_MICROAPP_LIVE = '1'
    process.env.SHADOW_MICROAPP_MODEL = model
    const output = join(home, 'evidence'), runtime = join(home, 'runtime')
    let outcome: { error?: unknown } | undefined
    const running = runAcceptance(output, 'Publish only the inert synthetic fixture. No external APIs, dependencies or devices.', undefined, 12, runtime)
      .then(() => { outcome = {} }, error => { outcome = { error } })
    async function waitFile<T>(name: string, schema: z.ZodType<T>, predicate: (value: T) => boolean, timeout = 30_000) {
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        if (outcome) throw outcome.error ?? new Error('Controller ended before the expected fixture outcome')
        try {
          const value = schema.parse(JSON.parse(await readFile(join(output, name), 'utf8')))
          if (predicate(value)) return value
        } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error }
        await delay(100)
      }
      throw new Error(`Timed out waiting for fixture artifact ${name}`)
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
  }))
