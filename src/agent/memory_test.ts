import assert, { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { MemoryStore } from './memory.ts'
import { withTempWorkspace } from '../testing/workspace.ts'

test('working set — empty when nothing recorded', async () => {
  await withTempWorkspace(async (workspace) => {
    const memory = new MemoryStore(workspace)
    assertEquals(await memory.readWorkingSet('discord:1'), '')
  })
})

test('working set — records writes and renders section', async () => {
  await withTempWorkspace(async (workspace) => {
    const memory = new MemoryStore(workspace)
    await memory.recordModifiedFile('discord:1', 'src/a.ts', 'write')
    await memory.recordModifiedFile('discord:1', 'src/b.ts', 'edit')

    const out = await memory.readWorkingSet('discord:1')
    assert(out.includes('### Working Set (this session)'))
    assert(out.includes('- src/a.ts'))
    assert(out.includes('- src/b.ts (edit)'))
  })
})

test('working set — collapses by path, most-recent last', async () => {
  await withTempWorkspace(async (workspace) => {
    const memory = new MemoryStore(workspace)
    await memory.recordModifiedFile('discord:1', 'src/a.ts', 'write')
    await memory.recordModifiedFile('discord:1', 'src/b.ts', 'write')
    // Re-touch a.ts as an edit — should collapse to one line with latest
    // action and move to the end (recency order).
    await memory.recordModifiedFile('discord:1', 'src/a.ts', 'edit')

    const out = await memory.readWorkingSet('discord:1')
    const lines = out.split('\n').filter((l) => l.startsWith('- '))
    assertEquals(lines, ['- src/b.ts', '- src/a.ts (edit)'])
  })
})

test('working set — is scoped per session', async () => {
  await withTempWorkspace(async (workspace) => {
    const memory = new MemoryStore(workspace)
    await memory.recordModifiedFile('discord:1', 'src/a.ts', 'write')

    assert((await memory.readWorkingSet('discord:1')).includes('src/a.ts'))
    assertEquals(await memory.readWorkingSet('discord:2'), '')
  })
})

test('working set — session key sanitized into a safe filename', async () => {
  await withTempWorkspace(async (workspace) => {
    const memory = new MemoryStore(workspace)
    await memory.recordModifiedFile('web/chat:99', 'notes.md', 'write')

    const out = await memory.readWorkingSet('web/chat:99')
    assert(out.includes('notes.md'))

    // File lands under memory/sessions with non-alphanumerics replaced.
    const entries = await readdir(`${workspace}/memory/sessions`)
    assert(entries.includes('web_chat_99.files.jsonl'))
  })
})

async function writeLogs(
  workspace: string,
  entries: Record<string, unknown>[],
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)
  const dir = `${workspace}/memory/events`
  await mkdir(dir, { recursive: true })
  const body = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
  await writeFile(`${dir}/${today}.jsonl`, body)
}

test('logs — empty when no log', async () => {
  await withTempWorkspace(async (workspace) => {
    const memory = new MemoryStore(workspace)
    assertEquals(await memory.readLogs('discord:1'), '')
  })
})

test('logs — split own (this session) vs related (others)', async () => {
  await withTempWorkspace(async (workspace) => {
    await writeLogs(workspace, [
      { when: '2026-07-07T09:30:00Z', who: 'agent', what: 'did mine', origin: 'discord:1' },
      { when: '2026-07-07T08:10:00Z', who: 'other', what: 'did theirs', origin: 'discord:2' },
    ])
    const memory = new MemoryStore(workspace)
    const out = await memory.readLogs('discord:1')

    assert(out.includes('### Recent Logs (this session)'))
    assert(out.includes('2026-07-07T09:30:00.000Z'))
    assert(out.includes('2026-07-07T08:10:00.000Z'))
    assert(out.includes('did mine'))
    assert(out.includes('### Related Logs (other sessions)'))
    // Related events show their origin; own events do not.
    assert(out.includes('[discord:2]'))
    assert(!out.includes('[discord:1]'))
  })
})

