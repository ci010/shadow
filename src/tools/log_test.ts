import { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { readFile } from 'node:fs/promises'
import { LogTool } from './log.ts'
import type { ExecutionContext } from './context.ts'
import { withTempWorkspace } from '../testing/workspace.ts'

function ectx(sessionId: string): ExecutionContext {
  return { sessionId } as unknown as ExecutionContext
}

async function readTodayEvents(
  workspace: string,
): Promise<Record<string, unknown>[]> {
  const today = new Date().toISOString().slice(0, 10)
  const content = await readFile(
    `${workspace}/memory/events/${today}.jsonl`,
    'utf8',
  )
  return content.trim().split('\n').map((l) => JSON.parse(l))
}

test('log — origin defaults to the context session', async () => {
  await withTempWorkspace(async (workspace) => {
    const tool = new LogTool(workspace)
    await tool.execute({ who: 'agent', what: 'did X' }, ectx('discord:1'))

    const [e] = await readTodayEvents(workspace)
    assertEquals(e.origin, 'discord:1')
    assertEquals(e.who, 'agent')
    assertEquals(e.what, 'did X')
  })
})

test('log — explicit session arg overrides origin', async () => {
  await withTempWorkspace(async (workspace) => {
    const tool = new LogTool(workspace)
    // The flush scribe reviews another session and attributes the event to it,
    // not to itself.
    await tool.execute(
      { who: 'scribe', what: 'reviewed', session: 'discord:99' },
      ectx('reflector:1'),
    )

    const [e] = await readTodayEvents(workspace)
    assertEquals(e.origin, 'discord:99')
  })
})

test('log — optional fields carried through', async () => {
  await withTempWorkspace(async (workspace) => {
    const tool = new LogTool(workspace)
    await tool.execute(
      {
        who: 'a',
        what: 'b',
        why: 'c',
        challenge: 'd',
        refs: ['memory/topics/x.md'],
      },
      ectx('s'),
    )

    const [e] = await readTodayEvents(workspace)
    assertEquals(e.why, 'c')
    assertEquals(e.challenge, 'd')
    assertEquals(e.refs, ['memory/topics/x.md'])
  })
})
