import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withTempWorkspace } from '../testing/workspace.ts'
import { SkillsManager } from './loader.ts'

test('the bundled image-generation skill documents the dynamic OpenRouter route without executable declarations', async () => {
  await withTempWorkspace(async workspace => {
    const skills = new SkillsManager(workspace)
    try {
      await skills.load()
      const skill = skills.availableSkills().find(entry => entry.meta.name === 'image-generation')
      assert.ok(skill)
      assert.match(skill.meta.description, /OpenRouter/)
      assert.ok(!skill.meta.tools?.length)
      for (const detail of ['invoke_tool({ name: "generate_image"', 'v:tools/generate_image', 'its own confirmation',
        'private Shadow Web', 'bytedance-seed/seedream-4.5', 'never retry automatically', 'v:skills/diffusion-cpp']) {
        assert.ok(skill.body.includes(detail), detail)
      }
    } finally { await skills.stopWatching() }
  })
})
