import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { parse } from 'yaml'
import { readFile } from 'node:fs/promises'
import { withTempWorkspace } from '../src/testing/workspace.ts'
import { createBuildReceipt, runUrlStep, stepIdentity, verifyBuildReceipt } from './event-wait-github-step.mjs'

const identity = { requestId: '1e2303bd-a72b-4dc1-a5d7-3486d55b9c46', repository: 'test/repo', sha: 'a'.repeat(40), runId: 2 }

test('third step publishes the same printed URL through Check Runs and only accepts the exact acknowledgement', async () => {
  const requests: Array<{ path: string; method: string; body: unknown }> = []
  const logs: string[] = []
  let signal: unknown
  const result = await runUrlStep({
    identity, ciRunId: 1, timeoutMs: 60_000, now: () => Date.parse('2026-10-03T00:00:00Z'),
    monotonic: () => 100, log: value => logs.push(value),
    async request(path, method = 'GET', body) {
      requests.push({ path, method, body })
      if (path.endsWith('/actions/runs/1')) return { status: 'completed', conclusion: 'success', head_sha: identity.sha, display_title: `Shadow event wait ci ${identity.requestId}` }
      if (method === 'POST' && path.endsWith('/deployments')) {
        assert.equal(body?.production_environment, false)
        assert.equal(body?.transient_environment, true)
        return { id: 3 }
      }
      if (method === 'POST' && path.endsWith('/check-runs')) {
        const output = body?.output
        assert.ok(output && typeof output === 'object' && 'text' in output && typeof output.text === 'string')
        signal = JSON.parse(output.text)
        return { id: 4 }
      }
      if (path.includes('/deployments/3/statuses')) return [
        { id: 5, state: 'success', description: 'unrelated acknowledgement' },
        { id: 6, state: 'success', description: `event-wait:${identity.requestId}:url-processed` },
      ]
      if (method === 'PATCH') { assert.equal(body?.conclusion, 'success'); return { id: 4 } }
      throw new Error('Unexpected test request')
    },
  })
  assert.equal(result.passed, true)
  assert.equal(result.ackStatusId, 6)
  assert.equal(logs[0], `PROCESS_URL=${result.url}`)
  assert.deepEqual(signal, {
    version: 1, requestId: identity.requestId, ciRunId: 1, cdRunId: 2, deploymentId: 3,
    url: result.url, printedAt: result.printedAt, deadlineAt: result.deadlineAt,
  })
  assert.equal(Date.parse(result.deadlineAt) - Date.parse(result.printedAt), 60_000)
})

test('an acknowledgement observed after the monotonic deadline cannot rescue the third step', async () => {
  let elapsed = 0
  const result = await runUrlStep({
    identity, ciRunId: 1, timeoutMs: 1000, monotonic: () => elapsed, pollMs: 1, log: () => {},
    async request(path, method = 'GET', body) {
      if (path.endsWith('/actions/runs/1')) return { status: 'completed', conclusion: 'success', head_sha: identity.sha, display_title: `Shadow event wait ci ${identity.requestId}` }
      if (method === 'POST') return { id: 3 }
      if (path.includes('/statuses')) {
        elapsed = 1001
        return [{ id: 5, state: 'success', description: `event-wait:${identity.requestId}:url-processed` }]
      }
      assert.equal(body?.conclusion, 'failure')
      return { id: 3 }
    },
  })
  assert.equal(result.passed, false)
  assert.equal(result.error, 'url_deadline_exceeded')
})

test('CD rejects a wrong or failed CI run before creating any deployment', async () => {
  let calls = 0
  await assert.rejects(runUrlStep({
    identity, ciRunId: 1, timeoutMs: 1000, log: () => {},
    request: async () => { calls++; return { status: 'completed', conclusion: 'failure', head_sha: identity.sha } },
  }), /CI dependency/)
  assert.equal(calls, 1)
})

test('real build receipt verifies exact request/run/commit and rejects changed files', async () => {
  await withTempWorkspace(async root => {
    await mkdir(join(root, 'dist'))
    await writeFile(join(root, 'dist', 'backend.js'), 'export const value = 1\n')
    const receipt = await createBuildReceipt(root, identity)
    await writeFile(join(root, 'build-receipt.json'), JSON.stringify(receipt))
    assert.equal((await verifyBuildReceipt(root, identity)).files, 1)
    await assert.rejects(verifyBuildReceipt(root, { ...identity, runId: 99 }), /identity mismatch/)
    await writeFile(join(root, 'dist', 'backend.js'), 'changed')
    await assert.rejects(verifyBuildReceipt(root, identity), /checksum mismatch/)
  })
})

test('manual-only real workflow has exactly three CD steps, least-privilege permissions and no signing/publication', async () => {
  const workflow = parse(await readFile(new URL('../.github/workflows/event-wait-live.yml', import.meta.url), 'utf8'))
  assert.deepEqual(Object.keys(workflow.on), ['workflow_dispatch'])
  assert.equal(workflow.jobs.cd.steps.length, 3)
  assert.deepEqual(workflow.jobs.cd.permissions, { contents: 'read', actions: 'read', checks: 'write', deployments: 'write' })
  assert.doesNotMatch(JSON.stringify(workflow), /signed_android|signed_ios|mobile-release|gh release create/)
  assert.throws(() => stepIdentity({}), /Missing/)
})
