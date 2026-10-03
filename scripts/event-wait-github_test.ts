import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { LLMProvider } from '../src/providers/provider.ts'
import type { GitHubTransport } from '../src/projects/github/client.ts'
import type { ExecutionContext } from '../src/tools/context.ts'
import { SessionTools, Tools } from '../src/tools/registry.ts'
import { withTempWorkspace } from '../src/testing/workspace.ts'
import { runEventWait } from './event-wait-acceptance.ts'
import { GitHubWait } from './event-wait-github.ts'
import { createBuildReceipt } from './event-wait-github-step.mjs'

test('real Project Node shell calls the authenticated host capability, preserves credentials and verifies the exact CI build', async () => {
  await withTempWorkspace(async root => {
    const identity = { requestId: '1e2303bd-a72b-4dc1-a5d7-3486d55b9c46', repository: 'test/repo', sha: 'a'.repeat(40), runId: 1 }
    let ciReads = 0
    let dispatched = false
    let acknowledged = false
    let modelCalls = 0
    const signal = {
      version: 1, requestId: identity.requestId, ciRunId: 1, cdRunId: 2, deploymentId: 3,
      url: 'https://api.github.com/repos/test/repo/deployments/3/statuses',
      printedAt: new Date().toISOString(), deadlineAt: new Date(Date.now() + 60_000).toISOString(),
    }
    // One timestamp must define both ends of the contract.
    signal.deadlineAt = new Date(Date.parse(signal.printedAt) + 60_000).toISOString()
    const run = (runId: number, completed: boolean) => ({
      id: runId, head_sha: identity.sha, head_branch: 'session',
      status: completed ? 'completed' : 'in_progress', conclusion: completed ? 'success' : null,
      display_title: `Shadow event wait ${runId === 1 ? 'ci' : 'cd'} ${identity.requestId}`,
      html_url: `https://github.com/test/repo/actions/runs/${runId}`,
      created_at: signal.printedAt, updated_at: new Date().toISOString(),
    })
    const transport: GitHubTransport = async (path, method, body) => {
      assert.doesNotMatch(JSON.stringify(body ?? null), /authorization|token|secret/i)
      if (path.endsWith('/actions/runs/1')) return run(1, ++ciReads > 1)
      if (path.endsWith('/dispatches')) {
        assert.equal(method, 'POST')
        assert.equal(dispatched, false)
        dispatched = true
        return null
      }
      if (path.includes('/workflows/event-wait-live.yml/runs?')) return { workflow_runs: [run(2, false)] }
      if (path.endsWith('/actions/runs/2')) return run(2, acknowledged)
      if (path.includes('/check-runs?')) return { total_count: 1, check_runs: [{
        id: 4, external_id: identity.requestId, details_url: 'https://github.com/test/repo/runs/4',
        status: acknowledged ? 'completed' : 'in_progress', conclusion: acknowledged ? 'success' : null,
        output: { text: JSON.stringify(acknowledged
          ? { ...signal, passed: true, elapsedMs: 50, observedAckAt: new Date().toISOString(), ackStatusId: 5 }
          : signal) },
      }] }
      if (path.endsWith('/deployments/3')) return {
        id: 3, sha: identity.sha, environment: 'shadow-event-wait-acceptance',
        production_environment: false, transient_environment: true,
        payload: { requestId: identity.requestId, ciRunId: 1, cdRunId: 2 },
      }
      if (path.endsWith('/deployments/3/statuses')) {
        assert.equal(method, 'POST')
        assert.equal(acknowledged, false)
        assert.equal(dispatched, true)
        assert.deepEqual(body, { state: 'success', description: `event-wait:${identity.requestId}:url-processed`,
          environment: 'shadow-event-wait-acceptance', auto_inactive: false })
        acknowledged = true
        return { id: 5, state: 'success', created_at: new Date().toISOString() }
      }
      throw new Error(`Unexpected test API route: ${path}`)
    }
    const capability = new GitHubWait({
      repository: identity.repository, branch: 'session', sha: identity.sha, requestId: identity.requestId,
      ciRunId: 1, transport, pollMs: 5,
      async download(directory) {
        await mkdir(join(directory, 'dist'))
        await writeFile(join(directory, 'dist', 'backend.js'), 'export const value = 1\n')
        await writeFile(join(directory, 'build-receipt.json'), JSON.stringify(await createBuildReceipt(directory, identity)))
      },
    })
    const provider: LLMProvider = {
      name: 'fixture', listModels: () => ['fixture'],
      async chat(messages) {
        modelCalls++
        if (modelCalls === 1) return { content: null, toolCalls: [{
          id: 'host-sdk-test', name: 'exec', arguments: {
            shell: 'node', timeout_ms: 20_000,
            script: `const call = args => invoke_tool({name:"github_actions",args});
const ci = await call({action:"watch",run_id:1}); if(ci.conclusion!=="success") throw new Error("CI failed");
const cd = await call({action:"dispatch"}); const value = await call({action:"watch_signal"});
const processed = await call({action:"process",url:value.signal.url});
const finished = await call({action:"watch",run_id:cd.id}); console.log({processed,finished});`,
          },
        }] }
        assert.match(JSON.stringify(messages), /verified|acknowledgement/)
        assert.doesNotMatch(JSON.stringify(messages), /Project execution requires an injected eval bridge/)
        return { content: 'Real CI and CD receipt succeeded', toolCalls: [] }
      },
    }
    const output = join(root, 'evaluation')
    const result = await runEventWait({
      output, scenario: 'cold', model: 'fixture', storage: 'sqlite', holdMs: 0,
      timeoutMs: 30_000, maxCalls: 3, urlTimeoutMs: 60_000, external: capability.asScenario(),
    }, provider)
    assert.equal(result.passed, true, JSON.stringify(result))
    assert.equal(dispatched, true)
    assert.equal(acknowledged, true)
    assert.equal(capability.dispatches.length, 1)
    assert.equal(capability.attempts.length, 1)
    assert.equal(modelCalls, 2)
    const calls: unknown = JSON.parse(await readFile(join(output, 'tool-calls.json'), 'utf8'))
    assert.match(JSON.stringify(calls), /"shell":"node"/)
    assert.doesNotMatch(JSON.stringify(calls), /Project execution requires|authorization|GH_TOKEN|GITHUB_TOKEN/)
  })
})

