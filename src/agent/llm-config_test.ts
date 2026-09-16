import assert from 'node:assert/strict'
import { test } from 'node:test'
import { REASONING_EFFORTS, isReasoningEffort } from './llm-config.ts'
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
