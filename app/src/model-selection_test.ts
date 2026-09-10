import assert from 'node:assert/strict'
import { test } from 'node:test'
import { modelSelectionInput } from './model-selection.ts'

test('composer model choice preserves qualified model and provider semantics', () => {
  assert.deepEqual(modelSelectionInput('claude-sonnet-4.6@copilot', 'openai'), {
    provider: 'copilot',
    model: 'claude-sonnet-4.6@copilot',
  })
})

test('unqualified model choices retain the configured local provider', () => {
  assert.deepEqual(modelSelectionInput('local-model', 'openai-compatible'), {
    provider: 'openai-compatible',
    model: 'local-model',
  })
})
