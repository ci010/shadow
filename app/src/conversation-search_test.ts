import assert from 'node:assert/strict'
import test from 'node:test'
import { conversationMatches, isConversationFindKey, loadConversationSearchHistory, textMatches } from './conversation-search.ts'

test('conversation search is literal, case insensitive and preserves Unicode offsets', () => {
  assert.deepEqual(textMatches('Hello HELLO hello', 'hello'), [{ start: 0, end: 5 }, { start: 6, end: 11 }, { start: 12, end: 17 }])
  assert.deepEqual(textMatches('中文搜索：历史消息，历史消息', '历史消息'), [{ start: 5, end: 9 }, { start: 10, end: 14 }])
  assert.deepEqual(textMatches('a.*[b] a123b', '.*[b]'), [{ start: 1, end: 6 }])
  assert.deepEqual(textMatches('😀 first 😀', '😀'), [{ start: 0, end: 2 }, { start: 9, end: 11 }])
  assert.deepEqual(textMatches(' \n ', ' '), [])
  const entries = [
    { segmentId: 'old', messageIndex: 3, blocks: ['one needle', 'needle two'] },
    { segmentId: null, messageIndex: 1, blocks: ['NEEDLE'] },
  ]
  assert.deepEqual(conversationMatches(entries, 'needle').map(match => [match.entry.segmentId, match.entry.messageIndex, match.blockIndex, match.start]),
    [['old', 3, 0, 4], ['old', 3, 1, 0], [null, 1, 0, 0]])
  assert.equal(conversationMatches([{ segmentId: null, messageIndex: 0, blocks: ['first', 'second'] }], 'firstsecond').length, 0)
})

test('find shortcut supports Ctrl and Cmd but respects IME and other shortcuts', () => {
  const event = { key: 'f', ctrlKey: true, metaKey: false, altKey: false, shiftKey: false, isComposing: false, keyCode: 70 }
  assert.equal(isConversationFindKey(event), true)
  assert.equal(isConversationFindKey({ ...event, key: 'F', ctrlKey: false, metaKey: true }), true)
  for (const patch of [{ ctrlKey: false }, { altKey: true }, { shiftKey: true }, { isComposing: true }, { keyCode: 229 }, { key: 'e' }]) {
    assert.equal(isConversationFindKey({ ...event, ...patch }), false)
  }
})

test('full-history search follows every physical segment within the owning Project', async t => {
  const urls: URL[] = []
  t.mock.method(globalThis, 'fetch', async (url: URL) => {
    urls.push(url)
    const previous = urls.length === 1 ? 'physical:one' : urls.length === 2 ? 'physical:zero' : null
    return Response.json({ messages: [{ role: 'user', content: `History ${urls.length}` }], previousPhysicalId: previous })
  })
  const segments = await loadConversationSearchHistory('http://localhost/projects/a/', 'web:chat', new AbortController().signal)
  assert.deepEqual(segments.map(segment => segment.id), ['physical:zero', 'physical:one', null])
  assert.deepEqual(urls.map(url => decodeURIComponent(url.pathname)), [
    '/projects/a/api/sessions/web:chat', '/projects/a/api/sessions/physical:one', '/projects/a/api/sessions/physical:zero',
  ])
  assert(urls.every(url => url.searchParams.get('shallow') === 'true' && !url.searchParams.has('pageSize')))
})

test('search does not silently report partial history on an invalid response, failed segment or cycle', async t => {
  for (const [data, pattern] of [
    [{ messages: 'invalid', previousPhysicalId: null }, /Invalid conversation search history/],
    [{ messages: [], previousPhysicalId: 'web:chat' }, /segment cycle/],
  ] as const) {
    t.mock.method(globalThis, 'fetch', async () => Response.json(data))
    await assert.rejects(loadConversationSearchHistory('http://localhost', 'web:chat', new AbortController().signal), pattern)
  }
  let calls = 0
  t.mock.method(globalThis, 'fetch', async () => ++calls === 1
    ? Response.json({ messages: [], previousPhysicalId: 'older' })
    : Response.json({ error: 'failure' }, { status: 503 }))
  await assert.rejects(loadConversationSearchHistory('http://localhost', 'web:chat', new AbortController().signal), /503.*Retry search/)
})

test('closing search aborts history loading without reading more segments', async t => {
  const controller = new AbortController()
  let calls = 0
  t.mock.method(globalThis, 'fetch', async (_url: URL, options: RequestInit) => {
    calls++
    controller.abort()
    assert.equal(options.signal?.aborted, true)
    return Response.json({ messages: [], previousPhysicalId: 'older' })
  })
  await assert.rejects(loadConversationSearchHistory('http://localhost', 'web:chat', controller.signal), { name: 'AbortError' })
  assert.equal(calls, 1)
})
