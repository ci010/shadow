import assert from 'node:assert/strict'
import { test } from 'node:test'
import { recordedFileChange } from './file-change.ts'
import { ViewEditTool } from './view-edit.ts'
import type { ExecutionContext } from './context.ts'

const change = recordedFileChange({ sessionId: 'session', toolCallId: 'write', path: 'file.ts', mode: 'edit', before: 'old', after: 'new' })
const tool = new ViewEditTool()
const context: ExecutionContext = {
  sessionId: 'session', physicalSessionId: 'session-0', channel: 'test', chatId: 'test', senderId: 'test', messageId: 'turn',
  signal: new AbortController().signal, tools: undefined as never,
  readFileChange: async id => id === change.id ? change : undefined,
}

test('view_edit returns only the stored patch and makes empty/unavailable results explicit', async () => {
  assert.equal(await tool.execute({ edit_id: change.id }, context), change.patch)
  assert.equal(await tool.execute({ edit_id: change.id }, { ...context, readFileChange: async () => ({ ...change, patch: '' }) }), 'No content changes.')
  await assert.rejects(tool.execute({ edit_id: change.id }, {
    ...context, readFileChange: async () => ({ ...change, unavailable: 'Size limit', patch: '' }),
  }), /Recorded diff unavailable: Size limit/)
})

test('view_edit rejects missing records, cross-session records, invalid input and cancellation', async () => {
  await assert.rejects(tool.execute({ edit_id: 'missing' }, context), /not found/)
  await assert.rejects(tool.execute({ edit_id: change.id }, { ...context, readFileChange: undefined }), /unavailable/)
  await assert.rejects(tool.execute({ edit_id: change.id }, {
    ...context, readFileChange: async () => ({ ...change, sessionId: 'other' }),
  }), /identity mismatch/)
  for (const args of [{}, { edit_id: '' }, { edit_id: 1 }, { edit_id: change.id, sessionId: 'other' }]) {
    await assert.rejects(tool.execute(args, context))
  }
  await assert.rejects(tool.execute({ edit_id: change.id }, { ...context, signal: AbortSignal.abort() }), /abort/i)
  const controller = new AbortController()
  await assert.rejects(tool.execute({ edit_id: change.id }, {
    ...context, signal: controller.signal,
    readFileChange: async (_id, signal) => {
      assert.equal(signal, controller.signal)
      controller.abort()
      return change
    },
  }), /abort/i)
})
