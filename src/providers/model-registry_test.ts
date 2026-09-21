import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_CONTEXT_WINDOW, resolveContextWindow } from './model-registry.ts'

test('unknown models use a 400k context window', () => {
  assert.equal(DEFAULT_CONTEXT_WINDOW, 400_000)
  assert.equal(resolveContextWindow(undefined), 400_000)
  assert.equal(resolveContextWindow('unknown-fixture-model'), 400_000)
  assert.equal(resolveContextWindow('unknown-fixture-model@copilot'), 400_000)
})

test('registered models and explicit overrides retain their context windows', () => {
  assert.equal(resolveContextWindow('gpt-4o@openai'), 128_000)
  assert.equal(resolveContextWindow('deepseek-v4-pro'), 1_000_000)
  assert.equal(resolveContextWindow('unknown-fixture-model@copilot', {
    modelContextWindows: { 'unknown-fixture-model': 200_000 },
  }), 200_000)
  assert.equal(resolveContextWindow('gpt-4o@openai', {
    modelContextWindows: { 'gpt-4o': 64_000 },
  }), 64_000)
})
