import assert from 'node:assert/strict'
import { test } from 'node:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Bus } from '../bus/bus.ts'
import { WeChatChannel } from './wechat.ts'
import { WeixinApiClient } from './wechat/sdk.ts'

test('send diagnostics classify responses without echoing remote data; read once, never retry', async () => {
  const fetch = globalThis.fetch
  const info = console.info
  const logs: string[] = []
  console.info = (...args) => { logs.push(args.join(' ')) }
  const api = new WeixinApiClient()
  try {
    for (const [body, expected, reason] of [
      ['', { structure: 'empty' }, 'malformed_response'],
      [' \n', { structure: 'empty' }, 'malformed_response'],
      ['secret', { structure: 'non_json' }, 'malformed_response'],
      ['null', { structure: 'null' }, 'malformed_response'],
      ['[]', { structure: 'array' }, 'malformed_response'],
      ['"secret"', { structure: 'string' }, 'malformed_response'],
      ['true', { structure: 'boolean' }, 'malformed_response'],
      ['17', { structure: 'number' }, 'malformed_response'],
      ['{"secret":"secret"}', { malformed: 'missing_codes', retPresent: false, errcodePresent: false }, 'malformed_response'],
      ['{"ret":"secret"}', { malformed: 'invalid_code', retType: 'string', retValid: false }, 'malformed_response'],
      ['{"ret":0,"errcode":null}', { ret: 0, errcodeType: 'null', errcodeValid: false }, 'malformed_response'],
      ['{"ret":1e100}', { retType: 'number', retValid: false }, 'malformed_response'],
      ['{"ret":-1,"errmsg":"secret"}', { ret: -1 }, 'business_rejected'],
      ['{"ret":0,"errcode":0,"secret":"secret"}', { ret: 0, errcode: 0 }, null],
      ['{"errcode":0}', { retPresent: false, errcode: 0 }, null],
    ] as const) {
      logs.length = 0
      let calls = 0; let reads = 0
      globalThis.fetch = async () => {
        calls++
        const res = new Response(body, { headers: { 'content-type': 'application/json; secret=secret' } })
        const text = res.text.bind(res)
        res.text = () => { reads++; return text() }
        return res
      }
      const result = api.sendMessage('https://secret', 'secret', { msg: { to_user_id: 'secret', context_token: 'secret' } })
      if (reason) await assert.rejects(result)
      else await result
      assert.equal(calls, 1); assert.equal(reads, 1)
      const entries = logs.map(line => JSON.parse(line.slice(line.indexOf('{'))))
      assert.equal(entries.length, 2)
      assert.equal(entries[0].event, 'start')
      assert.equal(entries[1].event, reason ? 'failed' : 'api_accepted')
      assert.equal(entries[1].reason, reason ?? undefined)
      assert.equal(entries[1].status, 200)
      assert.equal(entries[1].contentType, 'application/json')
      for (const [key, value] of Object.entries(expected)) assert.equal(entries[1][key], value)
      assert.equal(entries[0].attemptId, entries[1].attemptId)
      assert.ok(entries[1].elapsedMs >= 0)
      assert.doesNotMatch(logs.join(''), /secret|errmsg|https/)
    }
    for (const kind of ['http', 'transport', 'read'] as const) {
      logs.length = 0
      globalThis.fetch = async () => {
        if (kind === 'transport') throw new Error('secret')
        const res = new Response('secret', { status: kind === 'http' ? 403 : 200, headers: { 'content-type': 'secret/secret' } })
        res.text = async () => { if (kind === 'http') assert.fail('must not read rejected HTTP body'); throw new Error('secret') }
        return res
      }
      await assert.rejects(api.sendMessage('https://secret', 'secret', { msg: {} }))
      const end = JSON.parse(logs.at(-1)!.slice(logs.at(-1)!.indexOf('{')))
      assert.equal(end.reason, kind === 'http' ? 'http_rejected' : kind === 'transport' ? 'transport_unknown' : 'malformed_response')
      if (kind === 'read') assert.equal(end.structure, 'unreadable')
      if (kind !== 'transport') assert.equal(end.contentType, 'other')
      assert.doesNotMatch(logs.join(''), /secret|https/)
    }
  } finally { globalThis.fetch = fetch; console.info = info }
})

test('reply IDs correlate media/text attempts and decision failures without user or token data', async () => {
  const root = mkdtempSync(join(process.cwd(), '.wechat-diagnostics-'))
  const info = console.info; const fetch = globalThis.fetch; const logs: string[] = []
  console.info = (...args) => { logs.push(args.join(' ')) }
  const channel = new WeChatChannel(new Bus(), { workspace: root, storageDirectory: root, scoped: true })
  try {
    const repo = channel['repository']
    repo.saveAccount({ accountId: 'secret', botToken: 'secret', baseUrl: 'https://secret', savedAt: 'secret' })
    repo.saveContextToken('secret', 'secret')
    const image = join(root, 'image'); writeFileSync(image, new Uint8Array([1, 2]))
    let calls = 0
    globalThis.fetch = async () => { calls++; return new Response('{"ret":0}') }
    await channel.send({ channel: 'wechat', chatId: 'secret', event: 'response', done: true, content: 'secret', media: [image] })
    assert.equal(calls, 2)
    const entries = logs.map(line => JSON.parse(line.slice(line.indexOf('{'))))
    assert.equal(new Set(entries.map(e => e.replyId)).size, 1)
    const attempts = entries.filter(e => e.event === 'start' && e.attemptId)
    assert.deepEqual(attempts.map(e => e.part), [1, 2])
    assert.equal(new Set(attempts.map(e => e.attemptId)).size, 2)
    assert.equal(entries.at(-1).partsAttempted, 2)
    assert.ok(entries.find(e => e.event === 'preflight').contextTokenAgeMs >= 0)
    assert.doesNotMatch(logs.join(''), /secret|https/)
    logs.length = 0
    await assert.rejects(channel.presentDecisionText('other-secret', 'secret'))
    const end = JSON.parse(logs.at(-1)!.slice(logs.at(-1)!.indexOf('{')))
    assert.equal(end.reason, 'missing_context_token')
    assert.equal(calls, 2)
    assert.doesNotMatch(logs.join(''), /secret|https/)
  } finally { await channel.stop(); console.info = info; globalThis.fetch = fetch; rmSync(root, { recursive: true, force: true }) }
})
