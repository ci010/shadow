import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_PROJECT_SIDEBAR, parseProjectSidebarPreferences, projectSidebarStorageKey, restoreProjectSidebarPreferences } from './project-sidebar.ts'
import { clampSidebarWidth, sidebarWidthBounds } from './sidebar-resize.ts'

test('project sidebar restores width and hidden preference, including legacy rail records', () => {
  assert.deepEqual(parseProjectSidebarPreferences(null), DEFAULT_PROJECT_SIDEBAR)
  assert.deepEqual(parseProjectSidebarPreferences('{"width":356,"collapsed":true}'), { width: 356, collapsed: true })
  for (const raw of ['{', 'null', '[]', '{"width":"300","collapsed":true}', '{"width":300}', '{"width":1e999,"collapsed":false}']) {
    assert.throws(() => parseProjectSidebarPreferences(raw))
  }
  assert.equal(parseProjectSidebarPreferences('{"width":9999,"collapsed":false}').width, 440)
  assert.equal(parseProjectSidebarPreferences('{"width":-1,"collapsed":false}').width, 200)
})

test('project sidebar preserves the preferred width across narrow layouts and pin toggles', () => {
  const saved = parseProjectSidebarPreferences('{"width":400,"collapsed":true}')
  assert.equal(clampSidebarWidth(saved.width, sidebarWidthBounds(650, 200, 440)), 290)
  saved.collapsed = false
  assert.equal(clampSidebarWidth(saved.width, sidebarWidthBounds(1200, 200, 440)), 400)
  assert.deepEqual(parseProjectSidebarPreferences(JSON.stringify(saved)), { width: 400, collapsed: false })
})

test('sidebar preferences read only the canonical key for the current API host', () => {
  const base = 'http://fixture'
  const saved = new Map([[projectSidebarStorageKey('http://other'), '{"width":356,"collapsed":true}']])
  const reads: string[] = []
  const storage = { getItem: (key: string) => { reads.push(key); return saved.get(key) ?? null } }
  assert.deepEqual(restoreProjectSidebarPreferences(storage, base), DEFAULT_PROJECT_SIDEBAR)
  assert.deepEqual(reads, [projectSidebarStorageKey(base)], 'Only the requested host preference key is read')
  assert.deepEqual(restoreProjectSidebarPreferences(storage, 'http://other'), { width: 356, collapsed: true })
  saved.set(projectSidebarStorageKey(base), '{"width":280,"collapsed":false}')
  assert.deepEqual(restoreProjectSidebarPreferences(storage, base), { width: 280, collapsed: false })
  saved.set(projectSidebarStorageKey(base), '{')
  assert.throws(() => restoreProjectSidebarPreferences(storage, base), 'Malformed canonical state remains an explicit error')
})
