import test from 'node:test'
import assert from 'node:assert/strict'
import { createSessionSummaryLoader, parseSessionSummary } from './session-summary-snapshot.ts'

test('logical summaries preserve fork, delegation, channel defaults and bounded composer overrides', () => {
  const rows = parseSessionSummary({ sessions: [
    { sessionId: 'task:child', mode: 'task', parentSessionId: 'web:root', executionStatus: 'running', description: 'Working' },
    { sessionId: 'web:root', mode: 'session', parentSessionId: null, inferenceOverrides: { model: 'selected', contextWindow: 123 }, inferenceDefaults: { model: 'default' } },
    { sessionId: 'web:fork', mode: 'session', parentSessionId: null, contextParentSessionId: 'web:root' },
  ] }, 'a')
  assert.equal(rows.find(row => row.sessionId === 'task:child')?.parentSessionId, 'web:root')
  assert.equal(rows.find(row => row.sessionId === 'task:child')?.depth, 1)
  assert.equal(rows.find(row => row.sessionId === 'web:fork')?.contextParentSessionId, 'web:root')
  assert.equal(rows.find(row => row.sessionId === 'web:root')?.config?.model, 'selected')
  assert.equal(rows.find(row => row.sessionId === 'web:root')?.inferenceDefaults?.model, 'default')
  // System automation names were graph title fallbacks, never overrides of a
  // nonempty semantic topic in sessionDisplayTitle. Lean DTO preserves that.
  const legacy = parseSessionSummary({ sessions: [{ sessionId: 'run', topic: 'Saved topic', name: 'Old name', title: 'System automation' }] }, 'a')
  const lean = parseSessionSummary({ sessions: [{ sessionId: 'run', topic: 'Saved topic' }] }, 'a')
  assert.equal(legacy[0]!.title, lean[0]!.title)
  assert.equal(lean[0]!.title, 'Saved topic')
  assert.throws(() => parseSessionSummary({ sessions: [{ sessionId: 'web:bad', projectId: null }] }, 'a'))
  assert.throws(() => parseSessionSummary({ sessions: [{ sessionId: 'web:bad', projectId: 'b' }] }, 'a'))
  assert.throws(() => parseSessionSummary({ sessions: [{ sessionId: 'web:bad', contextParentSessionId: 12 }] }))
})

test('summary reader revalidates without requesting a physical graph and ignores aborted responses', async () => {
  let calls = 0
  const loader = createSessionSummaryLoader('http://main/projects/a', 'a', async (input, init) => {
    assert.equal(new URL(String(input)).pathname, '/projects/a/api/sessions/summary')
    calls++
    if (calls === 2) {
      assert.equal(new Headers(init?.headers).get('If-None-Match'), '"one"')
      return new Response(null, { status: 304 })
    }
    return Response.json({ sessions: [{ sessionId: 'web:one', title: 'One' }] }, { headers: { ETag: '"one"' } })
  })
  const first = await loader.load(new AbortController().signal)
  assert.equal(await loader.load(new AbortController().signal), first)
  const aborted = new AbortController(); aborted.abort()
  await assert.rejects(loader.load(aborted.signal))
})

test('delta rejects mismatched bases without poisoning the validated snapshot; full snapshots still work', async () => {
  let calls = 0
  const loader = createSessionSummaryLoader('http://main/a', 'a', async (_input, init) => {
    calls++
    const headers = new Headers(init?.headers)
    assert.equal(headers.get('Accept'), 'application/vnd.shadow.session-summary-delta+json')
    if (calls === 1) return Response.json({ sessions: [{ sessionId: 'one' }] }, { headers: { ETag: '"one"' } })
    assert.equal(headers.get('If-None-Match'), '"one"')
    if (calls === 2) return Response.json({ delta: 1, base: '"wrong"', upsert: [], removed: [], order: [] }, { headers: { ETag: '"bad"' } })
    return Response.json({ sessions: [{ sessionId: 'two' }] })
  })
  await loader.load(new AbortController().signal)
  await assert.rejects(loader.load(new AbortController().signal), /Invalid session summary delta/)
  assert.equal((await loader.load(new AbortController().signal))[0]!.sessionId, 'two')
})

test('concurrent summary requests apply patches to their captured base, never a later response', async () => {
  let calls = 0
  let finish: (value: Response) => void = () => {}
  const loader = createSessionSummaryLoader('http://main/a', 'a', async () => {
    calls++
    if (calls === 1) return Response.json({ sessions: [{ sessionId: 'one' }] }, { headers: { ETag: '"one"' } })
    if (calls === 2) return new Promise<Response>(resolve => { finish = resolve })
    if (calls === 3) return Response.json({ delta: 1, base: '"one"', upsert: [{ sessionId: 'two' }], removed: ['one'] }, { headers: { ETag: '"two"' } })
    return new Response(null, { status: 304 })
  })
  const load = () => loader.load(new AbortController().signal)
  await load()
  const delayed = load()
  assert.equal((await load())[0]!.sessionId, 'two')
  finish(Response.json({ delta: 1, base: '"one"', upsert: [{ sessionId: 'three' }], removed: ['one'] }, { headers: { ETag: '"three"' } }))
  assert.equal((await delayed)[0]!.sessionId, 'three')
  assert.equal((await load())[0]!.sessionId, 'two')
})


