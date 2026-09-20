import assert, { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readFile, utimes, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MemoryStore } from '../memory.ts'
import { memoryProvider } from './memory-provider.ts'
import type { SessionPromptContext } from './builder.ts'
import type { AgentTypeDefinition } from '../types/types.ts'
import type { SessionConfig } from '../../sessions/session-store.ts'
import { withTempWorkspace } from '../../testing/workspace.ts'
import type { ExecutionMode } from '../../sessions/execution-mode.ts'

function agent(name: string, defaultMode: ExecutionMode = 'session'): AgentTypeDefinition {
  return {
    name,
    description: '',
    prompt: '',
    defaultMode,
    source: 'builtin',
  }
}

function ctx(
  sessionId: string,
  a: AgentTypeDefinition,
  initiativeId?: string,
): SessionPromptContext {
  return {
    behavior: {} as SessionConfig,
    channel: 'test',
    sessionId,
    chatId: sessionId,
    agent: a,
    initiativeId,
  }
}

async function seedEvent(workspace: string, origin: string): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)
  await mkdir(`${workspace}/memory/events`, { recursive: true })
  await writeFile(
    `${workspace}/memory/events/${today}.jsonl`,
    JSON.stringify({
      when: '2026-07-07T09:00:00Z',
      who: 'a',
      what: 'own event',
      origin,
    }) + '\n',
  )
}

test('memory provider — composes block in MEM.md order', async () => {
  await withTempWorkspace(async (workspace) => {
    const memory = new MemoryStore(workspace)
    await memory.addConvention('session', 'discord:1', 'be terse')
    await memory.recordModifiedFile('discord:1', 'src/a.ts', 'write')
    await mkdir(`${workspace}/memory/topics`, { recursive: true })
    await writeFile(`${workspace}/memory/topics/plasma.md`, '# x')
    await seedEvent(workspace, 'discord:1')

    const provider = memoryProvider(memory, () => undefined)
    const out = await provider.getPromptSection(ctx('discord:1', agent('general')))
    assert(out !== null)

    // Order: Conventions → Keywords → Events → Working Set.
    const iConv = out.indexOf('### Conventions')
    const iKw = out.indexOf('**Long-term keywords**')
    const iEvents = out.indexOf('### Recent Events')
    const iWs = out.indexOf('### Working Set')
    assert(iConv >= 0 && iKw >= 0 && iEvents >= 0 && iWs >= 0, 'all sections present')
    assert(iConv < iKw, 'conventions before keywords')
    assert(iKw < iEvents, 'keywords before events')
    assert(iEvents < iWs, 'events before working set')
  })
})

test('memory provider — keyword index is main-agent-only', async () => {
  await withTempWorkspace(async (workspace) => {
    const memory = new MemoryStore(workspace)
    await mkdir(`${workspace}/memory/topics`, { recursive: true })
    await writeFile(`${workspace}/memory/topics/plasma.md`, '# x')
    const provider = memoryProvider(memory, () => undefined)

    const main = await provider.getPromptSection(ctx('discord:1', agent('general')))
    assert((main ?? '').includes('**Long-term keywords**'))

    // Keyword indexing belongs to the main role, not the execution lifetime.
    const sub = await provider.getPromptSection(ctx('discord:1', agent('sub')))
    assert(!(sub ?? '').includes('**Long-term keywords**'))

    const eph = await provider.getPromptSection(
      ctx('discord:1', agent('reflector', 'task')),
    )
    assert(!(eph ?? '').includes('**Long-term keywords**'))
  })
})

test('memory provider — conventions inject for sub-agents (read-only)', async () => {
  await withTempWorkspace(async (workspace) => {
    const memory = new MemoryStore(workspace)
    await memory.addConvention('agent', undefined, 'always be safe')
    const provider = memoryProvider(memory, () => undefined)

    const sub = await provider.getPromptSection(ctx('discord:1', agent('sub')))
    assert((sub ?? '').includes('### Conventions'))
    assert((sub ?? '').includes('always be safe'))
  })
})

test('memory provider — returns null when nothing to inject', async () => {
  await withTempWorkspace(async (workspace) => {
    const provider = memoryProvider(new MemoryStore(workspace), () => undefined)
    assertEquals(
      await provider.getPromptSection(ctx('fresh:1', agent('general'))),
      null,
    )
  })

  test('clear excludes old transient context without deleting memory and accepts new entries', async () => {
    await withTempWorkspace(async workspace => {
      const memory = new MemoryStore(workspace)
      await memory.addConvention('session', 'web:clear', 'KEEP_CONVENTION')
      const directory = join(workspace, 'memory', 'sessions')
      await mkdir(directory, { recursive: true })
      const summary = join(directory, 'web_clear.md')
      await writeFile(summary, 'OLD_SUMMARY')
      const reset = '2026-07-08T12:00:00.000Z'
      await utimes(summary, new Date('2026-07-08T11:00:00Z'), new Date('2026-07-08T11:00:00Z'))
      await writeFile(join(directory, 'web_clear.files.jsonl'), [
        { when: '2026-07-08T11:00:00Z', path: 'OLD_FILE', action: 'write' },
        { when: '2026-07-08T13:00:00Z', path: 'NEW_FILE', action: 'edit' },
      ].map(entry => JSON.stringify(entry)).join('\n') + '\n')
      const eventDir = join(workspace, 'memory', 'events')
      await mkdir(eventDir, { recursive: true })
      await writeFile(join(eventDir, `${new Date().toISOString().slice(0, 10)}.jsonl`), [
        { when: '2026-07-08T11:00:00Z', what: 'OLD_EVENT', origin: 'web:clear' },
        { what: 'OLD_UNDATED', origin: 'web:clear' },
        { when: '2026-07-08T13:00:00Z', what: 'NEW_EVENT', origin: 'web:clear' },
      ].map(entry => JSON.stringify(entry)).join('\n') + '\n')
      const context = { ...ctx('web:clear', agent('general')), contextResetAt: reset }
      const provider = memoryProvider(memory, () => undefined)
      const prompt = await provider.getPromptSection(context)
      assert.match(prompt!, /KEEP_CONVENTION/)
      assert.match(prompt!, /NEW_FILE/)
      assert.match(prompt!, /NEW_EVENT/)
      assert.doesNotMatch(prompt!, /OLD_/)
      assert.equal(await readFile(summary, 'utf8'), 'OLD_SUMMARY')
      await writeFile(summary, 'NEW_SUMMARY')
      await utimes(summary, new Date('2026-07-08T13:00:00Z'), new Date('2026-07-08T13:00:00Z'))
      assert.match((await provider.getPromptSection(context))!, /NEW_SUMMARY/)
    })
  })
})
