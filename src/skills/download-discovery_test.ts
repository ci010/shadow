import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withTempWorkspace } from '../testing/workspace.ts'
import { SkillsManager } from './loader.ts'

test('new sessions discover the shared download skill without implicit installs', async () => {
  await withTempWorkspace(async workspace => {
    const skills = new SkillsManager(workspace)
    try {
      await skills.load()
      assert.match(skills.getMetadataSummary(), /<skill name="download">/)
      const body = skills.getSkillBody('download')
      for (const detail of ['aria2c', 'SHA-256', 'approved: true', 'ModelScope', 'SHADOW_ARIA2C_PATH']) {
        assert.ok(body?.includes(detail), `Missing downloader instruction: ${detail}`)
      }
    } finally {
      await skills.stopWatching()
    }
  })
})
