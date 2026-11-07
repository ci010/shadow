import test from 'node:test'
import assert from 'node:assert/strict'
import { IMPORT_TIMEOUT, importTimeoutMs } from './import-timeout.ts'
import { ToolNoEffectError } from '../../tools/tool.ts'
import { runBridge } from './bridge.ts'

test('one import timeout policy owns default, limits and exact configured values', () => {
  assert.equal(importTimeoutMs(), 300000)
  for (const value of [1000, 300000, 600000, 1800000]) assert.equal(importTimeoutMs(value), value)
  assert.equal(Object.isFrozen(IMPORT_TIMEOUT), true)
  for (const value of [null, 0, -1, 999, 1800001, 1000.5, '600000', NaN, Infinity]) {
    assert.throws(() => importTimeoutMs(value), ToolNoEffectError)
    assert.throws(() => runBridge({ sdkModule: 'must-not-load', env: {} }, 'fixture', 'create', { importTimeoutMs: value }, new AbortController().signal), ToolNoEffectError)
  }
})
