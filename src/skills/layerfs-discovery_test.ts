import assert from 'node:assert/strict'
import test from 'node:test'
import { SkillsManager } from './loader.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { createSkillsHandler } from '../vfs/mounts.ts'
import type { ExecutionContext } from '../tools/context.ts'

test('LayerFS skills expose executable official SDK path, not pipeline tools or implicit installation', async () => {
  await withTempWorkspace(async home => {
    const skills = new SkillsManager(home)
    try {
      await skills.load()
      const declarations: unknown[] = []
      const handlers = createSkillsHandler(skills, async skill => { declarations.push(skill.meta.tools ?? {}); return [] })
      const context = { signal: new AbortController().signal } as ExecutionContext
      const setup = String(await handlers.read('layerfs/setup.md', context))
      const script = String(await handlers.read('layerfs/sdk-init.mjs', context))
      const bodies: Record<string, string> = {}
      for (const name of ['layerfs', 'layerfs-worker', 'layerfs-manager', 'layerfs-setup']) bodies[name] = String(await handlers.read(name, context))
      assert.deepEqual(declarations, [{}, {}, {}, {}])
      for (const body of [setup, script, ...Object.values(bodies)]) assert.doesNotMatch(body, /Resource not found|Skill not found|layerfs_template_prepare|layerfs_template_plan/)
      assert.match(bodies.layerfs, /v:tools\/layerfs_resource_list/)
      assert.match(bodies.layerfs, /No preliminary source\s+initialization is required/)
      assert.match(bodies['layerfs-worker'], /ordinary `read`, `write`, `search` and `exec`/)
      assert.match(bodies['layerfs-worker'], /even on nonzero command exit/)
      assert.match(bodies['layerfs-manager'], /source:"EXACT_RESOURCE_ID"/)
      assert.match(bodies['layerfs-manager'], /Publish updates LayerFS\s+main only, never host source files/)
      for (const term of ['layerfs_runtime_context', 'layerfs_resource_register', 'allowRootWorker', 'allowDownloads', 'ELECTRON_RUN_AS_NODE', 'exit $LASTEXITCODE', 'git -C', 'lfs checkout', 'lfs fsck', 'sourceName', 'sourceRoot', 'ext4', 'docker build', 'standalone', '127.0.0.1']) assert.ok(setup.includes(term), term)
      assert.match(script, /runtime.project.start_init/)
      assert.match(script, /runtime.project.get_init/)
      assert.match(script, /client.project.list_branches/)
      assert.match(script, /finally.*client.close/s)
      assert.doesNotMatch(script, /child_process|Dockerfile|git clone|LayerFSRuntime.open/)
    } finally { await skills.stopWatching() }
  })
})
