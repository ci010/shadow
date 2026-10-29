import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { groupFolderSessions, parseSessionGraph, restoreChatListPreferences, saveChatListPreferences, sortSidebarChats } from './folders-sidebar.ts'

const folders = [{ id: 'a', name: 'Alpha', path: '/alpha', createdAt: '2026-01-01T00:00:00Z' }, { id: 'b', name: 'Beta', path: '/beta', createdAt: '2026-01-01T00:00:00Z' }]
const sessions = parseSessionGraph({ sessions: [
  { sessionId: 'web:old', folderId: 'a', lastActivityAt: '2026-01-01T00:00:00Z' },
  { sessionId: 'web:scratch', lastActivityAt: '2026-01-03T00:00:00Z' },
  { sessionId: 'web:new', folderId: 'a', lastActivityAt: '2026-01-04T00:00:00Z' },
  { sessionId: 'web:beta', folderId: 'b', lastActivityAt: '2026-01-02T00:00:00Z' },
  { sessionId: 'web:unknown', folderId: 'removed', lastActivityAt: 'invalid' },
  { sessionId: 'web:task', mode: 'task', parentSessionId: 'web:new' },
  { sessionId: 'chat-admin' },
], nodes: [] })
const names = new Map(folders.map(f => [f.id, f.name]))
const ids = (items: typeof sessions) => items.map(s => s.sessionId)
test('unified chats combine folders, scratch and missing folders without temporary executions or coordination', () => {
  const groups = groupFolderSessions(folders, sessions)
  assert.equal(groups.unified.length, 5)
  assert.deepEqual(ids(sortSidebarChats(groups.unified, names, 'time')), ['web:new', 'web:scratch', 'web:beta', 'web:old', 'web:unknown'])
  assert.equal(sessions.find(session => session.sessionId === 'web:unknown')?.lastActivityAt, undefined)
  assert.deepEqual(ids(groups.folders[0].sessions), ['web:old', 'web:new'])
})
test('folder sorting keeps same-folder chats recent first without mutating input', () => {
  const original = ids(sessions)
  assert.deepEqual(ids(sortSidebarChats(groupFolderSessions(folders, sessions).unified, names, 'folder')), ['web:scratch', 'web:new', 'web:old', 'web:beta', 'web:unknown'])
  assert.deepEqual(ids(sessions), original)
})
test('preferences default to unified recent activity and are scoped by endpoint/project', () => {
  const values = new Map<string, string>()
  const storage = { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value) } }
  assert.deepEqual(restoreChatListPreferences(storage, '/api', 'one'), { folderGrouped: false, sort: 'time' })
  saveChatListPreferences(storage, '/api', 'one', { folderGrouped: true, sort: 'folder' })
  assert.deepEqual(restoreChatListPreferences(storage, '/api', 'one'), { folderGrouped: true, sort: 'folder' })
  assert.equal(restoreChatListPreferences(storage, '/api', 'two').folderGrouped, false)
  assert.equal(restoreChatListPreferences(storage, '/other', 'one').sort, 'time')
  assert.deepEqual(restoreChatListPreferences({getItem: () => '{broken'}, '/api'), {folderGrouped: false, sort: 'time'})
  assert.doesNotThrow(() => saveChatListPreferences({setItem: () => {throw Error('denied')}}, '/api', undefined, {folderGrouped: false, sort: 'time'}))
})
test('folder presentation is independent of project grouping and subtitle is ellipsized separately', () => {
  const sidebar = readFileSync(new URL('./components/FoldersSidebar.vue', import.meta.url), 'utf8')
  const row = readFileSync(new URL('./components/TreeRow.vue', import.meta.url), 'utf8')
  assert.match(sidebar, /v-if="folderGrouped"/)
  assert.match(sidebar, /groups.value.unified/)
  assert.match(sidebar, /:session-metadata="sessionMetadata"/)
  assert.match(row, /v-if="subtitle \|\| \$slots.subtitle" class="tree-subtitle"/)
})


test('activity labels respect minute, hour and date boundaries in the current locale', async () => {
  const { formatSidebarActivity: format } = await import('./sidebar-chat-time.ts')
  const now = Date.parse('2026-06-01T12:00:00Z')
  const ago = (age: number, locale = 'en') => format(new Date(now - age).toISOString(), now, locale)
  assert.equal(ago(59_999), 'now')
  assert.equal(ago(60_000), '1 minute ago')
  assert.equal(ago(3_599_999), '59 minutes ago')
  assert.equal(ago(3_600_000), '1 hour ago')
  assert.equal(ago(86_399_999), '23 hours ago')
  for (const locale of ['en', 'zh-CN']) {
    for (const day of [1, 2, 3]) {
      const expected = new Intl.RelativeTimeFormat(locale, { numeric: 'always' }).format(-day, 'day')
      assert.equal(ago(day * 86_400_000, locale), expected)
      assert.equal(ago((day + 1) * 86_400_000 - 1, locale), expected)
    }
    assert.equal(ago(4 * 86_400_000, locale), new Intl.DateTimeFormat(locale, { year: 'numeric', month: 'short', day: 'numeric' }).format(now - 4 * 86_400_000))
  }
  assert.equal(ago(86_400_000, 'zh-CN'), '1天前')
  assert.equal(ago(120_000, 'zh-CN'), new Intl.RelativeTimeFormat('zh-CN', { numeric: 'auto' }).format(-2, 'minute'))
  assert.equal(ago(-60_000), 'now')
  assert.equal(format('invalid', now, 'en'), '')
  assert.equal(format(undefined, now, 'en'), '')
})

