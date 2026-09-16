import assert from 'node:assert/strict'
import test from 'node:test'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { ReadTool } from './read.ts'
import { SessionTools, Tools } from './registry.ts'
import type { ExecutionContext } from './context.ts'
import { withTempWorkspace } from '../testing/workspace.ts'

test('read deduplication and cleanup are instance-owned despite identical physical session and file names', async () => {
  await withTempWorkspace(async (root) => {
    const file = join(root, 'shared-readonly.txt')
    await writeFile(file, 'shared read-only fixture')
    const readers = [new ReadTool(join(root, 'a')), new ReadTool(join(root, 'b'))]
    const contexts: ExecutionContext[] = ['a', 'b'].map((organizationId) => ({
      organizationId, sessionId: 'same-session', physicalSessionId: 'same-physical',
      channel: 'test', chatId: 'same-chat', senderId: 'same-user', messageId: 'same-input',
      tools: new SessionTools(new Tools(root), root), signal: new AbortController().signal,
    }))
    for (let i = 0; i < readers.length; i++) {
      assert.equal(await readers[i].execute({ path: file }, contexts[i]), 'shared read-only fixture')
      assert.match(await readers[i].execute({ path: file }, contexts[i]), /already in context/)
    }
    readers[0].clearSession('same-physical')
    assert.equal(await readers[0].execute({ path: file }, contexts[0]), 'shared read-only fixture')
    assert.match(await readers[1].execute({ path: file }, contexts[1]), /already in context/)
    const replacement = new ReadTool(join(root, 'a'))
    assert.equal(await replacement.execute({ path: file }, contexts[0]), 'shared read-only fixture')
  })
})
