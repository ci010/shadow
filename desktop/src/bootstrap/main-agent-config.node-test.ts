import assert from 'node:assert/strict'
import test from 'node:test'
import { access, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { AtomicMainAgentConfigInitializer } from './main-agent-config.js'

async function fixture(context: test.TestContext) {
  const root = await mkdtemp(join(tmpdir(), 'shadow-main-agent-config-'))
  context.after(() => rm(root, { recursive: true, force: true }))
  const dataDir = resolve(root, 'data')
  const runtimeConfigFilePath = join(root, 'bootstrap', 'runtime-config.v1.json')
  await mkdir(join(root, 'bootstrap'), { recursive: true })
  await writeFile(runtimeConfigFilePath, JSON.stringify({
    version: 1,
    mode: 'main',
    dataDir,
    localNodeId: 'node-id',
  }))
  return { dataDir, runtimeConfigFilePath }
}

test('writes the exact protected Main agent config and supports idempotent recovery', async (context) => {
  const { dataDir, runtimeConfigFilePath } = await fixture(context)
  const initializer = new AtomicMainAgentConfigInitializer(runtimeConfigFilePath)
  const configFilePath = join(dataDir, 'config', 'bot.config.json')

  await initializer.initialize()
  const first = await readFile(configFilePath, 'utf8')
  assert.deepEqual(JSON.parse(first), {
    agent: { workspace: join(dataDir, 'workspace'), sessionStorage: 'sqlite' },
    channels: { web: { enabled: true } },
    providers: { copilot: {} },
  })
  await access(join(dataDir, 'workspace'))
  if (process.platform !== 'win32') assert.equal((await stat(configFilePath)).mode & 0o777, 0o600)

  await writeFile(configFilePath, JSON.stringify({
    providers: { copilot: {} },
    channels: { web: { enabled: true } },
    agent: { sessionStorage: 'sqlite', workspace: join(dataDir, 'workspace') },
  }))
  await initializer.initialize()
  assert.deepEqual(JSON.parse(await readFile(configFilePath, 'utf8')), JSON.parse(first))
})

test('rejects an incompatible existing config without overwriting it', async (context) => {
  const { dataDir, runtimeConfigFilePath } = await fixture(context)
  const configFilePath = join(dataDir, 'config', 'bot.config.json')
  await mkdir(join(dataDir, 'config'), { recursive: true })
  const incompatible = '{"apiKey":"secret"}\n'
  await writeFile(configFilePath, incompatible)

  await assert.rejects(
    new AtomicMainAgentConfigInitializer(runtimeConfigFilePath).initialize(),
    /incompatible/,
  )
  assert.equal(await readFile(configFilePath, 'utf8'), incompatible)
})

test('strictly validates the protected runtime config', async (context) => {
  const { runtimeConfigFilePath } = await fixture(context)
  await writeFile(runtimeConfigFilePath, JSON.stringify({
    version: 1,
    mode: 'main',
    dataDir: 'relative',
    localNodeId: 'node-id',
    token: 'secret',
  }))
  await assert.rejects(
    new AtomicMainAgentConfigInitializer(runtimeConfigFilePath).initialize(),
    /runtime config is invalid/,
  )
})