import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { withTempWorkspace } from '../testing/workspace.ts'
import { PlanWriteTool } from './plan-write.ts'

test('plans persist and edit in canonical durable state with directly readable output paths', async () => {
  await withTempWorkspace(async home => {
    const tool = new PlanWriteTool(home)
    const file = join(home, 'state', 'plans', 'nested', 'plan.md')
    assert.equal(await tool.execute({ path: 'nested/plan.md', content: 'first' }), `📝 ${file}`)
    assert.equal(await readFile(file, 'utf8'), 'first')
    assert.equal(await tool.execute({ path: 'nested/plan.md', match: 'first', content: 'revised' }), `✏️ ${file}`)
    assert.equal(await readFile(file, 'utf8'), 'revised')
    assert.equal(existsSync(join(home, '.plans')), false)
    assert.match(await tool.execute({ path: '../escape.md', content: 'blocked' }), /^Error:/)
    assert.match(await tool.execute({ path: join(home, 'outside.md'), content: 'blocked' }), /^Error:/)
    assert.equal(existsSync(join(home, 'outside.md')), false)
  })
})
