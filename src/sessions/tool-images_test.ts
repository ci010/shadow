import assert from 'node:assert/strict'
import { test } from 'node:test'
import { join } from 'node:path'
import { readFile, readdir, writeFile } from 'node:fs/promises'
import { BaseSession } from './base-session.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import type { SessionStore } from './session-store.ts'
import type { ChatMessage, ContentPart, LLMProvider } from '../providers/provider.ts'
import { Bus } from '../bus/bus.ts'
import type { OutboundMessage } from '../bus/events.ts'
import { ReadTool } from '../tools/read.ts'
import { Tools, SessionTools } from '../tools/registry.ts'
import type { ExecutionContext } from '../tools/context.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { pngFixture } from '../testing/image.ts'
import { toolResultText, transientToolResult } from '../tools/tool.ts'

const llm = { model: 'fixture', contextWindow: 128_000, temperature: 0 }
class ImageSession extends BaseSession {
  run(context: ExecutionContext) { return this.runLlmLoop(context, llm, context.signal) }
}

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: private observations reach only the next inference, never persisted images or history`, async () => withTempWorkspace(async home => {
    const store: SessionStore = new Store(join(home, '.sessions'))
    await store.init()
    try {
      const bytes = pngFixture(16, 16)
      const raw = 'PRIVATE-DESKTOP-CONTENT-' + 'x'.repeat(40_000)
      const tools = new Tools(home)
      const hookResults: string[] = []
      tools.addHook({ name: 'private-observation-fixture', async afterExecute(_name, _args, result) {
        hookResults.push(result)
        return result
      } })
      tools.register({
        name: 'private_observe', description: 'Synthetic private observation', parameters: { type: 'object', properties: {} },
        async execute() { return transientToolResult([
          { type: 'text', text: raw },
          { type: 'image_url', image_url: { url: `data:image/png;base64,${bytes.toString('base64')}` } },
        ], 'Private observation omitted; observe again.') },
      })
      tools.register({ name: 'next_step', description: 'Synthetic next step', parameters: { type: 'object', properties: {} }, async execute() { return 'done' } })
      const sessionTools = new SessionTools(tools, home)
      const inputs: ChatMessage[][] = []
      const provider: LLMProvider = {
        name: 'fixture', listModels: () => ['fixture'],
        async chat(messages) {
          inputs.push(structuredClone(messages))
          return inputs.length <= 2 ? {
            content: null, toolCalls: [{ id: `step-${inputs.length}`, name: inputs.length === 1 ? 'private_observe' : 'next_step', arguments: {} }],
          } : { content: 'Finished', toolCalls: [] }
        },
      }
      const bus = new Bus()
      const outputs: OutboundMessage[] = []
      bus.on('message.outbound', message => { outputs.push(message) })
      const sessionId = 'web:private-images'
      const session = new ImageSession(home, sessionId, { sessionId, segmentIndex: 0, mode: 'session' },
        [{ role: 'user', content: 'Observe the synthetic fixture' }], provider, sessionTools, bus, store)
      await session.run({
        sessionId, physicalSessionId: session.physicalSessionId, channel: 'web', chatId: 'fixture',
        senderId: 'fixture', messageId: 'fixture', tools: sessionTools, signal: new AbortController().signal,
      })
      const observed = inputs[1].find(message => message.tool_call_id === 'step-1')!
      assert.ok(Array.isArray(observed.content))
      assert.ok(observed.content.some(part => part.type === 'image_url'))
      assert.equal(observed.content.find(part => part.type === 'text')?.text, raw)
      assert.doesNotMatch(JSON.stringify(inputs[2]), /PRIVATE-DESKTOP-CONTENT|base64,/)
      const records = await Array.fromAsync(store.readSessionLog(session.physicalSessionId))
      assert.doesNotMatch(JSON.stringify(records), /PRIVATE-DESKTOP-CONTENT|base64,|Image snapshots/)
      assert.match(JSON.stringify(records), /Private observation omitted/)
      assert.doesNotMatch(JSON.stringify(outputs), /PRIVATE-DESKTOP-CONTENT|base64,|Image snapshots/)
      assert.equal(outputs.some(output => output.media?.length), false)
      assert.doesNotMatch(JSON.stringify(hookResults), /PRIVATE-DESKTOP-CONTENT|base64,/)
      const files = await readdir(home, { recursive: true })
      assert.equal(files.some(path => path.endsWith('.png') || path.includes('tool-result-')), false)
    } finally { store.close?.() }
  }))
  test(`${Store.name}: tool image reaches the next inference, survives restart and can be reread from an immutable snapshot`, async () => withTempWorkspace(async home => {
    let store: SessionStore = new Store(join(home, '.sessions'))
    await store.init()
    try {
      const bytes = pngFixture(256, 256)
      const path = join(home, 'fixture.png')
      await writeFile(path, bytes)
      const tools = new Tools(home)
      tools.register(new ReadTool(home))
      const sessionTools = new SessionTools(tools, home)
      const bus = new Bus()
      const outputs: OutboundMessage[] = []
      bus.on('message.outbound', message => { outputs.push(message) })
      const inputs: ChatMessage[][] = []
      const provider: LLMProvider = {
        name: 'fixture', listModels: () => ['fixture'],
        async chat(messages) {
          inputs.push(structuredClone(messages))
          return inputs.length === 1
            ? { content: null, toolCalls: [{ id: 'read-image', name: 'read', arguments: { path } }] }
            : { content: 'Image received', toolCalls: [] }
        },
      }
      const sessionId = 'web:images'
      const state = { sessionId, segmentIndex: 0, mode: 'session' as const }
      const session = new ImageSession(home, sessionId, state, [{ role: 'user', content: 'Inspect the screenshot' }], provider, sessionTools, bus, store)
      const context: ExecutionContext = {
        sessionId, physicalSessionId: session.physicalSessionId, cwd: home,
        channel: 'web', chatId: 'images', senderId: 'fixture', messageId: 'fixture',
        tools: sessionTools, signal: new AbortController().signal,
      }
      await session.run(context)
      const result = inputs[1].find(message => message.role === 'tool')
      assert(result && Array.isArray(result.content))
      assert.equal(result.tool_call_id, 'read-image')
      const image = result.content.find(part => part.type === 'image_url')
      assert(image?.type === 'image_url')
      assert.equal(image.image_url.url, `data:image/png;base64,${bytes.toString('base64')}`)
      const live = outputs.find(message => message.event === 'tool_result')
      assert(live?.media?.length === 1)
      assert(!JSON.stringify(live).includes('base64,'), 'Live events must not overflow the bounded realtime queue')
      assert.deepEqual(await readFile(live.media[0]), bytes)
      assert.match(live.content, /Image snapshots/)
      assert(!inputs[1].some(message => message.role === 'user' && Array.isArray(message.content)), 'Do not impersonate a human in durable context')

      store.close?.()
      store = new Store(join(home, '.sessions'))
      await store.init()
      const records = await Array.fromAsync(store.readSessionLog(session.physicalSessionId))
      const restored = records.find(record => record.role === 'tool')
      assert(restored)
      assert.deepEqual(restored.content, result.content)
      assert.equal(restored.tool_call_id, 'read-image')
      // Same conversion guard as a provider payload: retain typed parts from saved records.
      assert(Array.isArray(restored.content))
      const parts: ContentPart[] = restored.content.map(part => {
        assert(part && typeof part === 'object' && 'type' in part)
        if (part.type === 'text') { assert('text' in part && typeof part.text === 'string'); return { type: 'text', text: part.text } }
        assert(part.type === 'image_url' && 'image_url' in part && part.image_url && typeof part.image_url === 'object')
        assert('url' in part.image_url && typeof part.image_url.url === 'string')
        return { type: 'image_url', image_url: { url: part.image_url.url, detail: 'auto' } }
      })
      const resumed = new ImageSession(home, sessionId, state, [
        { role: 'assistant', content: null, tool_calls: [{ id: 'read-image', type: 'function', function: { name: 'read', arguments: JSON.stringify({ path }) } }] },
        { role: 'tool', name: 'read', tool_call_id: 'read-image', content: parts },
      ], provider, sessionTools, bus, store)
      await resumed.run(context)
      assert.deepEqual(inputs[2].find(message => message.role === 'tool')?.content, parts)

      await writeFile(path, pngFixture(2, 2))
      const reread = await sessionTools.execute('read', { path: live.media[0] }, context)
      assert(typeof reread !== 'string', toolResultText(reread))
      assert.equal(reread.content.find(part => part.type === 'image_url')?.image_url.url, image.image_url.url)
      assert(!toolResultText(reread).includes('already in context'))
    } finally { store.close?.() }
  }))
}
