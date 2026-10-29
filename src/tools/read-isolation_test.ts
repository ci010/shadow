import { requireToolText } from './tool.ts'
import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createServer } from 'node:http'
import { once } from 'node:events'
import { VirtualFs } from '../vfs/virtual-fs.ts'
import { ReadTool } from './read.ts'
import { SessionTools, Tools } from './registry.ts'
import type { ExecutionContext } from './context.ts'
import { withTempWorkspace } from '../testing/workspace.ts'

test('read deduplication and cleanup are instance-owned despite identical physical session and file names', async () => {
  await withTempWorkspace(async (root) => {
    const file = join(root, 'shared-readonly.txt')
    await writeFile(file, 'shared read-only fixture')
    const readers = [new ReadTool(join(root, 'a')), new ReadTool(join(root, 'b'))]
    const contexts: ExecutionContext[] = ['a', 'b'].map((projectId) => ({
      projectId, sessionId: 'same-session', physicalSessionId: 'same-physical',
      channel: 'test', chatId: 'same-chat', senderId: 'same-user', messageId: 'same-input',
      tools: new SessionTools(new Tools(root), root), signal: new AbortController().signal,
    }))
    for (let i = 0; i < readers.length; i++) {
      assert.equal(await readers[i].execute({ path: file }, contexts[i]), 'shared read-only fixture')
      assert.match(requireToolText(await readers[i].execute({ path: file }, contexts[i])), /already in context/)
    }
    readers[0].clearSession('same-physical')
    assert.equal(await readers[0].execute({ path: file }, contexts[0]), 'shared read-only fixture')
    assert.match(requireToolText(await readers[1].execute({ path: file }, contexts[1])), /already in context/)
    const replacement = new ReadTool(join(root, 'a'))
    assert.equal(await replacement.execute({ path: file }, contexts[0]), 'shared read-only fixture')
  })

})

test('virtual text paging is applied and invalid ranges are rejected', async () => withTempWorkspace(async home => {
  const vfs = new VirtualFs()
  vfs.mount('v:fixture', 'Fixture', () => 'one\ntwo\nthree\nfour')
  const tools = new SessionTools(new Tools(home), home)
  const context = { tools, signal: new AbortController().signal } as ExecutionContext
  const reader = new ReadTool(home, vfs)
  assert.equal(await reader.execute({ path: 'v:fixture', offset: 2, limit: 2 }, context),
    'two\nthree\n\n[truncated: showing lines 2-3 of 4; use offset=4 to continue]')
  assert.match(requireToolText(await reader.execute({ path: 'v:fixture', offset: 4, limit: 1, flag: 'n' }, context)), /4.*four/)
  assert.equal(await reader.execute({ path: 'v:fixture', offset: 20, limit: 2 }, context), '')
  for (const range of [{ offset: 0 }, { limit: 0 }, { offset: 1.5 }, { limit: '2' }]) {
    await assert.rejects(reader.execute({ path: 'v:fixture', ...range }, context), /positive safe integer/)
  }
  vfs.mount('v:large', 'Large', () => 'very large text '.repeat(100_000))
  const large = requireToolText(await reader.execute({ path: 'v:large' }, context))
  assert.ok(large.length <= 100_000)
  assert.match(large, /token budget.*line 1 incomplete/s)
}))

test('URL paging preserves non-HTML line structure and raw HTML, and supports cancellation', async t => {
  await withTempWorkspace(async home => {
    const server = createServer((request, response) => {
      const html = request.url === '/html'
      response.setHeader('content-type', html ? 'text/html' : 'text/plain')
      response.end(html ? '<p>one</p>\n<p>two</p>' : '#include <stdio.h>\nsecond\nthird\nfourth')
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    t.after(async () => {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    })
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const url = `http://127.0.0.1:${address.port}`
    const context = { tools: new SessionTools(new Tools(home), home), signal: new AbortController().signal } as ExecutionContext
    const reader = new ReadTool(home)
    assert.equal(await reader.execute({ path: url, offset: 1, limit: 1 }, context),
      '#include <stdio.h>\n\n[truncated: showing lines 1-1 of 4; use offset=2 to continue]')
    assert.equal(await reader.execute({ path: `${url}/html`, flag: 'r', offset: 2, limit: 1 }, context), '<p>two</p>')
    await assert.rejects(reader.execute({ path: url }, { ...context, signal: AbortSignal.abort() }), { name: 'AbortError' })
  })
})
