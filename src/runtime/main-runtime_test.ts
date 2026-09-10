import { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { readFile, rm } from 'node:fs/promises'
import { createTempWorkspace } from '../testing/workspace.ts'
import { ConfigSchema } from '../config/schema.ts'
import { startMainRuntime } from '../index.ts'

test('Main runtime supports a relative workspace, readiness, idempotent shutdown, and completion', async () => {
  const workspace = await createTempWorkspace()
  const originalCwd = process.cwd()
  try {
    process.chdir(workspace)
    const config = ConfigSchema.parse({
      agent: { workspace: '.' },
      channels: {},
      mcp: {},
    })
    const runtime = await startMainRuntime(config, {
      gateway: { host: '127.0.0.1', port: 0 },
    })

    await runtime.ready
    assertEquals(await Promise.all([runtime.shutdown(), runtime.shutdown()]), [
      undefined,
      undefined,
    ])
    await runtime.finished
    assertEquals(
      JSON.parse(
        await readFile(`${workspace}/.cluster/registry.v1.json`, 'utf8'),
      ).version,
      1,
    )
  } finally {
    process.chdir(originalCwd)
    await rm(workspace, { recursive: true })
  }
})
