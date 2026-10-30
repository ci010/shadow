import { projectStoragePath } from '../utils/data-paths.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { withTempWorkspace } from '../testing/workspace.ts'
import { localFolderWorkdirRef, resolveSessionLocations } from '../sessions/locality.ts'
import { resolveAgentPath } from '../utils/paths.ts'
import { ReadTool } from './read.ts'
import { WriteTool } from './filesystem.ts'
import { GrepTool, GlobTool } from './ripgrep.ts'
import { VirtualFs } from '../vfs/virtual-fs.ts'
import type { ExecutionContext } from './context.ts'
import { requireToolText } from './tool.ts'

const collisions = ['AGENTS.md', 'SOUL.md', 'IDENTITY.md', 'USER.md', 'MODEL_SETTINGS.json',
  'HEARTBEAT.pulse', 'projects/fixture.txt', 'skills/fixture.txt', 'agents/fixture.txt',
  'memory/fixture.txt', 'prompts/fixture.txt', 'tuning/fixture.txt', '.sessions/fixture.txt', '.plans/fixture.txt']

test('read directory and relative files use the same capability-backed cwd despite Home collisions', async () => {
  await withTempWorkspace(async root => {
    const home = join(root, 'home')
    const repo = join(root, 'repo')
    const locations = resolveSessionLocations(home, { sessionId: 'test', workdir: localFolderWorkdirRef('repo') },
      'local', () => ({ node: 'online', workdir: { online: true, path: repo } }))
    assert.ok(locations.workdir.available && locations.workdir.locality === 'local')
    const context = { cwd: locations.workdir.path, sessionId: 'test', physicalSessionId: 'physical',
      signal: new AbortController().signal } as ExecutionContext
    for (const path of [...collisions, '.tmp/fixture.txt']) {
      for (const [base, label] of [[home, 'home'], [repo, 'repo']]) {
        const file = base === home && path.startsWith('.tmp/') ? projectStoragePath(home, path) : join(base, path)
        await mkdir(dirname(file), { recursive: true })
        await writeFile(file, `${label}:${path}`)
      }
    }
    const vfs = new VirtualFs()
    vfs.mount('v:fixture', 'Fixture', () => 'virtual content')
    const reader = new ReadTool(home, vfs)
    assert.match(requireToolText(await reader.execute({ path: '.' }, context)), /AGENTS\.md/)
    for (const path of collisions) {
      assert.equal(await reader.execute({ path }, context), `repo:${path}`)
      assert.equal(resolveAgentPath(home, repo, path), resolve(repo, path))
    }
    assert.equal(await reader.execute({ path: '.tmp/fixture.txt' }, context), 'home:.tmp/fixture.txt')
    assert.equal(await reader.execute({ path: 'v:fixture' }, context), 'virtual content')
    assert.equal(resolveAgentPath(home, repo, 'v:memory/fixture.txt'), join(home, 'memory/fixture.txt'))
    assert.equal(resolveAgentPath(home, repo, 'v:memory\\fixture.txt'), join(home, 'memory/fixture.txt'))
    assert.equal(resolveAgentPath(home, repo, join(home, 'AGENTS.md')), join(home, 'AGENTS.md'))
    await assert.rejects(reader.execute({ path: 'skills/missing.txt' }, context), /ENOENT/)
    const writer = new WriteTool(home)
    await writer.execute({ path: 'AGENTS.md', content: 'updated repo' }, context)
    assert.equal(await readFile(join(repo, 'AGENTS.md'), 'utf8'), 'updated repo')
    assert.equal(await readFile(join(home, 'AGENTS.md'), 'utf8'), 'home:AGENTS.md')
    assert.match(await new GrepTool(home).execute({ path: 'AGENTS.md', pattern: 'updated repo' }, context), /updated repo/)
    assert.match(await new GlobTool(home).execute({ path: 'skills', pattern: '**' }, context), /repo[\\/]skills[\\/]fixture\.txt/)
  })
})

test('managed fallback stays the effective cwd; only explicit Home aliases escape it', async () => {
  await withTempWorkspace(async home => {
    const locations = resolveSessionLocations(home, { sessionId: 'fallback' })
    assert.ok(locations.workdir.available && locations.workdir.locality === 'local')
    const cwd = locations.workdir.path
    assert.equal(cwd, locations.sessionDataDir)
    for (const path of collisions) assert.equal(resolveAgentPath(home, cwd, path), resolve(cwd, path))
    assert.equal(resolveAgentPath(home, cwd, '.tmp/file'), projectStoragePath(home, '.tmp/file'))
    assert.equal(resolveAgentPath(home, cwd, 'v:memory/file'), join(home, 'memory/file'))
    assert.equal(resolveAgentPath(home, cwd, 'uploads/file'), join(cwd, 'uploads/file'))
  })
})
