import { deepEqual as assertEquals } from 'node:assert/strict'
import { test } from 'node:test'
import { rm, writeFile } from 'node:fs/promises'
import { createTempWorkspace } from '../testing/workspace.ts'
import { join } from 'node:path'
import { runRootProcessEntry } from '../index.ts'

test('root process entry validates a real Main bootstrap config path', async () => {
  const directory = await createTempWorkspace()
  try {
    const bootstrapPath = join(directory, 'bootstrap.json')
    await writeFile(
      bootstrapPath,
      JSON.stringify({
        version: 1,
        mode: 'main',
        dataDir: './state',
        localNodeId: 'main-node',
      }),
    )

    const result = await runRootProcessEntry({
      argv: [
        process.execPath,
        'src/index.ts',
        'server',
        'validate',
        '--config',
        bootstrapPath,
      ],
      on: () => {},
      off: () => {},
      exit: () => {
        throw new Error('validate must not exit the process')
      },
    })

    assertEquals(result.route, 'runtime')
    if (result.route === 'runtime') {
      assertEquals(result.result.started, false)
      assertEquals(result.result.paths.bootstrapConfigPath, bootstrapPath)
      assertEquals(
        result.result.paths.mutableAgentConfigPath,
        join(directory, 'state', 'config', 'bot.config.json'),
      )
    }
  } finally {
    await rm(directory, { recursive: true })
  }
})
