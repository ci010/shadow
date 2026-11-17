import assert from 'node:assert/strict'
import { test } from 'node:test'
import { withTempWorkspace } from '../testing/workspace.ts'
import { SkillsManager } from './loader.ts'

test('workspace fork hints are discoverable without provisioning', async () => {
  await withTempWorkspace(async workspace => {
    const skills = new SkillsManager(workspace)
    try {
      await skills.load()
      assert.ok(skills.availableSkills().some(skill => skill.meta.name === 'workspace-fork'))
      const body = skills.getSkillBody('workspace-fork')
      assert.ok(body)
      for (const detail of [
        'v:tools/workspace_fork', 'workspaceId', 'workspace_use',
        'committed tip', 'v:skills/layerfs-worker',
        'packageManager', 'virtualStoreType: global', 'older settings differ',
        'https://pnpm.io/git-worktrees', 'https://pnpm.io/global-virtual-store',
        'content-addressable store', 'pnpm install --frozen-lockfile',
        'do not copy/symlink sibling', 'same trust boundary', 'platform/Node ABI',
        'Completed is not integrated', 'not automatic cleanup',
      ]) assert.ok(body.includes(detail), `Missing fork hint: ${detail}`)
      assert.doesNotMatch(body, /pnpm config set|git worktree remove --force/)
    } finally { await skills.stopWatching() }
  })
})
