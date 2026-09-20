import assert from 'node:assert/strict'
import test from 'node:test'
import { Hono } from 'hono'
import { CommandDispatcher, type SlashCommandContext } from './index.ts'
import { createHelpCommand } from './handlers/help.ts'
import { slashCommandsPlugin } from './routes.ts'
import { FolderError } from '../folders/registry.ts'

function fixture() {
  const dispatcher = new CommandDispatcher()
  for (const name of ['status', 'yield', 'agent-publish']) dispatcher.register({
    name, description: `Description of ${name}`, adminOnly: name !== 'yield',
    coordinatorOnly: name === 'agent-publish',
    execute: async () => assert.fail('Catalog reads must never execute a command'),
  })
  const checked: string[] = []
  const app = new Hono()
  slashCommandsPlugin(dispatcher, {
    assertFolderAccess(id) {
      checked.push(id)
      if (id === 'web:revoked') throw new FolderError('folder_access_revoked', 'Folder access changed.', 409)
    },
    isManagedConversation: id => id === 'web:managed',
  }, request => request.headers.get('authorization') === 'Bearer synthetic')(app)
  const request = (id = '') => app.request(`/api/chat/commands${id ? `?sessionId=${encodeURIComponent(id)}` : ''}`, {
    headers: { authorization: 'Bearer synthetic' },
  })
  return { app, dispatcher, checked, request }
}

test('authenticated catalogs reuse registered handlers and filter coordinator-only commands', async () => {
  const f = fixture()
  assert.equal((await f.app.request('/api/chat/commands')).status, 401)
  for (const id of ['', 'web:conversation']) {
    const response = await f.request(id)
    assert.equal(response.status, 200)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.deepEqual((await response.json()).commands, [
      { name: 'status', description: 'Description of status' },
      { name: 'yield', description: 'Description of yield' },
    ])
  }
  assert.deepEqual(f.checked, ['web:conversation'])
  assert.deepEqual((await (await f.request('web:orchestrator')).json()).commands.map((item: { name: string }) => item.name),
    ['agent-publish', 'status', 'yield'])
  f.dispatcher.register({ name: 'new-command', description: 'Registered later', adminOnly: true, execute: async () => '' })
  assert.equal((await (await f.request()).json()).commands[0].name, 'new-command')
})

test('managed conversations and non-web execution contexts cannot advertise slash execution', async () => {
  const f = fixture()
  assert.deepEqual(await (await f.request('web:managed')).json(), { commands: [] })
  assert.equal((await f.request('web:revoked')).status, 409)
  for (const id of ['web:', 'sub:task', 'qq:group', 'web:line\nbreak', 'web:' + 'x'.repeat(513)]) {
    assert.equal((await f.request(id)).status, 400)
  }
})

test('help and discovery use the same permission and conversation filtering', async () => {
  const { dispatcher } = fixture()
  assert.deepEqual(dispatcher.getHandlers({ admin: false, sessionId: 'web:ordinary' }).map(item => item.name), ['yield'])
  const context: SlashCommandContext = {
    sessionId: 'web:ordinary', admin: true, llm: { model: 'test', contextWindow: 4096, temperature: 0 },
    msg: { channel: 'web', chatId: 'ordinary', senderId: 'owner', messageId: 'synthetic', content: '/help', timestamp: new Date().toISOString() },
  }
  assert.doesNotMatch(await createHelpCommand(dispatcher).execute(context, ''), /agent-publish/)
  assert.match(await createHelpCommand(dispatcher).execute({ ...context, sessionId: 'web:orchestrator' }, ''), /agent-publish/)
})
