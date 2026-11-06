import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { configuration } from './bridge.ts'
import { LayerFSTool } from '../../tools/layerfs.ts'
import { ToolNoEffectError, toolResultText } from '../../tools/tool.ts'
import type { ExecutionContext } from '../../tools/context.ts'

const context = { projectId: 'one', signal: new AbortController().signal } as ExecutionContext

test('configuration failures are safe, actionable no-effect errors; doctor never loads the SDK', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.layerfs-config-test-'))
  const prior = process.env.SHADOW_LAYERFS_CONFIG
  const tool = new LayerFSTool('one')
  const doctor = async () => JSON.parse(toolResultText(await tool.execute({ action: 'doctor' }, context)))
  const failure = async (code: string) => {
    await assert.rejects(configuration('one'), (error: unknown) => {
      assert.ok(error instanceof ToolNoEffectError)
      assert.equal((error as ToolNoEffectError & { code: string }).code, code)
      assert.match(error.message, /operator|backend/)
      assert.doesNotMatch(error.message, /DO_NOT_DISCLOSE/)
      return true
    })
    const receipt = await doctor()
    assert.equal(receipt.ok, true)
    assert.equal(receipt.result.configured, false)
    assert.equal(receipt.result.code, code)
    assert.equal(receipt.result.runtime, 'not_checked')
    await assert.rejects(tool.execute({ action: 'list' }, context), ToolNoEffectError)
  }
  try {
    delete process.env.SHADOW_LAYERFS_CONFIG
    await failure('CONFIG_NOT_SET')
    process.env.SHADOW_LAYERFS_CONFIG = 'relative.json'
    await failure('CONFIG_PATH_INVALID')
    const configPath = join(dir, 'config.json')
    process.env.SHADOW_LAYERFS_CONFIG = configPath
    await failure('CONFIG_UNREADABLE')
    await writeFile(configPath, '{"DO_NOT_DISCLOSE":bad-json}')
    await failure('CONFIG_INVALID')
    for (const value of [null, [], { projects: [] }, { projects: { one: { sdkModule: 123, env: {} } } }]) {
      await writeFile(configPath, JSON.stringify(value))
      await failure('CONFIG_INVALID')
    }
    await writeFile(configPath, JSON.stringify({ projects: {} }))
    await failure('PROJECT_NOT_CONFIGURED')
    const sdkModule = join(dir, 'sdk.mjs')
    await writeFile(sdkModule, `throw new Error('SDK MUST NOT RUN DURING DOCTOR')`)
    const env = { LAYERFS_HOME: dir, LAYERFS_STORE_PATH: join(dir, 'store'), LAYERFS_WORKER_ENDPOINT: 'test-worker' }
    await writeFile(configPath, JSON.stringify({ projects: { one: { sdkModule, env }, two: null } }))
    await failure('CONFIG_INVALID')
    await writeFile(configPath, JSON.stringify({ projects: { one: { sdkModule, env }, two: { sdkModule, env } } }))
    await failure('PROJECT_STORAGE_SHARED')
    await writeFile(configPath, JSON.stringify({ projects: { one: { sdkModule, env } } }))
    const receipt = await doctor()
    assert.equal(receipt.ok, true)
    assert.equal(receipt.result.configured, true)
    assert.equal(receipt.result.runtime, 'not_checked')
    assert.match(receipt.result.message, /not.*verified/i)
    assert.doesNotMatch(JSON.stringify(receipt), /test-worker|sdk\.mjs/)
    await assert.rejects(tool.execute({ action: 'doctor' }, { ...context, projectId: 'two' }), /mismatch/)
    await assert.rejects(tool.execute({ action: 'doctor' }, { ...context, remoteWorkdir: {} } as ExecutionContext), /no Main fallback/)
    await assert.rejects(tool.execute({ action: 'doctor' }, { ...context, signal: AbortSignal.abort() }), /abort/i)
  } finally {
    if (prior === undefined) delete process.env.SHADOW_LAYERFS_CONFIG
    else process.env.SHADOW_LAYERFS_CONFIG = prior
    await rm(dir, { recursive: true, force: true })
  }
})
