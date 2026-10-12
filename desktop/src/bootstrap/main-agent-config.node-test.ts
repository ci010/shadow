import assert from 'node:assert/strict'
import test from 'node:test'
import { access, mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { AtomicMainAgentConfigInitializer } from './main-agent-config.js'

async function fixture(context: test.TestContext) {
  const fixtureRoot = resolve('.tmp', 'desktop-main-agent-config-tests')
  await mkdir(fixtureRoot, { recursive: true })
  const root = await mkdtemp(join(fixtureRoot, 'case-'))
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
  const configFilePath = join(dataDir, 'app.json')

  await initializer.initialize()
  const first = await readFile(configFilePath, 'utf8')
  assert.deepEqual(JSON.parse(first), {
    agent: { workspace: dataDir, sessionStorage: 'sqlite' },
    channels: { web: { enabled: true } },
    providers: { copilot: {} },
  })
  await assert.rejects(access(join(dataDir, 'workspace')), { code: 'ENOENT' })
  if (process.platform !== 'win32') assert.equal((await stat(configFilePath)).mode & 0o777, 0o600)

  await writeFile(configFilePath, JSON.stringify({
    providers: { copilot: {} },
    channels: { web: { enabled: true } },
    agent: { sessionStorage: 'sqlite', workspace: dataDir },
  }))
  await initializer.initialize()
  assert.deepEqual(JSON.parse(await readFile(configFilePath, 'utf8')), JSON.parse(first))
})

test('rejects an incompatible existing config without overwriting it', async (context) => {
  const { dataDir, runtimeConfigFilePath } = await fixture(context)
  const configFilePath = join(dataDir, 'app.json')
  await mkdir(dataDir, { recursive: true })
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

test('resumed setup preserves customized app config byte-for-byte for supported storage modes', async (context) => {
  const { dataDir, runtimeConfigFilePath } = await fixture(context)
  await mkdir(dataDir, { recursive: true })
  for (const sessionStorage of ['sqlite', 'jsonl', undefined]) {
    const original = JSON.stringify({
      agent: { workspace: dataDir, sessionStorage, model: 'custom@openai', maxTokens: 1234 },
      providers: { openai: { apiKey: 'synthetic-test-key' } },
      channels: { web: { enabled: true }, discord: { enabled: false } },
      mcp: {}, learning: { enabled: false },
    }, null, 2) + '\n'
    await writeFile(join(dataDir, 'app.json'), original)
    await new AtomicMainAgentConfigInitializer(runtimeConfigFilePath).initialize()
    assert.equal(await readFile(join(dataDir, 'app.json'), 'utf8'), original)
    await assert.rejects(access(join(dataDir, 'workspace')), { code: 'ENOENT' })
  }
})

test('rejects noncanonical Home and unsupported storage without changing app config', async (context) => {
  const { dataDir, runtimeConfigFilePath } = await fixture(context)
  await mkdir(dataDir, { recursive: true })
  for (const agent of [
    { workspace: join(dataDir, 'workspace'), sessionStorage: 'sqlite' },
    { workspace: dataDir, sessionStorage: 'unsupported' },
  ]) {
    const original = JSON.stringify({ agent })
    await writeFile(join(dataDir, 'app.json'), original)
    await assert.rejects(new AtomicMainAgentConfigInitializer(runtimeConfigFilePath).initialize(), /incompatible/)
    assert.equal(await readFile(join(dataDir, 'app.json'), 'utf8'), original)
  }
})
