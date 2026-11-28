import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import test from 'node:test'

const exec = promisify(execFile)
const root = fileURLToPath(new URL('../../../', import.meta.url))
const entry = fileURLToPath(new URL('../../index.ts', import.meta.url))

test('project-video is an early CLI route without starting Main or loading user config', async () => {
  const dir = await mkdtemp(join(root, '.tmp-video-cli-'))
  try {
    const invoke = async (...args: string[]) => {
      const result = await exec(process.execPath, ['--import', 'tsx', entry, 'project-video', ...args], {
        cwd: dir, timeout: 30_000,
      })
      return JSON.parse(result.stdout)
    }
    assert.match((await invoke('--help')).usage, /project-video/)
    const created = await invoke('init', 'edit.otio', '--duration', '1', '--rate', '24')
    assert.match(created.revision, /^[a-f0-9]{64}$/)
    assert.equal(JSON.parse(await readFile(join(dir, 'edit.otio'), 'utf8')).OTIO_SCHEMA, 'Timeline.1')
    const plan = await invoke('plan', 'edit.otio')
    assert.equal(plan.revision, created.revision)
    assert.equal(plan.duration, 1)
    assert.equal(plan.rate, 24)
    await writeFile(join(dir, 'changes.json'), JSON.stringify([{ op: 'replace', path: '/name', value: 'CLI revision 2' }]))
    const edited = await invoke('edit', 'edit.otio', '--patch', 'changes.json', '--revision', created.revision, '--output', 'edit-v2.otio')
    assert.equal(edited.sourceRevision, created.revision)
    assert.notEqual(edited.revision, created.revision)
    assert.equal(JSON.parse(await readFile(join(dir, 'edit-v2.otio'), 'utf8')).name, 'CLI revision 2')
    assert.equal(JSON.parse(await readFile(join(dir, 'edit.otio'), 'utf8')).name, 'Agent video')
    await assert.rejects(invoke('init', 'edit.otio'), /EEXIST/)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
})