test('logs — related section caps with +N more', async () => {
  await withTempWorkspace(async (workspace) => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      when: '2026-07-07T08:00:00Z',
      who: 'other',
      what: `event ${i}`,
      origin: 'discord:other',
    }))
    await writeLogs(workspace, entries)
    const memory = new MemoryStore(workspace)
    const out = await memory.readLogs('discord:1', { maxRelated: 15 })

    assert(out.includes('+5 more in other sessions'))
  })
})

test('logs — no-origin (legacy) entries treated as related', async () => {
  await withTempWorkspace(async (workspace) => {
    await writeLogs(workspace, [
      { when: '2026-07-07T09:00:00Z', who: 'legacy', what: 'old event' },
    ])
    const memory = new MemoryStore(workspace)
    const out = await memory.readLogs('discord:1')

    assert(!out.includes('### Recent Logs (this session)'))
    assert(out.includes('### Related Logs (other sessions)'))
    assert(out.includes('old event'))
  })
})

test('relevance gate — same project keeps related logs', async () => {
  await withTempWorkspace(async (workspace) => {
    await writeLogs(workspace, [
      { when: '2026-07-07T08:00:00Z', who: 'o', what: 'same proj', origin: 'discord:2' },
      { when: '2026-07-07T08:01:00Z', who: 'o', what: 'other proj', origin: 'discord:3' },
    ])
    const memory = new MemoryStore(workspace)
    const initiativeOf = (sid: string) =>
      ({ 'discord:2': 'shadow', 'discord:3': 'other' })[sid]

    const out = await memory.readLogs('discord:1', {
      currentInitiative: 'shadow',
      initiativeOf,
    })
    assert(out.includes('same proj'))
    assert(!out.includes('other proj'))
    assert(out.includes('+1 more in other sessions'))
  })
})

test('relevance gate — shared modified file keeps related logs', async () => {
  await withTempWorkspace(async (workspace) => {
    await writeLogs(workspace, [
      { when: '2026-07-07T08:00:00Z', who: 'o', what: 'touched shared', origin: 'discord:2' },
      { when: '2026-07-07T08:01:00Z', who: 'o', what: 'unrelated', origin: 'discord:3' },
    ])
    const memory = new MemoryStore(workspace)
    // Current session and discord:2 both touch src/a.ts; discord:3 touches something else.
    await memory.recordModifiedFile('discord:1', 'src/a.ts', 'edit')
    await memory.recordModifiedFile('discord:2', 'src/a.ts', 'write')
    await memory.recordModifiedFile('discord:3', 'src/z.ts', 'write')

    const out = await memory.readLogs('discord:1')
    assert(out.includes('touched shared'))
    assert(!out.includes('unrelated'))
  })
})

test('relevance gate — disabled when session has no signals', async () => {
  await withTempWorkspace(async (workspace) => {
    await writeLogs(workspace, [
      { when: '2026-07-07T08:00:00Z', who: 'o', what: 'shown anyway', origin: 'discord:2' },
    ])
    const memory = new MemoryStore(workspace)
    // No project, no working set → gate disabled, related passes through.
    const out = await memory.readLogs('discord:1')
    assert(out.includes('shown anyway'))
  })
})

test('keywords — empty when no wiki items', async () => {
  await withTempWorkspace(async (workspace) => {
    const memory = new MemoryStore(workspace)
    assertEquals(await memory.readKeywords(), '')
  })
})

test('keywords — derived from topic/identity filenames', async () => {
  await withTempWorkspace(async (workspace) => {
    const memory = new MemoryStore(workspace)
    await mkdir(`${workspace}/memory/topics`, { recursive: true })
    await mkdir(`${workspace}/memory/identities`, { recursive: true })
    await writeFile(`${workspace}/memory/topics/plasma-physics.md`, '# x')
    await writeFile(`${workspace}/memory/topics/docker.md`, '# x')
    await writeFile(`${workspace}/memory/identities/honx.md`, '# x')
    // Non-markdown files are ignored.
    await writeFile(`${workspace}/memory/topics/notes.txt`, 'x')

    const out = await memory.readKeywords()
    assert(out.includes('**Long-term keywords**'))
    assert(out.includes('- topics: '))
    assert(out.includes('plasma-physics'))
    assert(out.includes('docker'))
    assert(out.includes('- identities: '))
    assert(out.includes('honx'))
    assert(!out.includes('notes'))
  })
})

