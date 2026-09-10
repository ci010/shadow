import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import test from 'node:test'
import { pathToFileURL } from 'node:url'
import { createTempWorkspace } from '../testing/workspace.ts'

test('native TypeScript loader supports transformed syntax and nested imports without tsx', async () => {
  const directory = await createTempWorkspace()
  try {
    await writeFile(join(directory, 'value.ts'), 'export enum Value { Answer = 42 }\n')
    const modulePath = join(directory, 'tool.ts')
    await writeFile(modulePath, `
      import { Value } from './value.ts'
      class Result { constructor(public value: number) {} }
      export default new Result(Value.Answer).value
    `)
    const loader = new URL('./typescript.ts', import.meta.url).href
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
      const { registerTypeScriptLoader } = await import(${JSON.stringify(loader)})
      registerTypeScriptLoader()
      const module = await import(${JSON.stringify(pathToFileURL(modulePath).href)})
      console.log(module.default)
    `], { cwd: directory, encoding: 'utf8', timeout: 15_000 })
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stdout.trim(), '42')
  } finally {
    await rm(directory, { recursive: true })
  }
})
