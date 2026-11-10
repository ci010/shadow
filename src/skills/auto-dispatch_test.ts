import assert from 'node:assert/strict'
import test from 'node:test'
import { SkillsManager } from './loader.ts'
import { withTempWorkspace } from '../testing/workspace.ts'

test('ordinary sessions can discover dispatch customization without replacing the internal role', async () => {
  await withTempWorkspace(async home => {
    const skills = new SkillsManager(home)
    try {
      await skills.load()
      assert(skills.availableSkills().some(skill => skill.meta.name === 'auto-dispatch'))
      const body = skills.getSkillBody('auto-dispatch')
      assert(body)
      for (const text of ['v:project/dispatch-instructions.md', 'v:project/dispatch-memory.md',
        'supplements', 'fresh dispatcher context', 'next dispatch run', 'Preserve unrelated',
        'not a source of current assignment', 'do not themselves enable']) {
        assert(body.includes(text), `Missing customization guidance: ${text}`)
      }
    } finally { await skills.stopWatching() }
  })
})
