import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, writeFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { configuration } from './bridge.ts'

test('host configuration is opt-in, allowlisted and refuses shared Project stores', async () => {
  const dir = await mkdtemp(join(process.cwd(), '.layerfs-test-'))
  const prior = process.env.SHADOW_LAYERFS_CONFIG
  try {
    delete process.env.SHADOW_LAYERFS_CONFIG
    await assert.rejects(configuration('one'), /disabled/)
    const path = join(dir, 'config.json')
    process.env.SHADOW_LAYERFS_CONFIG = path
    const env = { LAYERFS_HOME: dir, LAYERFS_STORE_PATH: join(dir, 'store'), LAYERFS_WORKER_ENDPOINT: join(dir, 'worker') }
    await writeFile(path, JSON.stringify({ projects: { one: { sdkModule: join(dir, 'sdk.mjs'), env: { ...env, NODE_OPTIONS: 'bad' } } } }))
    await assert.rejects(configuration('one'), /Invalid LayerFS environment/)
    await writeFile(path, JSON.stringify({ projects: { one: { sdkModule: join(dir, 'sdk.mjs'), env }, two: { sdkModule: join(dir, 'sdk.mjs'), env } } }))
    await assert.rejects(configuration('one'), /must not share/)
  } finally {
    if (prior === undefined) delete process.env.SHADOW_LAYERFS_CONFIG
    else process.env.SHADOW_LAYERFS_CONFIG = prior
    await rm(dir, { recursive: true, force: true })
  }
})
