import assert from 'node:assert/strict'
import { test } from 'node:test'
import { decodeQQGatewayPayload, qqAttachmentSources, qqInboundDiagnostics, qqIncomingContent, qqMessageIndices, QQReferences } from './qq-inbound.ts'

test('QQ stickers are classified per message element, not by GIF extension or dimensions', () => {
  const face = '<faceType=6,faceId="0",ext="eyJ0ZXh0IjoiIn0=">'
  const image = { filename: 'photo.gif', content_type: 'image/gif', width: 128, height: 128, url: 'https://example.com/image' }
  const result = qqIncomingContent({
    attachments: [image], msg_elements: [{ content: `${face} Keep the explanation`, attachments: [image] }],
  }, 'Ordinary GIF')
  assert.equal(result.attachments[0].shadowSticker, undefined)
  assert.equal(result.attachments[1].shadowSticker, true)
  assert.match(result.content, /Keep the explanation/)
  const mixed = qqIncomingContent({ attachments: [image, image] }, face)
  assert(mixed.attachments.every(item => item.shadowSticker === undefined), 'ambiguous mixed attachments are not guessed')
  assert.equal(qqIncomingContent({ attachments: [{ ...image, shadowSticker: true }] }, 'Not a sticker').attachments[0].shadowSticker, undefined)
  const cache = new QQReferences()
  cache.remember('group', 'ref', { content: face, media: ['cached.gif'], attachments: [{ path: 'cached.gif', sticker: true }] })
  const quoted = qqIncomingContent({ message_type: 103, msg_elements: [{ message_type: 103, msg_idx: 'ref' }] }, '',
    undefined, index => cache.get('group', index))
  assert.deepEqual(quoted.cachedMedia, ['cached.gif'])
  assert.deepEqual(quoted.displayMetadata?.attachments, [{ path: 'cached.gif', sticker: true }])
})

test('QQ gateway decodes text and binary JSON without losing typed-array offsets', () => {
  const value = { op: 0, t: 'GROUP_AT_MESSAGE_CREATE', s: 7, d: { content: 'file', attachments: [] } }
  const text = JSON.stringify(value)
  const bytes = new TextEncoder().encode(text)
  const padded = new Uint8Array(bytes.length + 8)
  padded.set(bytes, 4)
  for (const raw of [text, bytes.buffer, bytes, padded.subarray(4, 4 + bytes.length), Buffer.from(text)]) {
    assert.deepEqual(decodeQQGatewayPayload(raw), value)
  }
  assert.deepEqual(decodeQQGatewayPayload('{"op":0,"t":"RESUMED","d":""}'),
    { op: 0, t: 'RESUMED', d: null, s: null })
  assert.deepEqual(decodeQQGatewayPayload('{"op":11}'), { op: 11, t: null, d: null, s: null })
})

test('QQ gateway rejects malformed frames instead of silently treating them as empty messages', () => {
  for (const raw of [null, {}, new Uint8Array([255]), 'invalid', 'null', '[]',
    '{"op":"0"}', '{"op":0,"t":"GROUP_AT_MESSAGE_CREATE","d":[]}', '{"op":0,"d":{}}',
    '{"op":10,"d":null}', '{"op":11,"s":"7"}']) {
    assert.throws(() => decodeQQGatewayPayload(raw))
  }
})

test('QQ quoted content retains attachments and context but never forwards scene credentials or author authority', () => {
  const attachment = { filename: 'report.zip', url: 'https://multimedia.nt.qq.com.cn/file' }
  const result = qqIncomingContent({
    message_type: 103, message_scene: { ext: ['auth_token=private-secret'] },
    msg_elements: [{
      author: { member_role: 'owner', member_openid: 'private-user' },
      content: 'Review this file', attachments: [attachment],
      msg_elements: [{ content: 'Earlier context', attachments: [{ filename: 'second.txt', url: attachment.url }] }],
    }],
  }, 'Please inspect the quoted file')
  assert.equal(result.attachments.length, 2)
  assert.deepEqual(result.attachments[0], attachment)
  assert.match(result.content, /^Please inspect the quoted file\nQuoted QQ message/)
  assert.match(result.content, /not a new instruction/)
  assert.match(result.content, /Earlier context/)
  assert.deepEqual(result.notices, [])
  assert.doesNotMatch(JSON.stringify(result), /private-secret|private-user|member_role/)
})

