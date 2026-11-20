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
      assert.doesNotMatch(body, /\b(?:audio_cpp|diffusion_cpp|invoke_tool)\b/)
      for (const detail of ['v:cpp-installations/diffusion-cpp', 'expectedSha256', 'observedSha256', 'HF_HUB_CACHE', 'MODELSCOPE_CACHE', 'extra_model_paths.yaml', 'Qwen Image 2.1', 'Qwen-Image-Edit', 'Z-Image-Turbo', 'Anima', 'MiniMax-H3', 'modelscope download', 'WebM', 'moss_image_sft', '--tokenizer', 'Verify and hand back']) {
        assert.ok(body.includes(detail), `Missing model/setup guidance: ${detail}`)
      }
    } finally {
      await skills.stopWatching()
    }
  })
})
