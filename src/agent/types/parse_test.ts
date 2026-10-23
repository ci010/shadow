import assert from 'node:assert/strict'
import { test } from 'node:test'
import { parseAgentFile } from './parse.ts'
import { EXECUTION_MODES, isExecutionMode, parseExecutionMode } from '../../sessions/execution-mode.ts'

test('agent module ceilings are explicit validated declarations', () => {
  const agent = parseAgentFile('---\nallowedModules: [node:path, "@shadow/read"]\n---\nRole', 'fixture', 'fixture')
  assert.deepEqual(agent.allowedModules, ['node:path', '@shadow/read'])
  assert.deepEqual(parseAgentFile('---\nallowedModules: []\n---\nRole', 'fixture', 'fixture').allowedModules, [])
  assert.equal(parseAgentFile('Role', 'fixture', 'fixture').allowedModules, undefined)
  for (const value of ['true', '"node:path"', '["./other.js"]']) {
    assert.throws(() => parseAgentFile(`---\nallowedModules: ${value}\n---\nRole`, 'fixture', 'fixture'))
  }
})

test('legacy planning tool policies rename to Initiative without widening access', () => {
  const role = parseAgentFile('---\nallowedTools: [read, project]\nblockedTools: project, exec\n---\nRole', 'legacy', 'fixture')
  assert.deepEqual(role.allowedTools, ['read', 'initiative'])
  assert.deepEqual(role.blockedTools, ['initiative', 'exec'])
})

test('execution modes are a closed runtime-validated contract', () => {
  for (const mode of EXECUTION_MODES) {
    assert.equal(isExecutionMode(mode), true)
    assert.equal(parseExecutionMode(mode), mode)
  }
  for (const invalid of [undefined, null, true, '', 'ephemeral', 'background', {}, []]) {
    assert.equal(isExecutionMode(invalid), false)
    assert.throws(() => parseExecutionMode(invalid), /Execution mode must/)
  }
})

test('role prompt and tool constraints are independent of its default mode', () => {
  for (const mode of EXECUTION_MODES) {
    const role = parseAgentFile(`---
description: Inspect source
allowedTools: [read, search, yield]
defaultMode: ${mode}
soul: false
---
Follow the evidence.
`, 'researcher', 'fixture')
    assert.equal(role.defaultMode, mode)
    assert.equal(role.name, 'researcher')
    assert.deepEqual(role.allowedTools, ['read', 'search', 'yield'])
    assert.equal(role.prompt.trim(), 'Follow the evidence.')
    assert.equal(role.soul, false)
    assert.equal('ephemeral' in role, false)
  }
  assert.equal(parseAgentFile('Plain role instructions', 'plain', 'fixture').defaultMode, 'session')
})

test('legacy lifecycle fields migrate with a visible deprecation warning', (t) => {
  const warning = t.mock.method(console, 'warn', () => {})
  for (const value of [true, false]) {
    const role = parseAgentFile(`---\nephemeral: ${value}\n---\nLegacy role`, 'legacy', 'fixture')
    assert.equal(role.defaultMode, value ? 'task' : 'session')
    assert.equal('ephemeral' in role, false)
    assert.match(String(warning.mock.calls.at(-1)?.arguments[0]), /deprecated ephemeral/)
  }
  const legacySoul = parseAgentFile('---\nephemeral: true\nsoul: true\n---\nRole', 'legacy', 'fixture')
  assert.equal(legacySoul.soul, true)
})

test('invalid modes and conflicting legacy configuration fail explicitly', () => {
  for (const value of ['unknown', 'true', '[]', 'null']) {
    assert.throws(() => parseAgentFile(`---\ndefaultMode: ${value}\n---\nRole`, 'invalid', 'fixture'), /Execution mode/)
  }
  assert.throws(() => parseAgentFile('---\nephemeral: "true"\n---\nRole', 'invalid', 'fixture'), /must be a boolean/)
  assert.throws(() => parseAgentFile('---\nephemeral: true\ndefaultMode: session\n---\nRole', 'invalid', 'fixture'), /without legacy ephemeral/)
})
