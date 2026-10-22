import assert from 'node:assert/strict'
import { readFile, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import { test } from 'node:test'
import { Bus } from '../bus/bus.ts'
import { channelSessionId, type InboundMessage } from '../bus/events.ts'
import { buildMediaParts } from '../agent/message-builder.ts'
import { withTempWorkspace } from '../testing/workspace.ts'
import { sessionWorkspacePath } from '../utils/paths.ts'
import { QQChannel } from './qq.ts'
import { once } from 'node:events'
import { WebSocketServer } from 'ws'

const sources = [
  { event: 'GROUP_MESSAGE_CREATE', chatId: 'group:group', isGroup: true, silent: true },
  { event: 'GROUP_AT_MESSAGE_CREATE', chatId: 'group:group', isGroup: true, silent: false },
  { event: 'C2C_MESSAGE_CREATE', chatId: 'c2c:sender', isGroup: false, silent: false },
  { event: 'AT_MESSAGE_CREATE', chatId: 'channel:channel', isGroup: true, silent: false },
  { event: 'DIRECT_MESSAGE_CREATE', chatId: 'dms:guild', isGroup: false, silent: false },
]

function payload(attachments: unknown, id = 'message') {
  return {
    id, group_openid: 'group', guild_id: 'guild', channel_id: 'channel',
    author: { member_openid: 'sender', user_openid: 'sender', id: 'sender' },
    content: '', timestamp: new Date().toISOString(), attachments,
  }
}

function receiver(channel: QQChannel): InboundMessage[] {
  const messages: InboundMessage[] = []
  channel.setReceiver(async message => {
    messages.push(message)
    return { status: 'accepted', sessionId: message.channelAddress
      ? channelSessionId(message.channelAddress) : `qq:${message.chatId}`, inputId: message.messageId }
  })
  return messages
}

for (const source of sources) {
  test(`QQ ${source.event} receives file-only messages without overwriting same-name files`, async t => {
    await withTempWorkspace(async workspace => {
      const channel = new QQChannel(new Bus(), { appId: 'fixture', secret: 'fixture', workspace })
      t.after(() => channel.stop())
      const messages = receiver(channel)
      let downloads = 0
      t.mock.method(Date, 'now', () => 1_800_000_000_000)
      t.mock.method(globalThis, 'fetch', async (input: string | URL | Request, init?: RequestInit) => {
        assert.equal(String(input), 'https://multimedia.nt.qq.com.cn/download?key=fixture')
        assert.equal(new Headers(init?.headers).has('authorization'), false)
        return new Response(`file-${++downloads}`)
      })
      await channel['handleDispatch'](source.event, payload([
        { filename: 'report.csv', url: 'multimedia.nt.qq.com.cn/download?key=fixture' },
        { filename: 'report.csv', url: '//multimedia.nt.qq.com.cn/download?key=fixture' },
      ]))
      assert.equal(messages.length, 1)
      const message = messages[0]
      assert.equal(message.chatId, source.chatId)
      assert.equal(message.isGroup, source.isGroup)
      assert.equal(message.silent === true, source.silent)
      assert.equal(message.content, '')
      assert.equal(message.media?.length, 2)
      assert.notEqual(message.media![0], message.media![1])
      const cwd = sessionWorkspacePath(workspace, `qq:${source.chatId}`)
      for (const [index, path] of message.media!.entries()) {
        assert.match(path, /^uploads\/qq_[\da-f-]+_report\.csv$/)
        assert.equal(await readFile(join(cwd, path), 'utf8'), `file-${index + 1}`)
      }
      assert.deepEqual(await buildMediaParts(message.media!, workspace, cwd),
        message.media!.map(path => ({ type: 'text', text: `[file: ${path}]` })))
      await channel['handleDispatch'](source.event, payload([]))
      assert.equal(downloads, 2, 'duplicate event does not download again')
    })
  })
}

test('QQ attachments stay in the owning Bot session and use safe filenames and MIME fallbacks', async t => {
  await withTempWorkspace(async workspace => {
    t.mock.method(globalThis, 'fetch', async () => new Response('document', {
      headers: { 'content-type': 'application/pdf' },
    }))
    const paths: string[] = []
    for (const botInstanceId of ['bot-a', 'bot-b']) {
      const channel = new QQChannel(new Bus(), { appId: 'fixture', secret: 'fixture', workspace })
      t.after(() => channel.stop())
      channel.setBotScope({ projectId: 'project', botInstanceId, platform: 'qq' })
      const messages = receiver(channel)
      await channel['handleDispatch']('C2C_MESSAGE_CREATE', payload([
        { filename: '..\\..\\report?.txt', url: 'https://multimedia.nt.qq.com.cn/file' },
        { url: 'https://multimedia.nt.qq.com.cn/document' },
        { filename: 'sheet', content_type: 'text/csv', url: 'https://multimedia.nt.qq.com.cn/file' },
        { url: 'https://multimedia.nt.qq.com.cn/notes.txt' },
      ]))
      const message = messages[0]
      assert.equal(message.media?.length, 4)
      assert.match(message.media![0], /_report_\.txt$/)
      assert.match(message.media![1], /_document\.pdf$/)
      assert.match(message.media![2], /_sheet\.csv$/)
      assert.match(message.media![3], /_notes\.txt$/)
      const cwd = sessionWorkspacePath(workspace, channelSessionId(message.channelAddress!))
      for (const path of message.media!) {
        assert.equal(await readFile(join(cwd, path), 'utf8'), 'document')
        paths.push(join(cwd, path))
      }
    }
    assert.equal(new Set(paths).size, 8)
    assert.equal((await readdir(workspace)).length, 2)
  })
})

test('QQ receives a referenced group ZIP over a real binary websocket frame', { timeout: 10_000 }, async t => {
  await withTempWorkspace(async workspace => {
    const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
    await once(server, 'listening')
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    const channel = new QQChannel(new Bus(), { appId: 'fixture', secret: 'fixture', workspace })
    channel['getGatewayUrl'] = async () => `ws://127.0.0.1:${address.port}`
    const accepted = Promise.withResolvers<InboundMessage>()
    channel.setReceiver(async message => {
      accepted.resolve(message)
      return { status: 'accepted', sessionId: `qq:${message.chatId}`, inputId: message.messageId }
    })
    t.mock.method(globalThis, 'fetch', async () => new Response('synthetic zip'))
    const warnings: unknown[][] = []
    t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args) })
    try {
      server.on('connection', socket => {
        socket.send(Buffer.from('invalid private wire data'))
        socket.send(Buffer.from(JSON.stringify({
          op: 0, s: 1, t: 'GROUP_AT_MESSAGE_CREATE', d: {
            ...payload(undefined), content: 'Read this quoted file', message_type: 103,
            msg_elements: [{
              content: 'previous file', attachments: [{
                filename: 'report (16).zip', content_type: 'file', url: 'https://multimedia.nt.qq.com.cn/download',
              }],
            }],
          },
        })))
      })
      await channel['connect']()
      const message = await accepted.promise
      assert.equal(message.silent, false)
      assert.equal(message.media?.length, 1)
      assert.match(message.content, /Quoted QQ message/)
      assert.match(message.media![0], /report__16_\.zip$/)
      const cwd = sessionWorkspacePath(workspace, `qq:${message.chatId}`)
      assert.equal(await readFile(join(cwd, message.media![0]), 'utf8'), 'synthetic zip')
      assert.match(JSON.stringify(warnings), /Gateway frame rejected/)
      assert.doesNotMatch(JSON.stringify(warnings), /private wire data/)
    } finally {
      await channel.stop()
      for (const socket of server.clients) socket.terminate()
      await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    }
  })
})

