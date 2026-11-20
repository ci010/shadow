import assert from 'node:assert/strict'
import { test } from 'node:test'
import { SkillsManager } from './loader.ts'
import { withTempWorkspace } from '../testing/workspace.ts'

test('the audio.cpp integration is disclosed to new sessions with setup instructions available on demand', async () => {
  await withTempWorkspace(async workspace => {
    const skills = new SkillsManager(workspace)
    try {
      await skills.load()
      const summary = skills.getMetadataSummary()
      assert.match(summary, /<skill name="audio-cpp">.*ASR\/TTS/)
      const body = skills.getSkillBody('audio-cpp')
      assert.ok(body)
      assert.doesNotMatch(body, /\b(?:audio_cpp|diffusion_cpp|invoke_tool)\b/)
      for (const detail of ['v:cpp-installations/audio-cpp', '--text-out', '--source modelscope', 'AUDIOCPP_CLI_PATH', 'observedSha256']) {
        assert.ok(body.includes(detail), `Missing setup guidance: ${detail}`)
      }
    } finally {
      await skills.stopWatching()
    }
  })
})
