import assert, { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { MemoryStore } from '../../agent/memory.ts'
import { WorkingSetHook } from './working-set.ts'
import type { ExecutionContext } from '../context.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'

function ectx(sessionId: string): ExecutionContext {
  return { sessionId } as unknown as ExecutionContext
}

test('working-set hook — records a successful write', async () => {
  await withTempWorkspace(async (workspace) => {
    const memory = new MemoryStore(workspace)
    const hook = new WorkingSetHook(memory)

    await hook.afterExecute(
      'write',
      { path: 'src/a.ts', content: '...' },
      '📝 src/a.ts',
      ectx('discord:1'),
    )
    assert((await memory.readWorkingSet('discord:1')).includes('- src/a.ts'))
  })
})

test('working-set hook — records edit action for match writes', async () => {
  await withTempWorkspace(async (workspace) => {
    const memory = new MemoryStore(workspace)
    const hook = new WorkingSetHook(memory)

    await hook.afterExecute(
      'write',
      { path: 'src/b.ts', content: 'x', match: 'y' },
      '✏️ src/b.ts',
      ectx('discord:1'),
    )
    assert((await memory.readWorkingSet('discord:1')).includes('- src/b.ts (edit)'))
  })
})

test('working-set hook — ignores failed writes and non-write tools', async () => {
  await withTempWorkspace(async (workspace) => {
    const memory = new MemoryStore(workspace)
    const hook = new WorkingSetHook(memory)

    // Failed write (result starts with "Error").
    await hook.afterExecute(
      'write',
      { path: 'src/x.ts', content: '' },
      'Error: write restricted to workspace directory',
      ectx('discord:1'),
    )
    // A read tool is not a mutation.
    await hook.afterExecute(
      'read',
      { path: 'src/y.ts' },
      'file contents',
      ectx('discord:1'),
    )

    assertEquals(await memory.readWorkingSet('discord:1'), '')
  })
})