for (const event of ['GROUP_MESSAGE_CREATE', 'C2C_MESSAGE_CREATE']) {
  test(`QQ ${event} resolves a cached file by scene index without cross-chat or cross-Bot leakage`, async t => {
    await withTempWorkspace(async workspace => {
      const channel = new QQChannel(new Bus(), { appId: 'fixture', secret: 'fixture', workspace })
      t.after(() => channel.stop())
      const messages = receiver(channel)
      let downloads = 0
      t.mock.method(globalThis, 'fetch', async () => { downloads++; return new Response('report') })
      const initial = {
        ...payload([{ filename: 'report.zip', url: 'https://multimedia.nt.qq.com.cn/download', content_type: 'file' }], 'file'),
        message_scene: { ext: ['msg_idx=file-index==', 'auth_token=private-secret'] },
      }
      await channel['handleDispatch'](event, initial)
      await channel['handleDispatch'](event, { ...initial, id: 'redelivered-id' })
      assert.equal(messages.length, 1)
      assert.equal(downloads, 1, 'same msg_idx is deduplicated even with a different delivery ID')
      const quoted = {
        ...payload(undefined, 'quote'), content: 'read this', message_type: 103,
        message_scene: { ext: ['msg_idx=quote-index', 'ref_msg_idx=file-index=='] },
      }
      const replyEvent = event === 'GROUP_MESSAGE_CREATE' ? 'GROUP_AT_MESSAGE_CREATE' : event
      await channel['handleDispatch'](replyEvent, quoted)
      assert.deepEqual(messages[1].media, messages[0].media)
      assert.equal(messages[1].platformMessageId, 'quote')
      assert.match(messages[1].content, /accepted message cache/)
      assert.doesNotMatch(messages[1].content, /private-secret/)
      assert.equal(downloads, 1)
      await channel['handleDispatch'](replyEvent, {
        ...quoted, id: 'other-conversation', group_openid: 'other-group',
        author: { member_openid: 'other-user', user_openid: 'other-user' },
      })
      assert.equal(messages[2].media, undefined)
      assert.match(messages[2].content, /no local record is available/)
      const other = new QQChannel(new Bus(), { appId: 'other-bot', secret: 'fixture', workspace })
      t.after(() => other.stop())
      const otherMessages = receiver(other)
      await other['handleDispatch'](replyEvent, quoted)
      assert.equal(otherMessages[0].media, undefined)
      assert.match(otherMessages[0].content, /no local record is available/)
      await channel.stop()
      assert.equal(channel['references'].get(messages[0].chatId, 'file-index=='), undefined)
    })
  })
}