test('set patches reject malformed IDs and old order protocol without poisoning the base', async () => {
  let patch: unknown
  const loader = createSessionSummaryLoader('http://main/a', 'a', async () => patch
    ? Response.json(patch, { headers: { ETag: '"next"' } })
    : Response.json({ sessions: [{ sessionId: 'b', title: 'Old' }, { sessionId: 'a' }] }, { headers: { ETag: '"base"' } }))
  const load = () => loader.load(new AbortController().signal)
  await load()
  const delta = { delta: 1, base: '"base"', upsert: [], removed: [] }
  for (const invalid of [
    { delta: 2 }, { base: '"wrong"' }, { order: null }, { order: ['a', 'b'] },
    { removed: ['missing'] }, { removed: ['a', 'a'] }, { removed: [''] },
    { removed: ['a'], upsert: [{ sessionId: 'a' }] },
    { upsert: [{ sessionId: 'a' }, { sessionId: 'a' }] }, { upsert: [{ sessionId: ' ' }] },
    { removed: [1] }, { upsert: [null] }, { upsert: {} },
  ]) {
    patch = { ...delta, ...invalid }
    await assert.rejects(load(), /Invalid session summary delta/)
  }
  patch = { ...delta, upsert: [{ sessionId: 'b' }, { sessionId: 'c' }], removed: ['a'] }
  const rows = await load()
  assert.deepEqual(rows.map(row => row.sessionId), ['b', 'c'])
  assert.notEqual(rows[0]!.title, 'Old', 'upsert replaces rather than merges fields')
})

test('full summaries deterministically order roots, siblings, ties, missing dates and cycles', () => {
  const sessions = [
    { sessionId: 'parent', lastActivityAt: '2026-01-02' },
    { sessionId: 'child-b', mode: 'task', parentSessionId: 'parent', lastActivityAt: '2026-01-03' },
    { sessionId: 'child-a', mode: 'call', parentSessionId: 'parent', lastActivityAt: '2026-01-03' },
    { sessionId: 'new', lastActivityAt: '2026-01-04' },
    { sessionId: 'absent' }, { sessionId: 'invalid', lastActivityAt: 'bad' },
    { sessionId: 'cycle-b', mode: 'task', parentSessionId: 'cycle-a' },
    { sessionId: 'cycle-a', mode: 'task', parentSessionId: 'cycle-b' },
  ]
  const expected = parseSessionSummary({ sessions })
  assert.deepEqual(expected.map(s => [s.sessionId, s.depth]), [
    ['new', 0], ['parent', 0], ['child-a', 1], ['child-b', 1], ['absent', 0], ['invalid', 0], ['cycle-a', 0], ['cycle-b', 1],
  ])
  for (let i = 0; i < sessions.length; i++) {
    assert.deepEqual(parseSessionSummary({ sessions: [...sessions.slice(i), ...sessions.slice(0, i)].reverse() }), expected)
  }
})

test('delta recency, deletion, recreation and relation changes rebuild the tree from fields', async () => {
  let body: unknown = { sessions: [
    { sessionId: 'child', mode: 'task', parentSessionId: 'parent', lastActivityAt: '2026-01-03' },
    { sessionId: 'other', lastActivityAt: '2026-01-01' }, { sessionId: 'parent', lastActivityAt: '2026-01-02' },
  ] }
  let revision = 0
  const loader = createSessionSummaryLoader('http://main/a', 'a', async () => Response.json(body, { headers: { ETag: `"${revision++}"` } }))
  const load = () => loader.load(new AbortController().signal)
  assert.deepEqual((await load()).map(s => s.sessionId), ['parent', 'child', 'other'])
  body = { delta: 1, base: '"0"', upsert: [], removed: ['parent'] }
  assert.deepEqual((await load()).map(s => [s.sessionId, s.depth]), [['child', 0], ['other', 0]])
  body = { delta: 1, base: '"1"', upsert: [{ sessionId: 'parent' }], removed: [] }
  assert.deepEqual((await load()).map(s => [s.sessionId, s.depth]), [['other', 0], ['parent', 0], ['child', 1]])
  body = { delta: 1, base: '"2"', upsert: [{ sessionId: 'child', mode: 'session', parentSessionId: null, lastActivityAt: '2026-01-04' }], removed: [] }
  assert.deepEqual((await load()).map(s => [s.sessionId, s.depth]), [['child', 0], ['other', 0], ['parent', 0]])
})

