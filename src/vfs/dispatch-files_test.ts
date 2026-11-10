import assert from 'node:assert/strict'
import test from 'node:test'
import { VirtualFs } from './virtual-fs.ts'
import type { ExecutionContext } from '../tools/context.ts'

test('Project dispatch documents are writable from a remote-bound session without widening other configuration writes', async () => {
  const vfs = new VirtualFs()
  const writes: string[] = []
  vfs.mount('v:project', 'Project', () => '', undefined, (path, request) => {
    writes.push(path)
    return request.content
  })
  vfs.mount('v:config', 'Config', () => '', undefined, () => 'saved')
  const context = {
    signal: new AbortController().signal,
    remoteWorkdir: { nodeId: 'remote', workdirId: 'directory' },
    tools: { executionMode: 'session' },
  } as unknown as ExecutionContext
  for (const file of ['dispatch-instructions.md', 'dispatch-memory.md']) {
    assert.equal(await vfs.write(`v:project/${file}`, { content: file }, context), file)
  }
  assert.deepEqual(writes, ['dispatch-instructions.md', 'dispatch-memory.md'])
  for (const path of ['v:project/workspaces', 'v:project/dispatch-memory.md/extra', 'v:project/other.md', 'v:config/mcp.json']) {
    assert.throws(() => vfs.write(path, { content: 'no' }, context), /local workdir/)
  }
  const call = { ...context, tools: { ...context.tools, executionMode: 'call' } } as ExecutionContext
  assert.throws(() => vfs.write('v:project/dispatch-memory.md', { content: 'no' }, call), /call mode/)
})
