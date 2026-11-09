import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deflateSync } from 'node:zlib'
import { join } from 'node:path'
import { readFile } from 'node:fs/promises'
import { Bus } from '../bus/bus.ts'
import { channelSessionId } from '../bus/events.ts'
import type { ChatMessage, ContentPart, LLMProvider, LLMResponse } from '../providers/provider.ts'
import type { AgentTypesManager } from '../agent/types/manager.ts'
import { Tools } from '../tools/registry.ts'
import { transientToolResult } from '../tools/tool.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { SessionManager, type SessionManagerDeps } from './session-manager.ts'
import { JsonlSessionStore } from './session-store-jsonl.ts'
import { SqliteSessionStore } from './session-store-sqlite.ts'
import type { SessionStore } from './session-store.ts'
import type { SessionMessageInput } from './input.ts'
import { physicalSessionId } from './session-identity.ts'

// A valid, large, highly compressible RGBA PNG; no external images or user data.
function chunk(type: string, data: Buffer): Buffer {
  const payload = Buffer.concat([Buffer.from(type), data])
  let crc = 0xffffffff
  for (const byte of payload) {
    crc ^= byte
    for (let i = 0; i < 8; i++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0)
  }
  const result = Buffer.alloc(payload.length + 8)
  result.writeUInt32BE(data.length); payload.copy(result, 4)
  result.writeUInt32BE((crc ^ 0xffffffff) >>> 0, result.length - 4)
  return result
}
const header = Buffer.alloc(13)
header.writeUInt32BE(512); header.writeUInt32BE(512, 4); header[8] = 8; header[9] = 6
const pixels = Buffer.alloc(2049 * 512, 255)
for (let row = 0; row < 512; row++) pixels[row * 2049] = 0
const original = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', header),
  chunk('IDAT', deflateSync(pixels, { level: 0 })), chunk('IEND', Buffer.alloc(0))])
const png = 'data:image/png;base64,' + original.toString('base64')
const image = (): ContentPart => ({ type: 'image_url', image_url: { url: png } })
const urls = (messages: ChatMessage[]) => messages.flatMap(m => Array.isArray(m.content)
  ? m.content.flatMap(p => p.type === 'image_url' ? [p.image_url.url] : []) : [])
const input = (media: string[] = [], policy: SessionMessageInput['policy'] = 'queue', channel = 'web'): SessionMessageInput => ({
  kind: 'message', id: crypto.randomUUID(), timestamp: new Date().toISOString(), content: 'Synthetic image input',
  media, policy, source: { kind: 'user', sender: { channel, chatId: 'images', senderId: 'fixture', messageId: crypto.randomUUID() } },
})
const done: LLMResponse = { content: 'Done', toolCalls: [] }

function fixture(workspace: string, store: SessionStore, respond: (messages: ChatMessage[]) => LLMResponse) {
  const bus = new Bus()
  const requests: ChatMessage[][] = []
  const provider: LLMProvider = {
    name: 'fixture', listModels: () => ['fixture'],
    async chat(messages) { requests.push(structuredClone(messages)); return respond(messages) },
  }
  const tools = new Tools(workspace)
  tools.register({ name: 'image_fixture', description: 'Synthetic images', parameters: { type: 'object', properties: {} },
    execute: async () => ({ content: [image()] }) })
  tools.register({ name: 'transient_fixture', description: 'Synthetic transient image', parameters: { type: 'object', properties: {} },
    execute: async () => transientToolResult([image()], 'Durable image summary') })
  const sessions = new SessionManager({ workspace, store, provider, bus, tools,
    agentTypes: { resolve: (name: string) => ({ name, description: '', prompt: '', source: 'builtin', defaultMode: 'session' }),
      allNames: () => ['general'] } as unknown as AgentTypesManager,
    handoffManager: { shouldHandoff: () => false, getContextPolicy: () => undefined },
    context: { buildSystemPrompt: async () => 'Synthetic image regression fixture' },
    getLlmRuntimeConfig: () => ({ model: 'fixture', contextWindow: 128000, temperature: 0 }),
  } as unknown as SessionManagerDeps)
  async function turn(id: string, value: SessionMessageInput) {
    const finished = Promise.withResolvers<void>()
    const off = bus.on('session.turn.finished', fact => { if (fact.sessionId === id) finished.resolve() })
    try { await sessions.deliver(id, value); await finished.promise } finally { bus.off(off) }
  }
  return { sessions, requests, turn }
}

