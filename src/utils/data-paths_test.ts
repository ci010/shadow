import assert from 'node:assert/strict'
import test, { type TestContext } from 'node:test'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { appDataPaths, projectDataPaths, projectStoragePath } from './data-paths.ts'
import { readMediaFile, resolveAgentPath, sessionWorkspacePath, workspacePath } from './paths.ts'
import { resolveLegacyProjectPath } from '../storage/legacy-paths.ts'

async function fixture(t: TestContext) {
  const parent = resolve('.test-data')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'layout-paths-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  return root
}

test('app and Project layout helpers describe canonical roots without creating directories', async t => {
  const root = await fixture(t)
  const home = join(root, 'projects', 'default')
  assert.equal(appDataPaths(root).config, join(root, 'app.json'))
  assert.equal(appDataPaths(root).catalog, join(root, 'projects.json'))
  assert.equal(appDataPaths(root).hostTelemetry, join(root, 'telemetry', 'host.db'))
  assert.equal(projectDataPaths(home).workdirs, join(home, 'workdirs'))
  for (const [entry, expected] of [
    ['.sessions/history.jsonl', 'state/sessions/history.jsonl'],
    ['.events/sources.json', 'state/events/sources.json'],
    ['.browser/profile', 'state/browser/profile'],
    ['.io/runs/run.json', 'state/io/runs/run.json'],
    ['.microapps/record.json', 'state/microapps/record.json'],
    ['.mcp-tool-index/index.json', 'cache/mcp-tool-index/index.json'],
    ['.tmp/result.txt', 'tmp/result.txt'],
    ['skills/custom/SKILL.md', 'config/skills/custom/SKILL.md'],
    ['SOUL.md', 'config/SOUL.md'],
    ['memory/wiki/note.md', 'memory/wiki/note.md'],
    ['initiatives.sqlite', 'state/initiatives.sqlite'],
  ]) assert.equal(workspacePath(home, entry!), resolve(home, expected!))
  assert.equal(projectStoragePath(home, '__proto__'), join(home, '__proto__'))
  assert.equal(projectStoragePath(home, 'constructor'), join(home, 'constructor'))
  await assert.rejects(readFile(join(home, 'config', 'SOUL.md')), { code: 'ENOENT' })
})

test('managed workdirs and shared temporary alias stay distinct from user-relative repository paths', async t => {
  const root = await fixture(t)
  const home = join(root, 'projects', 'default')
  const repo = join(root, 'external-repo')
  assert.equal(sessionWorkspacePath(home, 'web:chat-123'), join(home, 'workdirs', 'web_chat-123'))
  assert.equal(resolveAgentPath(home, repo, '.tmp/output.txt'), join(home, 'tmp', 'output.txt'))
  assert.equal(resolveAgentPath(home, repo, 'v:memory/note.md'), join(home, 'memory', 'note.md'))
  assert.equal(resolveAgentPath(home, repo, 'skills/custom'), join(repo, 'skills', 'custom'))
  assert.equal(resolveAgentPath(home, repo, join(repo, 'file')), join(repo, 'file'))
})

test('historical absolute paths resolve only within the migrated managed Home and config', async t => {
  const root = await fixture(t)
  const home = join(root, 'projects', 'default')
  const legacyHome = join(root, 'workspace.projects', 'projects', 'default', 'workspace')
  await mkdir(join(home, 'state'), { recursive: true })
  await writeFile(join(home, 'state', 'layout-migration.json'), JSON.stringify({ version: 1, legacyHome }))
  assert.equal(resolveLegacyProjectPath(home, join(legacyHome, 'web_chat-123', 'uploads', 'photo.png')),
    join(home, 'workdirs', 'web_chat-123', 'uploads', 'photo.png'))
  assert.equal(resolveLegacyProjectPath(home, join(legacyHome, '.tmp', 'output.txt')), join(home, 'tmp', 'output.txt'))
  assert.equal(resolveLegacyProjectPath(home, join(legacyHome, 'memory', 'wiki.md')), join(home, 'memory', 'wiki.md'))
  assert.equal(resolveLegacyProjectPath(home, join(legacyHome, '..', 'config', 'bots.v1.json')),
    join(home, 'config', 'bots.v1.json'))
  const external = join(root, 'external', 'repo.txt')
  assert.equal(resolveLegacyProjectPath(home, external), external)
  const sibling = join(root, 'workspace.projects', 'projects', 'other', 'workspace', 'file')
  assert.equal(resolveLegacyProjectPath(home, sibling), sibling)
  const destination = join(home, 'workdirs', 'web_chat-123', 'uploads', 'photo.png')
  await mkdir(join(destination, '..'), { recursive: true })
  await writeFile(destination, 'synthetic-image')
  const media = await readMediaFile(home, 'web:chat-123', join(legacyHome, 'web_chat-123', 'uploads', 'photo.png'))
  assert.equal(new TextDecoder().decode(media.data), 'synthetic-image')
})

test('a tampered migration marker cannot redirect external repositories', async t => {
  const root = await fixture(t)
  const home = join(root, 'projects', 'default')
  await mkdir(join(home, 'state'), { recursive: true })
  await writeFile(join(home, 'state', 'layout-migration.json'), JSON.stringify({ version: 1, legacyHome: join(root, 'external') }))
  assert.throws(() => resolveLegacyProjectPath(home, join(root, 'external', 'secret')), /Invalid Project storage migration marker/)
})
