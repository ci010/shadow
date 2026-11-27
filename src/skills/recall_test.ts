import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { parseSkillFile } from './parse.ts'
import { SkillsManager } from './loader.ts'
import { SkillRecallStore } from './recall.ts'
import { createSkillsHandler } from '../vfs/mounts.ts'
import type { ExecutionContext } from '../tools/context.ts'

test('Skill body reads forward host context; continuation, resources and discovery do not count', async () => {
  await withTempWorkspace(async workspace => {
    const dir = join(workspace, 'skills', 'recall-fixture')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'SKILL.md'), '---\nname: recall-fixture\ndescription: Fixture\n---\nFixture body')
    await writeFile(join(dir, 'resource.md'), 'Resource')
    const skills = new SkillsManager(workspace)
    skills.setSkill('recall-fixture', { ...parseSkillFile('---\nname: recall-fixture\ndescription: Fixture\n---\nFixture body', 'recall-fixture'), dirPath: dir })
    const context = { sessionId: 'ordinary', inputSource: 'user', signal: new AbortController().signal, admin: true } as ExecutionContext
    const calls: string[] = []
    const store = new SkillRecallStore(':memory:', undefined, (path, admitted) => {
      assert.equal(admitted, context)
      calls.push(path)
    }, () => 'Corrected totals only')
    try {
      const handler = createSkillsHandler(skills, undefined, undefined, undefined, store)
      await handler.read('', context)
      await handler.read('recall-fixture/resource.md', context)
      await handler.read('recall-fixture', context, { offset: 2 })
      await handler.read('missing-fixture', context)
      assert.deepEqual(calls, [])
      assert.match(await handler.read('recall-fixture', context), /Fixture body/)
      assert.deepEqual(calls, ['recall-fixture'])
      assert.equal(await handler.read('.stats', context), 'Corrected totals only')
    } finally { store.close(); await skills.stopWatching() }
  })
})
