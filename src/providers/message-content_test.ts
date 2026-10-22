import assert from 'node:assert/strict'
import test from 'node:test'
import { modelMessages, qqStickerCount } from './message-content.ts'
import type { ChatMessage, ImageContentPart } from './provider.ts'
import { AggregatedProvider } from './aggregated.ts'

const sticker = '<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">'
const image = (url: string, displayOnly?: boolean): ImageContentPart => ({
  type: 'image_url', image_url: { url }, ...(displayOnly !== undefined ? { displayOnly } : {}),
})

test('aggregate routing projects display metadata and resolves bare catalog IDs through its primary provider', async () => {
  const provider = new AggregatedProvider(new Map([['primary', {
    name: 'fixture', listModels: () => ['model'],
    chat: async (messages: ChatMessage[]) => {
      assert.doesNotMatch(JSON.stringify(messages), /sticker-data|displayOnly/)
      return { content: 'ok', toolCalls: [] }
    },
  }]]), 'primary')
  assert.equal(provider.qualifiedModelId('model'), 'model@primary')
  assert.equal(provider.qualifiedModelId('model@other'), 'model@other')
  await provider.chat([{ role: 'user', content: [image('sticker-data', true)] }], [], { model: 'model' })
})

test('display-only stickers are omitted without mutating previews, normal GIFs, text or tool pairing', () => {
  const messages: ChatMessage[] = [
    { role: 'user', content: [{ type: 'text', text: `${sticker} Please fix this` },
      image('sticker-data', true), image('screenshot.gif', false)] },
    { role: 'assistant', content: null, tool_calls: [{ id: 'call', type: 'function', function: { name: 'read', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'call', content: 'receipt' },
  ]
  const before = structuredClone(messages)
  const projected = modelMessages(messages)
  assert.deepEqual(messages, before)
  assert.doesNotMatch(JSON.stringify(projected), /sticker-data|faceType|displayOnly/)
  assert.match(JSON.stringify(projected), /screenshot.gif|Please fix this|QQ sticker omitted/)
  assert.deepEqual(projected.slice(1), messages.slice(1))
  assert.deepEqual(modelMessages(projected), projected)
})

test('legacy QQ filtering requires exact markers and an unambiguous all-sticker message', () => {
  const message: ChatMessage = { role: 'user', content: [{ type: 'text', text: `${sticker} still keep this` }, image('legacy')] }
  assert.equal(qqStickerCount(sticker), 1)
  assert.match(JSON.stringify(modelMessages([message])), /legacy/)
  assert.doesNotMatch(JSON.stringify(modelMessages([message], true)), /legacy|faceType/)
  for (const content of [
    [{ type: 'text' as const, text: sticker }, image('one'), image('two')],
    [{ type: 'text' as const, text: 'ordinary animated GIF' }, image('normal.gif')],
    [{ type: 'text' as const, text: `Quoted QQ message ${sticker}` }, image('quote')],
    [{ type: 'text' as const, text: sticker }, image('explicit-normal', false)],
  ]) {
    const projected = modelMessages([{ role: 'user', content }], true)
    assert.equal(Array.isArray(projected[0].content) && projected[0].content.filter(part => part.type === 'image_url').length,
      content.filter(part => part.type === 'image_url').length)
  }
})