test('QQ rejects admission without making the file available through its reference index', async t => {
  await withTempWorkspace(async workspace => {
    const channel = new QQChannel(new Bus(), { appId: 'fixture', secret: 'fixture', workspace })
    t.after(() => channel.stop())
    t.mock.method(globalThis, 'fetch', async () => new Response('file'))
    channel.setReceiver(async () => { throw new Error('rejected fixture') })
    await assert.rejects(channel['handleDispatch']('GROUP_MESSAGE_CREATE', {
      ...payload([{ filename: 'report.zip', url: 'https://multimedia.nt.qq.com.cn/file' }]),
      message_scene: { ext: ['msg_idx=rejected-file'] },
    }), /rejected fixture/)
    const messages = receiver(channel)
    await channel['handleDispatch']('GROUP_AT_MESSAGE_CREATE', {
      ...payload(undefined, 'quote'), content: 'read', message_scene: { ext: ['ref_msg_idx=rejected-file'] },
    })
    assert.equal(messages[0].media, undefined)
    assert.match(messages[0].content, /no local record is available/)
  })
})

test('QQ card-only group messages retain sender display and never turn platform owner into Shadow admin', async t => {
  await withTempWorkspace(async workspace => {
    const channel = new QQChannel(new Bus(), { appId: 'fixture', secret: 'fixture', workspace })
    t.after(() => channel.stop())
    const messages = receiver(channel)
    t.mock.method(globalThis, 'fetch', async () => assert.fail('card URLs are not attachment downloads'))
    await channel['handleDispatch']('GROUP_AT_MESSAGE_CREATE', {
      ...payload(undefined), message_type: 3,
      author: { member_openid: 'sender', username: 'Display name', member_role: 'owner' },
      ark_data: { ark_type: 'feed', fields: { title: 'Report', desc: 'A shared report', jump_url: 'https://example.test/report' } },
    })
    assert.equal(messages.length, 1)
    assert.equal(messages[0].senderName, 'Display name')
    assert.equal(messages[0].admin, false)
    assert.match(messages[0].content, /A shared report/)
    assert.equal(messages[0].media, undefined)
  })
})

for (const convertedAvailable of [true, false]) {
  test(`QQ speech preserves transcription and ${convertedAvailable ? 'downloads converted WAV' : 'falls back to original audio'}`, async t => {
    await withTempWorkspace(async workspace => {
      const channel = new QQChannel(new Bus(), { appId: 'fixture', secret: 'fixture', workspace })
      t.after(() => channel.stop())
      const messages = receiver(channel)
      const requests: string[] = []
      t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
        requests.push(String(input))
        return String(input).endsWith('/converted') && !convertedAvailable
          ? new Response('expired', { status: 403 }) : new Response('audio')
      })
      await channel['handleDispatch']('C2C_MESSAGE_CREATE', payload([{
        filename: 'speech.silk', content_type: 'voice', url: 'https://multimedia.nt.qq.com.cn/original',
        voice_wav_url: 'https://multimedia.nt.qq.com.cn/converted', asr_refer_text: 'Read this report',
        size: 5,
      }]))
      assert.match(messages[0].content, /Read this report/)
      assert.doesNotMatch(messages[0].content, /attachment unavailable/)
      assert.ok(messages[0].media![0].endsWith(convertedAvailable ? '.wav' : '.silk'))
      assert.equal(requests.length, convertedAvailable ? 1 : 2)
      assert.equal(await readFile(join(sessionWorkspacePath(workspace, 'qq:c2c:sender'), messages[0].media![0]), 'utf8'), 'audio')
    })
  })
}

