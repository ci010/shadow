import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SkillsManager } from './loader.ts'
import { withTempWorkspace } from '../testing/workspace.ts'

test('new sessions can discover the optional image/video skill and its reuse-first instructions', async () => {
  await withTempWorkspace(async workspace => {
    const skills = new SkillsManager(workspace)
    try {
      await skills.load()
      assert.match(skills.getMetadataSummary(), /<skill name="diffusion-cpp">.*MiniMax-H3/)
      const body = skills.getSkillBody('diffusion-cpp')
      assert.ok(body)
      for (const detail of [
        'diffusion_cpp status', 'diffusion_cpp discover', 'licenseAcknowledged',
        'HF_HUB_CACHE', 'MODELSCOPE_CACHE', 'extra_model_paths.yaml',
        'Qwen Image 2.1', 'Qwen-Image-Edit', 'Z-Image-Turbo', 'Anima', 'MiniMax-H3',
        'modelscope download', 'WebM', 'filename_and_size_only',
      ]) {
        assert.ok(body.includes(detail), `Missing model/setup guidance: ${detail}`)
      }
    } finally {
      await skills.stopWatching()
    }
  })
})
