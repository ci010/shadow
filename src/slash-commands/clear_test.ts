import assert from 'node:assert/strict'
import { test } from 'node:test'
import { Hono } from 'hono'
import { CommandDispatcher, type SlashCommandContext } from './index.ts'
import { createClearCommand } from './handlers/clear.ts'
import { createHelpCommand } from './handlers/help.ts'
import { slashCommandsPlugin } from './routes.ts'

test('clear is discoverable in ordinary/coordinator chats and enforces admin, arguments and busy errors', async () => {
  let calls = 0
  let result: 'cleared' | 'busy' | 'unsupported' = 'cleared'
  const dispatcher = new CommandDispatcher()
  dispatcher.register(createClearCommand({
    async clearSessionContext() { calls++; return result },
  }))
  const app = new Hono()
  slashCommandsPlugin(dispatcher, {
    assertFolderAccess() {},
    isManagedConversation: () => false,
  }, () => true)(app)
  const context: SlashCommandContext = {
    sessionId: 'web:chat-admin', admin: true,
    llm: { model: 'fixture', contextWindow: 1000, temperature: 0 },
    msg: { channel: 'web', chatId: 'chat-admin', senderId: 'owner', messageId: 'fixture', content: '/clear', timestamp: new Date().toISOString() },
  }
  for (const id of ['web:chat-admin', 'web:topic']) {
    const response = await app.request(`/api/chat/commands?sessionId=${encodeURIComponent(id)}`)
    assert.equal((await response.json()).commands[0].name, 'clear')
    assert.match(await createHelpCommand(dispatcher).execute({ ...context, sessionId: id }, ''), /\/clear/)
  }
  assert.match((await dispatcher.dispatch('/clear', { ...context, admin: false }))!, /^Permission denied:/)
  assert.match((await dispatcher.dispatch('/clear all', context))!, /^Error:.*without arguments/)
  assert.equal(calls, 0)
  result = 'busy'
  assert.match((await dispatcher.dispatch('/clear', context))!, /^Error:.*active or queued/)
  result = 'unsupported'
  assert.match((await dispatcher.dispatch('/clear', context))!, /^Error:.*persistent/)
  result = 'cleared'
  assert.match((await dispatcher.dispatch('/clear', context))!, /^AI context cleared/)
})
