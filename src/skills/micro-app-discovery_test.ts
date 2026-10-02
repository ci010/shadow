import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SkillsManager } from './loader.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { readFile } from 'node:fs/promises'

test('reusable apps are discoverable without building a domain-specific audio application', async () => withTempWorkspace(async home => {
  const skills = new SkillsManager(home)
  try {
    await skills.load()
    assert.match(await readFile(new URL('../agent/types/builtin/general/AGENT.md', import.meta.url), 'utf8'), /v:skills\/micro-app/)
    const body = skills.getSkillBody('micro-app')!
    for (const text of ['shadow-app.json', 'awaiting_approval', '/_shadow/sdk.js', 'SHADOW_APP_DATA',
      'not an OS', 'never executes tools', 'restart', 'original',
      'status-only events', 'extended idle interval', '[Console]::OutputEncoding',
      'primary error message']) {
      assert.ok(body.toLowerCase().includes(text.toLowerCase()), text)
    }
  } finally { await skills.stopWatching() }
}))

test('short-goal guidance owns engineering work without turning input into permission', async () => withTempWorkspace(async home => {
  const skills = new SkillsManager(home)
  try {
    await skills.load()
    const body = skills.getSkillBody('micro-app')!
    const role = await readFile(new URL('../agent/types/builtin/general/AGENT.md', import.meta.url), 'utf8')
    assert.match(role, /v:skills\/micro-app` for guided builds/)
    for (const rule of [
      'inputs, useful outputs and repeat-use workflow',
      'There is\nno minimum number of questions',
      'Do not re-ask answered questions',
      'one focused question in user language',
      'never disguise permission as ordinary input',
      'not local human authorization',
      'exact-version owner review',
      'plausible-looking wrong output',
      'partial milestone is not final acceptance',
      'retain earlier answers, constraints and verified behavior',
      'existing app/revision',
      'implementation assumption is not a user requirement',
      'executor adoption at the existing revision',
      'never relabel them to bypass it',
      'primary input, result and action',
      'both fresh first-use and ready states',
      'Integrate one\nthin end-to-end path early',
      'Do not rerun completed side effects',
      'Keep an explicit acceptance ledger',
      'ask about that distinction before publishing',
      'Stop visual polishing once the stated checks pass',
      'do not sleep through an MCP deadline',
      '[Console]::InputEncoding',
    ]) assert.ok(body.includes(rule), rule)
    assert.doesNotMatch(body, /VRChat|WASAPI|Silero|26200/, 'The workflow is not a hidden audio recipe')
  } finally { await skills.stopWatching() }
}))
