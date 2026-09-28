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
      assert.ok(body)
      for (const detail of ['outputPath', 'v:bg/bg:0123456789abcdef', 'cancel({executionId})']) {
        assert.ok(body.includes(detail), `Missing execution reference instruction: ${detail}`)
      }
      assert.doesNotMatch(body, /v:bg\/<taskId>|kill\(\{|Where the execution-ID API/)
    } finally {
      await skills.stopWatching()
    }
  })
})
