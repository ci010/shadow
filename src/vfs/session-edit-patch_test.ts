import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recordedFileChange } from '../tools/file-change.ts'
import { ReadTool } from '../tools/read.ts'
import { createSessionsHandler } from './mounts.ts'
import { VirtualFs } from './virtual-fs.ts'
import { sessionEditPatchPath } from '../sessions/file-change-path.ts'
import type { ExecutionContext } from '../tools/context.ts'

const change = recordedFileChange({ sessionId: 'session', toolCallId: 'write', path: 'file.ts', mode: 'edit', before: 'old', after: 'new' })
const history = createSessionsHandler({ listSessions: () => [], getSessionState: () => null,
  getHistory: async () => ({ messages: [], total: 0 }) })
const vfs = new VirtualFs()
vfs.mount('v:sessions', 'session history', history.read, history.list)
const tool = new ReadTool('.', vfs)
const path = sessionEditPatchPath(change.id)
const context: ExecutionContext = {
  sessionId: 'session', physicalSessionId: 'session-0', channel: 'test', chatId: 'test', senderId: 'test', messageId: 'turn',
  signal: new AbortController().signal, tools: undefined as never,
  readFileChange: async id => id === change.id ? change : undefined,
}

test('edit patch read returns only the stored patch and makes empty/unavailable results explicit', async () => {
  assert.equal(await tool.execute({ path }, context), change.patch)
  assert.equal(await tool.execute({ path }, { ...context, readFileChange: async () => ({ ...change, patch: '' }) }), 'No content changes.')
  await assert.rejects(tool.execute({ path }, {
    ...context, readFileChange: async () => ({ ...change, unavailable: 'Size limit', patch: '' }),
  }), /Recorded diff unavailable: Size limit/)
})

test('edit patch read rejects missing records, cross-session records, invalid input and cancellation', async () => {
  await assert.rejects(tool.execute({ path: sessionEditPatchPath('missing') }, context), /not found/)
  await assert.rejects(tool.execute({ path }, { ...context, readFileChange: undefined }), /unavailable/)
  await assert.rejects(tool.execute({ path }, {
    ...context, readFileChange: async () => ({ ...change, sessionId: 'other' }),
  }), /identity mismatch/)
  for (const id of ['%2f', '%', '..', 'extra/path', 'patch?offset=1']) {
    await assert.rejects(tool.execute({ path: `v:sessions/self/edits/${id}` }, context), /Invalid session edit/)
  }
  await assert.rejects(tool.execute({ path: `v:sessions/another/edits/${change.id}` }, context), /not found/i)
  assert.deepEqual(await vfs.list(path, context), [])
  assert.match(String(await tool.execute({ path, offset: 1, limit: 1 }, context)), /^@@ .*\n\n\[truncated:/)
  assert.match(String(await tool.execute({ path, offset: 2, flag: 'n' }, context)), /-old/)
  await assert.rejects(tool.execute({ path }, { ...context, signal: AbortSignal.abort() }), /abort/i)
  const controller = new AbortController()
  await assert.rejects(tool.execute({ path }, {
    ...context, signal: controller.signal,
    readFileChange: async (_id, signal) => {
      assert.equal(signal, controller.signal)
      controller.abort()
      return change
    },
  }), /abort/i)
})