test('log briefings omit detail, honestly preview legacy entries and bound total injection', async () => {
  await withTempWorkspace(async workspace => {
    await writeLogs(workspace, [
      { who: 'worker', origin: 'other', summary: 'Observed failure; recovery unverified.', what: 'PRIVATE_DETAIL', why: 'PRIVATE_REASON', challenge: 'PRIVATE_CHALLENGE', refs: ['PRIVATE_REF'] },
      { who: 'old', origin: 'self', what: 'x'.repeat(1000) },
    ])
    const memory = new MemoryStore(workspace)
    const out = await memory.readLogs('self')
    assert(out.includes('Observed failure; recovery unverified.'))
    assert(!out.includes('PRIVATE_'))
    assert(out.includes('[legacy/detail preview, not a summary]'))
    assert(out.includes('x'.repeat(180) + '…'))
    assert(out.includes('.jsonl, line 1'))
    assert(out.includes('.jsonl, line 2'))
    const bounded = await memory.readLogs('self', { maxChars: 220 })
    assert(bounded.length <= 220)
    assert(bounded.includes('omitted by budget'))
    assertEquals(await memory.readLogs('self', { maxChars: 0 }), '')
    assertEquals(await memory.readLogs('self', { maxOwn: 0, maxRelated: 0 }), '### Related Logs (other sessions)\n- +1 more in other sessions')
  })
})

test('log detail references count blank and malformed physical lines', async () => {
  await withTempWorkspace(async workspace => {
    const date = new Date().toISOString().slice(0, 10)
    await mkdir(`${workspace}/memory/events`, { recursive: true })
    await writeFile(`${workspace}/memory/events/${date}.jsonl`, '\nmalformed\n' + JSON.stringify({ summary: 'Brief', what: 'Full' }) + '\n')
    const out = await new MemoryStore(workspace).readLogs('self')
    assert(out.includes('.jsonl, line 3'))
  })
})

test('briefing detail path is readable through the memory VFS', async () => {
  await withTempWorkspace(async workspace => {
    await writeLogs(workspace, [{ summary: 'Brief', what: 'Original full detail', refs: ['source'] }])
    const { createMemoryHandler } = await import('../vfs/mounts.ts')
    const date = new Date().toISOString().slice(0, 10)
    const detail = await createMemoryHandler(workspace).read(`events/${date}.jsonl`, {} as never)
    assert(String(detail).includes('Original full detail'))
    assert(String(detail).includes('source'))
  })
})


test('legacy log storage and original log wording remain unchanged by injection and VFS reads', async () => {
  await withTempWorkspace(async workspace => {
    const date = new Date().toISOString().slice(0, 10)
    const path = `${workspace}/memory/events/${date}.jsonl`
    await mkdir(`${workspace}/memory/events`, { recursive: true })
    const original = '\n' + JSON.stringify({ when: `${date}T00:00:00Z`, who: 'historical actor',
      what: 'Original event report about event providers', origin: 'self', refs: ['v:signals/providers/old'] }) + '\n'
    await writeFile(path, original)
    const out = await new MemoryStore(workspace).readLogs('self')
    assert(out.includes('### Recent Logs'))
    assert(!out.includes('### Recent Events'))
    assert(out.includes('Original event report about event providers'))
    assert(out.includes(`v:memory/events/${date}.jsonl, line 2`))
    const { createMemoryHandler } = await import('../vfs/mounts.ts')
    assertEquals(await createMemoryHandler(workspace).read(`events/${date}.jsonl`, {} as never), original)
    assertEquals(await readFile(path, 'utf8'), original)
    assert(!(await readdir(`${workspace}/memory`)).includes('logs'), 'no parallel storage tree or migration')
  })
})
