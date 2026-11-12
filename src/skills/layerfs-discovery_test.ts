import assert from 'node:assert/strict'
import test from 'node:test'
import { SkillsManager } from './loader.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { createSkillsHandler } from '../vfs/mounts.ts'
import type { ExecutionContext } from '../tools/context.ts'

test('LayerFS scenario skills guide flattened discovery without tool aliases or mandatory source initialization', async () => {
  await withTempWorkspace(async home => {
    const skills = new SkillsManager(home)
    try {
      await skills.load()
      const toolDeclarations: unknown[] = []
      const handlers = createSkillsHandler(skills, async skill => {
        // The VFS callback runs on skill reads even without frontmatter tools.
        // Callback count is not evidence that the builtin factory was activated.
        toolDeclarations.push(skill.meta.tools ?? {})
        return []
      })
      const context = { signal: new AbortController().signal } as ExecutionContext
      const setup = String(await handlers.read('layerfs/setup.md', context))
      assert.doesNotMatch(setup, /Resource not found/)
      assert.equal(toolDeclarations.length, 0)
      const bodies: Record<string, string> = {}
      for (const name of ['layerfs', 'layerfs-worker', 'layerfs-manager', 'layerfs-setup']) {
        bodies[name] = String(await handlers.read(name, context))
        assert.doesNotMatch(bodies[name], /Resource not found|Skill not found/)
        assert.match(bodies[name], new RegExp(`# LayerFS`))
      }
      assert.deepEqual(toolDeclarations, [{}, {}, {}, {}])
      const nav = bodies.layerfs
      for (const name of ['worker', 'manager', 'setup']) assert.match(nav, new RegExp(`v:skills/layerfs-${name}`))
      assert.match(nav, /v:tools\/layerfs_branches/)
      assert.match(nav, /invoke_tool \{name:"layerfs_branches",args:\{\}\}/)
      assert.match(nav, /No preliminary source\s+initialization is required/)
      assert.match(nav, /Skill reads do not activate the builtin LayerFS factory/)
      assert.match(nav, /not role-based tool visibility or permission gates/)
      assert.match(nav, /\[setup.md\]\(setup.md\)/)
      assert.match(bodies['layerfs-worker'], /ordinary `read`, `write`, `search` and `exec`/)
      assert.match(bodies['layerfs-worker'], /Do not install, connect, import, provision or repair/)
      assert.match(bodies['layerfs-worker'], /even on nonzero command exit/)
      assert.match(bodies['layerfs-worker'], /literal.*grep/)
      assert.match(bodies['layerfs-manager'], /backend:"layerfs",source:"main",idempotencyKey/)
      assert.match(bodies['layerfs-manager'], /Legacy mount records are preserved but ordinary tools refuse them/)
      assert.match(bodies['layerfs-manager'], /Publish updates LayerFS main only, never host source files/)
      const lifecycle = bodies['layerfs-setup']
      assert.match(lifecycle, /v:skills\/layerfs\/setup.md/)
      assert.match(lifecycle, /layerfs_connect/)
      assert.match(lifecycle, /allowDownloads/)
      assert.match(lifecycle, /continue the original task/)
      assert.match(lifecycle, /environment edits or ad hoc shell installers/)
      assert.match(lifecycle, /code-change request is not runtime approval/)
      assert.match(setup, /SHADOW_LAYERFS_CONFIG/)
      assert.match(setup, /backend's\s+environment/)
      assert.match(setup, /runtime:"not_checked"/)
      assert.match(setup, /ignored and\s+untracked/)
      assert.match(setup, /session-bound and expires after fifteen minutes/)
      assert.match(setup, /No SDK path, image choice, script, URL, JSON file or environment variable/)
      assert.match(setup, /allowRootWorker/)
      assert.match(setup, /fresh-machine installer requires/)
      assert.match(setup, /v:skills\/layerfs\/setup.md/)
      assert.doesNotMatch(setup, /v:skills\/layerfs\/layerfs_setup.md/)
      for (const body of [...Object.values(bodies), setup]) {
        assert.doesNotMatch(body, /Initialize `invoke_tool \{source:"layerfs"/)
      }
    } finally { await skills.stopWatching() }
  })
})