test('acceptance HTTP source broker rejects unrelated resources and writes before calling host auth', async () => {
  let requests = 0
  const capability = new GitHubWait({
    repository: 'test/repo', branch: 'session', sha: 'a'.repeat(40),
    requestId: '1e2303bd-a72b-4dc1-a5d7-3486d55b9c46', ciRunId: 1,
    transport: async () => { requests++; return {} },
  })
  const request = capability.asScenario().request
  assert.ok(request)
  await assert.rejects(request('https://api.github.com/repos/test/repo/actions/runs/99'), /outside/)
  await assert.rejects(request('https://api.github.com/repos/test/repo/actions/runs/1', { method: 'POST' }), /outside/)
  await assert.rejects(request('https://example.com/repos/test/repo/actions/runs/1'), /outside/)
  assert.equal(requests, 0)
  assert.equal((await request('https://api.github.com/repos/test/repo/actions/runs/1')).status, 200)
  assert.equal(requests, 1)
  await capability.asScenario().fixture.close()
})

test('only this CI/CD pair is readable and premature or uncertain dispatches never produce a second write', async () => {
  await withTempWorkspace(async workspace => {
    const options = {
      repository: 'test/repo', branch: 'session', sha: 'a'.repeat(40),
      requestId: '1e2303bd-a72b-4dc1-a5d7-3486d55b9c46', ciRunId: 1,
    }
    const context: ExecutionContext = {
      channel: 'web', messageId: 'test', senderId: 'owner', chatId: 'test',
      sessionId: 'web:test', physicalSessionId: 'web:test', cwd: workspace,
      tools: new SessionTools(new Tools(workspace), workspace), signal: AbortSignal.timeout(10_000),
    }
    let completed = false
    let writes = 0
    const capability = new GitHubWait({ ...options, transport: async (_path, method) => {
      if (method === 'POST') { writes++; throw new Error('Unknown transport outcome') }
      return {
        id: 1, head_sha: options.sha, head_branch: 'session',
        status: completed ? 'completed' : 'in_progress', conclusion: completed ? 'success' : null,
        display_title: `Shadow event wait ci ${options.requestId}`, html_url: 'https://github.com/test/repo/actions/runs/1',
        created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
      }
    } })
    try {
      await assert.rejects(capability.execute({ action: 'view', run_id: 99 }, context), /outside/)
      assert.equal(capability.requests.length, 0)
      await assert.rejects(capability.execute({ action: 'dispatch' }, context), /completed successfully/)
      assert.equal(writes, 0)
      completed = true
      await assert.rejects(capability.execute({ action: 'dispatch' }, context), /Unknown transport outcome/)
      await assert.rejects(capability.execute({ action: 'dispatch' }, context), /already attempted/)
      assert.equal(writes, 1)
    } finally {
      await capability.asScenario().fixture.close()
    }
  })
})
