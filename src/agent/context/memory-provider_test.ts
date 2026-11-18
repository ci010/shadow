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

test('memory provider composes keywords, logs and working set without a second convention authority', async () => {
  await withTempWorkspace(async (workspace) => {
    const memory = new MemoryStore(workspace)
    await memory.recordModifiedFile('discord:1', 'src/a.ts', 'write')
    await mkdir(`${workspace}/memory/topics`, { recursive: true })
    await writeFile(`${workspace}/memory/topics/plasma.md`, '# x')
    await seedEvent(workspace, 'discord:1')

    const provider = memoryProvider(memory, () => undefined)
    const out = await provider.getPromptSection(ctx('discord:1', agent('general')))
    assert(out !== null)

    const iKw = out.indexOf('**Long-term keywords**')
    const iEvents = out.indexOf('### Recent Logs')
    const iWs = out.indexOf('### Working Set')
    assert(iKw >= 0 && iEvents >= 0 && iWs >= 0, 'all sections present')
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

test('legacy convention files remain unchanged and are not promoted for any role or Work key', async () => {
  await withTempWorkspace(async (workspace) => {
    const memory = new MemoryStore(workspace)
    const paths = ['agent.conventions.md', 'sessions/discord_1.conventions.md', 'projects/old/conventions.md']
    for (const path of paths) {
      const target = join(workspace, 'memory', path)
      await mkdir(join(target, '..'), { recursive: true })
      await writeFile(target, '- LEGACY_RULE_UNKNOWN_AUTHORITY\n')
    }
    const provider = memoryProvider(memory, () => undefined)
    for (const name of ['general', 'sub', 'reflector']) {
      for (const initiative of ['old', 'work:123', 'initiative:old', undefined]) {
        assert.doesNotMatch(await provider.getPromptSection(ctx('discord:1', agent(name), initiative)) ?? '', /LEGACY_RULE_UNKNOWN_AUTHORITY/)
      }
    }
    for (const path of paths) assert.equal(await readFile(join(workspace, 'memory', path), 'utf8'), '- LEGACY_RULE_UNKNOWN_AUTHORITY\n')
  })
})

test('memory provider excludes persisted session summaries for every role', async () => {
  await withTempWorkspace(async workspace => {
    const directory = join(workspace, 'memory', 'sessions')
    await mkdir(directory, { recursive: true })
    const summary = '# Session Summary\n## Current Focus\nUNIQUE_OBJECTIVE\n## Progress\nUNIQUE_PROGRESS'
    await writeFile(join(directory, 'discord_1.md'), summary)
    const memory = new MemoryStore(workspace)
    const provider = memoryProvider(memory, () => undefined)

    for (const name of ['general', 'general-legacy', 'sub', 'reflector']) {
      assert.equal(await provider.getPromptSection(ctx('discord:1', agent(name))), null)
    }
    assert.equal(await memory.readSessionMemory('discord:1'), summary)
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
      assert.match(prompt!, /NEW_FILE/)
      assert.match(prompt!, /NEW_EVENT/)
      assert.doesNotMatch(prompt!, /OLD_/)
      assert.equal(await readFile(summary, 'utf8'), 'OLD_SUMMARY')
      await writeFile(summary, 'NEW_SUMMARY')
      await utimes(summary, new Date('2026-07-08T13:00:00Z'), new Date('2026-07-08T13:00:00Z'))
      assert.doesNotMatch((await provider.getPromptSection(context))!, /NEW_SUMMARY/)
      assert.equal(await memory.readSessionMemory(context.sessionId, 200, reset), 'NEW_SUMMARY')
    })
  })
})

test('memory provider keeps descriptions main-only and historical, and gates related logs', async () => {
  await withTempWorkspace(async workspace => {
    await mkdir(`${workspace}/memory/topics`, { recursive: true })
    await writeFile(`${workspace}/memory/topics/objects.md`, '---\ndescription: When investigating object relationships\n---\n# Objects\nBODY_NOT_FOR_PROMPT')
    await seedEvent(workspace, 'other')
    const memory = new MemoryStore(workspace)
    const provider = memoryProvider(memory, () => 'work')
    for (const role of ['general', 'general-legacy', 'sub', 'reflector']) {
      const out = await provider.getPromptSection(ctx('self', agent(role)))
      if (role === 'general' || role === 'general-legacy') {
        assert(out?.includes('objects — When investigating object relationships'))
        assert(out?.includes('memory, not current task state'))
        assert(out?.includes('Inferred motives remain hypotheses'))
      } else assert.equal(out, null)
      assert(!(out ?? '').includes('own event'))
      assert(!(out ?? '').includes('BODY_NOT_FOR_PROMPT'))
      const related = await provider.getPromptSection(ctx('self', agent(role), 'work'))
      assert(related?.includes('### Related Logs'))
      assert(related?.includes('[other]'))
    }
  })
})

test('general-v2 Session shortens the memory introduction without changing the recalled content', async () => {
  const memory = {
    readKeywords: async () => 'decisions: known-keyword — Summary',
    readLogs: async () => 'Historical log',
    readWorkingSet: async () => 'Previously touched file',
  } as unknown as MemoryStore
  const provider = memoryProvider(memory, () => undefined)
  const concise = (await provider.getPromptSection(ctx('web:fixture', agent('general-v2'))))!
  const legacy = (await provider.getPromptSection(ctx('web:fixture', agent('general'))))!
  const content = (prompt: string) => prompt.slice(prompt.indexOf('## Memory lookup index'))
  assert.match(concise, /## Memory lookup index/)
  assert.equal(content(concise), content(legacy))
  assert.match(concise, /Top-of-mind memory, not current state or authorization/)
  assert.match(concise, /search `v:memory`.*browse `v:knowledge`/)
  assert.doesNotMatch(concise, /Source scope:|explicit supersession/)
  assert.match(legacy, /Source scope: session "web:fixture"/)
})

test('automatic recall counts only log entries selected for a runtime prompt, not previews or indexes', async () => {
  await withTempWorkspace(async workspace => {
    await seedEvent(workspace, 'discord:reference')
    const recalled: string[] = []
    const provider = memoryProvider(new MemoryStore(workspace), () => undefined, entry => recalled.push(entry))
    const context = ctx('discord:reference', agent('general'))
    assert.match((await provider.getPromptSection(context))!, /Recent Logs/)
    assert.deepEqual(recalled, [])
    assert.match((await provider.getPromptSection({ ...context, runtimePrompt: true }))!, /Recent Logs/)
    assert.equal(recalled.length, 1)
    assert.match(recalled[0]!, /^events\/\d{4}-\d{2}-\d{2}\.jsonl#1$/)
  })
})
