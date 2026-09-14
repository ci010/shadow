import { test } from 'node:test'
import assert from 'node:assert/strict'
import { hoverInfoPosition } from './hover-info.ts'
import { railInitial, rootSessionFamilies } from './project-rail.ts'
import type { SidebarSession } from './projects-sidebar.ts'

test('hover cards prefer the right, flip left, and stay inside narrow or short viewports', () => {
  const popup = { width: 320, height: 240 }
  assert.deepEqual(hoverInfoPosition({ left: 10, right: 54, top: 100 }, popup, { width: 1000, height: 700 }), { left: 62, top: 100 })
  assert.deepEqual(hoverInfoPosition({ left: 850, right: 900, top: 600 }, popup, { width: 1000, height: 700 }), { left: 522, top: 452 })
  assert.deepEqual(hoverInfoPosition({ left: 10, right: 54, top: 500 }, { width: 304, height: 600 }, { width: 320, height: 600 }), { left: 8, top: 8 })
})

test('rail initials are deterministic, Unicode aware, and safe for empty labels', () => {
  assert.equal(railInitial(' shadow'), 'S')
  assert.equal(railInitial('影子'), '影')
  assert.equal(railInitial('🪄 Agent'), '🪄')
  assert.equal(railInitial(' '), '?')
})

test('rail groups only visible tree roots while retaining every descendant for navigation', () => {
  const session = (sessionId: string, depth: number) => ({ sessionId, depth } as SidebarSession)
  const sessions = [session('root', 0), session('child', 1), session('nested', 2), session('other', 0)]
  assert.deepEqual(rootSessionFamilies(sessions).map(family => family.map(item => item.sessionId)), [['root', 'child', 'nested'], ['other']])
  assert.deepEqual(rootSessionFamilies([]), [])
})
