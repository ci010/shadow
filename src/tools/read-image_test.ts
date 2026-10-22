import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { writeFile } from 'node:fs/promises'
import { ReadTool } from './read.ts'
import { Tools, SessionTools } from './registry.ts'
import { InvokeTool } from './invoke-tool.ts'
import { requireToolText, type ToolResult } from './tool.ts'
import type { ExecutionContext } from './context.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { pngFixture } from '../testing/image.ts'
import { MAX_IMAGE_BYTES, imageFromBytes, imageFromDataUrl } from '../utils/image-input.ts'
import { estimateTokens } from '../utils/estimate-tokens.ts'

function fixture(home: string) {
  const base = new Tools(home, 80)
  base.register(new ReadTool(home))
  base.register(new InvokeTool())
  const tools = new SessionTools(base, home)
  const context: ExecutionContext = {
    sessionId: 'web:images', physicalSessionId: 'images-0', cwd: home,
    channel: 'web', chatId: 'images', senderId: 'fixture', messageId: 'fixture',
    tools, signal: new AbortController().signal,
  }
  return { base, tools, context }
}

function images(result: ToolResult) {
  assert.notEqual(typeof result, 'string', 'Images must not be returned as encoded text')
  if (typeof result === 'string') throw new Error(result)
  return result.content.filter(part => part.type === 'image_url')
}

test('read delivers real large PNG bytes without line paging, text limits or dedup omissions', async () => withTempWorkspace(async home => {
  const { tools, context } = fixture(home)
  const bytes = pngFixture(256, 256)
  assert(bytes.length > 128 * 1024)
  const path = join(home, 'screenshot.png')
  await writeFile(path, bytes)
  for (let i = 0; i < 2; i++) {
    const result = await tools.execute('read', { path }, context)
    const parts = images(result)
    assert.equal(parts.length, 1)
    assert.equal(parts[0].image_url.url, `data:image/png;base64,${bytes.toString('base64')}`)
    assert(estimateTokens([{ role: 'tool', content: parts }]) < 5000)
  }
  for (const args of [{ offset: 1 }, { limit: 4 }, { flag: 'n' }]) {
    assert.match(requireToolText(await tools.execute('read', { path, ...args }, context)), /Images do not support line paging/)
  }
  await writeFile(join(home, 'text.txt'), 'plain text')
  assert.equal(await tools.execute('read', { path: 'text.txt' }, context), 'plain text')
}))

test('unsupported, corrupted, oversized and remote images fail explicitly without text or Main fallback', async () => withTempWorkspace(async home => {
  const { tools, context } = fixture(home)
  for (const [name, bytes, error] of [
    ['invalid.png', Buffer.from('not a PNG'), /Invalid image header/],
    ['vector.svg', Buffer.from('<svg width="10" height="10"></svg>'), /Unsupported image format/],
    ['large.png', Buffer.alloc(MAX_IMAGE_BYTES + 1), /exceeds 5 MiB/],
    ['binary.bin', Buffer.from([0, 1, 2, 255]), /Binary file/],
  ] as const) {
    await writeFile(join(home, name), bytes)
    assert.match(requireToolText(await tools.execute('read', { path: name }, context)), error)
  }
  const remote: ExecutionContext = { ...context, remoteWorkdir: {
    nodeId: 'child', capabilityId: 'remote',
    executor: {
      async *execute() { throw new Error('Must not execute remote text read') },
      getStatus: async () => null,
      cancel: async () => { throw new Error('Must not cancel remote work') },
    },
  } }
  assert.match(requireToolText(await tools.execute('read', { path: 'secret.png' }, remote)), /Remote image reads are not supported/)
  const oversizedPixels = pngFixture()
  oversizedPixels.writeUInt32BE(30_000, 16)
  oversizedPixels.writeUInt32BE(30_000, 20)
  assert.throws(() => imageFromBytes(oversizedPixels), /25 million pixels/)
  assert.throws(() => imageFromDataUrl('data:image/jpeg;base64,' + pngFixture().toString('base64')), /does not match/)
  const controller = new AbortController()
  controller.abort(new Error('cancel fixture'))
  await assert.rejects(tools.execute('read', { path: 'invalid.png' }, { ...context, signal: controller.signal }), /cancel fixture/)
}))

test('dynamic image results survive invoke_tool, text hooks and truncation with image bytes unchanged', async () => withTempWorkspace(async home => {
  const { base, tools, context } = fixture(home)
  const image = imageFromBytes(pngFixture()).part
  base.addHook({ name: 'fixture', afterExecute: async () => '\nHook diagnostic' })
  tools.registerDynamic({
    name: 'screenshot', description: 'fixture', parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [{ type: 'text', text: 'x'.repeat(1000) }, image] }),
  })
  const result = await tools.execute('invoke_tool', { name: 'screenshot', args: {} }, context)
  assert.deepEqual(images(result), [image])
  assert.throws(() => requireToolText(result), /accepts text only/)
  tools.registerDynamic({
    name: 'bad-image', description: '', parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,eA==' } }] }),
  })
  assert.match(requireToolText(await tools.execute('invoke_tool', { name: 'bad-image', args: {} }, context)), /Invalid image header/)
}))
