import assert from 'node:assert/strict'
import { test } from 'node:test'
import { REASONING_EFFORTS, isReasoningEffort, resolveInferenceSettings, validateInferenceCapabilities } from './llm-config.ts'
import { ConfigSchema } from '../config/schema.ts'
import { parseAgentFile } from './types/parse.ts'
import { parseSessionConfigPatch } from '../sessions/config-patch.ts'

test('all explicit effort levels survive global, role and session configuration', () => {
  for (const reasoningEffort of REASONING_EFFORTS) {
    assert(isReasoningEffort(reasoningEffort))
    assert.equal(ConfigSchema.parse({ agent: { reasoningEffort } }).agent.reasoningEffort, reasoningEffort)
    assert.equal(parseAgentFile(`---\nreasoningEffort: ${reasoningEffort}\n---\nFixture`, 'fixture', '.').reasoningEffort, reasoningEffort)
    assert.equal(parseSessionConfigPatch({ reasoningEffort }).set.reasoningEffort, reasoningEffort)
  }
  for (const value of ['none', 'default', 'extreme', false, null, undefined]) {
    assert.equal(isReasoningEffort(value), false)
  }
})

const defaults = { model: 'default', contextWindow: 1000, temperature: 0, reasoningEffort: 'medium' as const }

test('session inference overrides win, while undefined Agent settings inherit runtime defaults', () => {
  assert.deepEqual(resolveInferenceSettings(defaults, { model: 'agent', reasoningEffort: 'low' }, { model: 'session', temperature: 1 }),
    { ...defaults, model: 'session', temperature: 1, reasoningEffort: 'low' })
  assert.deepEqual(resolveInferenceSettings(defaults, { model: undefined, reasoningEffort: undefined }), defaults)
})

test('model catalog validation distinguishes unknown effort metadata from unsupported values', () => {
  const settings = { model: 'agent', reasoningEffort: 'low' as const }
  assert.doesNotThrow(() => validateInferenceCapabilities(settings, defaults, [{ id: 'agent' }]))
  assert.doesNotThrow(() => validateInferenceCapabilities(settings, defaults, [{ id: 'agent', reasoningEfforts: ['low'] }]))
  assert.throws(() => validateInferenceCapabilities(settings, defaults, []), /catalog/)
  assert.throws(() => validateInferenceCapabilities(settings, defaults, [{ id: 'agent', selectable: false }]), /selectable/)
  assert.throws(() => validateInferenceCapabilities(settings, defaults, [{ id: 'agent', reasoningEfforts: [] }]), /does not support/)
})