for (const Store of [JsonlSessionStore, SqliteSessionStore]) {
  test(`${Store.name}: standard new-image session admission is channel-independent`, { timeout: 30000 }, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions')); await store.init()
      const f = fixture(workspace, store, () => done)
      try {
        await f.sessions.start()
        for (const channel of ['web', 'qq', 'wechat', 'feishu', 'discord']) {
          await f.turn(`${channel}:images`, input([png], 'queue', channel))
        }
        assert.equal(f.requests.length, 5)
        const modelUrls = f.requests.map(request => {
          const images = urls(request)
          assert.equal(images.length, 1)
          assert.match(images[0], /^data:image\/webp;base64,/)
          return images[0]
        })
        assert.equal(new Set(modelUrls).size, 1, 'All channels use the same image encoding policy')
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: old PNG history stays unchanged; new user/tool images are prepared before inference and survive reload`, { timeout: 30000 }, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions')); await store.init()
      let calls = 0
      const f = fixture(workspace, store, () => ++calls === 1
        ? { content: '', toolCalls: [{ id: 'image-call', name: 'image_fixture', arguments: {} }] } : done)
      const id = 'web:images'
      try {
        await f.sessions.start(); await f.sessions.buildSession(id)
        const physical = physicalSessionId(f.sessions.getSessionState(id)!)
        await store.appendMessages(physical, [{ role: 'user', content: [image()], timestamp: '2020-01-01T00:00:00.000Z' }])
        await f.turn(id, input([png]))
        assert.equal(f.requests.length, 2)
        const first = urls(f.requests[0]); assert.equal(first.length, 2)
        assert.equal(first[0], png, 'loading old history must not optimize it')
        assert.match(first[1], /^data:image\/webp;base64,/, 'new user image is optimized before provider')
        const second = urls(f.requests[1]); assert.equal(second.length, 3)
        assert.equal(second[0], png); assert.equal(second[1], first[1])
        assert.match(second[2], /^data:image\/webp;base64,/, 'new tool image is optimized before provider')
        const snapshotMessage = f.requests[1].find(m => m.tool_call_id === 'image-call')!
        const text = Array.isArray(snapshotMessage.content) ? snapshotMessage.content.filter(p => p.type === 'text').map(p => p.text).join('\n') : ''
        const snapshot = text.split('\n').find(line => line.startsWith('"'))
        assert.ok(snapshot, 'tool result records its original snapshot path')
        assert.deepEqual(await readFile(JSON.parse(snapshot)), original, 'snapshot retains original PNG bytes')
        await f.sessions.stop()
        const reloaded = fixture(workspace, store, () => done)
        try {
          await reloaded.sessions.start(); await reloaded.turn(id, input())
          assert.deepEqual(urls(reloaded.requests[0]), second, 'restart preserves exact optimized URLs and untouched historical PNG')
        } finally { await reloaded.sessions.stop() }
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: concurrent new images all optimize, including transient tool results`, { timeout: 30000 }, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions')); await store.init()
      const f = fixture(workspace, store, messages => messages.some(m => m.tool_call_id === 'transient-call') ? done
        : { content: '', toolCalls: [{ id: 'transient-call', name: 'transient_fixture', arguments: {} }] })
      try {
        await f.sessions.start()
        await Promise.all(['web:a', 'web:b', 'web:c'].map(id => f.turn(id, input([png, png]))))
        assert.equal(f.requests.length, 6)
        for (const messages of f.requests) {
          const images = urls(messages)
          assert.ok(images.length >= 2)
          for (const url of images) assert.match(url, /^data:image\/webp;base64,/, 'codec contention must not leave new PNG unoptimized')
        }
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })

  test(`${Store.name}: silent channel archive prepares image without inference and reload uses identical URL`, { timeout: 30000 }, async () => {
    await withTempWorkspace(async workspace => {
      const store: SessionStore = new Store(join(workspace, 'sessions')); await store.init()
      const address = { projectId: 'default', botInstanceId: 'fixture', platform: 'web', conversationId: 'images' }
      const id = channelSessionId(address)
      const f = fixture(workspace, store, () => done)
      try {
        await f.sessions.start()
        const archived = input([png], 'silent')
        if (archived.source.kind === 'user') archived.source.sender.channelAddress = address
        await f.sessions.deliver(id, archived)
        assert.equal(f.requests.length, 0)
        const state = f.sessions.getSessionState(id)!
        const records = []
        for await (const record of store.readSessionLog(physicalSessionId(state))) records.push(record)
        const archivedUrls = urls(records.filter(r => r.role === 'user').map(r => ({ role: 'user', content: r.content as ChatMessage['content'] })))
        assert.equal(archivedUrls.length, 1); assert.match(archivedUrls[0], /^data:image\/webp;base64,/)
        await f.sessions.stop()
        const reloaded = fixture(workspace, store, () => done)
        try {
          await reloaded.sessions.start(); await reloaded.turn(id, input())
          assert.deepEqual(urls(reloaded.requests[0]), archivedUrls)
        } finally { await reloaded.sessions.stop() }
      } finally { await f.sessions.stop(); store.close?.() }
    })
  })
}
