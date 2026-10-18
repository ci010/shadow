import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Bus } from '../bus/bus.ts'
import type { OutboundMessage } from '../bus/events.ts'
import { WeChatChannel } from './wechat.ts'

function message(fields: Partial<OutboundMessage> = {}): OutboundMessage {
  return { channel: 'wechat', chatId: 'owner', event: 'response', content: 'Final answer', done: true, ...fields }
}

test('WeChat sends only final responses, not tool events or intermediate commentary', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-wechat-replies-'))
  const channel = new WeChatChannel(new Bus(), { workspace: root, storageDirectory: root, scoped: true })
  const sent: string[] = []
  channel['_sendText'] = async (_chatId, content) => { sent.push(content) }
  try {
    // Exercise the normal delivery entry point. Filter before media reads too.
    for (const event of ['tool_call', 'tool_result'] as const) {
      for (const done of [false, true]) {
        await channel.onMessage(message({ event, done, content: 'v:skills/cron', media: ['nonexistent-tool-media.png'] }))
      }
    }
    await channel.onMessage(message({ done: false, content: 'Checking tools…', media: ['nonexistent-progress.png'] }))
    assert.deepEqual(sent, [])
    await channel.onMessage(message())
    assert.deepEqual(sent, ['Final answer'])
    await channel.onMessage(message({ content: '' }))
    assert.deepEqual(sent, ['Final answer'])
    await channel.onMessage(message({ content: '⚠️ Request failed: fixture' }))
    await channel.presentDecisionText('owner', 'Choose an option')
    assert.deepEqual(sent, ['Final answer', '⚠️ Request failed: fixture', 'Choose an option'])
    // Direct sends must not bypass the adapter policy.
    await channel.send(message({ event: 'tool_call' }))
    await channel.send(message({ done: false }))
    assert.equal(sent.length, 3)
  } finally {
    await channel.stop()
    rmSync(root, { recursive: true, force: true })
  }
})

test('WeChat final media still reaches delivery while send failures remain visible', async () => {
  const root = mkdtempSync(join(tmpdir(), 'shadow-wechat-media-'))
  const channel = new WeChatChannel(new Bus(), { workspace: root, storageDirectory: root, scoped: true })
  try {
    const image = join(root, 'fixture.png')
    writeFileSync(image, Buffer.from([1, 2, 3]))
    const images: string[] = []
    channel['_sendImage'] = async (_chatId, base64) => { images.push(base64) }
    await channel.onMessage(message({ content: '', media: [image] }))
    assert.deepEqual(images, ['AQID'])
    await assert.rejects(channel.onMessage(message({ media: [join(root, 'missing.png')] })), /WeChat delivery failed/)
    channel['_sendText'] = async () => { throw new Error('fixture') }
    await assert.rejects(channel.onMessage(message()), /WeChat delivery failed/)
  } finally {
    await channel.stop()
    rmSync(root, { recursive: true, force: true })
  }
})