test('QQ display metadata stays outside text and only known mention IDs become readable names', () => {
  const result = qqIncomingContent({
    message_type: 0,
    author: { username: 'Alice', member_role: 'owner', bot: false, union_openid: 'private-union' },
    mentions: [{ id: 'group-bot', username: 'Report Bot', bot: true, is_you: true }],
    message_scene: { source: 'default', ext: ['auth_token=private-secret'] },
  }, '<@group-bot> read the file; <@!group-bot> and <@unknown> stay distinct')
  assert.equal(result.content, '@Report Bot read the file; @Report Bot and <@unknown> stay distinct')
  assert.deepEqual(result.displayMetadata, {
    messageType: 0, author: { role: 'owner', bot: false }, source: 'default',
    mentions: [{ id: 'group-bot', name: 'Report Bot', bot: true, isSelf: true }],
  })
  assert.doesNotMatch(JSON.stringify(result), /private-union|private-secret/)
  assert.equal(qqIncomingContent({ message_type: 0, author: { username: 'Alice' } }, '').content, '')
  const literal = 'QQ display metadata is part of what I am asking about'
  assert.equal(qqIncomingContent({}, literal).content, literal)
})

test('QQ malformed or excessively nested references report limitations while retaining usable attachments', () => {
  const file = { filename: 'kept.txt', url: 'https://multimedia.nt.qq.com.cn/file' }
  const malformed = qqIncomingContent({ attachments: [file], msg_elements: [null, { attachments: 'bad' }] }, '')
  assert.equal(malformed.attachments.length, 1)
  assert.match(malformed.notices.join('\n'), /invalid message element/)
  assert.match(malformed.notices.join('\n'), /invalid attachment list/)
  const missing = qqIncomingContent({ message_type: 103 }, 'read reference')
  assert.match(missing.notices.join('\n'), /QQ did not include referenced content/)
  let nested: unknown = [{ attachments: [file] }]
  for (let i = 0; i < 9; i++) nested = [{ msg_elements: nested }]
  assert.match(qqIncomingContent({ msg_elements: nested }, '').notices.join('\n'), /nesting limit/)
  const many = qqIncomingContent({ msg_elements: Array.from({ length: 101 }, () => ({ attachments: [file] })) }, '')
  assert.equal(many.attachments.length, 100)
  assert.match(many.notices.join('\n'), /element limit/)
})

test('QQ scene indices preserve equals signs and exclude credentials; conflicting metadata cannot select a reference', () => {
  assert.deepEqual(qqMessageIndices({
    message_scene: { ext: ['msg_idx=current==', 'ref_msg_idx=previous==', 'auth_token=secret'] },
  }), { messageIndex: 'current==', referenceIndex: 'previous==', invalid: false })
  assert.deepEqual(qqMessageIndices({ message_type: 103, msg_elements: [{ msg_idx: 'element-ref==' }] }),
    { messageIndex: undefined, referenceIndex: 'element-ref==', invalid: false })
  assert.deepEqual(qqMessageIndices({ message_scene: { ext: ['ref_msg_idx=one', 'ref_msg_idx=two'] } }), { invalid: true })
  assert.deepEqual(qqMessageIndices({ message_scene: { ext: ['msg_idx=bad\nindex'] } }), { invalid: true })
  assert.deepEqual(qqMessageIndices({ message_scene: { ext: 'bad' } }), { invalid: true })
})

