import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { withTempWorkspace } from '../testing/workspace.ts'
import { SkillsManager } from './loader.ts'

test('Git/GitHub CLI skill is bundled and discoverable without installing CLIs', async () => {
  await withTempWorkspace(async workspace => {
    const skills = new SkillsManager(workspace)
    try {
      await skills.load()
      const skill = skills.getSkillBody('git-github')
      assert.ok(skill)
      for (const detail of ['**safegit**', 'child-only PATH alias', 'SHADOW_SAFEGIT_PATH',
        'Never automatically fall back to raw Git', 'Other Git commands use ordinary Git', 'safegit coverage alone does not require', 'Prefer **gh**', 'v:skills/download']) {
        assert.ok(skill.includes(detail), detail)
      }
      assert.doesNotMatch(skill, /v:tools\/safegit|invoke_tool/)
      assert.ok(skills.getMetadataSummary().includes('git-github'))
    } finally { await skills.stopWatching() }
  })
})

test('Git fallback is human-scoped and consistent in skill and runtime roles', async () => {
  for (const file of ['./builtin/git-github/SKILL.md', './builtin/git-github/references/safegit.md']) {
    const text = await readFile(new URL(file, import.meta.url), 'utf8')
    for (const boundary of ['side effects', 'human authorization', 'specified repository and operation', 'higher-priority', 'force/reset/clean']) {
      assert(text.includes(boundary), `${file}: ${boundary}`)
    }
    assert.doesNotMatch(text, /never raw `git commit`|never request a raw Git bypass|do not fall back to raw Git|v:tools\/safegit/)
  }
  const prompt = await readFile(new URL('../agent/context/workspace.ts', import.meta.url), 'utf8')
  assert.equal(prompt.split('Other Git commands use ordinary Git; safegit coverage alone does not require extra approval.').length - 1, 2)
  assert.doesNotMatch(prompt, /Before Git mutations|Never automatically fall back to raw Git/)
  const runtime = await readFile(new URL('../runtime/main/project-runtime.ts', import.meta.url), 'utf8')
  assert.doesNotMatch(runtime, /SafegitTool|registerBuiltin\('safegit'/)
})