test('summary set normalization stabilizes bot/automation/Discord groups and service first-match without changing ownership', async () => {
  const { groupFolderSessions, sortSidebarChats } = await import('./folders-sidebar.ts')
  const { groupBotConversations } = await import('./bot-sidebar.ts')
  const { projectGroupConversations } = await import('./service-groups.ts')
  const { discordChannelPosts, discordParentKey } = await import('./discord-navigation.ts')
  const { searchQuickOpenSessions } = await import('./session-quick-open.ts')
  const { filterReferenceSessions } = await import('./session-references.ts')
  const qq = 'bot:a:qq:qq:group', inbox = 'channel-inbox:a:qq:qq:group'
  const sessions = [
    { sessionId: qq, lastActivityAt: '2026-01-01' },
    { sessionId: inbox, lastActivityAt: '2026-01-03', channelSource: { version: 1, projectId: 'a', botInstanceId: 'qq', platform: 'qq', conversationId: 'group', kind: 'group' } },
    { sessionId: 'bot:a:discord:discord:300', discordChannel: { id: '300', name: 'Old', type: 11, guildId: '200', parentId: '100', parentName: 'Forum old' } },
    { sessionId: 'channel-inbox:a:discord:discord:300', lastActivityAt: '2026-01-04', channelSource: { version: 1, projectId: 'a', botInstanceId: 'discord', platform: 'discord', conversationId: '300', kind: 'thread', parentId: '100', guildId: '200', botUserId: '999' }, discordChannel: { id: '300', name: 'New', type: 11, guildId: '200', parentId: '100', parentName: 'Forum new' } },
    { sessionId: 'web:chat-run', automation: { contextMode: 'fresh', jobId: 'job', name: 'Job', runId: 'run', startedAt: '2026-01-01' } },
    { sessionId: 'task:child', mode: 'task', parentSessionId: 'web:chat-run' },
    { sessionId: 'web:chat-regular', title: 'Regular', lastActivityAt: '2026-01-02' },
    { sessionId: 'web:chat-other', title: 'Other', folderId: 'f' },
  ]
  const project = (input: typeof sessions) => {
    const parsed = parseSessionSummary({ sessions: input }, 'a')
    const observed = projectGroupConversations(parsed, [{ botInstanceId: 'qq', platform: 'qq', conversationId: 'group',
      botName: 'QQ', enabled: false, pending: true, lastSeen: 1, messages: [] }], 'a')
    const folders = groupFolderSessions([], observed)
    const bots = groupBotConversations(folders.unified, 'a')
    return { folders, bots, selected: observed.find(s => s.groupObservation)?.sessionId,
      posts: discordChannelPosts(parsed, discordParentKey(parsed.find(s => s.discordChannel)!)!),
      quick: searchQuickOpenSessions(parsed.map(s => ({ ...s, projectId: 'a' })), '', ['a']),
      references: filterReferenceSessions(parsed, '', ''),
      chats: sortSidebarChats(parsed, new Map([['f', 'Folder']]), 'folder'),
    }
  }
  const expected = project(sessions)
  assert.equal(expected.selected, inbox, 'same scoped-address predicate selects client-most-recent match')
  assert.deepEqual(expected.folders.automations[0]!.sessions.map(s => s.sessionId), ['web:chat-run', 'task:child'])
  assert.equal(expected.bots.bots.length, 2)
  assert.equal(expected.posts.length, 1)
  assert.deepEqual(new Set(expected.posts[0]!.histories.map(s => s.sessionId)), new Set(sessions.filter(s => s.discordChannel).map(s => s.sessionId)))
  for (let i = 0; i < sessions.length; i++) {
    assert.deepEqual(project([...sessions.slice(i), ...sessions.slice(0, i)].reverse()), expected)
  }
})

test('permuted full baselines and multi-row patches yield the identical final set projection', async () => {
  const before = [{ sessionId: 'a' }, { sessionId: 'b' }, { sessionId: 'c' }]
  const upsert = [{ sessionId: 'parent', lastActivityAt: '2026-01-01' },
    { sessionId: 'a', mode: 'task', parentSessionId: 'parent', lastActivityAt: '2026-01-02' },
    { sessionId: 'new', lastActivityAt: '2026-01-03' }]
  const expected = parseSessionSummary({ sessions: upsert }, 'a')
  for (const reverseBase of [false, true]) for (const reversePatch of [false, true]) {
    let calls = 0
    const loader = createSessionSummaryLoader('http://main/a', 'a', async () => ++calls === 1
      ? Response.json({ sessions: reverseBase ? [...before].reverse() : before }, { headers: { ETag: '"base"' } })
      : Response.json({ delta: 1, base: '"base"', upsert: reversePatch ? [...upsert].reverse() : upsert,
        removed: reversePatch ? ['c', 'b'] : ['b', 'c'] }))
    await loader.load(new AbortController().signal)
    assert.deepEqual(await loader.load(new AbortController().signal), expected)
  }
})