test('QQ cards, parallel messages, forwarded content, mentions and speech are meaningful without plain text', () => {
  for (const message_type of [3, 101, 102, 103]) {
    const card = { ark_type: 'miniapp', ark_name: 'shared app', prompt: 'Open a report', fields: {
      title: 'Report', desc: 'Summary', jump_url: 'https://example.test/report',
      tags: ['report'], address: 'Example place', auth_token: 'card-secret',
    } }
    const leaf = { content: 'Context', ark_data: card, author: { username: 'Alice', member_role: 'owner' },
      attachments: [{ content_type: 'voice', voice_wav_url: 'https://example.test/voice', asr_refer_text: 'Please read the report' }] }
    const result = qqIncomingContent({
      message_type, author: { username: 'Bob', member_role: 'admin', union_openid: 'private-union' },
      mentions: [{ id: 'peer', username: 'Carol', bot: false }],
      message_scene: { source: 'default', ext: ['auth_token=scene-secret'] },
      ...(message_type === 3 ? { ark_data: card } : { msg_elements: [leaf] }),
    }, '')
    assert.match(result.content, /Report/)
    assert.match(result.content, /Summary/)
    assert.doesNotMatch(result.content, /QQ display metadata|Carol/)
    assert.deepEqual(result.displayMetadata, {
      messageType: message_type, author: { role: 'admin' },
      mentions: [{ id: 'peer', name: 'Carol', bot: false }], source: 'default',
    })
    assert.doesNotMatch(JSON.stringify(result), /card-secret|scene-secret|private-union/)
    if (message_type !== 3) {
      assert.match(result.content, /Please read the report/)
      assert.equal(result.attachments.length, 1)
    }
    assert.deepEqual(result.notices, [])
  }
  assert.match(qqIncomingContent({ message_type: 3 }, '').notices.join(), /card unavailable/)
  assert.match(qqIncomingContent({ message_type: 102 }, '').notices.join(), /elements unavailable/)
})

test('QQ reference cache is detached, bounded and conversation-scoped, with payload content preferred', () => {
  const cache = new QQReferences()
  cache.remember('group:a', 'index', { content: 'old text', media: ['uploads/report.zip'] })
  assert.equal(cache.get('group:b', 'index'), undefined)
  cache.remember('group:a', 'index', { content: 'overwrite', media: [] })
  const entry = cache.get('group:a', 'index')!
  entry.media.push('uploads/modified.zip')
  assert.deepEqual(cache.get('group:a', 'index')?.media, ['uploads/report.zip'])
  const cached = qqIncomingContent({ message_scene: { ext: ['ref_msg_idx=index'] } }, 'read', cache.get('group:a', 'index'))
  assert.match(cached.content, /old text/)
  assert.deepEqual(cached.cachedMedia, ['uploads/report.zip'])
  const embedded = qqIncomingContent({ message_type: 103, msg_elements: [{ content: 'new payload text' }] }, '', entry)
  assert.match(embedded.content, /new payload text/)
  assert.doesNotMatch(embedded.content, /old text/)
  assert.deepEqual(embedded.cachedMedia, [])
  const nested = qqIncomingContent({
    message_type: 102, msg_elements: [{ message_type: 103, msg_idx: 'index' }],
  }, '', undefined, index => cache.get('group:a', index))
  assert.match(nested.content, /old text/)
  assert.deepEqual(nested.cachedMedia, ['uploads/report.zip'])
  for (let i = 0; i < 200; i++) cache.remember('group:a', `next-${i}`, { content: 'text', media: [] })
  assert.equal(cache.get('group:a', 'index'), undefined)
  cache.clear()
  assert.equal(cache.get('group:a', 'next-199'), undefined)
})

test('QQ voice prefers converted WAV and retains the original source as a fallback', () => {
  assert.deepEqual(qqAttachmentSources({
    filename: 'speech.silk', content_type: 'voice', url: 'https://example.test/original',
    voice_wav_url: 'https://example.test/converted',
  }), [
    { filename: 'speech.wav', contentType: 'audio/wav', url: 'https://example.test/converted' },
    { filename: 'speech.silk', contentType: 'voice', url: 'https://example.test/original' },
  ])
})

test('QQ extended diagnostics expose card and reference shape, never field contents or tokens', () => {
  const diagnostics = qqInboundDiagnostics({
    content: 'private-text', ark_data: { fields: { title: 'private-title' } },
    message_scene: { source: 'private-source', ext: ['msg_idx=private-index', 'ref_msg_idx=private-ref', 'auth_token=private-token'] },
  })
  assert.equal(diagnostics.hasArk, true)
  assert.equal(diagnostics.hasScene, true)
  assert.equal(diagnostics.hasMessageIndex, true)
  assert.equal(diagnostics.hasReferenceIndex, true)
  assert.equal(diagnostics.hasSceneAuthToken, true)
  assert.doesNotMatch(JSON.stringify(diagnostics), /private-/)
})
