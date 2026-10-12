import { sessionWorkspacePath } from '../utils/paths.ts'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Bus } from '../bus/bus.ts'
import type { InboundMessage } from '../bus/events.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { DiscordChannel } from './discord.ts'

class TestDiscordChannel extends DiscordChannel {
  acceptMessages(): void { this.setAccepting(true) }
}

test('Discord audio is kept as a session attachment; a failed download is not treated as audio input', async t => {
  await withTempWorkspace(async workspace => {
    const channel = new TestDiscordChannel(new Bus(), {
      token: 'fixture', workspace, reactionEmoji: '',
    })
    t.after(() => channel.stop())
    channel.acceptMessages()
    const messages: InboundMessage[] = []
    channel.setReceiver(async message => {
      messages.push(message)
      return { status: 'accepted', sessionId: 'discord:100', inputId: message.messageId }
    })
    let downloadSucceeds = true
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input)
      if (url === 'https://cdn.discordapp.com/attachments/100/456/voice.ogg') {
        assert.equal(new Headers(init?.headers).has('authorization'), false, 'Bot credentials never reach the CDN')
        return downloadSucceeds ? new Response('voice', { status: 200 }) : new Response('', { status: 403 })
      }
      if (url.endsWith('/channels/100')) return Response.json({ name: 'dm' })
      assert.fail(`Unexpected request: ${url}`)
    })
    const dispatch = (channel as unknown as {
      handleDispatch(event: string, data: Record<string, unknown>): Promise<void>
    }).handleDispatch.bind(channel)
    const message = {
      author: { id: '300', bot: false }, channel_id: '100', content: '', id: '123',
      attachments: [{ id: '456', filename: 'voice.ogg', url: 'https://cdn.discordapp.com/attachments/100/456/voice.ogg' }],
    }
    await dispatch('MESSAGE_CREATE', message)
    assert.deepEqual(messages[0].media, ['uploads/discord_456.ogg'])
    assert.equal(messages[0].content, '')
    assert.equal(await readFile(join(sessionWorkspacePath(workspace, 'discord:100'), messages[0].media![0]), 'utf8'), 'voice')
    downloadSucceeds = false
    await dispatch('MESSAGE_CREATE', { ...message, id: '124' })
    assert.equal(messages[1].media, undefined)
    assert.match(messages[1].content, /attachment unavailable: download failed/)
    await dispatch('MESSAGE_CREATE', { ...message, id: '125',
      attachments: [{ ...message.attachments[0], url: 'https://untrusted.example/attachments/voice.ogg' }] })
    assert.equal(messages[2].media, undefined)
    assert.match(messages[2].content, /attachment unavailable: download failed/)
  })
})
