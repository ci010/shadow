import assert, { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readdir, writeFile } from 'node:fs/promises'
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

async function writeEvents(
  workspace: string,
  entries: Record<string, unknown>[],
): Promise<void> {
  const today = new Date().toISOString().slice(0, 10)
  const dir = `${workspace}/memory/events`
  await mkdir(dir, { recursive: true })
  const body = entries.map((e) => JSON.stringify(e)).join('\n') + '\n'
  await writeFile(`${dir}/${today}.jsonl`, body)
}

test('events — empty when no log', async () => {
  await withTempWorkspace(async (workspace) => {
    const memory = new MemoryStore(workspace)
    assertEquals(await memory.readEvents('discord:1'), '')
  })
})

test('events — split own (this session) vs related (others)', async () => {
  await withTempWorkspace(async (workspace) => {
    await writeEvents(workspace, [
      { when: '2026-07-07T09:30:00Z', who: 'agent', what: 'did mine', origin: 'discord:1' },
      { when: '2026-07-07T08:10:00Z', who: 'other', what: 'did theirs', origin: 'discord:2' },
    ])
    const memory = new MemoryStore(workspace)
    const out = await memory.readEvents('discord:1')

    assert(out.includes('### Recent Events (this session)'))
    assert(out.includes('did mine'))
    assert(out.includes('### Related Events (other sessions)'))
    // Related events show their origin; own events do not.
    assert(out.includes('[discord:2]'))
    assert(!out.includes('[discord:1]'))
  })
})

test('events — related section caps with +N more', async () => {
  await withTempWorkspace(async (workspace) => {
    const entries = Array.from({ length: 20 }, (_, i) => ({
      when: '2026-07-07T08:00:00Z',
      who: 'other',
      what: `event ${i}`,
      origin: 'discord:other',
    }))
    await writeEvents(workspace, entries)
    const memory = new MemoryStore(workspace)
    const out = await memory.readEvents('discord:1', { maxRelated: 15 })

    assert(out.includes('+5 more in other sessions'))
  })
})

test('events — no-origin (legacy) entries treated as related', async () => {
  await withTempWorkspace(async (workspace) => {
    await writeEvents(workspace, [
      { when: '2026-07-07T09:00:00Z', who: 'legacy', what: 'old event' },
    ])
    const memory = new MemoryStore(workspace)
    const out = await memory.readEvents('discord:1')

    assert(!out.includes('### Recent Events (this session)'))
    assert(out.includes('### Related Events (other sessions)'))
    assert(out.includes('old event'))
  })
})

test('relevance gate — same project keeps related events', async () => {
  await withTempWorkspace(async (workspace) => {
    await writeEvents(workspace, [
      { when: '2026-07-07T08:00:00Z', who: 'o', what: 'same proj', origin: 'discord:2' },
      { when: '2026-07-07T08:01:00Z', who: 'o', what: 'other proj', origin: 'discord:3' },
    ])
    const memory = new MemoryStore(workspace)
    const projectOf = (sid: string) =>
      ({ 'discord:2': 'shadow', 'discord:3': 'other' })[sid]

    const out = await memory.readEvents('discord:1', {
      currentProject: 'shadow',
      projectOf,
    })
    assert(out.includes('same proj'))
    assert(!out.includes('other proj'))
    assert(out.includes('+1 more in other sessions'))
  })
})

test('relevance gate — shared modified file keeps related events', async () => {
  await withTempWorkspace(async (workspace) => {
    await writeEvents(workspace, [
      { when: '2026-07-07T08:00:00Z', who: 'o', what: 'touched shared', origin: 'discord:2' },
      { when: '2026-07-07T08:01:00Z', who: 'o', what: 'unrelated', origin: 'discord:3' },
    ])
    const memory = new MemoryStore(workspace)
    // Current session and discord:2 both touch src/a.ts; discord:3 touches something else.
    await memory.recordModifiedFile('discord:1', 'src/a.ts', 'edit')
    await memory.recordModifiedFile('discord:2', 'src/a.ts', 'write')
    await memory.recordModifiedFile('discord:3', 'src/z.ts', 'write')

    const out = await memory.readEvents('discord:1')
    assert(out.includes('touched shared'))
    assert(!out.includes('unrelated'))
  })
})

test('relevance gate — disabled when session has no signals', async () => {
  await withTempWorkspace(async (workspace) => {
    await writeEvents(workspace, [
      { when: '2026-07-07T08:00:00Z', who: 'o', what: 'shown anyway', origin: 'discord:2' },
    ])
    const memory = new MemoryStore(workspace)
    // No project, no working set → gate disabled, related passes through.
    const out = await memory.readEvents('discord:1')
    assert(out.includes('shown anyway'))
  })
})

test('conventions — empty when none set', async () => {
  await withTempWorkspace(async (workspace) => {
    const memory = new MemoryStore(workspace)
    assertEquals(await memory.readConventions('discord:1', 'shadow'), '')
  })
})

test('conventions — merges scopes with tags in order agent→project→session', async () => {
  await withTempWorkspace(async (workspace) => {
    const memory = new MemoryStore(workspace)
    await memory.addConvention('agent', undefined, 'answer concisely')
    await memory.addConvention('project', 'shadow', 'deps use chore: prefix')
    await memory.addConvention('session', 'discord:1', "don't touch build")

    const out = await memory.readConventions('discord:1', 'shadow')
    const lines = out.split('\n')
    assertEquals(lines[0], '### Conventions (always in effect)')
    assertEquals(lines[1], '- [agent] answer concisely')
    assertEquals(lines[2], '- [project:shadow] deps use chore: prefix')
    assertEquals(lines[3], "- [session] don't touch build")
  })
})

test('conventions — add is idempotent, remove matches substring', async () => {
  await withTempWorkspace(async (workspace) => {
    const memory = new MemoryStore(workspace)
    await memory.addConvention('session', 'discord:1', 'rule one')
    await memory.addConvention('session', 'discord:1', 'rule one') // dup
    await memory.addConvention('session', 'discord:1', 'rule two')

    let out = await memory.readConventions('discord:1')
    assertEquals(out.split('\n').filter((l) => l.startsWith('- ')).length, 2)

    await memory.removeConvention('session', 'discord:1', 'one')
    out = await memory.readConventions('discord:1')
    assert(!out.includes('rule one'))
    assert(out.includes('rule two'))
  })
})

test('conventions — session scope does not leak across sessions', async () => {
  await withTempWorkspace(async (workspace) => {
    const memory = new MemoryStore(workspace)
    await memory.addConvention('session', 'discord:1', 'only mine')

    assert((await memory.readConventions('discord:1')).includes('only mine'))
    assertEquals(await memory.readConventions('discord:2'), '')
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


