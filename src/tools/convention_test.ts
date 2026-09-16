import assert, { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { MemoryStore } from '../agent/memory.ts'
import { ConventionTool } from './convention.ts'
import type { ExecutionContext } from './context.ts'
import { withTempWorkspace } from '../testing/workspace.ts'

function ectx(sessionId: string): ExecutionContext {
  return { sessionId } as unknown as ExecutionContext
}

test('update_convention — adds a session convention', async () => {
  await withTempWorkspace(async (workspace) => {
    const memory = new MemoryStore(workspace)
    const tool = new ConventionTool(memory)

    const res = await tool.execute(
      { action: 'add', scope: 'session', text: 'be terse' },
      ectx('discord:1'),
    )
    assert(res.includes('Added [session]'))
    assert((await memory.readConventions('discord:1')).includes('be terse'))
  })
})

test('update_convention — project scope requires a project name', async () => {
  await withTempWorkspace(async (workspace) => {
    const tool = new ConventionTool(new MemoryStore(workspace))
    const res = await tool.execute(
      { action: 'add', scope: 'project', text: 'x' },
      ectx('discord:1'),
    )
    assert(res.includes('project name is required'))
  })
})

test('update_convention — project scope writes to the project', async () => {
  await withTempWorkspace(async (workspace) => {
    const memory = new MemoryStore(workspace)
    const tool = new ConventionTool(memory)

    await tool.execute(
      { action: 'add', scope: 'project', text: 'chore prefix', project: 'shadow' },
      ectx('discord:1'),
    )
    assert((await memory.readConventions('discord:1', 'shadow')).includes('chore prefix'))
    // Not visible to a session in a different project context.
    assertEquals(await memory.readConventions('discord:1', 'other'), '')
  })
})

test('update_convention — remove and validation errors', async () => {
  await withTempWorkspace(async (workspace) => {
    const memory = new MemoryStore(workspace)
    const tool = new ConventionTool(memory)

    await tool.execute(
      { action: 'add', scope: 'session', text: 'temp rule' },
      ectx('discord:1'),
    )
    const removed = await tool.execute(
      { action: 'remove', scope: 'session', text: 'temp' },
      ectx('discord:1'),
    )
    assert(removed.includes('Removed [session]'))
    assertEquals(await memory.readConventions('discord:1'), '')

    assert(
      (await tool.execute(
        { action: 'add', scope: 'session', text: '' },
        ectx('discord:1'),
      )).includes('Error: text is required'),
    )
    assert(
      (await tool.execute(
        { action: 'nope', scope: 'session', text: 'x' },
        ectx('discord:1'),
      )).includes('unknown action'),
    )
  })
})
