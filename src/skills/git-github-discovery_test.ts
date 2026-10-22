import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { test } from 'node:test'
import { withTempWorkspace } from '../testing/workspace.ts'
import { SkillsManager } from './loader.ts'

test('Git/GitHub skill is bundled and discoverable without installing CLIs', async () => {
  await withTempWorkspace(async workspace => {
    const skills = new SkillsManager(workspace)
    try {
      await skills.load()
      const skill = skills.getSkillBody('git-github')
      assert.ok(skill)
      for (const detail of ['bundled **safegit**', 'never raw',
        'v:skills/git-github/references/safegit.md', 'Prefer **gh**',
        'fetch', 'read', 'not unlimited requests', 'v:skills/download',
        'v:tools/safegit/safegit', 'invoke_tool', 'SHADOW_SAFEGIT_PATH', 'authorized safegit']) {
        assert.ok(skill.includes(detail), `Missing guidance: ${detail}`)
      }
      assert.doesNotMatch(skill, /### Native Windows|Windows ARM64|pinned SHA-256/)
      const usage = await readFile(new URL('./builtin/git-github/references/safegit.md', import.meta.url), 'utf8')
      assert.match(usage, /v:tools\/safegit\/safegit/)
      assert.doesNotMatch(usage, /Discover `safegit` under|Windows x64|SHA-256/)
      assert.ok(skills.getMetadataSummary().includes('git-github'))
    } finally {
      await skills.stopWatching()
    }
  })
})

test('shared session workspace context defaults commits and pushes to safegit', async () => {
  const source = await readFile(new URL('../agent/context/workspace.ts', import.meta.url), 'utf8')
  assert.match(source, /Before Git mutations or GitHub research, read `v:skills\/git-github`/)
  assert.match(source, /In every session, use the bundled stricttools\/safegit/)
  assert.match(source, /If safegit is unavailable, stop the mutation/)
})
