import assert from 'node:assert/strict'
import test from 'node:test'
import { SkillsManager } from './loader.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { createSkillsHandler } from '../vfs/mounts.ts'
import type { ExecutionContext } from '../tools/context.ts'

test('LayerFS setup is a bundled readable resource and routing guidance agrees with the tools', async () => {
  await withTempWorkspace(async home => {
    const skills = new SkillsManager(home)
    try {
      await skills.load()
      let registrations = 0
      const handlers = createSkillsHandler(skills, async () => { registrations++; return [] })
      const context = { signal: new AbortController().signal } as ExecutionContext
      const setup = String(await handlers.read('layerfs/setup.md', context))
      assert.doesNotMatch(setup, /Resource not found/)
      assert.match(setup, /SHADOW_LAYERFS_CONFIG/)
      assert.match(setup, /backend's\s+environment/)
      assert.match(setup, /runtime:"not_checked"/)
      assert.match(setup, /ignored and\s+untracked/)
      assert.equal(registrations, 0)
      const skill = String(await handlers.read('layerfs', context))
      assert.match(skill, /action:"connect"/)
      assert.match(skill, /action:"bootstrap"/)
      assert.match(skill, /allowDownloads:true/)
      assert.match(skill, /continue the\s+original user request/)
      assert.match(setup, /session-bound and expires after fifteen minutes/)
      assert.match(setup, /No SDK path, image choice, script, URL, JSON file or environment variable/)
      assert.match(skill, /no environment variable or backend restart/)
      assert.match(setup, /allowRootWorker/)
      assert.match(setup, /fresh-machine installer requires/)
      assert.match(skill, /Setup\/start is forbidden if the user declined it/)
      assert.match(skill, /v:skills\/layerfs\/setup\.md/)
      assert.match(skill, /Ordinary read\/write\/exec accept\s+new `layerfs:` mount IDs/)
      assert.doesNotMatch(skill, /do not transparently target LayerFS/)
      assert.equal(registrations, 1)
    } finally { await skills.stopWatching() }
  })
})