test('QQ preserves successful files and exposes unavailable attachments without leaking signed URLs', async t => {
  await withTempWorkspace(async workspace => {
    const channel = new QQChannel(new Bus(), { appId: 'fixture', secret: 'fixture', workspace })
    t.after(() => channel.stop())
    const messages = receiver(channel)
    const warnings: unknown[][] = []
    t.mock.method(console, 'warn', (...args: unknown[]) => { warnings.push(args) })
    t.mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
      if (String(input).includes('/ok')) return new Response('ok')
      if (String(input).includes('/expired')) return new Response('private error', { status: 403 })
      throw new Error('network failure with signed-secret')
    })
    await channel['handleDispatch']('C2C_MESSAGE_CREATE', {
      ...payload([
        { filename: 'ok.txt', url: 'https://multimedia.nt.qq.com.cn/ok' },
        { url: 'https://multimedia.nt.qq.com.cn/expired?key=signed-secret' },
        { url: 'https://multimedia.nt.qq.com.cn/error?key=signed-secret' },
        null, { url: 42 }, { url: 'file:///private.txt' },
      ]),
      content: 'Please read',
    })
    assert.equal(messages[0].media?.length, 1)
    assert.equal(messages[0].content, ['Please read', ...Array(5).fill('[attachment unavailable: download failed]')].join('\n'))
    for (const [index, attachments] of [[{}], { url: 'invalid' }].entries()) {
      await channel['handleDispatch']('C2C_MESSAGE_CREATE', payload(attachments, `failed-${index}`))
      assert.equal(messages[index + 1].media, undefined)
      assert.match(messages[index + 1].content, /attachment unavailable:/)
    }
    assert.doesNotMatch(JSON.stringify({ warnings, messages }), /signed-secret|private error/)
  })
})

test('QQ rejects disallowed file senders before downloads or disk writes', async t => {
  await withTempWorkspace(async workspace => {
    const channel = new QQChannel(new Bus(), { appId: 'fixture', secret: 'fixture', workspace, allowFrom: ['allowed'] })
    t.after(() => channel.stop())
    const messages = receiver(channel)
    t.mock.method(globalThis, 'fetch', async () => assert.fail('unauthorized attachment download'))
    for (const source of sources) {
      await assert.rejects(channel['handleDispatch'](source.event,
        payload([{ url: 'https://multimedia.nt.qq.com.cn/file' }], source.event)), /not authorized/)
    }
    assert.equal(messages.length, 0)
    assert.deepEqual(await readdir(workspace), [])
  })
})

test('QQ diagnostics distinguish gateway delivery and attachment download without private payloads', async t => {
  await withTempWorkspace(async workspace => {
    const channel = new QQChannel(new Bus(), { appId: 'fixture', secret: 'fixture', workspace })
    t.after(() => channel.stop())
    receiver(channel)
    const logs: unknown[][] = []
    t.mock.method(console, 'info', (...args: unknown[]) => { logs.push(args) })
    t.mock.method(globalThis, 'fetch', async () => new Response('private file bytes'))
    await channel['handleDispatch']('GROUP_MESSAGE_CREATE', {
      ...payload([{ filename: 'private-file.txt', url: 'https://multimedia.nt.qq.com.cn/download?key=private-key' }]),
      content: 'private text', message_type: 0,
    })
    await channel['handleDispatch']('GROUP_AT_MESSAGE_CREATE', { ...payload(undefined, 'mention'), content: 'read' })
    const noScene = { hasArk: false, hasScene: false, hasMessageIndex: false, hasReferenceIndex: false, invalidScene: false, hasSceneAuthToken: false }
    assert.deepEqual(logs, [
      ['[qq] Gateway dispatch', { event: 'GROUP_MESSAGE_CREATE', messageType: 0, textLength: 12, attachments: 1, elements: 0, ...noScene }],
      ['[qq] Attachment reception', { received: 1, saved: 1, failed: 0 }],
      ['[qq] Gateway dispatch', { event: 'GROUP_AT_MESSAGE_CREATE', messageType: null, textLength: 4, attachments: 0, elements: 0, ...noScene }],
    ])
    assert.doesNotMatch(JSON.stringify(logs), /private|sender|https:/)
  })
})

test('QQ does not publish or save a download completed after the connection stops', async t => {
  await withTempWorkspace(async workspace => {
    const channel = new QQChannel(new Bus(), { appId: 'fixture', secret: 'fixture', workspace })
    t.after(() => channel.stop())
    const messages = receiver(channel)
    t.mock.method(globalThis, 'fetch', async () => {
      await channel.stop()
      return new Response('stale')
    })
    await assert.rejects(channel['handleDispatch']('C2C_MESSAGE_CREATE',
      payload([{ filename: 'stale.txt', url: 'https://multimedia.nt.qq.com.cn/file' }])), /connection has changed/)
    assert.deepEqual(messages, [])
    assert.deepEqual(await readdir(workspace), [])
  })
})
