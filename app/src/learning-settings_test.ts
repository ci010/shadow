import assert from 'node:assert/strict'
import test from 'node:test'
import { fetchLearningStatus, learningPipelineState, parseLearningStatus } from './learning-settings.ts'
import { parseOrganizationConfig } from './organization-settings.ts'

const pipeline = () => ({ intervalMs: 60_000, pending: false, dispatching: false })
const status = (organizationId = 'a') => ({
  organizationId, enabled: true, stopped: false,
  pipelines: { reflector: pipeline(), encapsulator: pipeline(), soulReflector: pipeline() },
})

test('learning status uses the confirmed scoped route and rejects other organization data', async () => {
  const result = await fetchLearningStatus('http://fixture/organizations/a/', 'a', new AbortController().signal, async input => {
    assert.equal(String(input), 'http://fixture/organizations/a/api/learning')
    return Response.json(status())
  })
  assert.equal(result.organizationId, 'a')
  assert.throws(() => parseLearningStatus(status('b'), 'a'), /ownership/)
  for (const patch of [{ intervalMs: -1 }, { intervalMs: 2_147_483_648 }, { pending: 'yes' }, { dispatching: null }, { lastStartedAt: 'invalid' }]) {
    const value = status()
    assert.throws(() => parseLearningStatus({
      ...value, pipelines: { ...value.pipelines, reflector: { ...pipeline(), ...patch } },
    }, 'a'), /invalid learning/)
  }
  assert.throws(() => parseOrganizationConfig({
    agent: { model: 'fixture', workspace: 'C:\\synthetic', temperature: .7 }, learning: { enabled: 'false' },
  }), /invalid organization settings/)
})

test('learning display distinguishes pending checks, stopping and launch acceptance from task completion', () => {
  const value = status()
  const pipeline = { ...value.pipelines.reflector, lastDispatchedAt: '2026-09-14T17:00:00.000Z' }
  assert.equal(learningPipelineState(value, pipeline), 'Waiting for activity')
  assert.equal(learningPipelineState(value, { ...pipeline, pending: true }), 'Waiting for next check')
  assert.equal(learningPipelineState(value, { ...pipeline, dispatching: true }), 'Checking')
  assert.equal(learningPipelineState({ ...value, enabled: false }, { ...pipeline, dispatching: true }), 'Stopping check')
  assert.equal(learningPipelineState({ ...value, enabled: false }, pipeline), 'Paused')
  assert.equal(learningPipelineState({ ...value, stopped: true }, pipeline), 'Stopped')
  assert.equal(learningPipelineState(value, { ...pipeline, lastError: 'Synthetic failure', pending: true }), 'Retry pending')
})
