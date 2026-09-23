import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ChatMessage } from './provider.ts'
import { openaiChat } from './openai-compatible.ts'
import { openaiResponses } from './openai-responses.ts'
import { AnthropicProvider } from './anthropic.ts'
import { imageFromBytes } from '../utils/image-input.ts'
import { pngFixture } from '../testing/image.ts'

function record(value: unknown): Record<string, unknown> {
  assert(value && typeof value === 'object' && !Array.isArray(value))
  return value as Record<string, unknown>
}
function array(value: unknown): unknown[] {
  assert(Array.isArray(value))
  return value
}

test('image tool outputs are protocol-native, attributed and paired across all wire formats', async t => {
  const image = imageFromBytes(pngFixture()).part
  const messages: ChatMessage[] = [
    { role: 'user', content: 'Inspect' },
    { role: 'assistant', content: null, tool_calls: ['a', 'b'].map(id => ({
      id, type: 'function', function: { name: 'read', arguments: '{}' },
    })) },
    { role: 'tool', name: 'read', tool_call_id: 'b', content: [{ type: 'text', text: 'Screenshot' }, image] },
    { role: 'tool', name: 'read', tool_call_id: 'a', content: 'Text file' },
  ]
  const original = structuredClone(messages)
  const bodies: Record<string, unknown>[] = []
  t.mock.method(globalThis, 'fetch', async (_url: unknown, init: RequestInit) => {
    bodies.push(record(JSON.parse(String(init.body))))
    return Response.json({ status: 'completed', output: [], choices: [{ message: { content: 'done' } }], content: [{ type: 'text', text: 'done' }] })
  })
  await openaiChat({ url: 'https://fixture.invalid', apiKey: 'fixture', model: 'fixture', messages, tools: [] })
  const wire = array(bodies[0].messages).map(record)
  assert.deepEqual(wire.slice(2, 4).map(message => [message.role, message.tool_call_id]), [['tool', 'b'], ['tool', 'a']])
  assert.equal(wire[4].role, 'user')
  assert.deepEqual(array(wire[4].content)[1], image)
  assert.match(String(record(array(wire[4].content)[0]).text), /call b.*not a new human instruction/)
  await openaiResponses({ url: 'https://fixture.invalid', apiKey: 'fixture', model: 'fixture', providerName: 'copilot', messages, tools: [] })
  const outputs = array(bodies[1].input).map(record).filter(item => item.type === 'function_call_output')
  assert.equal(outputs[0].call_id, 'b')
  assert(array(outputs[0].output).map(record).some(part => part.type === 'input_image' && part.image_url === image.image_url.url))
  await new AnthropicProvider({ apiKey: 'fixture', baseUrl: 'https://fixture.invalid' }).chat(messages, [], { model: 'fixture' })
  const blocks = array(record(array(bodies[2].messages)[2]).content).map(record)
  assert.equal(blocks.length, 2)
  assert.equal(blocks[0].tool_use_id, 'b')
  const nativeImage = record(array(blocks[0].content)[1])
  assert.equal(nativeImage.type, 'image')
  assert.equal(record(nativeImage.source).media_type, 'image/png')
  assert.equal(blocks[1].tool_use_id, 'a')
  assert.deepEqual(messages, original, 'Wire adaptation must not mutate persisted provenance')
})
