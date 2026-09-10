import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AtomicRuntimeConfigWriter, FileRuntimeConfigReader, runtimeConfigPath } from './runtime-config.js'

test('runtime config writer creates the exact protected Main config atomically', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadow-runtime-config-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = runtimeConfigPath(directory)
  const writer = new AtomicRuntimeConfigWriter(filePath, () => 'local-node-id')
  const dataDir = resolve(directory, 'data')

  await writer.writeMain(dataDir)

  assert.deepEqual(JSON.parse(await readFile(filePath, 'utf8')), {
    version: 1,
    mode: 'main',
    dataDir,
    localNodeId: 'local-node-id',
  })
  if (process.platform !== 'win32') assert.equal((await stat(filePath)).mode & 0o777, 0o600)
  assert.deepEqual(await new FileRuntimeConfigReader(filePath).readMain(), {
    version: 1,
    mode: 'main',
    dataDir,
    localNodeId: 'local-node-id',
  })
})

test('runtime config reader rejects unknown fields', async (context) => {
  const directory = await mkdtemp(join(tmpdir(), 'shadow-runtime-config-'))
  context.after(() => rm(directory, { recursive: true, force: true }))
  const filePath = runtimeConfigPath(directory)
  await new AtomicRuntimeConfigWriter(filePath, () => 'local-node-id').writeMain(resolve(directory, 'data'))
  const config = JSON.parse(await readFile(filePath, 'utf8'))
  await import('node:fs/promises').then(({ writeFile }) => writeFile(filePath, JSON.stringify({ ...config, token: 'secret' })))
  await assert.rejects(new FileRuntimeConfigReader(filePath).readMain(), /Runtime config is invalid/)
})