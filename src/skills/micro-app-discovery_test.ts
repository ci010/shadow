import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SkillsManager } from './loader.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { readFile } from 'node:fs/promises'

const source = (path: string) => readFile(new URL(path, import.meta.url), 'utf8')

test('micro-app discovery requires Shadow Apps delivery, not merely a reusable webpage', async () => withTempWorkspace(async home => {
  const skills = new SkillsManager(home)
  try {
    await skills.load()
    const raw = await source('./builtin/micro-app/SKILL.md')
    const description = raw.split('\n').find(line => line.startsWith('description:'))!
    for (const text of ['Shadow Apps', 'has chosen that delivery format', 'ordinary websites',
      'standalone HTML pages', 'UI prototypes', 'existing Web projects', 'repeat use alone is not a trigger']) {
      assert.ok(description.includes(text), text)
    }
    const body = skills.getSkillBody('micro-app')!
    assert.match(body, /does not by itself select Shadow Apps/)
    assert.match(body, /do\s+not silently choose it or ask every webpage requester/)
    const role = await source('../agent/types/builtin/general/AGENT.md')
    assert.match(role, /v:skills\/micro-app` when the user requests a Shadow-hosted/)
    assert.match(role, /repeat use alone do not imply Micro Apps/)
    assert.doesNotMatch(role, /Reusable tools: read/)
    assert.match(await source('./builtin/impeccable/SKILL.md'), /Only when the user requests or chooses Shadow Apps/)
  } finally { await skills.stopWatching() }
}))

test('compact app guide keeps approval boundaries and points to stage-specific protocols', async () => withTempWorkspace(async home => {
  const skills = new SkillsManager(home)
  try {
    await skills.load()
    const body = skills.getSkillBody('micro-app')!
    assert.ok(body.split('\n').length < 210, 'Keep the default guide compact')
    for (const text of ['shadow-app.json', 'awaiting_approval', '/_shadow/sdk.js',
      'exact-version owner review', 'not an OS sandbox', 'never executes tools',
      'retain earlier answers, constraints and verified behavior', 'cannot replace it']) {
      assert.ok(body.includes(text), text)
    }
    const references = [...body.matchAll(/v:skills\/micro-app\/(reference\/[\w-]+\.md)/g)]
    assert.equal(references.length, 3)
    const docs = new Map<string, string>()
    for (const [, path] of references) docs.set(path!, await source(`./builtin/micro-app/${path}`))
    for (const [path, rules] of [
      ['reference/testing.md', ['sdk_connected', 'workRevision', 'observations', 'not_tested', 'evidence', 'restart']],
      ['reference/backend.md', ['Authorization: Bearer', 'SHADOW_APP_TEMP', '127.0.0.1', 'not an OS', 'SHADOW_APP_DATA']],
      ['reference/ui-and-errors.md', ['status-only events', 'extended idle interval', '[Console]::OutputEncoding', '[Console]::InputEncoding', 'primary error message']],
    ] as const) {
      for (const rule of rules) assert.ok(docs.get(path)!.includes(rule), `${path}: ${rule}`)
    }
  } finally { await skills.stopWatching() }
}))
