import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { withTempWorkspace } from '../../testing/workspace.ts'
import { projectStoragePath } from '../../utils/data-paths.ts'
import { TestSignalProviderRuntime } from './testing.ts'

// No migration is required by the new contract. Old user data must not be deleted or executed.
test('new source/workflow storage leaves obsolete provider jobs untouched and never replays them', async () => withTempWorkspace(async workspace => {
  const files = [projectStoragePath(workspace, '.events', 'providers-v1.json'), projectStoragePath(workspace, '.signals', 'providers-v2.json')]
  const content = JSON.stringify({ format: 2, jobs: [{ drafts: [{ content: 'must not deliver' }] }] })
  for (const path of files) { await mkdir(dirname(path), { recursive: true }); await writeFile(path, content) }
  const runtime = new TestSignalProviderRuntime(workspace, { execute: async () => { throw Error('No collection expected') } }, async () => { throw Error('No delivery expected') }, () => true, () => false)
  runtime.start()
  try {
    await runtime.run()
    assert.deepEqual(runtime.snapshot('owner').subscriptions, [])
    assert.deepEqual(runtime.snapshot('owner').pending, [])
    for (const path of files) assert.equal(await readFile(path, 'utf8'), content)
  } finally { await runtime.stop() }
}))