test('unified new row starts scratch while grouped retains its heading; metadata uses chips and a cleaned clock', () => {
  const sidebar = readFileSync(new URL('./components/FoldersSidebar.vue', import.meta.url), 'utf8')
  const list = readFileSync(new URL('./components/FolderSessionList.vue', import.meta.url), 'utf8')
  assert.match(sidebar, /<TreeRow v-if="!folderGrouped"[\s\S]*?@select="startScratchDraft"/)
  assert.match(sidebar, /<div v-else class="chats-heading">/)
  assert.match(sidebar, /function startScratchDraft\(\) \{\s*selectedFolderId.value = ''\s*emit\('scratch'\)/)
  assert.match(sidebar, /function deactivate\(\) \{\s*stopActivityClock\(\)/)
  assert.match(sidebar, /clearInterval\(activityTimer\)/)
  assert.match(list, /class="session-folder-chip"/)
  assert.match(list, /#subtitle/)
  assert.match(list, /:datetime="session.lastActivityAt"/)
})

test('new action is neutral and left aligned with no inline sorting control', () => {
  const sidebar = readFileSync(new URL('./components/FoldersSidebar.vue', import.meta.url), 'utf8')
  assert.doesNotMatch(sidebar, /class="chat-sort"/)
  assert.match(sidebar, /const chatSort = 'time' as const/)
  assert.doesNotMatch(sidebar, /chatSort.value|prefs.sort/)
  assert.match(sidebar, /button-class="chat-new" :icon-only="isRail"/)
  assert.match(sidebar, /<kbd class="chat-new-shortcut">Ctrl\+N<\/kbd>/)
  const row = readFileSync(new URL('./components/TreeRow.vue', import.meta.url), 'utf8')
  assert.match(row, /text-align: left/)
  assert.match(row, /background: transparent/)
  assert.match(sidebar, /prefers-reduced-motion: reduce/)
})

test('folder and keyboard chips follow app radius tokens and retain neutral, distinct treatments', () => {
  const sidebar = readFileSync(new URL('./components/FoldersSidebar.vue', import.meta.url), 'utf8')
  const list = readFileSync(new URL('./components/FolderSessionList.vue', import.meta.url), 'utf8')
  const kbd = sidebar.match(/\.chat-new-shortcut \{([^}]+)\}/)![1]
  const chip = list.match(/\.session-folder-chip \{([^}]+)\}/)![1]
  for (const rule of [kbd, chip]) {
    assert.match(rule, /border-radius: var\(--radius-sm\)/)
    assert.doesNotMatch(rule, /c-primary|border-radius: \d+px/)
  }
  assert.match(kbd, /border: 1px solid var\(--c-border\)/)
  assert.match(kbd, /ui-monospace/)
  assert.match(chip, /box-shadow: inset/)
  assert.match(chip, /font-weight: 500/)
  assert.match(list, /\.session-folder-chip.is-scratch \{[^}]*background: transparent; box-shadow: none/)
})


test('committed folder changes drive sidebar selection and file workbench without browsing mutation', () => {
  const sidebar = readFileSync(new URL('./components/FoldersSidebar.vue', import.meta.url), 'utf8')
  const chat = readFileSync(new URL('./components/ChatTab.vue', import.meta.url), 'utf8')
  const workbench = readFileSync(new URL('./components/files/FileWorkbench.vue', import.meta.url), 'utf8')
  assert.match(sidebar, /:selected="selectedFolderId === group.folder.id"/)
  assert.match(sidebar, /props.sessions.find\(session => session.sessionId === props.activeSessionId\)\?\.folderId/)
  assert.match(chat, /:folder-id="activeSessionId \? activeSession\?\.folderId : draft.folder\?\.id"/)
  assert.match(workbench, /watch\(\(\) => \[props.contextKey, props.folderId\]/)
  assert.doesNotMatch(sidebar + workbench, /use_project|switchProjectFolder/)
})


test('draft activity competes with message recency rather than permanently pinning drafts', () => {
  const chats = groupFolderSessions(folders, sessions).unified.filter(session => session.sessionId !== 'chat-admin')
  const drafts = new Map([['web:old', Date.parse('2026-01-03T12:00:00Z')]])
  assert.deepEqual(ids(sortSidebarChats(chats, names, 'time', drafts)),
    ['web:new', 'web:old', 'web:scratch', 'web:beta', 'web:unknown'])
  drafts.set('web:old', Date.parse('2026-01-05T00:00:00Z'))
  assert.equal(sortSidebarChats(chats, names, 'time', drafts)[0].sessionId, 'web:old')
  assert.deepEqual(ids(sortSidebarChats(chats, names, 'folder', drafts)),
    ['web:scratch', 'web:old', 'web:new', 'web:beta', 'web:unknown'])
  drafts.clear()
  assert.deepEqual(ids(sortSidebarChats(chats, names, 'time', drafts)),
    ['web:new', 'web:scratch', 'web:beta', 'web:old', 'web:unknown'])
})
