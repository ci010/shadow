import assert from 'node:assert/strict'
import { test, mock } from 'node:test'
import childProcess from 'node:child_process'
import { syncBuiltinESMExports } from 'node:module'
import { SearchTool } from './search.ts'
import type { ExecutionContext } from './context.ts'

test('coordinator file search never auto-installs a missing ripgrep helper', async () => {
  const previousPath = process.env.PATH
  const spawn = childProcess.spawn
  const commands: string[] = []
  const replacement = ((...args: Parameters<typeof spawn>) => {
    commands.push(String(args[0]))
    return spawn(...args)
  }) as typeof spawn
  const spy = mock.method(childProcess, 'spawn', replacement)
  syncBuiltinESMExports()
  try {
    process.env.PATH = ''
    const tool = new SearchTool(process.cwd(), undefined, undefined, false)
    const result = await tool.execute({ space: 'grep', query: 'unused' }, {
      signal: new AbortController().signal,
    } as ExecutionContext)
    assert.match(result, /ripgrep/)
    assert.deepEqual(commands, ['rg'])
  } finally {
    if (previousPath === undefined) delete process.env.PATH
    else process.env.PATH = previousPath
    spy.mock.restore()
    syncBuiltinESMExports()
  }
})
