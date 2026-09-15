import assert from 'node:assert/strict'
import { test } from 'node:test'
import { DEFAULT_ORGANIZATION_SIDEBAR, parseOrganizationSidebarPreferences } from './organization-sidebar.ts'
import { clampSidebarWidth, sidebarWidthBounds } from './sidebar-resize.ts'

test('organization sidebar restores width and rail independently and rejects malformed saved values', () => {
  assert.deepEqual(parseOrganizationSidebarPreferences(null), DEFAULT_ORGANIZATION_SIDEBAR)
  assert.deepEqual(parseOrganizationSidebarPreferences('{"width":356,"collapsed":true}'), { width: 356, collapsed: true })
  for (const raw of ['{', 'null', '[]', '{"width":"300","collapsed":true}', '{"width":300}', '{"width":1e999,"collapsed":false}']) {
    assert.throws(() => parseOrganizationSidebarPreferences(raw))
  }
  assert.equal(parseOrganizationSidebarPreferences('{"width":9999,"collapsed":false}').width, 440)
  assert.equal(parseOrganizationSidebarPreferences('{"width":-1,"collapsed":false}').width, 200)
})

test('organization sidebar preserves the preferred width across narrow layouts and rail toggles', () => {
  const saved = parseOrganizationSidebarPreferences('{"width":400,"collapsed":true}')
  assert.equal(clampSidebarWidth(saved.width, sidebarWidthBounds(650, 200, 440)), 290)
  saved.collapsed = false
  assert.equal(clampSidebarWidth(saved.width, sidebarWidthBounds(1200, 200, 440)), 400)
  assert.deepEqual(parseOrganizationSidebarPreferences(JSON.stringify(saved)), { width: 400, collapsed: false })
})
